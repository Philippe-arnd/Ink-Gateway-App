use axum::Json;
use axum::extract::State;
use serde::Deserialize;

use crate::auth::CurrentUser;
use crate::blocking;
use crate::error::{AppError, AppResult};
use crate::routes::books::Book;
use crate::routes::util::valid_slug;
use crate::state::AppState;

/// The static 13-question onboarding list, ported from `ink-cli init`'s TUI.
/// Auth-gated for consistency with the rest of the app, though the list
/// itself doesn't depend on any user state.
pub async fn questions(_user: CurrentUser) -> AppResult<Json<Vec<ink_core::init::Question>>> {
    Ok(Json(ink_core::init::question_list()))
}

#[derive(Debug, Deserialize)]
pub struct StartOnboarding {
    pub title: String,
    pub author: String,
    /// Directory name under `books_dir` for the new book's git working copy.
    /// Same rules as `books::CreateBook::slug`.
    pub slug: String,
    /// (question_index, answer_text) pairs, index matching `question_list()`'s order.
    pub answers: Vec<(usize, String)>,
}

/// Scaffolds a brand-new book from scratch: `git init`, the `ink-cli init`
/// template files, then the onboarding answers written into `Global
/// Material/*` and committed — all in one request, then registers the book.
/// Unlike `books::create`, which only registers an already-scaffolded repo,
/// this is the entry point for users who don't have a book yet.
pub async fn start(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<StartOnboarding>,
) -> AppResult<Json<Book>> {
    if !valid_slug(&body.slug) {
        return Err(AppError::bad_request(
            "slug must be non-empty and contain only letters, digits, '-' and '_'",
        ));
    }

    let repo_path = state.books_dir.join(&body.slug);
    if repo_path.join("Global Material/Config.yml").exists() {
        return Err(AppError::bad_request(
            "that name is already taken — pick another, or use \"Enregistrer un livre existant\" if this is your book",
        ));
    }

    let title = body.title;
    let author = body.author;
    let answers = body.answers;
    let scaffold_path = repo_path.clone();

    let payload = blocking::run(move || {
        std::fs::create_dir_all(&scaffold_path)?;
        ink_core::git::run_git(&scaffold_path, &["init"])?;
        let payload = ink_core::init::run_init(&scaffold_path, &title, &author)?;
        ink_core::init::submit_qa_answers(&scaffold_path, &answers)?;
        Ok(payload)
    })
    .await?;

    let id = uuid::Uuid::new_v4().to_string();
    let created_at = chrono::Utc::now().to_rfc3339();
    let repo_path_str = repo_path.to_string_lossy().to_string();

    sqlx::query(
        "INSERT INTO books (id, owner_id, title, repo_path, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&user.id)
    .bind(&payload.title)
    .bind(&repo_path_str)
    .bind(&created_at)
    .execute(&state.db)
    .await?;

    Ok(Json(Book {
        id,
        title: payload.title,
        created_at,
    }))
}
