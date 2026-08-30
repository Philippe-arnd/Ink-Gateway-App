pub mod auth;
pub mod books;
pub mod chat;
pub mod comments;
pub mod edit;
pub mod settings;
pub mod versions;

use axum::Router;
use axum::routing::{get, post};

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
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
}
