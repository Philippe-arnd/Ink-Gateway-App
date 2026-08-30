//! SQLite registry: users, sessions' API keys, and the book registry.
//!
//! Book content itself is never stored here — it lives in git working copies
//! on disk (see `ink_core`). This is only the thin bookkeeping layer the
//! architecture plan calls for: no Postgres, no S3.

use anyhow::{Context, Result};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::str::FromStr;

pub async fn connect(database_url: &str) -> Result<SqlitePool> {
    let options = SqliteConnectOptions::from_str(database_url)
        .with_context(|| format!("invalid DATABASE_URL: {}", database_url))?
        .create_if_missing(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .context("failed to connect to sqlite database")?;

    migrate(&pool).await?;
    Ok(pool)
}

async fn migrate(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS api_keys (
            user_id TEXT PRIMARY KEY REFERENCES users(id),
            provider TEXT NOT NULL,
            key_type TEXT NOT NULL DEFAULT 'api_key',
            encrypted_key TEXT NOT NULL,
            last_four TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS books (
            id TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL REFERENCES users(id),
            title TEXT NOT NULL,
            repo_path TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_books_owner ON books(owner_id);

        -- token_hash, never the raw token — a DB leak alone shouldn't yield
        -- usable reset links. One row per outstanding request; a fresh
        -- request replaces prior ones for the same user (see auth.rs).
        CREATE TABLE IF NOT EXISTS password_resets (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id),
            expires_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
        "#,
    )
    .execute(pool)
    .await
    .context("failed to run schema migration")?;

    Ok(())
}
