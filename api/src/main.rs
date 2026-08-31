mod agent;
mod auth;
mod blocking;
mod crypto;
mod db;
mod email;
mod error;
mod llm;
mod routes;
mod state;

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;
use tower_http::cors::{AllowCredentials, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;
use tower_sessions::cookie::SameSite;
use tower_sessions::{Expiry, MemoryStore, SessionManagerLayer};
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

use crate::crypto::Cipher;
use crate::state::AppState;

/// Request bodies are JSON book content (up to a full manuscript) — generous
/// but bounded, so a malformed/hostile client can't force unbounded memory
/// growth.
const MAX_BODY_BYTES: usize = 20 * 1024 * 1024;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(fmt::layer())
        .with(EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "sqlite://data/ink-gateway.db".to_string());
    let books_dir =
        std::env::var("INK_GATEWAY_BOOKS_DIR").unwrap_or_else(|_| "data/books".to_string());
    let frontend_origin =
        std::env::var("FRONTEND_ORIGIN").unwrap_or_else(|_| "http://localhost:5173".to_string());
    let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8787".to_string());
    let secure_cookies = std::env::var("INK_GATEWAY_SECURE_COOKIES")
        .map(|v| v == "true")
        .unwrap_or(false);

    // Any of these three failing returns Err from main, which exits the
    // process — and under `restart: unless-stopped` that reads from the
    // outside as an unexplained crash-loop, with the actual cause only in the
    // stderr of a container that's already gone (see #34). Announce each step
    // so `docker logs` on a dead container shows how far startup got, and
    // give the one bare `?` here the context its neighbours already carry.
    tracing::info!("creating books directory at {books_dir}");
    std::fs::create_dir_all(&books_dir)
        .with_context(|| format!("failed to create books directory at {books_dir}"))?;

    tracing::info!("connecting to database at {database_url}");
    let db = db::connect(&database_url).await?;

    tracing::info!("loading master key from INK_GATEWAY_MASTER_KEY");
    let cipher = Cipher::from_env()?;
    let state = AppState::new(db, cipher, PathBuf::from(books_dir));

    // In-memory session store: sessions don't survive a restart (everyone
    // has to log back in after a deploy). A persistent store was evaluated
    // (tower-sessions-sqlx-store) but its published version pins an older,
    // incompatible tower-sessions-core than tower-sessions itself — a real
    // upstream version conflict, not something to work around here. Tracked
    // in the deployment doc as a known limitation.
    let session_store = MemoryStore::default();
    let session_layer = SessionManagerLayer::new(session_store)
        .with_secure(secure_cookies)
        // No anti-CSRF tokens on state-changing routes — this is the
        // defense instead: Strict means the cookie is never sent on a
        // cross-site request, so a forged form/fetch from another origin
        // can't ride the session even though CORS also already restricts
        // which origins can read the response.
        .with_same_site(SameSite::Strict)
        .with_expiry(Expiry::OnInactivity(
            tower_sessions::cookie::time::Duration::days(30),
        ));

    // Credentialed CORS (session cookies) can't combine with `Any` for origin
    // or headers — the browser rejects it outright. Everything must be explicit.
    let cors = CorsLayer::new()
        .allow_origin(frontend_origin.parse::<axum::http::HeaderValue>()?)
        .allow_credentials(AllowCredentials::yes())
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::DELETE,
        ])
        .allow_headers([axum::http::header::CONTENT_TYPE]);

    let app = routes::router()
        .with_state(state)
        .layer(session_layer)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        // SSE sessions can legitimately run for a few minutes (agentic tool
        // loop); this is a backstop against a genuinely hung connection, not
        // a normal-path limit.
        .layer(TimeoutLayer::with_status_code(
            axum::http::StatusCode::GATEWAY_TIMEOUT,
            Duration::from_secs(300),
        ))
        .layer(RequestBodyLimitLayer::new(MAX_BODY_BYTES));

    tracing::info!("ink-gateway-api listening on {bind_addr}");
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .with_context(|| format!("failed to bind {bind_addr}"))?;
    // The auth rate limiter keys on peer IP, which requires connect-info to
    // be threaded through explicitly — the default make-service doesn't
    // carry it.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;

    Ok(())
}
