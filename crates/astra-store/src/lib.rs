/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! `astra-store`: SQLite persistence for `astra-core` (P2-T04).
//!
//! Bundled SQLite via `rusqlite`, schema history via `rusqlite_migration`
//! (one migration per change, tracked in `user_version`), WAL mode with
//! foreign keys on. Conventions across tables: integer primary keys plus
//! stable UUIDs for sync, `created_at`/`updated_at` in UTC seconds,
//! `deleted_at` soft-delete tombstones on synced tables.

use rusqlite::{params, Connection, Row};
use rusqlite_migration::{Migrations, M};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

/// Current schema version (number of migrations in [`MIGRATIONS`]).
pub const SCHEMA_VERSION: u32 = 4;

/// v1: P2-T01 skeleton tables. Preserved verbatim so databases created by
/// the skeleton upgrade cleanly through v2+.
const MIGRATION_V1: &str = "
CREATE TABLE settings_kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE history (
    id         INTEGER PRIMARY KEY,
    url        TEXT NOT NULL,
    title      TEXT NOT NULL,
    visited_at INTEGER NOT NULL
);
CREATE INDEX idx_history_visited_at ON history (visited_at DESC);
CREATE TABLE bookmarks (
    id         INTEGER PRIMARY KEY,
    url        TEXT NOT NULL UNIQUE,
    title      TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
";

/// v2: core organisation schema (profiles, spaces, folders, tabs_org),
/// settings/keymap tables, history v2 (with UUIDs + space link, data
/// migrated from v1), sessions, favicons.
const MIGRATION_V2: &str = "
CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
INSERT INTO settings (key, value, updated_at)
    SELECT key, value, 0 FROM settings_kv;
DROP TABLE settings_kv;

CREATE TABLE keymap (
    action     TEXT PRIMARY KEY,
    binding    TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE profiles (
    id         INTEGER PRIMARY KEY,
    uuid       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);

CREATE TABLE spaces (
    id            INTEGER PRIMARY KEY,
    uuid          TEXT NOT NULL UNIQUE,
    profile_id    INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    position      INTEGER NOT NULL DEFAULT 0,
    container_ref TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    deleted_at    INTEGER
);
CREATE INDEX idx_spaces_profile ON spaces (profile_id);

CREATE TABLE folders (
    id         INTEGER PRIMARY KEY,
    uuid       TEXT NOT NULL UNIQUE,
    space_id   INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    parent_id  INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);
CREATE INDEX idx_folders_space ON folders (space_id);

CREATE TABLE tabs_org (
    id           INTEGER PRIMARY KEY,
    uuid         TEXT NOT NULL UNIQUE,
    space_id     INTEGER REFERENCES spaces(id) ON DELETE SET NULL,
    folder_id    INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    astra_tab_id TEXT NOT NULL UNIQUE,
    url          TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    pinned       INTEGER NOT NULL DEFAULT 0,
    position     INTEGER NOT NULL DEFAULT 0,
    favicon_ref  TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER
);
CREATE INDEX idx_tabs_org_space ON tabs_org (space_id);
CREATE INDEX idx_tabs_org_folder ON tabs_org (folder_id);

ALTER TABLE history RENAME TO history_v1;
CREATE TABLE history (
    id         INTEGER PRIMARY KEY,
    uuid       TEXT NOT NULL UNIQUE,
    url        TEXT NOT NULL,
    title      TEXT NOT NULL,
    visit_time INTEGER NOT NULL,
    space_id   INTEGER REFERENCES spaces(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
);
INSERT INTO history (uuid, url, title, visit_time, created_at)
    SELECT lower(hex(randomblob(16))), url, title, visited_at, visited_at
    FROM history_v1;
DROP TABLE history_v1;
DROP INDEX IF EXISTS idx_history_visited_at;
CREATE INDEX idx_history_visit_time ON history (visit_time DESC);
CREATE INDEX idx_history_url ON history (url);

CREATE TABLE sessions (
    id         INTEGER PRIMARY KEY,
    uuid       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    snapshot   TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE favicons (
    id          INTEGER PRIMARY KEY,
    page_url    TEXT NOT NULL UNIQUE,
    icon_url    TEXT,
    blob        BLOB,
    size_bytes  INTEGER,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
";

/// v3: tasks, notes index, time tracking, blocker lists, extensions meta.
const MIGRATION_V3: &str = "
CREATE TABLE task_lists (
    id         INTEGER PRIMARY KEY,
    uuid       TEXT NOT NULL UNIQUE,
    title      TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);

CREATE TABLE tasks (
    id           INTEGER PRIMARY KEY,
    uuid         TEXT NOT NULL UNIQUE,
    list_id      INTEGER REFERENCES task_lists(id) ON DELETE SET NULL,
    parent_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    notes        TEXT NOT NULL DEFAULT '',
    due_at       INTEGER,
    priority     INTEGER NOT NULL DEFAULT 0,
    position     INTEGER NOT NULL DEFAULT 0,
    completed_at INTEGER,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER
);
CREATE INDEX idx_tasks_list ON tasks (list_id);

CREATE TABLE task_links (
    id         INTEGER PRIMARY KEY,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    url        TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_task_links_task ON task_links (task_id);

CREATE TABLE notes_index (
    id         INTEGER PRIMARY KEY,
    uuid       TEXT NOT NULL UNIQUE,
    path       TEXT NOT NULL UNIQUE,
    hash       TEXT NOT NULL DEFAULT '',
    mtime      INTEGER NOT NULL DEFAULT 0,
    title      TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);

CREATE TABLE time_sessions (
    id             INTEGER PRIMARY KEY,
    uuid           TEXT NOT NULL UNIQUE,
    url            TEXT NOT NULL DEFAULT '',
    host           TEXT NOT NULL DEFAULT '',
    title          TEXT NOT NULL DEFAULT '',
    started_at     INTEGER NOT NULL,
    ended_at       INTEGER,
    duration_secs  INTEGER NOT NULL DEFAULT 0,
    space_id       INTEGER REFERENCES spaces(id) ON DELETE SET NULL,
    created_at     INTEGER NOT NULL,
    deleted_at     INTEGER
);
CREATE INDEX idx_time_sessions_host ON time_sessions (host);

CREATE TABLE focus_rules (
    id         INTEGER PRIMARY KEY,
    uuid       TEXT NOT NULL UNIQUE,
    host       TEXT NOT NULL UNIQUE,
    mode       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);

CREATE TABLE blocker_lists (
    id            INTEGER PRIMARY KEY,
    uuid          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL UNIQUE,
    source_url    TEXT NOT NULL DEFAULT '',
    enabled       INTEGER NOT NULL DEFAULT 1,
    etag          TEXT NOT NULL DEFAULT '',
    rule_count    INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    deleted_at    INTEGER
);

CREATE TABLE blocker_overrides (
    id         INTEGER PRIMARY KEY,
    uuid       TEXT NOT NULL UNIQUE,
    host       TEXT NOT NULL,
    action     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);
CREATE UNIQUE INDEX idx_blocker_overrides_host ON blocker_overrides (host)
    WHERE deleted_at IS NULL;

CREATE TABLE extensions_meta (
    id          INTEGER PRIMARY KEY,
    uuid        TEXT NOT NULL UNIQUE,
    ext_id      TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL DEFAULT '',
    version     TEXT NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    permissions TEXT NOT NULL DEFAULT '[]',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted_at  INTEGER
);
";

/// v4: agent runs/steps, canvas, memory, skills, MCP servers, model
/// providers (no secrets — keys live in the OS keychain), approvals
/// audit, sync state/outbox, schema metadata.
const MIGRATION_V4: &str = "
CREATE TABLE agent_runs (
    id         INTEGER PRIMARY KEY,
    uuid       TEXT NOT NULL UNIQUE,
    goal       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    model      TEXT NOT NULL DEFAULT '',
    space_id   INTEGER REFERENCES spaces(id) ON DELETE SET NULL,
    started_at INTEGER,
    ended_at   INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);

CREATE TABLE agent_steps (
    id         INTEGER PRIMARY KEY,
    uuid       TEXT NOT NULL UNIQUE,
    run_id     INTEGER NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    kind       TEXT NOT NULL DEFAULT '',
    summary    TEXT NOT NULL DEFAULT '',
    detail     TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_agent_steps_run ON agent_steps (run_id, seq);

CREATE TABLE canvas_items (
    id         INTEGER PRIMARY KEY,
    uuid       TEXT NOT NULL UNIQUE,
    run_id     INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
    kind       TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL DEFAULT '',
    position   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);
CREATE INDEX idx_canvas_items_run ON canvas_items (run_id);

CREATE TABLE memory_items (
    id            INTEGER PRIMARY KEY,
    uuid          TEXT NOT NULL UNIQUE,
    scope         TEXT NOT NULL DEFAULT 'global',
    content       TEXT NOT NULL,
    embedding_ref TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    deleted_at    INTEGER
);

CREATE TABLE skills (
    id           INTEGER PRIMARY KEY,
    uuid         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL UNIQUE,
    description  TEXT NOT NULL DEFAULT '',
    content_path TEXT NOT NULL DEFAULT '',
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER
);

CREATE TABLE mcp_servers (
    id         INTEGER PRIMARY KEY,
    uuid       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL UNIQUE,
    command    TEXT NOT NULL DEFAULT '',
    args       TEXT NOT NULL DEFAULT '[]',
    env_json   TEXT NOT NULL DEFAULT '{}',
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);

CREATE TABLE model_providers (
    id         INTEGER PRIMARY KEY,
    uuid       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL UNIQUE,
    kind       TEXT NOT NULL,
    base_url   TEXT NOT NULL DEFAULT '',
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);

CREATE TABLE approvals_audit (
    id         INTEGER PRIMARY KEY,
    uuid       TEXT NOT NULL UNIQUE,
    run_id     INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
    action     TEXT NOT NULL,
    subject    TEXT NOT NULL DEFAULT '',
    decision   TEXT NOT NULL,
    decided_by TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_approvals_run ON approvals_audit (run_id);

CREATE TABLE sync_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE sync_outbox (
    id          INTEGER PRIMARY KEY,
    uuid        TEXT NOT NULL UNIQUE,
    entity      TEXT NOT NULL,
    entity_uuid TEXT NOT NULL,
    op          TEXT NOT NULL,
    payload     TEXT NOT NULL DEFAULT '{}',
    created_at  INTEGER NOT NULL,
    claimed_at  INTEGER
);
CREATE INDEX idx_sync_outbox_unclaimed ON sync_outbox (id)
    WHERE claimed_at IS NULL;

CREATE TABLE schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT INTO schema_meta (key, value) VALUES ('schema_version', '4');
";

const MIGRATIONS_SLICE: &[M<'_>] = &[
    M::up(MIGRATION_V1),
    M::up(MIGRATION_V2),
    M::up(MIGRATION_V3),
    M::up(MIGRATION_V4),
];
const MIGRATIONS: Migrations<'_> = Migrations::from_slice(MIGRATIONS_SLICE);

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("migration error: {0}")]
    Migration(#[from] rusqlite_migration::Error),
    #[error("store poisoned: lock held by panicked thread")]
    Poisoned,
    #[error("database file is corrupt: {0}")]
    Corrupt(String),
    #[error("backup/export failed: {0}")]
    Backup(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

fn lock_err() -> StoreError {
    StoreError::Poisoned
}

/// Current UTC time in whole seconds.
pub fn now_utc() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// New stable UUID for syncable rows.
pub fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn apply_pragmas(conn: &Connection, wal: bool) -> Result<(), StoreError> {
    // Foreign keys are per-connection; the store holds a single connection
    // behind a mutex so setting once here covers every operation.
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "busy_timeout", 5000_i64)?;
    if wal {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
    }
    Ok(())
}

/// `PRAGMA integrity_check` must return exactly one row containing `ok`.
fn integrity_ok(conn: &Connection) -> bool {
    let rows: Result<Vec<String>, _> =
        conn.prepare("PRAGMA integrity_check").and_then(|mut stmt| {
            stmt.query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()
        });
    matches!(rows, Ok(rows) if rows.len() == 1 && rows[0] == "ok")
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/// One stored history visit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryRow {
    pub id: i64,
    pub uuid: String,
    pub url: String,
    pub title: String,
    pub visit_time: i64,
    pub space_id: Option<i64>,
}

/// One stored bookmark.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookmarkRow {
    pub id: i64,
    pub url: String,
    pub title: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfileRow {
    pub id: i64,
    pub uuid: String,
    pub name: String,
    pub is_default: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpaceRow {
    pub id: i64,
    pub uuid: String,
    pub profile_id: Option<i64>,
    pub name: String,
    pub position: i64,
    pub container_ref: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FolderRow {
    pub id: i64,
    pub uuid: String,
    pub space_id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub position: i64,
}

/// Tab organisation owned by `astra-core` (the live tab object belongs to
/// the engine host; this row is the stable mapping + display state).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TabOrgRow {
    pub id: i64,
    pub uuid: String,
    pub space_id: Option<i64>,
    pub folder_id: Option<i64>,
    pub astra_tab_id: String,
    pub url: String,
    pub title: String,
    pub pinned: bool,
    pub position: i64,
    pub favicon_ref: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionRow {
    pub id: i64,
    pub uuid: String,
    pub name: String,
    pub snapshot: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskListRow {
    pub id: i64,
    pub uuid: String,
    pub title: String,
    pub position: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskRow {
    pub id: i64,
    pub uuid: String,
    pub list_id: Option<i64>,
    pub parent_id: Option<i64>,
    pub title: String,
    pub notes: String,
    pub due_at: Option<i64>,
    pub priority: i64,
    pub position: i64,
    pub completed_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoteRow {
    pub id: i64,
    pub uuid: String,
    pub path: String,
    pub hash: String,
    pub mtime: i64,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimeSessionRow {
    pub id: i64,
    pub uuid: String,
    pub url: String,
    pub host: String,
    pub title: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub duration_secs: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FocusRuleRow {
    pub id: i64,
    pub uuid: String,
    pub host: String,
    pub mode: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockerListRow {
    pub id: i64,
    pub uuid: String,
    pub name: String,
    pub source_url: String,
    pub enabled: bool,
    pub etag: String,
    pub rule_count: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtensionRow {
    pub id: i64,
    pub uuid: String,
    pub ext_id: String,
    pub name: String,
    pub version: String,
    pub enabled: bool,
    pub permissions: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentRunRow {
    pub id: i64,
    pub uuid: String,
    pub goal: String,
    pub status: String,
    pub model: String,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentStepRow {
    pub id: i64,
    pub uuid: String,
    pub run_id: i64,
    pub seq: i64,
    pub kind: String,
    pub summary: String,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanvasItemRow {
    pub id: i64,
    pub uuid: String,
    pub run_id: Option<i64>,
    pub kind: String,
    pub title: String,
    pub content: String,
    pub position: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemoryItemRow {
    pub id: i64,
    pub uuid: String,
    pub scope: String,
    pub content: String,
    pub embedding_ref: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillRow {
    pub id: i64,
    pub uuid: String,
    pub name: String,
    pub description: String,
    pub content_path: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpServerRow {
    pub id: i64,
    pub uuid: String,
    pub name: String,
    pub command: String,
    pub args: String,
    pub env_json: String,
    pub enabled: bool,
}

/// Model provider metadata. Secrets (API keys) are never stored here;
/// they live in the OS keychain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelProviderRow {
    pub id: i64,
    pub uuid: String,
    pub name: String,
    pub kind: String,
    pub base_url: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovalRow {
    pub id: i64,
    pub uuid: String,
    pub run_id: Option<i64>,
    pub action: String,
    pub subject: String,
    pub decision: String,
    pub decided_by: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutboxRow {
    pub id: i64,
    pub uuid: String,
    pub entity: String,
    pub entity_uuid: String,
    pub op: String,
    pub payload: String,
    pub created_at: i64,
    pub claimed_at: Option<i64>,
}

// Row decoders (positional; keep column order in sync with SELECT lists).

fn decode_profile(row: &Row) -> rusqlite::Result<ProfileRow> {
    Ok(ProfileRow {
        id: row.get(0)?,
        uuid: row.get(1)?,
        name: row.get(2)?,
        is_default: row.get::<_, i64>(3)? != 0,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn decode_space(row: &Row) -> rusqlite::Result<SpaceRow> {
    Ok(SpaceRow {
        id: row.get(0)?,
        uuid: row.get(1)?,
        profile_id: row.get(2)?,
        name: row.get(3)?,
        position: row.get(4)?,
        container_ref: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn decode_folder(row: &Row) -> rusqlite::Result<FolderRow> {
    Ok(FolderRow {
        id: row.get(0)?,
        uuid: row.get(1)?,
        space_id: row.get(2)?,
        parent_id: row.get(3)?,
        name: row.get(4)?,
        position: row.get(5)?,
    })
}

fn decode_tab(row: &Row) -> rusqlite::Result<TabOrgRow> {
    Ok(TabOrgRow {
        id: row.get(0)?,
        uuid: row.get(1)?,
        space_id: row.get(2)?,
        folder_id: row.get(3)?,
        astra_tab_id: row.get(4)?,
        url: row.get(5)?,
        title: row.get(6)?,
        pinned: row.get::<_, i64>(7)? != 0,
        position: row.get(8)?,
        favicon_ref: row.get(9)?,
    })
}

fn decode_history(row: &Row) -> rusqlite::Result<HistoryRow> {
    Ok(HistoryRow {
        id: row.get(0)?,
        uuid: row.get(1)?,
        url: row.get(2)?,
        title: row.get(3)?,
        visit_time: row.get(4)?,
        space_id: row.get(5)?,
    })
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/// SQLite-backed store. `Send`; share across threads via reference.
pub struct Store {
    conn: Mutex<Connection>,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store").finish_non_exhaustive()
    }
}

impl Store {
    fn new(conn: Connection) -> Result<Self, StoreError> {
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn configure_file(conn: &Connection) -> Result<(), StoreError> {
        // PRAGMA setup itself fails on garbage files (e.g. `NotADatabase`
        // from `journal_mode`); map that to `Corrupt` when the file also
        // fails integrity_check, so callers get one clean error kind.
        if let Err(e) = apply_pragmas(conn, true) {
            if !integrity_ok(conn) {
                return Err(StoreError::Corrupt(
                    "not a valid SQLite database".to_owned(),
                ));
            }
            return Err(e);
        }
        if !integrity_ok(conn) {
            return Err(StoreError::Corrupt(
                "PRAGMA integrity_check failed (file is not a database or is damaged)".to_owned(),
            ));
        }
        Ok(())
    }

    /// Open (or create) a file-backed database in WAL mode with FKs on.
    /// Returns [`StoreError::Corrupt`] for garbage/damaged files instead
    /// of panicking or surfacing a bare SQLite error.
    #[tracing::instrument(skip(path))]
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let conn = Connection::open(path.as_ref())?;
        Self::configure_file(&conn).map_err(|e| match e {
            StoreError::Corrupt(_) => StoreError::Corrupt(format!(
                "{}: not a valid SQLite database",
                path.as_ref().display()
            )),
            other => other,
        })?;
        Self::new(conn)
    }

    /// Open a file-backed database, recovering from corruption: if the
    /// file is not a valid database it is moved aside to
    /// `<name>.corrupt-<unix-ts>.bak` and a fresh database is created.
    /// Returns the store plus the backup path when recovery happened.
    #[tracing::instrument(skip(path))]
    pub fn open_recovering(path: impl AsRef<Path>) -> Result<(Self, Option<PathBuf>), StoreError> {
        let path = path.as_ref().to_path_buf();
        match Self::open(&path) {
            Ok(store) => Ok((store, None)),
            Err(StoreError::Corrupt(_)) => {
                let backup = path.with_extension(format!("corrupt-{}.bak", now_utc().max(0)));
                std::fs::rename(&path, &backup)?;
                let store = Self::open(&path)?;
                store.migrate()?;
                Ok((store, Some(backup)))
            }
            Err(other) => Err(other),
        }
    }

    /// Open a private in-memory database (tests, ephemeral profiles).
    /// WAL is a no-op for in-memory databases, so only FKs/timeouts apply.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        apply_pragmas(&conn, false)?;
        Self::new(conn)
    }

    /// Apply pending migrations atomically; returns the schema version.
    /// Safe to call on every startup; already-current databases are a no-op.
    #[tracing::instrument(skip(self))]
    pub fn migrate(&self) -> Result<u32, StoreError> {
        let mut conn = self.conn.lock().map_err(|_| lock_err())?;
        MIGRATIONS.to_latest(&mut conn)?;
        Ok(SCHEMA_VERSION)
    }

    /// Schema version recorded in the database file (`user_version`).
    pub fn user_version(&self) -> Result<u32, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        Ok(conn.pragma_query_value(None, "user_version", |row| row.get(0))?)
    }

    /// Journal mode in effect (expected `wal` for file-backed databases).
    pub fn journal_mode(&self) -> Result<String, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        Ok(conn.pragma_query_value(None, "journal_mode", |row| row.get(0))?)
    }

    // -- backup / export ----------------------------------------------------

    /// Online backup to `dest` via `VACUUM INTO`. The destination must not
    /// exist; an existing file is replaced. Verified by re-opening.
    #[tracing::instrument(skip(self, dest))]
    pub fn backup_to(&self, dest: impl AsRef<Path>) -> Result<(), StoreError> {
        let dest = dest.as_ref();
        if dest.exists() {
            std::fs::remove_file(dest)?;
        }
        {
            let conn = self.conn.lock().map_err(|_| lock_err())?;
            conn.pragma_update(None, "wal_checkpoint", "TRUNCATE")?;
            let dest_str = dest.to_string_lossy().into_owned();
            conn.execute("VACUUM INTO ?1", params![dest_str])?;
        }
        let check = Connection::open(dest)?;
        if !integrity_ok(&check) {
            return Err(StoreError::Backup(format!(
                "backup to {} failed integrity_check",
                dest.display()
            )));
        }
        Ok(())
    }

    /// Export the full database (schema version + every table's rows) as
    /// JSON. Blobs are hex-encoded. Tombstoned rows are included with
    /// their `deleted_at` marker so sync tooling can see them.
    #[tracing::instrument(skip(self))]
    pub fn export_json(&self) -> Result<String, StoreError> {
        use rusqlite::types::Value;
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut tables: Vec<String> = Vec::new();
        {
            let mut stmt = conn.prepare(
                "SELECT name FROM sqlite_master
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                 ORDER BY name",
            )?;
            for name in stmt.query_map([], |row| row.get::<_, String>(0))? {
                tables.push(name?);
            }
        }
        let mut out = serde_json::Map::new();
        out.insert(
            "schema_version".to_owned(),
            serde_json::Value::from(SCHEMA_VERSION),
        );
        let mut dump = serde_json::Map::new();
        for table in &tables {
            let mut stmt = conn.prepare(&format!("SELECT * FROM \"{table}\""))?;
            let count = stmt.column_count();
            let mut names = Vec::with_capacity(count);
            for i in 0..count {
                names.push(stmt.column_name(i)?.to_owned());
            }
            let rows = stmt.query_map([], |row| {
                let mut obj = serde_json::Map::new();
                for (i, name) in names.iter().enumerate() {
                    let v: Value = row.get(i)?;
                    obj.insert(
                        name.clone(),
                        match v {
                            Value::Null => serde_json::Value::Null,
                            Value::Integer(n) => serde_json::Value::from(n),
                            Value::Real(f) => serde_json::json!(f),
                            Value::Text(s) => serde_json::Value::from(s),
                            Value::Blob(b) => serde_json::Value::from(
                                b.iter().map(|x| format!("{x:02x}")).collect::<String>(),
                            ),
                        },
                    );
                }
                Ok(serde_json::Value::Object(obj))
            })?;
            let collected: Vec<serde_json::Value> = rows.collect::<Result<_, _>>()?;
            dump.insert(table.clone(), serde_json::Value::Array(collected));
        }
        out.insert("tables".to_owned(), serde_json::Value::Object(dump));
        Ok(serde_json::Value::Object(out).to_string())
    }

    // -- settings / keymap / meta -------------------------------------------

    #[tracing::instrument(skip(self))]
    pub fn setting_get(&self, key: &str) -> Result<Option<String>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    #[tracing::instrument(skip(self))]
    pub fn setting_set(&self, key: &str, value: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (key) DO UPDATE
             SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now_utc()],
        )?;
        Ok(())
    }

    pub fn keymap_set(&self, action: &str, binding: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            "INSERT INTO keymap (action, binding, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (action) DO UPDATE
             SET binding = excluded.binding, updated_at = excluded.updated_at",
            params![action, binding, now_utc()],
        )?;
        Ok(())
    }

    pub fn keymap_get(&self, action: &str) -> Result<Option<String>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare("SELECT binding FROM keymap WHERE action = ?1")?;
        let mut rows = stmt.query(params![action])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    pub fn keymap_list(&self) -> Result<Vec<(String, String)>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare("SELECT action, binding FROM keymap ORDER BY action")?;
        let collected = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from);
        collected
    }

    /// Schema metadata (e.g. import provenance). Distinct from the
    /// migration-tracked `user_version`.
    pub fn schema_meta_get(&self, key: &str) -> Result<Option<String>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare("SELECT value FROM schema_meta WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    pub fn schema_meta_set(&self, key: &str, value: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            "INSERT INTO schema_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    // -- history / bookmarks (P2-T01 API, now on the v2 schema) --------------

    #[tracing::instrument(skip(self))]
    pub fn history_add(&self, url: &str, title: &str, visit_time: i64) -> Result<i64, StoreError> {
        self.history_add_in_space(url, title, visit_time, None)
    }

    pub fn history_add_in_space(
        &self,
        url: &str,
        title: &str,
        visit_time: i64,
        space_id: Option<i64>,
    ) -> Result<i64, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            "INSERT INTO history (uuid, url, title, visit_time, space_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![new_uuid(), url, title, visit_time, space_id, visit_time],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn history_recent(&self, limit: u32) -> Result<Vec<HistoryRow>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, url, title, visit_time, space_id FROM history
             WHERE deleted_at IS NULL
             ORDER BY visit_time DESC LIMIT ?1",
        )?;
        let collected = stmt
            .query_map(params![limit], decode_history)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from);
        collected
    }

    pub fn history_search(&self, query: &str, limit: u32) -> Result<Vec<HistoryRow>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, url, title, visit_time, space_id FROM history
             WHERE deleted_at IS NULL AND (url LIKE ?1 OR title LIKE ?1)
             ORDER BY visit_time DESC LIMIT ?2",
        )?;
        let like = format!("%{query}%");
        let collected = stmt
            .query_map(params![like, limit], decode_history)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from);
        collected
    }

    pub fn history_delete(&self, id: i64) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            "UPDATE history SET deleted_at = ?1 WHERE id = ?2",
            params![now_utc(), id],
        )?;
        Ok(())
    }

    #[tracing::instrument(skip(self))]
    pub fn bookmark_add(&self, url: &str, title: &str, created_at: i64) -> Result<i64, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            "INSERT INTO bookmarks (url, title, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (url) DO UPDATE SET title = excluded.title",
            params![url, title, created_at],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn bookmark_list(&self) -> Result<Vec<BookmarkRow>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn
            .prepare("SELECT id, url, title, created_at FROM bookmarks ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], |row| {
            Ok(BookmarkRow {
                id: row.get(0)?,
                url: row.get(1)?,
                title: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    // -- profiles / spaces / folders / tabs -----------------------------------

    pub fn profile_create(&self, name: &str, is_default: bool) -> Result<ProfileRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        let uuid = new_uuid();
        if is_default {
            conn.execute("UPDATE profiles SET is_default = 0", [])?;
        }
        conn.execute(
            "INSERT INTO profiles (uuid, name, is_default, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![uuid, name, i64::from(is_default), now],
        )?;
        let id = conn.last_insert_rowid();
        Ok(ProfileRow {
            id,
            uuid,
            name: name.to_owned(),
            is_default,
            created_at: now,
            updated_at: now,
        })
    }

    pub fn profile_list(&self) -> Result<Vec<ProfileRow>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, name, is_default, created_at, updated_at
             FROM profiles WHERE deleted_at IS NULL ORDER BY id",
        )?;
        let collected = stmt
            .query_map([], decode_profile)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from);
        collected
    }

    pub fn space_create(
        &self,
        profile_id: Option<i64>,
        name: &str,
        position: i64,
    ) -> Result<SpaceRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO spaces (uuid, profile_id, name, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![uuid, profile_id, name, position, now],
        )?;
        let id = conn.last_insert_rowid();
        Ok(SpaceRow {
            id,
            uuid,
            profile_id,
            name: name.to_owned(),
            position,
            container_ref: None,
            created_at: now,
            updated_at: now,
        })
    }

    pub fn space_list(&self, profile_id: Option<i64>) -> Result<Vec<SpaceRow>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, profile_id, name, position, container_ref, created_at, updated_at
             FROM spaces
             WHERE deleted_at IS NULL AND ((?1 IS NULL AND profile_id IS NULL) OR profile_id = ?1)
             ORDER BY position, id",
        )?;
        let collected = stmt
            .query_map(params![profile_id], decode_space)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from);
        collected
    }

    pub fn space_rename(&self, id: i64, name: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            "UPDATE spaces SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, now_utc(), id],
        )?;
        Ok(())
    }

    pub fn folder_create(
        &self,
        space_id: i64,
        parent_id: Option<i64>,
        name: &str,
        position: i64,
    ) -> Result<FolderRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO folders (uuid, space_id, parent_id, name, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![uuid, space_id, parent_id, name, position, now],
        )?;
        let id = conn.last_insert_rowid();
        Ok(FolderRow {
            id,
            uuid,
            space_id,
            parent_id,
            name: name.to_owned(),
            position,
        })
    }

    pub fn folder_list(&self, space_id: i64) -> Result<Vec<FolderRow>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, space_id, parent_id, name, position FROM folders
             WHERE space_id = ?1 AND deleted_at IS NULL ORDER BY position, id",
        )?;
        let collected = stmt
            .query_map(params![space_id], decode_folder)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from);
        collected
    }

    #[allow(clippy::too_many_arguments)]
    pub fn tab_place(
        &self,
        space_id: Option<i64>,
        folder_id: Option<i64>,
        astra_tab_id: &str,
        url: &str,
        title: &str,
        pinned: bool,
        position: i64,
    ) -> Result<TabOrgRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        conn.execute(
            "INSERT INTO tabs_org
             (uuid, space_id, folder_id, astra_tab_id, url, title, pinned, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
             ON CONFLICT (astra_tab_id) DO UPDATE SET
               space_id = excluded.space_id, folder_id = excluded.folder_id,
               url = excluded.url, title = excluded.title, pinned = excluded.pinned,
               position = excluded.position, updated_at = excluded.updated_at,
               deleted_at = NULL",
            params![
                new_uuid(),
                space_id,
                folder_id,
                astra_tab_id,
                url,
                title,
                i64::from(pinned),
                position,
                now
            ],
        )?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, space_id, folder_id, astra_tab_id, url, title,
                    pinned, position, favicon_ref
             FROM tabs_org WHERE astra_tab_id = ?1",
        )?;
        stmt.query_row(params![astra_tab_id], decode_tab)
            .map_err(StoreError::from)
    }

    pub fn tab_list(&self, space_id: Option<i64>) -> Result<Vec<TabOrgRow>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, space_id, folder_id, astra_tab_id, url, title,
                    pinned, position, favicon_ref
             FROM tabs_org
             WHERE deleted_at IS NULL AND (?1 IS NULL OR space_id = ?1)
             ORDER BY position, id",
        )?;
        let collected = stmt
            .query_map(params![space_id], decode_tab)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from);
        collected
    }

    pub fn tab_remove(&self, astra_tab_id: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            "UPDATE tabs_org SET deleted_at = ?1 WHERE astra_tab_id = ?2",
            params![now_utc(), astra_tab_id],
        )?;
        Ok(())
    }

    // -- sessions / favicons ----------------------------------------------------

    /// Save a session snapshot under `name`, replacing any previous
    /// snapshot with the same name. Returns the stored row.
    pub fn session_save(&self, name: &str, snapshot: &str) -> Result<SessionRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        conn.execute("DELETE FROM sessions WHERE name = ?1", params![name])?;
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO sessions (uuid, name, snapshot, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![uuid, name, snapshot, now],
        )?;
        Ok(SessionRow {
            id: conn.last_insert_rowid(),
            uuid,
            name: name.to_owned(),
            snapshot: snapshot.to_owned(),
            created_at: now,
            updated_at: now,
        })
    }

    pub fn session_load(&self, name: &str) -> Result<Option<SessionRow>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, name, snapshot, created_at, updated_at FROM sessions
             WHERE name = ?1 ORDER BY updated_at DESC LIMIT 1",
        )?;
        let mut rows = stmt.query(params![name])?;
        match rows.next()? {
            Some(row) => Ok(Some(SessionRow {
                id: row.get(0)?,
                uuid: row.get(1)?,
                name: row.get(2)?,
                snapshot: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })),
            None => Ok(None),
        }
    }

    pub fn favicon_upsert(
        &self,
        page_url: &str,
        icon_url: Option<&str>,
        blob: Option<&[u8]>,
    ) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        let size = blob.map(|b| b.len() as i64);
        conn.execute(
            "INSERT INTO favicons (page_url, icon_url, blob, size_bytes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT (page_url) DO UPDATE SET
               icon_url = excluded.icon_url, blob = excluded.blob,
               size_bytes = excluded.size_bytes, updated_at = excluded.updated_at",
            params![page_url, icon_url, blob, size, now],
        )?;
        Ok(())
    }

    pub fn favicon_get(&self, page_url: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare("SELECT blob FROM favicons WHERE page_url = ?1")?;
        let mut rows = stmt.query(params![page_url])?;
        match rows.next()? {
            Some(row) => Ok(row.get::<_, Option<Vec<u8>>>(0)?),
            None => Ok(None),
        }
    }

    // -- tasks ------------------------------------------------------------------

    pub fn task_list_create(&self, title: &str, position: i64) -> Result<TaskListRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO task_lists (uuid, title, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![uuid, title, position, now],
        )?;
        Ok(TaskListRow {
            id: conn.last_insert_rowid(),
            uuid,
            title: title.to_owned(),
            position,
        })
    }

    pub fn task_create(
        &self,
        list_id: Option<i64>,
        title: &str,
        due_at: Option<i64>,
        priority: i64,
    ) -> Result<TaskRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO tasks
             (uuid, list_id, title, due_at, priority, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![uuid, list_id, title, due_at, priority, now],
        )?;
        Ok(TaskRow {
            id: conn.last_insert_rowid(),
            uuid,
            list_id,
            parent_id: None,
            title: title.to_owned(),
            notes: String::new(),
            due_at,
            priority,
            position: 0,
            completed_at: None,
        })
    }

    pub fn task_complete(&self, id: i64) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            "UPDATE tasks SET completed_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now_utc(), id],
        )?;
        Ok(())
    }

    pub fn task_link(&self, task_id: i64, url: &str, title: &str) -> Result<i64, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            "INSERT INTO task_links (task_id, url, title, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![task_id, url, title, now_utc()],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn task_list_open(&self, list_id: Option<i64>) -> Result<Vec<TaskRow>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, list_id, parent_id, title, notes, due_at,
                    priority, position, completed_at
             FROM tasks
             WHERE deleted_at IS NULL AND completed_at IS NULL
               AND (?1 IS NULL OR list_id = ?1)
             ORDER BY priority DESC, position, id",
        )?;
        let collected = stmt
            .query_map(params![list_id], |row| {
                Ok(TaskRow {
                    id: row.get(0)?,
                    uuid: row.get(1)?,
                    list_id: row.get(2)?,
                    parent_id: row.get(3)?,
                    title: row.get(4)?,
                    notes: row.get(5)?,
                    due_at: row.get(6)?,
                    priority: row.get(7)?,
                    position: row.get(8)?,
                    completed_at: row.get(9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from);
        collected
    }

    // -- notes / time / focus -----------------------------------------------------

    pub fn note_upsert(
        &self,
        path: &str,
        hash: &str,
        mtime: i64,
        title: &str,
    ) -> Result<NoteRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO notes_index (uuid, path, hash, mtime, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT (path) DO UPDATE SET
               hash = excluded.hash, mtime = excluded.mtime,
               title = excluded.title, updated_at = excluded.updated_at,
               deleted_at = NULL",
            params![uuid, path, hash, mtime, title, now],
        )?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, path, hash, mtime, title FROM notes_index WHERE path = ?1",
        )?;
        stmt.query_row(params![path], |row| {
            Ok(NoteRow {
                id: row.get(0)?,
                uuid: row.get(1)?,
                path: row.get(2)?,
                hash: row.get(3)?,
                mtime: row.get(4)?,
                title: row.get(5)?,
            })
        })
        .map_err(StoreError::from)
    }

    pub fn note_list(&self) -> Result<Vec<NoteRow>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, path, hash, mtime, title FROM notes_index
             WHERE deleted_at IS NULL ORDER BY path",
        )?;
        let collected = stmt
            .query_map([], |row| {
                Ok(NoteRow {
                    id: row.get(0)?,
                    uuid: row.get(1)?,
                    path: row.get(2)?,
                    hash: row.get(3)?,
                    mtime: row.get(4)?,
                    title: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from);
        collected
    }

    pub fn time_start(
        &self,
        url: &str,
        host: &str,
        title: &str,
        started_at: i64,
    ) -> Result<TimeSessionRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO time_sessions
             (uuid, url, host, title, started_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![uuid, url, host, title, started_at],
        )?;
        Ok(TimeSessionRow {
            id: conn.last_insert_rowid(),
            uuid,
            url: url.to_owned(),
            host: host.to_owned(),
            title: title.to_owned(),
            started_at,
            ended_at: None,
            duration_secs: 0,
        })
    }

    pub fn time_end(&self, id: i64, ended_at: i64) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            "UPDATE time_sessions
             SET ended_at = ?1,
                 duration_secs = max(0, ?1 - started_at)
             WHERE id = ?2",
            params![ended_at, id],
        )?;
        Ok(())
    }

    pub fn time_for_host(&self, host: &str) -> Result<i64, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let total: Option<i64> = conn.query_row(
            "SELECT COALESCE(SUM(duration_secs), 0) FROM time_sessions
             WHERE host = ?1 AND deleted_at IS NULL",
            params![host],
            |row| row.get(0),
        )?;
        Ok(total.unwrap_or(0))
    }

    pub fn focus_rule_set(&self, host: &str, mode: &str) -> Result<FocusRuleRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO focus_rules (uuid, host, mode, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT (host) DO UPDATE SET
               mode = excluded.mode, updated_at = excluded.updated_at,
               deleted_at = NULL",
            params![uuid, host, mode, now],
        )?;
        let mut stmt =
            conn.prepare("SELECT id, uuid, host, mode FROM focus_rules WHERE host = ?1")?;
        stmt.query_row(params![host], |row| {
            Ok(FocusRuleRow {
                id: row.get(0)?,
                uuid: row.get(1)?,
                host: row.get(2)?,
                mode: row.get(3)?,
            })
        })
        .map_err(StoreError::from)
    }

    // -- blocker / extensions -------------------------------------------------------

    pub fn blocker_list_upsert(
        &self,
        name: &str,
        source_url: &str,
        enabled: bool,
    ) -> Result<BlockerListRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO blocker_lists (uuid, name, source_url, enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT (name) DO UPDATE SET
               source_url = excluded.source_url, enabled = excluded.enabled,
               updated_at = excluded.updated_at, deleted_at = NULL",
            params![uuid, name, source_url, i64::from(enabled), now],
        )?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, name, source_url, enabled, etag, rule_count
             FROM blocker_lists WHERE name = ?1",
        )?;
        stmt.query_row(params![name], |row| {
            Ok(BlockerListRow {
                id: row.get(0)?,
                uuid: row.get(1)?,
                name: row.get(2)?,
                source_url: row.get(3)?,
                enabled: row.get::<_, i64>(4)? != 0,
                etag: row.get(5)?,
                rule_count: row.get(6)?,
            })
        })
        .map_err(StoreError::from)
    }

    pub fn blocker_override_set(&self, host: &str, action: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        // Matches the partial unique index `idx_blocker_overrides_host`
        // (active rows only); tombstoned rows are revived below.
        conn.execute(
            "INSERT INTO blocker_overrides (uuid, host, action, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT (host) WHERE deleted_at IS NULL DO UPDATE SET
               uuid = excluded.uuid, action = excluded.action,
               updated_at = excluded.updated_at",
            params![new_uuid(), host, action, now],
        )?;
        // Row existed but tombstoned: revive it.
        conn.execute(
            "UPDATE blocker_overrides SET action = ?1, updated_at = ?2, deleted_at = NULL
             WHERE host = ?3 AND deleted_at IS NOT NULL",
            params![action, now, host],
        )?;
        Ok(())
    }

    pub fn extension_upsert(
        &self,
        ext_id: &str,
        name: &str,
        version: &str,
        enabled: bool,
    ) -> Result<ExtensionRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO extensions_meta
             (uuid, ext_id, name, version, enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT (ext_id) DO UPDATE SET
               name = excluded.name, version = excluded.version,
               enabled = excluded.enabled, updated_at = excluded.updated_at,
               deleted_at = NULL",
            params![uuid, ext_id, name, version, i64::from(enabled), now],
        )?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, ext_id, name, version, enabled, permissions
             FROM extensions_meta WHERE ext_id = ?1",
        )?;
        stmt.query_row(params![ext_id], |row| {
            Ok(ExtensionRow {
                id: row.get(0)?,
                uuid: row.get(1)?,
                ext_id: row.get(2)?,
                name: row.get(3)?,
                version: row.get(4)?,
                enabled: row.get::<_, i64>(5)? != 0,
                permissions: row.get(6)?,
            })
        })
        .map_err(StoreError::from)
    }

    // -- agents / canvas / memory / skills / mcp / providers / approvals -------------

    pub fn agent_run_start(&self, goal: &str, model: &str) -> Result<AgentRunRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO agent_runs
             (uuid, goal, status, model, started_at, created_at, updated_at)
             VALUES (?1, ?2, 'running', ?3, ?4, ?4, ?4)",
            params![uuid, goal, model, now],
        )?;
        Ok(AgentRunRow {
            id: conn.last_insert_rowid(),
            uuid,
            goal: goal.to_owned(),
            status: "running".to_owned(),
            model: model.to_owned(),
            started_at: Some(now),
            ended_at: None,
        })
    }

    pub fn agent_run_finish(&self, id: i64, status: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            "UPDATE agent_runs SET status = ?1, ended_at = ?2, updated_at = ?2 WHERE id = ?3",
            params![status, now_utc(), id],
        )?;
        Ok(())
    }

    pub fn agent_step_add(
        &self,
        run_id: i64,
        seq: i64,
        kind: &str,
        summary: &str,
        detail: &str,
    ) -> Result<AgentStepRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO agent_steps (uuid, run_id, seq, kind, summary, detail, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![uuid, run_id, seq, kind, summary, detail, now],
        )?;
        Ok(AgentStepRow {
            id: conn.last_insert_rowid(),
            uuid,
            run_id,
            seq,
            kind: kind.to_owned(),
            summary: summary.to_owned(),
            detail: detail.to_owned(),
        })
    }

    pub fn agent_steps(&self, run_id: i64) -> Result<Vec<AgentStepRow>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, run_id, seq, kind, summary, detail FROM agent_steps
             WHERE run_id = ?1 ORDER BY seq, id",
        )?;
        let collected = stmt
            .query_map(params![run_id], |row| {
                Ok(AgentStepRow {
                    id: row.get(0)?,
                    uuid: row.get(1)?,
                    run_id: row.get(2)?,
                    seq: row.get(3)?,
                    kind: row.get(4)?,
                    summary: row.get(5)?,
                    detail: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from);
        collected
    }

    pub fn canvas_put(
        &self,
        run_id: Option<i64>,
        kind: &str,
        title: &str,
        content: &str,
        position: i64,
    ) -> Result<CanvasItemRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO canvas_items
             (uuid, run_id, kind, title, content, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![uuid, run_id, kind, title, content, position, now],
        )?;
        Ok(CanvasItemRow {
            id: conn.last_insert_rowid(),
            uuid,
            run_id,
            kind: kind.to_owned(),
            title: title.to_owned(),
            content: content.to_owned(),
            position,
        })
    }

    pub fn canvas_list(&self, run_id: Option<i64>) -> Result<Vec<CanvasItemRow>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, run_id, kind, title, content, position FROM canvas_items
             WHERE deleted_at IS NULL AND (?1 IS NULL OR run_id = ?1)
             ORDER BY position, id",
        )?;
        let collected = stmt
            .query_map(params![run_id], |row| {
                Ok(CanvasItemRow {
                    id: row.get(0)?,
                    uuid: row.get(1)?,
                    run_id: row.get(2)?,
                    kind: row.get(3)?,
                    title: row.get(4)?,
                    content: row.get(5)?,
                    position: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from);
        collected
    }

    pub fn memory_put(&self, scope: &str, content: &str) -> Result<MemoryItemRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO memory_items (uuid, scope, content, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![uuid, scope, content, now],
        )?;
        Ok(MemoryItemRow {
            id: conn.last_insert_rowid(),
            uuid,
            scope: scope.to_owned(),
            content: content.to_owned(),
            embedding_ref: None,
        })
    }

    pub fn memory_recall(&self, scope: &str, limit: u32) -> Result<Vec<MemoryItemRow>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, scope, content, embedding_ref FROM memory_items
             WHERE deleted_at IS NULL AND scope = ?1
             ORDER BY id DESC LIMIT ?2",
        )?;
        let collected = stmt
            .query_map(params![scope, limit], |row| {
                Ok(MemoryItemRow {
                    id: row.get(0)?,
                    uuid: row.get(1)?,
                    scope: row.get(2)?,
                    content: row.get(3)?,
                    embedding_ref: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from);
        collected
    }

    pub fn skill_register(
        &self,
        name: &str,
        description: &str,
        content_path: &str,
    ) -> Result<SkillRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO skills (uuid, name, description, content_path, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT (name) DO UPDATE SET
               description = excluded.description, content_path = excluded.content_path,
               updated_at = excluded.updated_at, deleted_at = NULL",
            params![uuid, name, description, content_path, now],
        )?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, name, description, content_path, enabled
             FROM skills WHERE name = ?1",
        )?;
        stmt.query_row(params![name], |row| {
            Ok(SkillRow {
                id: row.get(0)?,
                uuid: row.get(1)?,
                name: row.get(2)?,
                description: row.get(3)?,
                content_path: row.get(4)?,
                enabled: row.get::<_, i64>(5)? != 0,
            })
        })
        .map_err(StoreError::from)
    }

    pub fn mcp_register(
        &self,
        name: &str,
        command: &str,
        args: &str,
    ) -> Result<McpServerRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO mcp_servers (uuid, name, command, args, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT (name) DO UPDATE SET
               command = excluded.command, args = excluded.args,
               updated_at = excluded.updated_at, deleted_at = NULL",
            params![uuid, name, command, args, now],
        )?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, name, command, args, env_json, enabled
             FROM mcp_servers WHERE name = ?1",
        )?;
        stmt.query_row(params![name], |row| {
            Ok(McpServerRow {
                id: row.get(0)?,
                uuid: row.get(1)?,
                name: row.get(2)?,
                command: row.get(3)?,
                args: row.get(4)?,
                env_json: row.get(5)?,
                enabled: row.get::<_, i64>(6)? != 0,
            })
        })
        .map_err(StoreError::from)
    }

    pub fn provider_register(
        &self,
        name: &str,
        kind: &str,
        base_url: &str,
    ) -> Result<ModelProviderRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO model_providers (uuid, name, kind, base_url, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT (name) DO UPDATE SET
               kind = excluded.kind, base_url = excluded.base_url,
               updated_at = excluded.updated_at, deleted_at = NULL",
            params![uuid, name, kind, base_url, now],
        )?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, name, kind, base_url, enabled
             FROM model_providers WHERE name = ?1",
        )?;
        stmt.query_row(params![name], |row| {
            Ok(ModelProviderRow {
                id: row.get(0)?,
                uuid: row.get(1)?,
                name: row.get(2)?,
                kind: row.get(3)?,
                base_url: row.get(4)?,
                enabled: row.get::<_, i64>(5)? != 0,
            })
        })
        .map_err(StoreError::from)
    }

    pub fn provider_list(&self) -> Result<Vec<ModelProviderRow>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, name, kind, base_url, enabled FROM model_providers
             WHERE deleted_at IS NULL ORDER BY name",
        )?;
        let collected = stmt
            .query_map([], |row| {
                Ok(ModelProviderRow {
                    id: row.get(0)?,
                    uuid: row.get(1)?,
                    name: row.get(2)?,
                    kind: row.get(3)?,
                    base_url: row.get(4)?,
                    enabled: row.get::<_, i64>(5)? != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from);
        collected
    }

    pub fn approval_record(
        &self,
        run_id: Option<i64>,
        action: &str,
        subject: &str,
        decision: &str,
    ) -> Result<ApprovalRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO approvals_audit
             (uuid, run_id, action, subject, decision, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![uuid, run_id, action, subject, decision, now],
        )?;
        Ok(ApprovalRow {
            id: conn.last_insert_rowid(),
            uuid,
            run_id,
            action: action.to_owned(),
            subject: subject.to_owned(),
            decision: decision.to_owned(),
            decided_by: "user".to_owned(),
            created_at: now,
        })
    }

    // -- sync ---------------------------------------------------------------------

    pub fn sync_state_get(&self, key: &str) -> Result<Option<String>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare("SELECT value FROM sync_state WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    pub fn sync_state_set(&self, key: &str, value: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            "INSERT INTO sync_state (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (key) DO UPDATE
             SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now_utc()],
        )?;
        Ok(())
    }

    pub fn outbox_enqueue(
        &self,
        entity: &str,
        entity_uuid: &str,
        op: &str,
        payload: &str,
    ) -> Result<OutboxRow, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO sync_outbox
             (uuid, entity, entity_uuid, op, payload, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![uuid, entity, entity_uuid, op, payload, now],
        )?;
        Ok(OutboxRow {
            id: conn.last_insert_rowid(),
            uuid,
            entity: entity.to_owned(),
            entity_uuid: entity_uuid.to_owned(),
            op: op.to_owned(),
            payload: payload.to_owned(),
            created_at: now,
            claimed_at: None,
        })
    }

    fn decode_outbox(row: &Row) -> rusqlite::Result<OutboxRow> {
        Ok(OutboxRow {
            id: row.get(0)?,
            uuid: row.get(1)?,
            entity: row.get(2)?,
            entity_uuid: row.get(3)?,
            op: row.get(4)?,
            payload: row.get(5)?,
            created_at: row.get(6)?,
            claimed_at: row.get(7)?,
        })
    }

    pub fn outbox_pending(&self, limit: u32) -> Result<Vec<OutboxRow>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, entity, entity_uuid, op, payload, created_at, claimed_at
             FROM sync_outbox WHERE claimed_at IS NULL ORDER BY id LIMIT ?1",
        )?;
        let collected = stmt
            .query_map(params![limit], Self::decode_outbox)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from);
        collected
    }

    pub fn outbox_claim(&self, id: i64) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            "UPDATE sync_outbox SET claimed_at = ?1 WHERE id = ?2",
            params![now_utc(), id],
        )?;
        Ok(())
    }

    pub fn outbox_ack(&self, id: i64) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute("DELETE FROM sync_outbox WHERE id = ?1", params![id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn migrated() -> Store {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.migrate().unwrap(), SCHEMA_VERSION);
        store
    }

    /// Open a database pinned at an older migration, seed v1-era data,
    /// then upgrade to latest — mirrors what real user databases do.
    fn upgrade_from(version: usize, seed_v1: bool) -> Store {
        let store = Store::open_in_memory().unwrap();
        {
            let mut conn = store.conn.lock().unwrap();
            MIGRATIONS.to_version(&mut conn, version).unwrap();
            if seed_v1 && version == 1 {
                conn.execute(
                    "INSERT INTO settings_kv (key, value) VALUES ('theme', 'dark')",
                    [],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO history (url, title, visited_at)
                     VALUES ('https://a.example', 'A', 42)",
                    [],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO bookmarks (url, title, created_at)
                     VALUES ('https://b.example', 'B', 7)",
                    [],
                )
                .unwrap();
            }
        }
        assert_eq!(store.migrate().unwrap(), SCHEMA_VERSION);
        store
    }

    #[test]
    fn migrate_is_idempotent_and_records_version() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.migrate().unwrap(), SCHEMA_VERSION);
        assert_eq!(store.migrate().unwrap(), SCHEMA_VERSION);
        assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn upgrade_from_v1_preserves_skeleton_data() {
        let store = upgrade_from(1, true);
        assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
        // settings_kv migrated into settings.
        assert_eq!(store.setting_get("theme").unwrap(), Some("dark".to_owned()));
        // v1 history rows carried over with generated UUIDs.
        let recent = store.history_recent(10).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].url, "https://a.example");
        assert!(!recent[0].uuid.is_empty());
        // bookmarks untouched.
        let marks = store.bookmark_list().unwrap();
        assert_eq!(marks.len(), 1);
        assert_eq!(marks[0].url, "https://b.example");
        // New tables exist and accept writes.
        let p = store.profile_create("default", true).unwrap();
        assert!(!p.uuid.is_empty());
    }

    #[test]
    fn upgrade_from_v2_and_v3_reaches_latest() {
        for version in [2usize, 3] {
            let store = upgrade_from(version, false);
            assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
            // Smoke-write into tables that postdate `version`.
            store.task_create(None, "t", None, 0).unwrap();
            store.memory_put("global", "m").unwrap();
            store.outbox_enqueue("tasks", "u", "upsert", "{}").unwrap();
        }
    }

    #[test]
    fn foreign_keys_are_enforced() {
        let store = migrated();
        // tabs_org.space_id references spaces(id): bogus id must fail.
        let err = store
            .tab_place(
                Some(9999),
                None,
                "tab-x",
                "https://x.example",
                "X",
                false,
                0,
            )
            .unwrap_err();
        assert!(matches!(err, StoreError::Sqlite(_)));
        // Cascade: deleting a space removes its folders.
        let space = store.space_create(None, "s", 0).unwrap();
        store.folder_create(space.id, None, "f", 0).unwrap();
        {
            let conn = store.conn.lock().unwrap();
            conn.execute("DELETE FROM spaces WHERE id = ?1", params![space.id])
                .unwrap();
            let n: i64 = conn
                .query_row("SELECT COUNT(*) FROM folders", [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0);
        }
    }

    #[test]
    fn settings_keymap_round_trip() {
        let store = migrated();
        assert_eq!(store.setting_get("theme").unwrap(), None);
        store.setting_set("theme", "dark").unwrap();
        assert_eq!(store.setting_get("theme").unwrap(), Some("dark".to_owned()));
        store.setting_set("theme", "light").unwrap();
        assert_eq!(
            store.setting_get("theme").unwrap(),
            Some("light".to_owned())
        );
        store
            .keymap_set("launcher.toggle", "ctrl+shift+space")
            .unwrap();
        assert_eq!(
            store.keymap_get("launcher.toggle").unwrap(),
            Some("ctrl+shift+space".to_owned())
        );
        assert_eq!(store.keymap_list().unwrap().len(), 1);
    }

    #[test]
    fn history_orders_most_recent_first_and_searches() {
        let store = migrated();
        store.history_add("https://a.example", "A", 10).unwrap();
        store.history_add("https://b.example", "B", 30).unwrap();
        store.history_add("https://c.example", "C", 20).unwrap();
        let recent = store.history_recent(2).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].url, "https://b.example");
        assert_eq!(recent[1].url, "https://c.example");
        let hits = store.history_search("b.example", 5).unwrap();
        assert_eq!(hits.len(), 1);
        // Soft delete hides the row.
        store.history_delete(recent[0].id).unwrap();
        assert_eq!(store.history_recent(10).unwrap().len(), 2);
    }

    #[test]
    fn bookmarks_upsert_by_url() {
        let store = migrated();
        store.bookmark_add("https://a.example", "A", 1).unwrap();
        store.bookmark_add("https://a.example", "A2", 2).unwrap();
        let all = store.bookmark_list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].title, "A2");
    }

    #[test]
    fn spaces_tabs_folders_round_trip() {
        let store = migrated();
        let profile = store.profile_create("work", true).unwrap();
        assert_eq!(store.profile_list().unwrap().len(), 1);
        let s1 = store.space_create(Some(profile.id), "inbox", 1).unwrap();
        let s2 = store.space_create(Some(profile.id), "later", 0).unwrap();
        let names: Vec<_> = store
            .space_list(Some(profile.id))
            .unwrap()
            .iter()
            .map(|s| s.name.clone())
            .collect();
        assert_eq!(names, vec!["later", "inbox"]);
        store.space_rename(s1.id, "inbox2").unwrap();
        let f = store.folder_create(s1.id, None, "proj", 0).unwrap();
        store.folder_create(s1.id, Some(f.id), "sub", 0).unwrap();
        assert_eq!(store.folder_list(s1.id).unwrap().len(), 2);
        store
            .tab_place(
                Some(s1.id),
                Some(f.id),
                "tab-1",
                "https://a.example",
                "A",
                true,
                0,
            )
            .unwrap();
        // Re-placing the same tab id upserts instead of duplicating.
        let t = store
            .tab_place(
                Some(s2.id),
                None,
                "tab-1",
                "https://b.example",
                "B",
                false,
                3,
            )
            .unwrap();
        assert_eq!(t.url, "https://b.example");
        assert_eq!(t.space_id, Some(s2.id));
        assert_eq!(store.tab_list(None).unwrap().len(), 1);
        store.tab_remove("tab-1").unwrap();
        assert!(store.tab_list(None).unwrap().is_empty());
    }

    #[test]
    fn sessions_favicons_round_trip() {
        let store = migrated();
        assert!(store.session_load("win-1").unwrap().is_none());
        store.session_save("win-1", "{\"tabs\":[]}").unwrap();
        let loaded = store.session_load("win-1").unwrap().unwrap();
        assert_eq!(loaded.snapshot, "{\"tabs\":[]}");
        assert!(store.favicon_get("https://a.example").unwrap().is_none());
        store
            .favicon_upsert(
                "https://a.example",
                Some("https://a.example/i.png"),
                Some(&[1, 2, 3]),
            )
            .unwrap();
        assert_eq!(
            store.favicon_get("https://a.example").unwrap(),
            Some(vec![1, 2, 3])
        );
    }

    #[test]
    fn tasks_notes_time_focus_round_trip() {
        let store = migrated();
        let list = store.task_list_create("today", 0).unwrap();
        let task = store
            .task_create(Some(list.id), "call Anna", Some(99), 1)
            .unwrap();
        store.task_link(task.id, "https://a.example", "A").unwrap();
        assert_eq!(store.task_list_open(Some(list.id)).unwrap().len(), 1);
        store.task_complete(task.id).unwrap();
        assert!(store.task_list_open(Some(list.id)).unwrap().is_empty());
        let note = store.note_upsert("notes/a.md", "abc", 5, "A").unwrap();
        assert_eq!(note.title, "A");
        store.note_upsert("notes/a.md", "def", 6, "A2").unwrap();
        let notes = store.note_list().unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].hash, "def");
        let ts = store
            .time_start("https://a.example/x", "a.example", "X", 100)
            .unwrap();
        store.time_end(ts.id, 160).unwrap();
        assert_eq!(store.time_for_host("a.example").unwrap(), 60);
        let rule = store.focus_rule_set("a.example", "block").unwrap();
        assert_eq!(rule.mode, "block");
        store.focus_rule_set("a.example", "allow").unwrap();
    }

    #[test]
    fn blocker_extensions_round_trip() {
        let store = migrated();
        let bl = store
            .blocker_list_upsert("easylist", "https://example.invalid/easy", true)
            .unwrap();
        assert!(bl.enabled);
        store.blocker_override_set("ads.example", "allow").unwrap();
        store.blocker_override_set("ads.example", "block").unwrap();
        let ext = store.extension_upsert("ext-1", "Ext", "1.0", true).unwrap();
        assert_eq!(ext.version, "1.0");
        store
            .extension_upsert("ext-1", "Ext", "1.1", false)
            .unwrap();
    }

    #[test]
    fn agents_canvas_memory_skills_mcp_providers_approvals_round_trip() {
        let store = migrated();
        let run = store
            .agent_run_start("research tabs", "test-model")
            .unwrap();
        store.agent_step_add(run.id, 0, "search", "s", "d").unwrap();
        store.agent_step_add(run.id, 1, "read", "s2", "d2").unwrap();
        assert_eq!(store.agent_steps(run.id).unwrap().len(), 2);
        store.agent_run_finish(run.id, "done").unwrap();
        store
            .canvas_put(Some(run.id), "table", "T", "|a|", 0)
            .unwrap();
        assert_eq!(store.canvas_list(Some(run.id)).unwrap().len(), 1);
        store.memory_put("global", "user likes tabs").unwrap();
        assert_eq!(store.memory_recall("global", 5).unwrap().len(), 1);
        let skill = store
            .skill_register("plan", "planning skill", "skills/plan.md")
            .unwrap();
        assert!(skill.enabled);
        store
            .skill_register("plan", "planning skill v2", "skills/plan.md")
            .unwrap();
        let mcp = store.mcp_register("gh", "gh", "[\"mcp\"]").unwrap();
        assert_eq!(mcp.command, "gh");
        let prov = store
            .provider_register("anthropic", "anthropic", "")
            .unwrap();
        assert_eq!(store.provider_list().unwrap().len(), 1);
        assert_eq!(prov.kind, "anthropic");
        // No secret columns on the provider row.
        let ddl: String = {
            let conn = store.conn.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT sql FROM sqlite_master WHERE name = 'model_providers'")
                .unwrap();
            stmt.query_row([], |r| r.get(0)).unwrap()
        };
        assert!(!ddl.to_lowercase().contains("secret"));
        assert!(!ddl.to_lowercase().contains("api_key"));
        let approval = store
            .approval_record(Some(run.id), "run_command", "ls", "approved")
            .unwrap();
        assert_eq!(approval.decision, "approved");
    }

    #[test]
    fn sync_state_outbox_and_schema_meta_round_trip() {
        let store = migrated();
        assert_eq!(store.sync_state_get("cursor").unwrap(), None);
        store.sync_state_set("cursor", "abc").unwrap();
        assert_eq!(
            store.sync_state_get("cursor").unwrap(),
            Some("abc".to_owned())
        );
        let item = store
            .outbox_enqueue("spaces", "uuid-1", "upsert", "{\"a\":1}")
            .unwrap();
        assert_eq!(store.outbox_pending(10).unwrap().len(), 1);
        store.outbox_claim(item.id).unwrap();
        assert!(store.outbox_pending(10).unwrap().is_empty());
        store.outbox_ack(item.id).unwrap();
        assert_eq!(
            store.schema_meta_get("schema_version").unwrap(),
            Some("4".to_owned())
        );
        store.schema_meta_set("import_base", "deadbeef").unwrap();
        assert_eq!(
            store.schema_meta_get("import_base").unwrap(),
            Some("deadbeef".to_owned())
        );
    }

    #[test]
    fn loop_based_round_trips_over_many_rows() {
        // Loop-based property check (used where full proptest strategies
        // would add little): N inserts, ordering + count invariants hold.
        let store = migrated();
        for i in 0..200 {
            store
                .history_add(&format!("https://site-{i}.example/p"), "T", i)
                .unwrap();
            store
                .setting_set(&format!("k{i}"), &format!("v{i}"))
                .unwrap();
        }
        let recent = store.history_recent(200).unwrap();
        assert_eq!(recent.len(), 200);
        for w in recent.windows(2) {
            assert!(w[0].visit_time >= w[1].visit_time);
        }
        for i in 0..200 {
            assert_eq!(
                store.setting_get(&format!("k{i}")).unwrap(),
                Some(format!("v{i}"))
            );
        }
        let json = store.export_json().unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["schema_version"], 4);
        assert_eq!(v["tables"]["history"].as_array().unwrap().len(), 200);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]
        #[test]
        fn settings_round_trip_prop(key in "[a-z0-9/._-]{1,32}", value in ".*") {
            let store = Store::open_in_memory().unwrap();
            store.migrate().unwrap();
            store.setting_set(&key, &value).unwrap();
            prop_assert_eq!(store.setting_get(&key).unwrap(), Some(value));
        }

        #[test]
        fn history_visit_monotonic_prop(
            visits in proptest::collection::vec((r"https?://[a-z]{1,12}\.example(/[a-z]{0,12})?", ".{0,40}", 0i64..1_000_000_000), 1..25)
        ) {
            let store = Store::open_in_memory().unwrap();
            store.migrate().unwrap();
            for (url, title, t) in &visits {
                store.history_add(url, title, *t).unwrap();
            }
            let mut expected: Vec<i64> = visits.iter().map(|v| v.2).collect();
            expected.sort_unstable_by(|a, b| b.cmp(a));
            let recent = store.history_recent(100).unwrap();
            prop_assert_eq!(recent.len(), visits.len());
            let got: Vec<i64> = recent.iter().map(|r| r.visit_time).collect();
            prop_assert_eq!(got, expected);
        }

        #[test]
        fn outbox_enqueue_claim_ack_prop(
            ops in proptest::collection::vec(("[a-z_]{1,16}", "[a-z]{1,16}"), 1..20)
        ) {
            let store = Store::open_in_memory().unwrap();
            store.migrate().unwrap();
            for (entity, op) in &ops {
                store.outbox_enqueue(entity, &new_uuid(), op, "{}").unwrap();
            }
            prop_assert_eq!(store.outbox_pending(100).unwrap().len(), ops.len());
            for row in store.outbox_pending(100).unwrap() {
                store.outbox_claim(row.id).unwrap();
            }
            prop_assert!(store.outbox_pending(100).unwrap().is_empty());
        }
    }

    #[test]
    fn corruption_is_a_clean_error_with_backup_path() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("astra.db");
        std::fs::write(&db, b"this is definitely not a sqlite database file!!!").unwrap();
        let err = Store::open(&db).unwrap_err();
        assert!(matches!(err, StoreError::Corrupt(_)), "got: {err:?}");
        // open_recovering moves the garbage aside and yields a fresh DB.
        let (store, backup) = Store::open_recovering(&db).unwrap();
        let backup = backup.expect("recovery must report a backup path");
        assert!(backup.exists());
        assert!(std::fs::read(&backup)
            .unwrap()
            .starts_with(b"this is definitely"));
        assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
        store.setting_set("k", "v").unwrap();
    }

    #[test]
    fn backup_and_export_round_trip_on_file_db() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("astra.db");
        let store = Store::open(&db).unwrap();
        assert_eq!(store.journal_mode().unwrap(), "wal");
        store.migrate().unwrap();
        store.setting_set("theme", "dark").unwrap();
        store.history_add("https://a.example", "A", 1).unwrap();
        let dest = dir.path().join("backup.db");
        store.backup_to(&dest).unwrap();
        assert!(dest.exists());
        let restored = Store::open(&dest).unwrap();
        assert_eq!(restored.user_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(
            restored.setting_get("theme").unwrap(),
            Some("dark".to_owned())
        );
        assert_eq!(restored.history_recent(5).unwrap().len(), 1);
        let json = store.export_json().unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["schema_version"], SCHEMA_VERSION);
        for table in [
            "profiles",
            "spaces",
            "folders",
            "tabs_org",
            "history",
            "sessions",
            "favicons",
            "settings",
            "keymap",
            "tasks",
            "task_lists",
            "task_links",
            "notes_index",
            "time_sessions",
            "focus_rules",
            "blocker_lists",
            "blocker_overrides",
            "extensions_meta",
            "agent_runs",
            "agent_steps",
            "canvas_items",
            "memory_items",
            "skills",
            "mcp_servers",
            "model_providers",
            "approvals_audit",
            "sync_state",
            "sync_outbox",
            "schema_meta",
        ] {
            assert!(v["tables"].get(table).is_some(), "missing table {table}");
        }
    }
}
