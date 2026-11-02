/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Tasks export/import: JSON + Markdown round-trip (P5-T05).
//!
//! Two formats, one model. JSON is the fully lossless path (every field,
//! including UUIDs, hierarchy, positions, timestamps and links). Markdown
//! is the human-readable path: nested checklists with the machine fields
//! tucked into `<!-- astra:… -->` comments so a Markdown export re-imports
//! to the same tasks.
//!
//! Versioning mirrors the `astra-core` session/layout precedent: every
//! payload carries `schema_version` (here [`astra_store::SCHEMA_VERSION`])
//! and imports reject anything else with
//! [`TasksError::VersionMismatch`][crate::TasksError] — old payloads fail
//! loudly, never silently.
//!
//! Import is merge-by-UUID (`INSERT … ON CONFLICT(uuid) DO UPDATE`, deleted
//! rows revived): importing the same payload twice converges instead of
//! duplicating. Unknown list/parent UUIDs fall back to the inbox (`None`)
//! rather than failing the whole import.
//!
//! Markdown limitations (JSON has none): titles are single-line (embedded
//! newlines export as spaces), and a link title containing `](` will not
//! re-import verbatim. Notes lines that would parse as tasks or links
//! (`- [ ] …`, `Link: …`) are backslash-escaped on export and unescaped on
//! import.

use std::collections::HashMap;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::domain::{Tasks, TasksError};

/// Export format version. Tied to the store schema so a database migration
/// and an export payload can never disagree silently.
pub use astra_store::SCHEMA_VERSION as TASKS_EXPORT_VERSION;

/// One task list in an export bundle.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskListExport {
    pub uuid: String,
    pub title: String,
    pub position: i64,
}

/// One linked page on an exported task.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskLinkExport {
    pub url: String,
    pub title: String,
}

/// One task in an export bundle. Lists and parents are referenced by UUID
/// (stable across databases); local row ids never leave the database.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskExport {
    pub uuid: String,
    pub list_uuid: Option<String>,
    pub parent_uuid: Option<String>,
    pub title: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub due_at: Option<i64>,
    #[serde(default)]
    pub priority: i64,
    #[serde(default)]
    pub position: i64,
    #[serde(default)]
    pub completed_at: Option<i64>,
    #[serde(default)]
    pub links: Vec<TaskLinkExport>,
}

/// Versioned JSON bundle: every list plus every non-deleted task.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TasksBundle {
    pub schema_version: u32,
    pub lists: Vec<TaskListExport>,
    pub tasks: Vec<TaskExport>,
}

/// Counts from an import, for tests and progress UI.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TasksImportReport {
    pub lists: usize,
    pub tasks: usize,
    pub links: usize,
}

impl Tasks {
    /// Capture every list and every non-deleted task (open and completed).
    pub fn export_bundle(&self) -> Result<TasksBundle, TasksError> {
        let lists = self.lists()?;
        let id_to_uuid: HashMap<i64, String> = lists
            .iter()
            .map(|list| (list.id, list.uuid.clone()))
            .collect();
        let all = self.all_tasks()?;
        let task_uuids: HashMap<i64, String> = all
            .iter()
            .map(|task| (task.id, task.uuid.clone()))
            .collect();
        let mut tasks = Vec::new();
        for task in all {
            let mut links = Vec::new();
            for link in self.links_for(task.id)? {
                links.push(TaskLinkExport {
                    url: link.url,
                    title: link.title,
                });
            }
            tasks.push(TaskExport {
                uuid: task.uuid,
                list_uuid: task.list_id.and_then(|id| id_to_uuid.get(&id).cloned()),
                parent_uuid: task.parent_id.and_then(|id| task_uuids.get(&id).cloned()),
                title: task.title,
                notes: task.notes,
                due_at: task.due_at,
                priority: task.priority.as_stored(),
                position: task.position,
                completed_at: task.completed_at,
                links,
            });
        }
        Ok(TasksBundle {
            schema_version: astra_store::SCHEMA_VERSION,
            lists: lists
                .into_iter()
                .map(|list| TaskListExport {
                    uuid: list.uuid,
                    title: list.title,
                    position: list.position,
                })
                .collect(),
            tasks,
        })
    }

