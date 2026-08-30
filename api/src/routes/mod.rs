pub mod auth;
pub mod books;
pub mod chat;
pub mod comments;
pub mod edit;
pub mod sessions;
pub mod settings;
pub mod versions;

use axum::Router;
use axum::routing::{get, post};
use tower_governor::GovernorLayer;
use tower_governor::governor::GovernorConfigBuilder;

use crate::state::AppState;

/// Credential-guessing surface (login, register, password reset) gets its
/// own stricter, per-IP rate limit — a handful of bursts, then a slow
/// trickle. Everything else is normal authenticated app traffic and isn't
/// worth limiting the same way.
///
/// Keyed on `SmartIpKeyExtractor`, which prefers `X-Forwarded-For`/`Forwarded`
/// over the raw peer address — required in production, where Coolify's
/// reverse proxy sits in front of this service and every direct connection
/// would otherwise appear to come from the proxy's own IP (one shared rate
/// limit bucket for every visitor). This is only safe because the proxy sets
/// that header itself; the app must never be reachable directly, or a client
/// could forge it to dodge the limit — see the deployment doc.
fn auth_rate_limit() -> GovernorLayer<
    tower_governor::key_extractor::SmartIpKeyExtractor,
    governor::middleware::NoOpMiddleware,
    axum::body::Body,
> {
    let config = GovernorConfigBuilder::default()
        .key_extractor(tower_governor::key_extractor::SmartIpKeyExtractor)
        .per_second(3)
        .burst_size(5)
        .finish()
        .expect("static governor config is always valid");
    GovernorLayer::new(config)
}

pub fn router() -> Router<AppState> {
    let auth_routes = Router::new()
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/forgot-password", post(auth::forgot_password))
        .route("/api/auth/reset-password", post(auth::reset_password))
        .layer(auth_rate_limit());

    auth_routes
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/me", get(auth::me))
        .route(
            "/api/settings/api-key",
            get(settings::get_api_key)
                .post(settings::set_api_key)
                .delete(settings::delete_api_key),
        )
        .route("/api/books", get(books::list).post(books::create))
        .route("/api/books/{id}", get(books::get))
        .route("/api/books/{id}/edit/insert", post(edit::insert_text))
        .route("/api/books/{id}/edit/rewrite", post(edit::rewrite_range))
        .route(
            "/api/books/{id}/comments",
            get(comments::list).post(comments::add),
        )
        .route(
            "/api/books/{id}/comments/{comment_id}/resolve",
            post(comments::resolve),
        )
        .route("/api/books/{id}/versions", get(versions::list))
        .route("/api/books/{id}/versions/restore", post(versions::restore))
        .route("/api/books/{id}/chat", post(chat::chat))
        .route("/api/books/{id}/sessions", post(sessions::start))
        .route("/api/books/{id}/sessions/{tag}/diff", get(sessions::diff))
}
