mod auth;
mod blocking;
mod crypto;
mod db;
mod error;
mod llm;
mod routes;
mod state;

use std::path::PathBuf;

use tower_http::cors::{AllowCredentials, CorsLayer};
use tower_http::trace::TraceLayer;
use tower_sessions::{Expiry, MemoryStore, SessionManagerLayer};
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

use crate::crypto::Cipher;
use crate::state::AppState;

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

    std::fs::create_dir_all(&books_dir)?;

    let db = db::connect(&database_url).await?;
    let cipher = Cipher::from_env()?;
    let state = AppState::new(db, cipher, PathBuf::from(books_dir));

    let session_store = MemoryStore::default();
    let session_layer = SessionManagerLayer::new(session_store)
        .with_secure(secure_cookies)
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
        .layer(TraceLayer::new_for_http());

    tracing::info!("ink-gateway-api listening on {bind_addr}");
    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