    /// Serialise [`Tasks::export_bundle`] to pretty JSON.
    pub fn export_json(&self) -> Result<String, TasksError> {
        let bundle = self.export_bundle()?;
        serde_json::to_string_pretty(&bundle).map_err(|e| TasksError::Json(e.to_string()))
    }

    /// Parse and merge a JSON bundle (see [`Tasks::import_bundle`]).
    pub fn import_json(&self, json: &str) -> Result<TasksImportReport, TasksError> {
        let bundle: TasksBundle =
            serde_json::from_str(json).map_err(|e| TasksError::Json(e.to_string()))?;
        self.import_bundle(&bundle)
    }

    /// Merge a bundle by UUID. Version-checked; unknown list/parent UUIDs
    /// fall back to the inbox.
    pub fn import_bundle(&self, bundle: &TasksBundle) -> Result<TasksImportReport, TasksError> {
        check_version(bundle.schema_version)?;
        let (lists, tasks) = specs_from_bundle(bundle);
        self.realize(&lists, &tasks)
    }

    /// Render every list and task as a nested Markdown checklist with
    /// `<!-- astra:… -->` metadata comments (see module docs).
    pub fn export_markdown(&self) -> Result<String, TasksError> {
        let bundle = self.export_bundle()?;
        let mut out = format!(
            "# Astra tasks export (schema {})\n",
            astra_store::SCHEMA_VERSION
        );
        let mut top_by_list: HashMap<Option<String>, Vec<&TaskExport>> = HashMap::new();
        for task in &bundle.tasks {
            if task.parent_uuid.is_none() {
                top_by_list
                    .entry(task.list_uuid.clone())
                    .or_default()
                    .push(task);
            }
        }
        for kids in top_by_list.values_mut() {
            kids.sort_by_key(|task| (task.position, task.uuid.clone()));
        }
        let mut lists: Vec<&TaskListExport> = bundle.lists.iter().collect();
        lists.sort_by_key(|list| (list.position, list.uuid.clone()));
        for list in lists {
            out.push_str(&format!("\n## {}\n", list.title));
            out.push_str(&format!(
                "<!-- astra:list uuid=\"{}\" position=\"{}\" -->\n",
                list.uuid, list.position
            ));
            let kids = top_by_list
                .get(&Some(list.uuid.clone()))
                .map_or(&[][..], |v| v);
            for task in kids {
                write_task_markdown(&mut out, &bundle.tasks, task, 0);
            }
            if !kids.is_empty() {
                out.push('\n');
            }
        }
        let inbox = top_by_list.get(&None).map_or(&[][..], |v| v);
        if !inbox.is_empty() {
            out.push_str("\n## Inbox\n<!-- astra:list uuid=\"-\" position=\"0\" -->\n");
            for task in inbox {
                write_task_markdown(&mut out, &bundle.tasks, task, 0);
            }
        }
        Ok(out)
    }

    /// Parse [`Tasks::export_markdown`] output (plus hand-written Markdown
    /// in the same shape) and merge it by UUID.
    pub fn import_markdown(&self, markdown: &str) -> Result<TasksImportReport, TasksError> {
        let (lists, tasks) = parse_markdown(markdown)?;
        self.realize(&lists, &tasks)
    }

