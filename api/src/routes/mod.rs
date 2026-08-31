pub mod auth;
pub mod books;
pub mod chat;
pub mod comments;
pub mod edit;
pub mod onboarding;
pub mod sessions;
pub mod settings;
pub mod util;
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
    // Coolify's own container healthcheck probes GET / on the container
    // directly (bypassing Traefik entirely), so this needs to exist even
    // though nothing external ever reaches it that way.
    let health_route = Router::new().route("/", get(|| async { "ok" }));

    // Unprefixed on purpose: Traefik's Domains-tab entry for this service is
    // https://<domain>/api, which always generates a stripprefix — Axum only
    // ever sees the path after /api is removed. The client (app/src/api.ts)
    // prefixes every request with VITE_API_BASE, which already ends in /api,
    // so the two line up. See DEPLOYMENT.md.
    let auth_routes = Router::new()
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/auth/forgot-password", post(auth::forgot_password))
        .route("/auth/reset-password", post(auth::reset_password))
        .layer(auth_rate_limit());

    auth_routes
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(auth::me))
        .route(
            "/settings/api-key",
            get(settings::get_api_key)
                .post(settings::set_api_key)
                .delete(settings::delete_api_key),
        )
        .route("/books", get(books::list).post(books::create))
        .route("/onboarding/questions", get(onboarding::questions))
        .route("/onboarding/start", post(onboarding::start))
        .route("/books/{id}", get(books::get))
        .route("/books/{id}/edit/insert", post(edit::insert_text))
        .route("/books/{id}/edit/rewrite", post(edit::rewrite_range))
        .route(
            "/books/{id}/comments",
            get(comments::list).post(comments::add),
        )
        .route(
            "/books/{id}/comments/{comment_id}/resolve",
            post(comments::resolve),
        )
        .route("/books/{id}/versions", get(versions::list))
        .route("/books/{id}/versions/restore", post(versions::restore))
        .route("/books/{id}/chat", post(chat::chat))
        .route("/books/{id}/sessions", post(sessions::start))
        .route("/books/{id}/sessions/{tag}/diff", get(sessions::diff))
        .merge(health_route)
}
