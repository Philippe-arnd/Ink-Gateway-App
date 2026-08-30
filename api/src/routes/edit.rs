use axum::Json;
use axum::extract::{Path, State};
use serde::Deserialize;
use serde_json::Value;

use super::books::load_owned_repo_path;
use crate::auth::CurrentUser;
use crate::blocking;
use crate::error::AppResult;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct InsertBody {
    pub position: usize,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct RewriteBody {
    pub start: usize,
    pub end: usize,
    pub content: String,
}

pub async fn insert_text(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<InsertBody>,
) -> AppResult<Json<Value>> {
    let repo_path = load_owned_repo_path(&state, &user, &id).await?;
    let result = blocking::run(move || {
        ink_core::edit::insert_text(&repo_path, body.position, &body.content)
    })
    .await?;
    Ok(Json(result))
}

pub async fn rewrite_range(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<RewriteBody>,
) -> AppResult<Json<Value>> {
    let repo_path = load_owned_repo_path(&state, &user, &id).await?;
    let result = blocking::run(move || {
        ink_core::edit::rewrite_range(&repo_path, body.start, body.end, &body.content)
    })
    .await?;
    Ok(Json(result))
}