    /// Merge list/task specs by UUID with `INSERT … ON CONFLICT DO UPDATE`.
    /// Two passes so children can reference parents created in the same
    /// payload regardless of order.
    fn realize(
        &self,
        lists: &[ListSpec],
        tasks: &[TaskSpec],
    ) -> Result<TasksImportReport, TasksError> {
        let conn = self.connection();
        let now = now_utc();
        let mut list_ids: HashMap<String, i64> = HashMap::new();
        for list in lists {
            if list.title.trim().is_empty() {
                return Err(TasksError::Invalid(
                    "list title must not be empty".to_owned(),
                ));
            }
            conn.execute(
                "INSERT INTO task_lists (uuid, title, position, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT (uuid) DO UPDATE SET
                   title = excluded.title, position = excluded.position,
                   updated_at = excluded.updated_at, deleted_at = NULL",
                params![list.uuid, list.title, list.position, now],
            )?;
            let id: i64 = conn.query_row(
                "SELECT id FROM task_lists WHERE uuid = ?1",
                params![list.uuid],
                |row| row.get(0),
            )?;
            list_ids.insert(list.uuid.clone(), id);
        }
        let mut task_ids: HashMap<String, i64> = HashMap::new();
        let mut link_count = 0usize;
        for task in tasks {
            if task.title.trim().is_empty() {
                return Err(TasksError::Invalid(
                    "task title must not be empty".to_owned(),
                ));
            }
            let list_id = task
                .list_uuid
                .as_ref()
                .and_then(|uuid| list_ids.get(uuid).copied());
            conn.execute(
                "INSERT INTO tasks
                 (uuid, list_id, parent_id, title, notes, due_at, priority,
                  position, completed_at, created_at, updated_at)
                 VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
                 ON CONFLICT (uuid) DO UPDATE SET
                   list_id = excluded.list_id, parent_id = NULL,
                   title = excluded.title, notes = excluded.notes,
                   due_at = excluded.due_at, priority = excluded.priority,
                   position = excluded.position,
                   completed_at = excluded.completed_at,
                   updated_at = excluded.updated_at, deleted_at = NULL",
                params![
                    task.uuid,
                    list_id,
                    task.title,
                    task.notes,
                    task.due_at,
                    task.priority,
                    task.position,
                    task.completed_at,
                    now
                ],
            )?;
            let id: i64 = conn.query_row(
                "SELECT id FROM tasks WHERE uuid = ?1",
                params![task.uuid],
                |row| row.get(0),
            )?;
            task_ids.insert(task.uuid.clone(), id);
            conn.execute("DELETE FROM task_links WHERE task_id = ?1", params![id])?;
            for link in &task.links {
                conn.execute(
                    "INSERT INTO task_links (task_id, url, title, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![id, link.url, link.title, now],
                )?;
                link_count += 1;
            }
        }
        for task in tasks {
            let Some(parent_uuid) = task.parent_uuid.as_ref() else {
                continue;
            };
            let (Some(&id), Some(&parent_id)) =
                (task_ids.get(&task.uuid), task_ids.get(parent_uuid))
            else {
                continue;
            };
            if id == parent_id {
                continue;
            }
            conn.execute(
                "UPDATE tasks SET parent_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![parent_id, now_utc(), id],
            )?;
        }
        Ok(TasksImportReport {
            lists: lists.len(),
            tasks: tasks.len(),
            links: link_count,
        })
    }
}

/// Internal spec shared by the JSON and Markdown importers.
struct ListSpec {
    uuid: String,
    title: String,
    position: i64,
}

/// Internal spec shared by the JSON and Markdown importers.
struct TaskSpec {
    uuid: String,
    list_uuid: Option<String>,
    parent_uuid: Option<String>,
    title: String,
    notes: String,
    due_at: Option<i64>,
    priority: i64,
    position: i64,
    completed_at: Option<i64>,
    links: Vec<TaskLinkExport>,
}

fn check_version(version: u32) -> Result<(), TasksError> {
    if version != astra_store::SCHEMA_VERSION {
        return Err(TasksError::VersionMismatch(
            version,
            astra_store::SCHEMA_VERSION,
        ));
    }
    Ok(())
}

fn specs_from_bundle(bundle: &TasksBundle) -> (Vec<ListSpec>, Vec<TaskSpec>) {
    let lists = bundle
        .lists
        .iter()
        .map(|list| ListSpec {
            uuid: list.uuid.clone(),
            title: list.title.clone(),
            position: list.position,
        })
        .collect();
    let tasks = bundle
        .tasks
        .iter()
        .map(|task| TaskSpec {
            uuid: task.uuid.clone(),
            list_uuid: task.list_uuid.clone(),
            parent_uuid: task.parent_uuid.clone(),
            title: task.title.clone(),
            notes: task.notes.clone(),
            due_at: task.due_at,
            priority: task.priority,
            position: task.position,
            completed_at: task.completed_at,
            links: task.links.clone(),
        })
        .collect();
    (lists, tasks)
}

fn one_line(title: &str) -> String {
    title.replace('\n', " ")
}

fn opt_num(value: Option<i64>) -> String {
    value.map_or_else(|| "-".to_owned(), |v| v.to_string())
}

