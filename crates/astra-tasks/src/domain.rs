/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Tasks domain: lists, priorities, deadlines, subtasks and linked pages.
//!
//! Rows live in the `task_lists` / `tasks` / `task_links` tables owned by
//! `astra-store` (migration v3). This crate adds no migrations: operations
//! covered by the store API (`task_list_create`, `task_create`,
//! `task_complete`, `task_link`, `task_list_open`) are reused, and the
//! remaining columns the schema already provides (`parent_id`, `notes`,
//! `position`, renames, soft-delete, link listing) are reached through a
//! second connection to the same database file.

use std::path::Path;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::parser::{self, Capture, ListRef};

/// Task priority. Stored as an integer with higher meaning more urgent, so
/// the store's `ORDER BY priority DESC` keeps working.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Priority {
    #[default]
    None = 0,
    Low = 1,
    Medium = 2,
    High = 3,
}

impl Priority {
    /// Parse a `!` sigil body (`1`, `high`, `med`, ...), case-insensitive.
    /// `!1` is high: the numbering follows urgency, not the stored integer.
    pub fn from_token(body: &str) -> Option<Self> {
        Some(match body.to_lowercase().as_str() {
            "1" | "high" => Priority::High,
            "2" | "medium" | "med" => Priority::Medium,
            "3" | "low" => Priority::Low,
            _ => return None,
        })
    }

    pub fn from_stored(value: i64) -> Self {
        match value {
            3 => Priority::High,
            2 => Priority::Medium,
            1 => Priority::Low,
            _ => Priority::None,
        }
    }

