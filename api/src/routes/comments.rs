use axum::Json;
use axum::extract::{Path, State};
use ink_core::comments::Comment;
use serde::Deserialize;

use super::books::load_owned_repo_path;
use crate::auth::CurrentUser;
use crate::blocking;
use crate::error::AppResult;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct AddCommentBody {
    pub anchor_start: usize,
    pub anchor_end: usize,
    pub text: String,
}

pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Vec<Comment>>> {
    let repo_path = load_owned_repo_path(&state, &user, &id).await?;
    let comments = blocking::run(move || ink_core::comments::list_comments(&repo_path)).await?;
    Ok(Json(comments))
}

pub async fn add(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<AddCommentBody>,
) -> AppResult<Json<Comment>> {
    let repo_path = load_owned_repo_path(&state, &user, &id).await?;
    let comment = blocking::run(move || {
        ink_core::comments::add_comment(
            &repo_path,
            body.anchor_start,
            body.anchor_end,
            "human",
            &body.text,
        )
    })
    .await?;
    Ok(Json(comment))
}

pub async fn resolve(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((id, comment_id)): Path<(String, String)>,
) -> AppResult<Json<Comment>> {
    let repo_path = load_owned_repo_path(&state, &user, &id).await?;
    let comment =
        blocking::run(move || ink_core::comments::resolve_comment(&repo_path, &comment_id)).await?;
    Ok(Json(comment))
}
