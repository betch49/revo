use std::io::{self, BufRead, IsTerminal, Write};

use anyhow::{Context, Result, bail};
use revo::{AppState, app, auth::hash_password, config::Config, db::Db};
use tracing_subscriber::EnvFilter;

const USAGE: &str = "\
revo — Betch collaborative whiteboard

USAGE:
    revo [serve]          Run the web server (configured with REVO_* environment variables)
    revo hash-password    Read a password and print the hash for REVO_ADMIN_PASSWORD_HASH
    revo backup <file>    Write a consistent copy of the database to <file> (safe while running)
    revo --version
";

#[tokio::main]
async fn main() -> Result<()> {
    match std::env::args().nth(1).as_deref() {
        None | Some("serve") => serve().await,
        Some("hash-password") => {
            println!("{}", hash_password(&read_password()?)?);
            Ok(())
        }
        Some("backup") => {
            let Some(dest) = std::env::args().nth(2) else { bail!("usage: revo backup <file>") };
            let data_dir = std::env::var("REVO_DATA_DIR").unwrap_or_else(|_| "./data".into());
            Db::open(&std::path::Path::new(&data_dir).join("revo.db"))?.backup(std::path::Path::new(&dest))?;
            eprintln!("database copied to {dest}; also back up {data_dir}/images");
            Ok(())
        }
        Some("--version" | "-V") => {
            println!("revo {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("--help" | "-h" | "help") => {
            print!("{USAGE}");
            Ok(())
        }
        Some(other) => bail!("unknown command `{other}`\n\n{USAGE}"),
    }
}

async fn serve() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let config = Config::from_env()?;
    std::fs::create_dir_all(&config.data_dir)
        .with_context(|| format!("creating data directory {}", config.data_dir.display()))?;
    let db = Db::open(&config.data_dir.join("revo.db"))?;
    let bind = config.bind;
    let state = AppState::new(db, config)?;

    let listener = tokio::net::TcpListener::bind(bind).await.with_context(|| format!("binding {bind}"))?;
    tracing::info!("revo listening on http://{bind}");
    axum::serve(listener, app(state)).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}

fn read_password() -> Result<String> {
    let stdin = io::stdin();
    if stdin.is_terminal() {
        eprint!("Password (shown while typing): ");
        io::stderr().flush()?;
    }
    let mut line = String::new();
    stdin.lock().read_line(&mut line)?;
    let password = line.trim_end_matches(['\r', '\n']).to_string();
    if password.chars().count() < 10 {
        bail!("use at least 10 characters");
    }
    Ok(password)
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!("shutting down");
}
