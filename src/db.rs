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
    passcode_hash TEXT,
    -- Bumped on every change so open boards know to refresh.
    rev           INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL
);

-- An image placed on a board. Its pixels live in image_versions.
CREATE TABLE IF NOT EXISTS images (
    id         INTEGER PRIMARY KEY,
    board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    x          REAL NOT NULL,
    y          REAL NOT NULL,
    -- Width on the board, in board units. Height follows the version's aspect ratio.
    width      REAL NOT NULL,
    z          INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS images_board ON images(board_id);

-- One uploaded file. Review status belongs to the version, not the image.
CREATE TABLE IF NOT EXISTS image_versions (
    id            INTEGER PRIMARY KEY,
    image_id      INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    number        INTEGER NOT NULL,
    file_key      TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime          TEXT NOT NULL,
    -- Format of the resized web copies (display + thumb): image/jpeg or image/png.
    display_mime  TEXT NOT NULL,
    px_width      INTEGER NOT NULL,
    px_height     INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    status_by     TEXT,
    status_at     INTEGER,
    created_at    INTEGER NOT NULL,
    UNIQUE (image_id, number)
);

-- Root comments carry a pin position (fractions of the image size); replies have parent_id.
CREATE TABLE IF NOT EXISTS comments (
    id          INTEGER PRIMARY KEY,
    version_id  INTEGER NOT NULL REFERENCES image_versions(id) ON DELETE CASCADE,
    parent_id   INTEGER REFERENCES comments(id) ON DELETE CASCADE,
    x           REAL,
    y           REAL,
    author      TEXT NOT NULL,
    is_admin    INTEGER NOT NULL DEFAULT 0,
    body        TEXT NOT NULL,
    resolved_at INTEGER,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_version ON comments(version_id);

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
        conn.execute_batch(SCHEMA)?;
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

pub fn bump_rev(conn: &Connection, board_id: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE boards SET rev = rev + 1 WHERE id = ?1", [board_id])?;
    Ok(())
}
