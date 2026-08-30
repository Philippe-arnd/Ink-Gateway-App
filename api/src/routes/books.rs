use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::auth::CurrentUser;
use crate::blocking;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct Book {
    pub id: String,
    pub title: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateBook {
    pub title: String,
    /// Directory name under `books_dir` of a git working copy already
    /// scaffolded by `ink-cli init` (or cloned from an existing book repo).
    /// Never a full path — the server resolves it under its own books
    /// directory, so a client can't point the API at an arbitrary path on
    /// the server's filesystem.
    pub slug: String,
}

fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Loads a book's repo path, verifying `user` owns it. Shared by every route
/// that operates on book content, so ownership can never be forgotten.
pub async fn load_owned_repo_path(
    state: &AppState,
    user: &CurrentUser,
    book_id: &str,
) -> AppResult<PathBuf> {
    let row =
        sqlx::query_as::<_, (String,)>("SELECT repo_path FROM books WHERE id = ? AND owner_id = ?")
            .bind(book_id)
            .bind(&user.id)
            .fetch_optional(&state.db)
            .await?;

    let (repo_path,) = row.ok_or_else(|| AppError::not_found("book not found"))?;
    Ok(PathBuf::from(repo_path))
}

pub async fn list(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Vec<Book>>> {
    let rows = sqlx::query_as::<_, (String, String, String)>(
        "SELECT id, title, created_at FROM books WHERE owner_id = ? ORDER BY created_at DESC",
    )
    .bind(&user.id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(|(id, title, created_at)| Book {
                id,
                title,
                created_at,
            })
            .collect(),
    ))
}

pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<CreateBook>,
) -> AppResult<Json<Book>> {
    if !valid_slug(&body.slug) {
        return Err(AppError::bad_request(
            "slug must be non-empty and contain only letters, digits, '-' and '_'",
        ));
    }

    let repo_path = state.books_dir.join(&body.slug);
    let config_path = repo_path.join("Global Material").join("Config.yml");
    if !config_path.exists() {
        return Err(AppError::bad_request(format!(
            "{} doesn't look like an ink-gateway book (no Global Material/Config.yml). \
             Scaffold it first with `ink-cli init` under the server's books directory.",
            repo_path.display()
        )));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let created_at = chrono::Utc::now().to_rfc3339();
    let repo_path_str = repo_path.to_string_lossy().to_string();

    sqlx::query(
        "INSERT INTO books (id, owner_id, title, repo_path, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&user.id)
    .bind(&body.title)
    .bind(&repo_path_str)
    .bind(&created_at)
    .execute(&state.db)
    .await?;

    Ok(Json(Book {
        id,
        title: body.title,
        created_at,
    }))
}

pub async fn get(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<ink_core::context::BookContext>> {
    let repo_path = load_owned_repo_path(&state, &user, &id).await?;
    let context = blocking::run(move || ink_core::context::get_book_context(&repo_path)).await?;
    Ok(Json(context))
}