    pub fn as_stored(self) -> i64 {
        self as i64
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskList {
    pub id: i64,
    pub uuid: String,
    pub title: String,
    pub position: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Task {
    pub id: i64,
    pub uuid: String,
    pub list_id: Option<i64>,
    pub parent_id: Option<i64>,
    pub title: String,
    pub notes: String,
    pub due_at: Option<i64>,
    pub priority: Priority,
    pub position: i64,
    pub completed_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskLink {
    pub id: i64,
    pub task_id: i64,
    pub url: String,
    pub title: String,
}

/// A task with its subtasks nested.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskNode {
    pub task: Task,
    pub children: Vec<TaskNode>,
}

/// Input for creating a task, including the natural-language fields.
#[derive(Clone, Debug, Default)]
pub struct NewTask {
    pub list_id: Option<i64>,
    pub title: String,
    pub notes: String,
    pub due_at: Option<i64>,
    pub priority: Priority,
    pub parent_id: Option<i64>,
    pub position: i64,
}

#[derive(Debug, Error)]
pub enum TasksError {
    #[error("store error: {0}")]
    Store(#[from] astra_store::StoreError),
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("task not found: {0}")]
    NotFound(i64),
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("tasks JSON error: {0}")]
    Json(String),
    #[error("unsupported tasks export version {0} (expected {1})")]
    VersionMismatch(u32, u32),
}

fn now_utc() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Tasks facade over a file-backed store database.
///
/// Holds the [`astra_store::Store`] (for schema setup plus the task
/// operations it already provides) and a second connection to the same file
/// for the columns the store API does not expose. Both connections target
/// the same tables; no new tables or migrations are introduced here.
pub struct Tasks {
    store: astra_store::Store,
    conn: Connection,
}

impl Tasks {
    /// Open (creating and migrating as needed) the database at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, TasksError> {
        let store = astra_store::Store::open(path.as_ref())?;
        store.migrate()?;
        let conn = Connection::open(path.as_ref())?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        Ok(Self { store, conn })
    }

    // -- lists ---------------------------------------------------------------

    pub fn create_list(&self, title: &str, position: i64) -> Result<TaskList, TasksError> {
        let title = title.trim();
        if title.is_empty() {
            return Err(TasksError::Invalid(
                "list title must not be empty".to_owned(),
            ));
        }
        let row = self.store.task_list_create(title, position)?;
        Ok(TaskList {
            id: row.id,
            uuid: row.uuid,
            title: row.title,
            position: row.position,
        })
    }

    pub fn rename_list(&self, id: i64, title: &str) -> Result<(), TasksError> {
        let title = title.trim();
        if title.is_empty() {
            return Err(TasksError::Invalid(
                "list title must not be empty".to_owned(),
            ));
        }
        let changed = self.conn.execute(
            "UPDATE task_lists SET title = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
            params![title, now_utc(), id],
        )?;
        if changed == 0 {
            return Err(TasksError::NotFound(id));
        }
        Ok(())
    }

    pub fn lists(&self) -> Result<Vec<TaskList>, TasksError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, uuid, title, position FROM task_lists
             WHERE deleted_at IS NULL ORDER BY position, id",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(TaskList {
                    id: row.get(0)?,
                    uuid: row.get(1)?,
                    title: row.get(2)?,
                    position: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Soft-delete a list. Its tasks are preserved and moved back to the
    /// inbox (`list_id = NULL`), mirroring the base snapshot's rule that
    /// removing an organizer never removes the tasks inside it.
    pub fn delete_list(&self, id: i64) -> Result<(), TasksError> {
        let now = now_utc();
        let changed = self.conn.execute(
            "UPDATE task_lists SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![now, id],
        )?;
        if changed == 0 {
            return Err(TasksError::NotFound(id));
        }
        self.conn.execute(
            "UPDATE tasks SET list_id = NULL, updated_at = ?1 WHERE list_id = ?2 AND deleted_at IS NULL",
            params![now, id],
        )?;
        Ok(())
    }

    fn list_refs(&self) -> Result<Vec<ListRef>, TasksError> {
        Ok(self
            .lists()?
            .into_iter()
            .map(|list| ListRef {
                id: list.id,
                title: list.title,
            })
            .collect())
    }

    // -- tasks -----------------------------------------------------------------

    pub fn create_task(&self, input: NewTask) -> Result<Task, TasksError> {
        let title = input.title.trim().to_owned();
        if title.is_empty() {
            return Err(TasksError::Invalid(
                "task title must not be empty".to_owned(),
            ));
        }
        if let Some(parent) = input.parent_id {
            if self.get_task(parent)?.completed_at.is_some() {
                return Err(TasksError::Invalid(
                    "cannot attach a subtask to a completed task".to_owned(),
                ));
            }
        }
        let row = self.store.task_create(
            input.list_id,
            &title,
            input.due_at,
            input.priority.as_stored(),
        )?;
        self.conn.execute(
            "UPDATE tasks SET parent_id = ?1, notes = ?2, position = ?3, updated_at = ?4 WHERE id = ?5",
            params![input.parent_id, input.notes, input.position, now_utc(), row.id],
        )?;
        self.get_task(row.id)
    }

    fn map_task_row(row: &rusqlite::Row) -> rusqlite::Result<Task> {
        Ok(Task {
            id: row.get(0)?,
            uuid: row.get(1)?,
            list_id: row.get(2)?,
            parent_id: row.get(3)?,
            title: row.get(4)?,
            notes: row.get(5)?,
            due_at: row.get(6)?,
            priority: Priority::from_stored(row.get(7)?),
            position: row.get(8)?,
            completed_at: row.get(9)?,
        })
    }

    pub fn get_task(&self, id: i64) -> Result<Task, TasksError> {
        self.conn
            .query_row(
                "SELECT id, uuid, list_id, parent_id, title, notes, due_at,
                        priority, position, completed_at
                 FROM tasks WHERE id = ?1 AND deleted_at IS NULL",
                params![id],
                Self::map_task_row,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => TasksError::NotFound(id),
                other => TasksError::Db(other),
            })
    }

    /// Open (not completed, not deleted) tasks, optionally in one list.
    pub fn open_tasks(&self, list_id: Option<i64>) -> Result<Vec<Task>, TasksError> {
        Ok(self
            .store
            .task_list_open(list_id)?
            .into_iter()
            .map(|row| Task {
                id: row.id,
                uuid: row.uuid,
                list_id: row.list_id,
                parent_id: row.parent_id,
                title: row.title,
                notes: row.notes,
                due_at: row.due_at,
                priority: Priority::from_stored(row.priority),
                position: row.position,
                completed_at: row.completed_at,
            })
            .collect())
    }

