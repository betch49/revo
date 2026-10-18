use std::{env, net::SocketAddr, path::PathBuf};

use anyhow::{Context, Result};

/// Runtime configuration, read from `REVO_*` environment variables.
#[derive(Clone, Debug)]
pub struct Config {
    /// Address the HTTP server listens on. Keep it on localhost behind a reverse proxy.
    pub bind: SocketAddr,
    /// Directory holding `revo.db` and the `images/` folder.
    pub data_dir: PathBuf,
    /// Argon2 PHC hash of the admin password (`revo hash-password` prints one).
    pub admin_password_hash: String,
    /// Mark cookies `Secure`. Must stay on in production (HTTPS); turn off only for local http testing.
    pub cookie_secure: bool,
    /// Maximum size of a single uploaded file, in megabytes.
    pub max_upload_mb: usize,
    /// Public base URL, used for the share links shown in the admin area.
    pub public_url: String,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let bind = env::var("REVO_BIND")
            .unwrap_or_else(|_| "127.0.0.1:4000".into())
            .parse()
            .context("REVO_BIND must look like 127.0.0.1:4000")?;
        let data_dir = env::var("REVO_DATA_DIR").unwrap_or_else(|_| "./data".into()).into();
        let admin_password_hash = env::var("REVO_ADMIN_PASSWORD_HASH")
            .context("REVO_ADMIN_PASSWORD_HASH is not set. Generate one with `revo hash-password`.")?;
        argon2::password_hash::phc::PasswordHash::new(&admin_password_hash)
            .map_err(|e| anyhow::anyhow!("REVO_ADMIN_PASSWORD_HASH is not a valid hash: {e}"))?;
        let cookie_secure =
            env::var("REVO_COOKIE_SECURE").map(|v| !matches!(v.as_str(), "0" | "false" | "no")).unwrap_or(true);
        let max_upload_mb = env::var("REVO_MAX_UPLOAD_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(60);
        let public_url = env::var("REVO_PUBLIC_URL")
            .unwrap_or_else(|_| "https://review.betch.ch".into())
            .trim_end_matches('/')
            .to_string();
        Ok(Self { bind, data_dir, admin_password_hash, cookie_secure, max_upload_mb, public_url })
    }
}
