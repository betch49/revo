mod admin;
mod board;
mod pages;
mod ws;

use axum::{
    Router,
    routing::{delete, get, patch, post},
};
use rusqlite::{Connection, OptionalExtension};

use crate::{AppState, auth::BoardAccess, error::AppError};

pub fn api_router() -> Router<AppState> {
    Router::new()
        // Owner session
        .route("/admin/session", get(admin::session))
        .route("/admin/login", post(admin::login))
        .route("/admin/logout", post(admin::logout))
        // Owner: boards
        .route("/admin/boards", get(admin::list_boards).post(admin::create_board))
        .route("/admin/boards/{id}", patch(admin::update_board).delete(admin::delete_board))
        .route("/admin/boards/{id}/duplicate", post(admin::duplicate_board))
        // A board, for anyone allowed in
        .route("/b/{slug}", get(board::get_board))
        .route("/b/{slug}/unlock", post(board::unlock))
        .route("/b/{slug}/ws", get(ws::connect))
        .route("/b/{slug}/assets", post(board::upload_asset))
        .route("/b/{slug}/comments", post(board::add_comment))
        .route("/b/{slug}/comments/{id}/resolve", post(board::resolve_comment))
        .route("/b/{slug}/comments/{id}", delete(board::delete_comment))
}

pub fn page_router() -> Router<AppState> {
    Router::new()
        .route("/", get(pages::home))
        .route("/healthz", get(|| async { "ok" }))
        .route("/admin", get(pages::admin))
        .route("/static/{file}", get(pages::asset))
        .route("/files/{asset}/{variant}", get(pages::file))
        .route("/{slug}", get(pages::board))
}

/// Board URLs are `/<slug>`: lowercase letters, digits and dashes, without
/// clashing with the app's own paths.
pub fn valid_slug(slug: &str) -> bool {
    const RESERVED: &[&str] = &["admin", "api", "static", "files", "healthz", "robots.txt"];
    (3..=64).contains(&slug.len())
        && slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && !RESERVED.contains(&slug)
}

/// Turn a title into a slug candidate ("Café Mila — Menu" → "cafe-mila-menu").
pub fn slugify(title: &str) -> String {
    let mut out = String::new();
    for c in title.chars().flat_map(char::to_lowercase) {
        let c = match c {
            'à' | 'á' | 'â' | 'ä' | 'ã' | 'å' => 'a',
            'ç' => 'c',
            'è' | 'é' | 'ê' | 'ë' => 'e',
            'ì' | 'í' | 'î' | 'ï' => 'i',
            'ñ' => 'n',
            'ò' | 'ó' | 'ô' | 'ö' | 'õ' => 'o',
            'ù' | 'ú' | 'û' | 'ü' => 'u',
            c => c,
        };
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let s: String = out.trim_matches('-').chars().take(56).collect();
    let s = s.trim_end_matches('-').to_string();
    if s.len() < 3 { format!("board-{s}").trim_end_matches('-').to_string() } else { s }
}

/// Trim and length-check a text field.
pub fn clean_text(value: &str, field: &str, max: usize) -> Result<String, AppError> {
    let v = value.trim();
    if v.is_empty() {
        return Err(AppError::bad(format!("{field} is required")));
    }
    if v.chars().count() > max {
        return Err(AppError::bad(format!("{field} is too long (max {max} characters)")));
    }
    Ok(v.to_string())
}

pub fn board_access_by_slug(conn: &Connection, slug: &str) -> Result<BoardAccess, AppError> {
    conn.query_row("SELECT id, access, passcode_hash IS NOT NULL FROM boards WHERE slug = ?1", [slug], |r| {
        Ok(BoardAccess { id: r.get(0)?, access: r.get(1)?, has_passcode: r.get(2)? })
    })
    .optional()?
    .ok_or(AppError::NotFound)
}

pub fn board_access_by_id(conn: &Connection, id: i64) -> Result<BoardAccess, AppError> {
    conn.query_row("SELECT id, access, passcode_hash IS NOT NULL FROM boards WHERE id = ?1", [id], |r| {
        Ok(BoardAccess { id: r.get(0)?, access: r.get(1)?, has_passcode: r.get(2)? })
    })
    .optional()?
    .ok_or(AppError::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_titles() {
        assert_eq!(slugify("Café Mila — Menu 2027"), "cafe-mila-menu-2027");
        assert_eq!(slugify("  Hello!!  "), "hello");
        assert_eq!(slugify("A"), "board-a");
        assert_eq!(slugify("€€"), "board");
        assert!(valid_slug(&slugify("Q3 planning / roadmap")));
    }
}