    pub fn subtasks(&self, parent_id: i64) -> Result<Vec<Task>, TasksError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, uuid, list_id, parent_id, title, notes, due_at,
                    priority, position, completed_at
             FROM tasks
             WHERE parent_id = ?1 AND deleted_at IS NULL AND completed_at IS NULL
             ORDER BY position, id",
        )?;
        let rows = stmt
            .query_map(params![parent_id], Self::map_task_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Every non-deleted task, including completed ones, in stable order.
    /// The export uses this (not [`Tasks::open_tasks`]) so completed work
    /// survives the round-trip too.
    pub fn all_tasks(&self) -> Result<Vec<Task>, TasksError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, uuid, list_id, parent_id, title, notes, due_at,
                    priority, position, completed_at
             FROM tasks WHERE deleted_at IS NULL ORDER BY position, id",
        )?;
        let rows = stmt
            .query_map([], Self::map_task_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Raw handle for the export module's UUID-preserving restores.
    pub(crate) fn connection(&self) -> &Connection {
        &self.conn
    }

    /// Open-task forest for a list (or the whole inbox), nested by parent.
    pub fn tree(&self, list_id: Option<i64>) -> Result<Vec<TaskNode>, TasksError> {
        let tasks = self.open_tasks(list_id)?;
        Ok(forest(&tasks))
    }

    /// Tasks due strictly before `now_unix` (still open).
    pub fn overdue(&self, now_unix: i64) -> Result<Vec<Task>, TasksError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, uuid, list_id, parent_id, title, notes, due_at,
                    priority, position, completed_at
             FROM tasks
             WHERE deleted_at IS NULL AND completed_at IS NULL AND due_at IS NOT NULL AND due_at < ?1
             ORDER BY due_at, priority DESC, id",
        )?;
        let rows = stmt
            .query_map(params![now_unix], Self::map_task_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn complete_task(&self, id: i64) -> Result<(), TasksError> {
        self.get_task(id)?;
        self.store.task_complete(id)?;
        Ok(())
    }

    pub fn reopen_task(&self, id: i64) -> Result<(), TasksError> {
        let changed = self.conn.execute(
            "UPDATE tasks SET completed_at = NULL, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![now_utc(), id],
        )?;
        if changed == 0 {
            return Err(TasksError::NotFound(id));
        }
        Ok(())
    }

    pub fn set_title(&self, id: i64, title: &str) -> Result<(), TasksError> {
        let title = title.trim();
        if title.is_empty() {
            return Err(TasksError::Invalid(
                "task title must not be empty".to_owned(),
            ));
        }
        self.update_columns(id, "title", title)
    }

    pub fn set_notes(&self, id: i64, notes: &str) -> Result<(), TasksError> {
        self.update_columns(id, "notes", notes)
    }

    pub fn set_priority(&self, id: i64, priority: Priority) -> Result<(), TasksError> {
        let changed = self.conn.execute(
            "UPDATE tasks SET priority = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
            params![priority.as_stored(), now_utc(), id],
        )?;
        if changed == 0 {
            return Err(TasksError::NotFound(id));
        }
        Ok(())
    }

    pub fn set_due(&self, id: i64, due_at: Option<i64>) -> Result<(), TasksError> {
        let changed = self.conn.execute(
            "UPDATE tasks SET due_at = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
            params![due_at, now_utc(), id],
        )?;
        if changed == 0 {
            return Err(TasksError::NotFound(id));
        }
        Ok(())
    }

    pub fn move_to_list(&self, id: i64, list_id: Option<i64>) -> Result<(), TasksError> {
        let changed = self.conn.execute(
            "UPDATE tasks SET list_id = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
            params![list_id, now_utc(), id],
        )?;
        if changed == 0 {
            return Err(TasksError::NotFound(id));
        }
        Ok(())
    }

    pub fn reparent(&self, id: i64, parent_id: Option<i64>) -> Result<(), TasksError> {
        if let Some(parent) = parent_id {
            if parent == id {
                return Err(TasksError::Invalid(
                    "a task cannot be its own parent".to_owned(),
                ));
            }
            // Refuse cycles: the new parent must not be a descendant of `id`.
            let mut cursor = Some(parent);
            while let Some(current) = cursor {
                if current == id {
                    return Err(TasksError::Invalid(
                        "reparenting would create a cycle".to_owned(),
                    ));
                }
                cursor = self.get_task(current)?.parent_id;
            }
        }
        let changed = self.conn.execute(
            "UPDATE tasks SET parent_id = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
            params![parent_id, now_utc(), id],
        )?;
        if changed == 0 {
            return Err(TasksError::NotFound(id));
        }
        Ok(())
    }

    fn update_columns(&self, id: i64, column: &str, value: &str) -> Result<(), TasksError> {
        // `column` is always one of two compile-time literals.
        let sql = format!(
            "UPDATE tasks SET {column} = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL"
        );
        let changed = self.conn.execute(&sql, params![value, now_utc(), id])?;
        if changed == 0 {
            return Err(TasksError::NotFound(id));
        }
        Ok(())
    }

    /// Soft-delete a task and its descendant subtasks.
    pub fn delete_task(&self, id: i64) -> Result<(), TasksError> {
        self.get_task(id)?;
        let now = now_utc();
        let mut stack = vec![id];
        while let Some(current) = stack.pop() {
            self.conn.execute(
                "UPDATE tasks SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
                params![now, current],
            )?;
            let mut stmt = self
                .conn
                .prepare("SELECT id FROM tasks WHERE parent_id = ?1 AND deleted_at IS NULL")?;
            let kids: Vec<i64> = stmt
                .query_map(params![current], |row| row.get(0))?
                .collect::<Result<_, _>>()?;
            stack.extend(kids);
        }
        Ok(())
    }

    // -- linked pages ------------------------------------------------------------

    pub fn add_link(&self, task_id: i64, url: &str, title: &str) -> Result<TaskLink, TasksError> {
        self.get_task(task_id)?;
        let url = url.trim();
        if url.is_empty() {
            return Err(TasksError::Invalid("link url must not be empty".to_owned()));
        }
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(TasksError::Invalid("link url must be http(s)".to_owned()));
        }
        let id = self.store.task_link(task_id, url, title)?;
        Ok(TaskLink {
            id,
            task_id,
            url: url.to_owned(),
            title: title.to_owned(),
        })
    }

    pub fn links_for(&self, task_id: i64) -> Result<Vec<TaskLink>, TasksError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, task_id, url, title FROM task_links WHERE task_id = ?1 ORDER BY id",
        )?;
        let rows = stmt
            .query_map(params![task_id], |row| {
                Ok(TaskLink {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    url: row.get(2)?,
                    title: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // -- natural-language creation -------------------------------------------------

    /// Create a task from one typed line: sigil tokens (`!1`, `#list`,
    /// `~45m`) are read anywhere in the line, then a trailing date/time
    /// phrase is consumed for the deadline.
    ///
    /// `today` is the `YYYY-MM-DD` day in the user's zone (see
    /// [`crate::today_in_zone`]) and `utc_offset_secs` the offset in effect
    /// for the due date (see [`crate::due_timestamp_utc`]).
    pub fn create_from_text(
        &self,
        line: &str,
        today: &str,
        week_start: u32,
        utc_offset_secs: i32,
    ) -> Result<Task, TasksError> {
        let lists = self.list_refs()?;
        let tokens = parser::parse_tokens(line, &lists, &[]);
        let capture: Capture =
            parser::parse_capture_with_week_start(&tokens.rest, today, week_start);
        if capture.title.trim().is_empty() {
            return Err(TasksError::Invalid(
                "task title must not be empty".to_owned(),
            ));
        }
        let due_at = capture.due_date.as_deref().and_then(|day| {
            crate::due_timestamp_utc(day, capture.due_time.as_deref(), utc_offset_secs)
        });
        let _ = capture.matched;
        self.create_task(NewTask {
            list_id: tokens.list,
            title: capture.title,
            notes: String::new(),
            due_at,
            priority: tokens.priority.unwrap_or_default(),
            parent_id: None,
            position: 0,
        })
    }
}

impl From<&TaskList> for ListRef {
    fn from(list: &TaskList) -> Self {
        ListRef {
            id: list.id,
            title: list.title.clone(),
        }
    }
}

/// Nest a flat open-task list into a forest by `parent_id`. Orphans (parent
/// completed, deleted, or in another list) surface as roots so no open task
/// is ever hidden.
fn forest(tasks: &[Task]) -> Vec<TaskNode> {
    use std::collections::HashMap;
    let mut by_parent: HashMap<Option<i64>, Vec<&Task>> = HashMap::new();
    for task in tasks {
        by_parent.entry(task.parent_id).or_default().push(task);
    }
    fn build(
        parent: Option<i64>,
        by_parent: &HashMap<Option<i64>, Vec<&Task>>,
        stack: &mut Vec<i64>,
    ) -> Vec<TaskNode> {
        let mut nodes = Vec::new();
        if let Some(kids) = by_parent.get(&parent) {
            for task in kids {
                if stack.contains(&task.id) {
                    continue;
                }
                stack.push(task.id);
                let children = build(Some(task.id), by_parent, stack);
                stack.pop();
                nodes.push(TaskNode {
                    task: (*task).clone(),
                    children,
                });
            }
        }
        nodes
    }
    // Roots: parentless tasks plus orphans whose parent is not in the set.
    let ids: std::collections::HashSet<i64> = tasks.iter().map(|t| t.id).collect();
    let mut roots: Vec<&Task> = tasks
        .iter()
        .filter(|t| t.parent_id.is_none() || !ids.contains(&t.parent_id.unwrap_or(-1)))
        .collect();
    roots.sort_by_key(|t| (t.position, t.id));
    let mut out = Vec::new();
    for task in roots {
        let mut guard = vec![task.id];
        let children = build(Some(task.id), &by_parent, &mut guard);
        out.push(TaskNode {
            task: task.clone(),
            children,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn open() -> (TempDir, Tasks) {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join("tasks.db");
        let tasks = Tasks::open(&path).expect("open");
        (dir, tasks)
    }

    #[test]
    fn list_lifecycle_round_trip() {
        let (_dir, tasks) = open();
        let inbox = tasks.create_list("Inbox", 0).unwrap();
        assert_eq!(inbox.title, "Inbox");
        tasks.rename_list(inbox.id, "Next").unwrap();
        assert_eq!(tasks.lists().unwrap()[0].title, "Next");
        assert!(tasks.rename_list(9999, "Ghost").is_err());
        assert!(tasks.create_list("   ", 0).is_err());
    }

    #[test]
    fn task_lifecycle_round_trip_through_real_store_tables() {
        let (_dir, tasks) = open();
        let list = tasks.create_list("Work", 0).unwrap();

        let task = tasks
            .create_task(NewTask {
                list_id: Some(list.id),
                title: "Call Anna".to_owned(),
                notes: "ask about Friday".to_owned(),
                due_at: Some(1_700_000_000),
                priority: Priority::High,
                parent_id: None,
                position: 0,
            })
            .unwrap();
        assert_eq!(task.priority, Priority::High);
        assert!(!task.uuid.is_empty());

        // Read back through the store-backed path.
        let fetched = tasks.get_task(task.id).unwrap();
        assert_eq!(fetched, task);

        // Open listing orders by priority descending (store query).
        let low = tasks
            .create_task(NewTask {
                list_id: Some(list.id),
                title: "File expenses".to_owned(),
                priority: Priority::Low,
                ..Default::default()
            })
            .unwrap();
        let open = tasks.open_tasks(Some(list.id)).unwrap();
        assert_eq!(open.len(), 2);
        assert_eq!(open[0].id, task.id);

        // Complete hides from open; reopen restores.
        tasks.complete_task(task.id).unwrap();
        assert_eq!(tasks.open_tasks(Some(list.id)).unwrap().len(), 1);
        tasks.reopen_task(task.id).unwrap();
        assert_eq!(tasks.open_tasks(Some(list.id)).unwrap().len(), 2);

        // Updates persist.
        tasks.set_title(low.id, "File Q3 expenses").unwrap();
        tasks.set_priority(low.id, Priority::Medium).unwrap();
        tasks.set_due(low.id, None).unwrap();
        tasks.set_notes(low.id, "receipts attached").unwrap();
        let updated = tasks.get_task(low.id).unwrap();
        assert_eq!(updated.title, "File Q3 expenses");
        assert_eq!(updated.priority, Priority::Medium);
        assert_eq!(updated.due_at, None);
        assert_eq!(updated.notes, "receipts attached");

        // Overdue picks up only open tasks past the instant.
        tasks.set_due(low.id, Some(1_000)).unwrap();
        let overdue = tasks.overdue(2_000).unwrap();
        assert_eq!(overdue.len(), 1);
        assert_eq!(overdue[0].id, low.id);

        // Delete hides everywhere.
        tasks.delete_task(low.id).unwrap();
        assert!(tasks.get_task(low.id).is_err());
        assert!(tasks
            .open_tasks(Some(list.id))
            .unwrap()
            .iter()
            .all(|t| t.id != low.id));
    }

    #[test]
    fn subtasks_nest_and_delete_cascades() {
        let (_dir, tasks) = open();
        let parent = tasks
            .create_task(NewTask {
                title: "Plan trip".to_owned(),
                ..Default::default()
            })
            .unwrap();
        let child = tasks
            .create_task(NewTask {
                title: "Book flights".to_owned(),
                parent_id: Some(parent.id),
                ..Default::default()
            })
            .unwrap();
        let grandchild = tasks
            .create_task(NewTask {
                title: "Pick seats".to_owned(),
                parent_id: Some(child.id),
                ..Default::default()
            })
            .unwrap();

        let tree = tasks.tree(None).unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].task.id, parent.id);
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].task.id, child.id);
        assert_eq!(tree[0].children[0].children.len(), 1);
        assert_eq!(tree[0].children[0].children[0].task.id, grandchild.id);
        assert_eq!(tasks.subtasks(parent.id).unwrap().len(), 1);

        // Cycles are refused.
        assert!(tasks.reparent(parent.id, Some(grandchild.id)).is_err());
        assert!(tasks.reparent(parent.id, Some(parent.id)).is_err());
        // A subtask cannot be attached to a completed parent.
        tasks.complete_task(parent.id).unwrap();
        assert!(tasks
            .create_task(NewTask {
                title: "Nope".to_owned(),
                parent_id: Some(parent.id),
                ..Default::default()
            })
            .is_err());

        tasks.delete_task(parent.id).unwrap();
        assert!(tasks.get_task(child.id).is_err());
        assert!(tasks.get_task(grandchild.id).is_err());
    }

    #[test]
    fn linked_pages_round_trip() {
        let (_dir, tasks) = open();
        let task = tasks
            .create_task(NewTask {
                title: "Read proposal".to_owned(),
                ..Default::default()
            })
            .unwrap();
        let link = tasks
            .add_link(task.id, "https://example.com/proposal", "Proposal")
            .unwrap();
        assert_eq!(link.task_id, task.id);
        let links = tasks.links_for(task.id).unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].url, "https://example.com/proposal");
        assert!(tasks.add_link(task.id, "notaurl", "Bad").is_err());
        assert!(tasks.add_link(9999, "https://example.com/x", "X").is_err());
    }

    #[test]
    fn deleting_a_list_preserves_its_tasks_in_the_inbox() {
        let (_dir, tasks) = open();
        let list = tasks.create_list("Errands", 0).unwrap();
        let task = tasks
            .create_task(NewTask {
                list_id: Some(list.id),
                title: "Buy milk".to_owned(),
                ..Default::default()
            })
            .unwrap();
        tasks.delete_list(list.id).unwrap();
        assert!(tasks.lists().unwrap().is_empty());
        let kept = tasks.get_task(task.id).unwrap();
        assert_eq!(kept.list_id, None);
        assert_eq!(tasks.open_tasks(None).unwrap().len(), 1);
    }

    #[test]
    fn create_from_text_end_to_end() {
        let (_dir, tasks) = open();
        let work = tasks.create_list("Work", 0).unwrap();
        // "Call Anna tomorrow at 3pm !1 #work"-style line through the real tables.
        let created = tasks
            .create_from_text(
                "Call Anna tomorrow at 3pm !high #work",
                "2026-09-20",
                1,
                -4 * 3600,
            )
            .unwrap();
        assert_eq!(created.title, "Call Anna");
        assert_eq!(created.list_id, Some(work.id));
        assert_eq!(created.priority, Priority::High);
        // 2026-09-21 15:00 at UTC-4 -> 19:00Z.
        assert_eq!(created.due_at, Some(1_790_017_200));
        let open = tasks.open_tasks(Some(work.id)).unwrap();
        assert_eq!(open.len(), 1);
    }

    #[test]
    fn priority_ordering_matches_store_semantics() {
        assert!(Priority::High > Priority::Low);
        assert_eq!(Priority::from_stored(0), Priority::None);
        assert_eq!(Priority::from_stored(99), Priority::None);
        assert_eq!(Priority::High.as_stored(), 3);
        assert_eq!(Priority::from_token("1"), Some(Priority::High));
        assert_eq!(Priority::from_token("3"), Some(Priority::Low));
        assert_eq!(Priority::from_token("urgent"), None);
    }
}