fn write_task_markdown(out: &mut String, all: &[TaskExport], task: &TaskExport, depth: usize) {
    let pad = "  ".repeat(depth);
    let mark = if task.completed_at.is_some() {
        "x"
    } else {
        " "
    };
    let list = task.list_uuid.as_deref().unwrap_or("-");
    let parent = task.parent_uuid.as_deref().unwrap_or("-");
    out.push_str(&format!(
        "{pad}- [{mark}] {} <!-- astra:task uuid=\"{}\" list=\"{list}\" parent=\"{parent}\" due=\"{}\" priority=\"{}\" pos=\"{}\" completed=\"{}\" -->\n",
        one_line(&task.title),
        task.uuid,
        opt_num(task.due_at),
        task.priority,
        task.position,
        opt_num(task.completed_at),
    ));
    for line in task.notes.lines() {
        let escaped = escape_note_line(line);
        out.push_str(&format!("{pad}  {escaped}\n"));
    }
    for link in &task.links {
        out.push_str(&format!(
            "{pad}  Link: [{}]({})\n",
            one_line(&link.title),
            link.url
        ));
    }
    let mut kids: Vec<&TaskExport> = all
        .iter()
        .filter(|t| t.parent_uuid.as_deref() == Some(task.uuid.as_str()))
        .collect();
    kids.sort_by_key(|t| (t.position, t.uuid.clone()));
    for kid in kids {
        write_task_markdown(out, all, kid, depth + 1);
    }
}

/// Notes lines that would parse back as tasks or links are backslash-escaped
/// on export and unescaped on import.
fn escape_note_line(line: &str) -> String {
    let trimmed = line.trim_start();
    if trimmed.starts_with("- [ ]") || trimmed.starts_with("- [x]") || trimmed.starts_with("Link: ")
    {
        format!("\\{line}")
    } else {
        line.to_owned()
    }
}

fn unescape_note_line(line: &str) -> String {
    if let Some(rest) = line.strip_prefix('\\') {
        if rest.starts_with("- [ ]") || rest.starts_with("- [x]") || rest.starts_with("Link: ") {
            return rest.to_owned();
        }
    }
    line.to_owned()
}

/// `Some(version)` when a `# … (schema N)` header names one, else `None`
/// (hand-written Markdown without a header is assumed current).
fn header_schema_version(line: &str) -> Option<u32> {
    let start = line.find("(schema ")? + "(schema ".len();
    let end = line[start..].find(')')?;
    line[start..start + end].trim().parse::<u32>().ok()
}

/// Parse `key="value"` pairs out of an `astra:…` comment body.
fn parse_meta(body: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for token in body.split_whitespace().skip(1) {
        let Some((key, quoted)) = token.split_once('=') else {
            continue;
        };
        if quoted.len() >= 2 && quoted.starts_with('"') && quoted.ends_with('"') {
            out.insert(key.to_owned(), quoted[1..quoted.len() - 1].to_owned());
        }
    }
    out
}

fn opt_uuid(raw: Option<&String>) -> Option<String> {
    raw.and_then(|v| {
        if v == "-" || v.is_empty() {
            None
        } else {
            Some(v.clone())
        }
    })
}

fn opt_num_parse(raw: Option<&String>) -> Result<Option<i64>, TasksError> {
    match raw.map(String::as_str) {
        None | Some("-") | Some("") => Ok(None),
        Some(text) => text
            .parse::<i64>()
            .map(Some)
            .map_err(|_| TasksError::Invalid(format!("bad number in export: {text}"))),
    }
}

fn parse_comment(line: &str) -> Option<String> {
    let start = line.find("<!--")? + "<!--".len();
    let end = line[start..].find("-->")?;
    Some(line[start..start + end].trim().to_owned())
}

/// Comment-only lines (the `astra:list` markers the exporter writes) must
/// not be confused with task lines, which carry their own trailing
/// `astra:task` comment.
fn trimmed_starts_with_comment(line: &str) -> bool {
    line.trim_start().starts_with("<!--")
}

