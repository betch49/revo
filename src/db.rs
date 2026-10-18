use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::Result;
use rusqlite::Connection;

use crate::error::AppError;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS boards (
    id            INTEGER PRIMARY KEY,
    slug          TEXT NOT NULL UNIQUE,
    title         TEXT NOT NULL,
    -- Who can open the board with its link: private (owner only), view, comment or edit.
    access        TEXT NOT NULL DEFAULT 'private',
    passcode_hash TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

-- Everything drawn on a board (stickies, shapes, text, connectors, strokes,
-- frames, images). The front end owns the JSON shape; the server stores it.
CREATE TABLE IF NOT EXISTS items (
    board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    id         TEXT NOT NULL,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (board_id, id)
) WITHOUT ROWID;

-- Uploaded image files. Image items point at an asset id.
CREATE TABLE IF NOT EXISTS assets (
    id            INTEGER PRIMARY KEY,
    board_id      INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    file_key      TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime          TEXT NOT NULL,
    -- Format of the resized web copies (display + thumb): image/jpeg or image/png.
    display_mime  TEXT NOT NULL,
    px_width      INTEGER NOT NULL,
    px_height     INTEGER NOT NULL,
    created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assets_board ON assets(board_id);

-- Comment threads pinned to a point on the board; replies have parent_id.
CREATE TABLE IF NOT EXISTS comments (
    id          INTEGER PRIMARY KEY,
    board_id    INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    parent_id   INTEGER REFERENCES comments(id) ON DELETE CASCADE,
    x           REAL,
    y           REAL,
    author      TEXT NOT NULL,
    is_owner    INTEGER NOT NULL DEFAULT 0,
    body        TEXT NOT NULL,
    resolved_at INTEGER,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_board ON comments(board_id);

CREATE TABLE IF NOT EXISTS admin_sessions (
    token      TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
);

-- Proof that a browser entered a board's passcode.
CREATE TABLE IF NOT EXISTS board_access (
    token      TEXT PRIMARY KEY,
    board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
);
"#;

/// A single SQLite connection shared behind a mutex. Review boards see light
/// traffic, so serialising writes is simpler than a pool and plenty fast.
#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")?;
        // Version 1 was the review-only prototype; its tables are not reused.
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 2 {
            conn.execute_batch(
                "DROP TABLE IF EXISTS comments; DROP TABLE IF EXISTS image_versions; DROP TABLE IF EXISTS images;
                 DROP TABLE IF EXISTS board_access; DROP TABLE IF EXISTS boards;",
            )?;
        }
        conn.execute_batch(SCHEMA)?;
        conn.execute_batch("PRAGMA user_version = 2")?;
        Ok(Self(Arc::new(Mutex::new(conn))))
    }

    /// Write a consistent snapshot of the database to `dest`.
    pub fn backup(&self, dest: &Path) -> Result<()> {
        if dest.exists() {
            anyhow::bail!("{} already exists", dest.display());
        }
        let conn = self.0.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute("VACUUM INTO ?1", [dest.to_string_lossy()])?;
        Ok(())
    }

    /// Run `f` with the connection on a blocking thread.
    pub async fn call<T, F>(&self, f: F) -> Result<T, AppError>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, AppError> + Send + 'static,
    {
        let db = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = db.lock().unwrap_or_else(|e| e.into_inner());
            f(&mut conn)
        })
        .await
        .map_err(|e| AppError::Internal(e.into()))?
    }
}

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn touch_board(conn: &Connection, board_id: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE boards SET updated_at = ?1 WHERE id = ?2", rusqlite::params![now(), board_id])?;
    Ok(())
}
