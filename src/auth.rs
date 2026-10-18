use std::{collections::HashMap, sync::Mutex};

use argon2::{
    Argon2,
    password_hash::{PasswordHasher, PasswordVerifier, phc::PasswordHash},
};
use axum::{extract::FromRequestParts, http::request::Parts};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use rand::Rng;
use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use crate::{AppState, db::now, error::AppError};

pub const ADMIN_COOKIE: &str = "revo_admin";
const ADMIN_SESSION_SECS: i64 = 30 * 24 * 3600;
const BOARD_ACCESS_SECS: i64 = 90 * 24 * 3600;
const MAX_FAILURES: usize = 8;
const FAILURE_WINDOW_SECS: i64 = 10 * 60;

/// Random hex token with `bytes` bytes of entropy.
pub fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn hash_password(password: &str) -> anyhow::Result<String> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("hashing failed: {e}"))
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
        .unwrap_or(false)
}

pub fn board_cookie_name(board_id: i64) -> String {
    format!("revo_b{board_id}")
}

pub fn make_cookie(state: &AppState, name: String, value: String, max_age_secs: i64) -> Cookie<'static> {
    Cookie::build((name, value))
        .path("/")
        .http_only(true)
        .secure(state.config.cookie_secure)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::seconds(max_age_secs))
        .build()
}

pub async fn create_admin_session(state: &AppState) -> Result<Cookie<'static>, AppError> {
    let token = random_token(32);
    let t = token.clone();
    state
        .db
        .call(move |c| {
            c.execute("DELETE FROM admin_sessions WHERE expires_at < ?1", [now()])?;
            c.execute(
                "INSERT INTO admin_sessions (token, expires_at) VALUES (?1, ?2)",
                params![t, now() + ADMIN_SESSION_SECS],
            )?;
            Ok(())
        })
        .await?;
    Ok(make_cookie(state, ADMIN_COOKIE.into(), token, ADMIN_SESSION_SECS))
}

pub async fn create_board_access(state: &AppState, board_id: i64) -> Result<Cookie<'static>, AppError> {
    let token = random_token(32);
    let t = token.clone();
    state
        .db
        .call(move |c| {
            c.execute("DELETE FROM board_access WHERE expires_at < ?1", [now()])?;
            c.execute(
                "INSERT INTO board_access (token, board_id, expires_at) VALUES (?1, ?2, ?3)",
                params![t, board_id, now() + BOARD_ACCESS_SECS],
            )?;
            Ok(())
        })
        .await?;
    Ok(make_cookie(state, board_cookie_name(board_id), token, BOARD_ACCESS_SECS))
}

pub async fn is_admin(state: &AppState, jar: &CookieJar) -> Result<bool, AppError> {
    let Some(token) = jar.get(ADMIN_COOKIE).map(|c| c.value().to_string()) else {
        return Ok(false);
    };
    state
        .db
        .call(move |c| {
            let found = c
                .query_row(
                    "SELECT 1 FROM admin_sessions WHERE token = ?1 AND expires_at > ?2",
                    params![token, now()],
                    |_| Ok(()),
                )
                .optional()?;
            Ok(found.is_some())
        })
        .await
}

/// What a browser may do on a board, from least to most.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    View,
    Comment,
    Edit,
    Owner,
}

impl Role {
    /// The role a board's link grants (`private` grants nothing).
    pub fn from_access(access: &str) -> Option<Self> {
        match access {
            "view" => Some(Self::View),
            "comment" => Some(Self::Comment),
            "edit" => Some(Self::Edit),
            _ => None,
        }
    }
}

pub const ACCESS_LEVELS: &[&str] = &["private", "view", "comment", "edit"];

/// The fields of a board needed to decide access.
#[derive(Clone, Debug)]
pub struct BoardAccess {
    pub id: i64,
    pub access: String,
    pub has_passcode: bool,
}

/// Work out this browser's role on a board. The owner always gets in;
/// everyone else needs a shared link and, if set, the passcode.
pub async fn role_for(state: &AppState, jar: &CookieJar, board: &BoardAccess) -> Result<Role, AppError> {
    if is_admin(state, jar).await? {
        return Ok(Role::Owner);
    }
    let role = Role::from_access(&board.access).ok_or(AppError::NotFound)?;
    if !board.has_passcode {
        return Ok(role);
    }
    let Some(token) = jar.get(&board_cookie_name(board.id)).map(|c| c.value().to_string()) else {
        return Err(AppError::PasscodeRequired);
    };
    let board_id = board.id;
    let ok = state
        .db
        .call(move |c| {
            let found = c
                .query_row(
                    "SELECT 1 FROM board_access WHERE token = ?1 AND board_id = ?2 AND expires_at > ?3",
                    params![token, board_id, now()],
                    |_| Ok(()),
                )
                .optional()?;
            Ok(found.is_some())
        })
        .await?;
    if ok { Ok(role) } else { Err(AppError::PasscodeRequired) }
}

/// Extractor for routes only the admin may call.
pub struct Admin;

impl FromRequestParts<AppState> for Admin {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let jar = CookieJar::from_headers(&parts.headers);
        if is_admin(state, &jar).await? { Ok(Admin) } else { Err(AppError::Unauthorized) }
    }
}

/// Slows down password guessing: after too many failures for a key (the admin
/// login, or one board's passcode), further attempts are refused for a while.
#[derive(Default)]
pub struct Throttle(Mutex<HashMap<String, Vec<i64>>>);

impl Throttle {
    pub fn check(&self, key: &str) -> Result<(), AppError> {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let cutoff = now() - FAILURE_WINDOW_SECS;
        let entry = map.entry(key.to_string()).or_default();
        entry.retain(|t| *t > cutoff);
        if entry.len() >= MAX_FAILURES { Err(AppError::TooManyAttempts) } else { Ok(()) }
    }

    pub fn fail(&self, key: &str) {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(key.to_string()).or_default().push(now());
    }

    pub fn clear(&self, key: &str) {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(key);
    }
}