/// Parse Markdown in [`Tasks::export_markdown`] shape back into specs.
/// Unknown list/parent references stay symbolic; [`Tasks::realize`]
/// resolves them (unknown → inbox).
fn parse_markdown(markdown: &str) -> Result<(Vec<ListSpec>, Vec<TaskSpec>), TasksError> {
    let mut lists: Vec<ListSpec> = Vec::new();
    let mut list_index: HashMap<String, usize> = HashMap::new();
    let mut tasks: Vec<TaskSpec> = Vec::new();
    // Uuids for sections seen without a metadata comment (hand-written Markdown).
    let mut section_uuid: HashMap<String, String> = HashMap::new();
    let mut current_section: Option<String> = None;
    let mut last_task: Option<(usize, usize)> = None;

    for raw_line in markdown.lines() {
        let line = raw_line.trim_end();
        if line.starts_with("# ") {
            if let Some(version) = header_schema_version(line) {
                check_version(version)?;
            }
            continue;
        }
        if let Some(heading) = line.strip_prefix("## ") {
            let title = heading.trim().to_owned();
            current_section = Some(title.clone());
            last_task = None;
            section_uuid.entry(title.clone()).or_insert_with(|| {
                // The inbox is the absence of a list, not a list: pre-seed
                // the `-` sentinel so tasks under `## Inbox` stay unlisted
                // even before the section's metadata comment is seen.
                if title == "Inbox" {
                    "-".to_owned()
                } else {
                    astra_store::new_uuid()
                }
            });
            continue;
        }
        if trimmed_starts_with_comment(line) {
            let body = parse_comment(line).unwrap_or_default();
            if !body.starts_with("astra:list") {
                continue;
            }
            let meta = parse_meta(&body);
            if let Some(section) = current_section.clone() {
                // `uuid="-"` marks the inbox section: no list row exists for
                // it, so register nothing — unlisted tasks round-trip as
                // unlisted instead of spawning a phantom "Inbox" list.
                let uuid = meta
                    .get("uuid")
                    .cloned()
                    .unwrap_or_else(astra_store::new_uuid);
                if uuid == "-" {
                    section_uuid.insert(section, "-".to_owned());
                    continue;
                }
                let position = meta
                    .get("position")
                    .and_then(|p| p.parse::<i64>().ok())
                    .unwrap_or(0);
                let title = if section == "Inbox" {
                    "Inbox".to_owned()
                } else {
                    section.clone()
                };
                section_uuid.insert(section, uuid.clone());
                if let Some(&i) = list_index.get(&uuid) {
                    lists[i].position = position;
                } else {
                    list_index.insert(uuid.clone(), lists.len());
                    lists.push(ListSpec {
                        uuid,
                        title,
                        position,
                    });
                }
            }
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let trimmed = line.trim_start();
        if let Some(task) = parse_task_line(trimmed) {
            let section = current_section
                .clone()
                .unwrap_or_else(|| "Inbox".to_owned());
            // Explicit per-task metadata wins; otherwise the task belongs to
            // its section's list (hand-written Markdown), or to the inbox
            // when the section has no list (the `-` sentinel).
            let mut list_uuid = task.list_uuid.clone();
            if list_uuid.is_none() {
                if let Some(section_id) = section_uuid.get(&section).cloned() {
                    if section_id != "-" {
                        list_uuid = Some(section_id);
                    }
                }
            }
            if let Some(uuid) = list_uuid.clone() {
                if !list_index.contains_key(&uuid) {
                    section_uuid.insert(section.clone(), uuid.clone());
                    list_index.insert(uuid.clone(), lists.len());
                    lists.push(ListSpec {
                        uuid,
                        title: section.clone(),
                        position: 0,
                    });
                }
            }
            tasks.push(TaskSpec {
                uuid: task.uuid,
                list_uuid,
                parent_uuid: task.parent_uuid,
                title: task.title,
                notes: String::new(),
                due_at: task.due_at,
                priority: task.priority,
                position: task.position,
                completed_at: task.completed_at,
                links: Vec::new(),
            });
            last_task = Some((indent, tasks.len() - 1));
            continue;
        }
        if let Some((task_indent, idx)) = last_task {
            let stripped = strip_indent(line, task_indent + 2);
            if let Some(content) = stripped {
                if let Some(rest) = content.strip_prefix("Link: ") {
                    if let Some((url, title)) = parse_link(rest) {
                        tasks[idx].links.push(TaskLinkExport { url, title });
                    } else {
                        let note = unescape_note_line(&content);
                        push_note(&mut tasks[idx].notes, &note);
                    }
                } else {
                    let note = unescape_note_line(&content);
                    push_note(&mut tasks[idx].notes, &note);
                }
            }
        }
    }
    Ok((lists, tasks))
}

struct ParsedTaskLine {
    uuid: String,
    list_uuid: Option<String>,
    parent_uuid: Option<String>,
    title: String,
    due_at: Option<i64>,
    priority: i64,
    position: i64,
    completed_at: Option<i64>,
}

fn parse_task_line(trimmed: &str) -> Option<ParsedTaskLine> {
    let checked = trimmed
        .strip_prefix("- [x] ")
        .or_else(|| trimmed.strip_prefix("- [X] "))
        .is_some();
    let rest = trimmed
        .strip_prefix("- [ ] ")
        .or_else(|| trimmed.strip_prefix("- [x] "))
        .or_else(|| trimmed.strip_prefix("- [X] "))?;
    let (title, comment) = match rest.find("<!--") {
        Some(i) => (rest[..i].trim_end().to_owned(), rest[i..].to_owned()),
        None => (rest.to_owned(), String::new()),
    };
    if !comment.is_empty() && !comment.contains("astra:task") {
        return None;
    }
    let parsed = parse_meta(&parse_comment(&comment).unwrap_or_default());
    // Lenient on malformed numbers (hand-written Markdown): fall back to
    // unset rather than dropping the task.
    let due_at = opt_num_parse(parsed.get("due")).unwrap_or(None);
    let completed_at = if checked {
        match opt_num_parse(parsed.get("completed")).unwrap_or(None) {
            some @ Some(_) => some,
            None => Some(now_utc()),
        }
    } else {
        None
    };
    Some(ParsedTaskLine {
        uuid: opt_uuid(parsed.get("uuid")).unwrap_or_else(astra_store::new_uuid),
        list_uuid: opt_uuid(parsed.get("list")),
        parent_uuid: opt_uuid(parsed.get("parent")),
        title,
        due_at,
        priority: parsed
            .get("priority")
            .and_then(|p| p.parse::<i64>().ok())
            .unwrap_or(0),
        position: parsed
            .get("pos")
            .and_then(|p| p.parse::<i64>().ok())
            .unwrap_or(0),
        completed_at,
    })
}

fn parse_link(text: &str) -> Option<(String, String)> {
    let text = text.trim();
    let title = text.strip_prefix('[')?;
    let (title, rest) = title.split_once("](")?;
    let url = rest.strip_suffix(')')?;
    Some((url.to_owned(), title.to_owned()))
}

/// Remove `width` leading spaces; `None` when the line is less indented
/// (belongs to an outer level) or blank.
fn strip_indent(line: &str, width: usize) -> Option<String> {
    if line.trim().is_empty() {
        return None;
    }
    let indent = line.len() - line.trim_start().len();
    if indent < width {
        return None;
    }
    Some(line[width..].to_owned())
}

fn push_note(notes: &mut String, line: &str) {
    if !notes.is_empty() {
        notes.push('\n');
    }
    notes.push_str(line);
}

fn now_utc() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{NewTask, Priority};
    use tempfile::TempDir;

    fn open() -> (TempDir, Tasks) {
        let dir = TempDir::new().expect("tempdir");
        let tasks = Tasks::open(dir.path().join("tasks.db")).expect("open");
        (dir, tasks)
    }

    fn seed() -> (TempDir, Tasks) {
        let (dir, tasks) = open();
        let work = tasks.create_list("Work", 2).unwrap();
        let home = tasks.create_list("Home", 0).unwrap();
        let parent = tasks
            .create_task(NewTask {
                list_id: Some(work.id),
                title: "Plan trip".to_owned(),
                notes: "ask about Friday\n- [ ] pack list".to_owned(),
                due_at: Some(1_700_000_000),
                priority: Priority::High,
                parent_id: None,
                position: 3,
            })
            .unwrap();
        let child = tasks
            .create_task(NewTask {
                list_id: Some(work.id),
                title: "Book flights".to_owned(),
                parent_id: Some(parent.id),
                position: 1,
                ..Default::default()
            })
            .unwrap();
        tasks
            .add_link(child.id, "https://example.com/flights", "Flights")
            .unwrap();
        let done = tasks
            .create_task(NewTask {
                list_id: Some(home.id),
                title: "Buy milk".to_owned(),
                priority: Priority::Low,
                position: 0,
                ..Default::default()
            })
            .unwrap();
        tasks.complete_task(done.id).unwrap();
        tasks
            .create_task(NewTask {
                title: "Link: inbox loose end".to_owned(),
                ..Default::default()
            })
            .unwrap();
        (dir, tasks)
    }

    /// Semantic task identity for cross-database comparison: uuid, list
    /// title, parent uuid, title, notes, due, priority, position,
    /// completion, links.
    type CanonicalTask = (
        String,
        Option<String>,
        String,
        String,
        String,
        Option<i64>,
        i64,
        i64,
        Option<i64>,
        Vec<(String, String)>,
    );

    fn canonical(tasks: &Tasks) -> Vec<CanonicalTask> {
        let list_titles: HashMap<i64, String> = tasks
            .lists()
            .unwrap()
            .into_iter()
            .map(|l| (l.id, l.title))
            .collect();
        let uuid_of: HashMap<i64, String> = tasks
            .all_tasks()
            .unwrap()
            .iter()
            .map(|t| (t.id, t.uuid.clone()))
            .collect();
        let mut rows: Vec<_> = tasks
            .all_tasks()
            .unwrap()
            .into_iter()
            .map(|t| {
                let links: Vec<(String, String)> = tasks
                    .links_for(t.id)
                    .unwrap()
                    .into_iter()
                    .map(|l| (l.url, l.title))
                    .collect();
                (
                    t.uuid,
                    t.list_id.and_then(|id| list_titles.get(&id).cloned()),
                    t.parent_id
                        .and_then(|id| uuid_of.get(&id).cloned())
                        .unwrap_or_default(),
                    t.title,
                    t.notes,
                    t.due_at,
                    t.priority.as_stored(),
                    t.position,
                    t.completed_at,
                    links,
                )
            })
            .collect();
        rows.sort();
        rows
    }

    #[test]
    fn json_round_trip_preserves_everything() {
        let (_dir, tasks) = seed();
        let json = tasks.export_json().unwrap();
        let bundle: TasksBundle = serde_json::from_str(&json).unwrap();
        assert_eq!(bundle.schema_version, astra_store::SCHEMA_VERSION);
        assert_eq!(bundle.lists.len(), 2);
        // Completed tasks are exported too.
        assert_eq!(bundle.tasks.len(), 4);

        let (_dir2, fresh) = open();
        let report = fresh.import_json(&json).unwrap();
        assert_eq!(
            report,
            TasksImportReport {
                lists: 2,
                tasks: 4,
                links: 1
            }
        );
        assert_eq!(fresh.export_bundle().unwrap(), bundle);

        // Re-importing converges instead of duplicating.
        let again = fresh.import_json(&json).unwrap();
        assert_eq!(again.tasks, 4);
        assert_eq!(fresh.export_bundle().unwrap(), bundle);
    }

    #[test]
    fn markdown_round_trip_preserves_hierarchy_and_fields() {
        let (_dir, tasks) = seed();
        let markdown = tasks.export_markdown().unwrap();
        assert!(markdown.contains("- [ ]"), "checklist markers: {markdown}");
        assert!(markdown.contains("- [x]"), "completed marker: {markdown}");
        assert!(
            markdown.contains("astra:task"),
            "metadata comments: {markdown}"
        );

        let (_dir2, fresh) = open();
        let report = fresh.import_markdown(&markdown).unwrap();
        assert_eq!(report.tasks, 4);
        assert_eq!(report.links, 1);
        // Same semantic content through the Markdown path.
        assert_eq!(canonical(&fresh), canonical(&tasks));
        // Markdown re-exports deterministically.
        assert_eq!(fresh.export_markdown().unwrap(), markdown);
    }

    #[test]
    fn old_versions_fail_loudly() {
        let (_dir, tasks) = seed();
        let mut bundle = tasks.export_bundle().unwrap();
        bundle.schema_version = astra_store::SCHEMA_VERSION - 1;
        assert!(matches!(
            tasks.import_bundle(&bundle),
            Err(TasksError::VersionMismatch(_, _))
        ));
        let bad = serde_json::json!({
            "schema_version": astra_store::SCHEMA_VERSION + 99,
            "lists": [],
            "tasks": [],
        })
        .to_string();
        assert!(matches!(
            tasks.import_json(&bad),
            Err(TasksError::VersionMismatch(_, _))
        ));
        assert!(matches!(
            tasks.import_json("{not json"),
            Err(TasksError::Json(_))
        ));
        assert!(matches!(
            tasks.import_markdown("# Astra tasks export (schema 999)\n"),
            Err(TasksError::VersionMismatch(999, _))
        ));
    }
}
