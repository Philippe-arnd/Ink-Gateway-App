use axum::Json;
use axum::extract::{Path, Query, State};
use ink_core::git::VersionEntry;
use serde::Deserialize;

use super::books::load_owned_repo_path;
use crate::auth::CurrentUser;
use crate::blocking;
use crate::error::AppResult;
use crate::state::AppState;

const DEFAULT_PATH: &str = "Review/current.md";

#[derive(Debug, Deserialize)]
pub struct PathQuery {
    #[serde(default = "default_path")]
    pub path: String,
}

fn default_path() -> String {
    DEFAULT_PATH.to_string()
}

#[derive(Debug, Deserialize)]
pub struct RestoreBody {
    #[serde(default = "default_path")]
    pub path: String,
    pub commit: String,
}

pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Query(query): Query<PathQuery>,
) -> AppResult<Json<Vec<VersionEntry>>> {
    let repo_path = load_owned_repo_path(&state, &user, &id).await?;
    let versions =
        blocking::run(move || ink_core::git::list_versions(&repo_path, &query.path)).await?;
    Ok(Json(versions))
}

pub async fn restore(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<RestoreBody>,
) -> AppResult<Json<serde_json::Value>> {
    let repo_path = load_owned_repo_path(&state, &user, &id).await?;
    blocking::run(move || ink_core::git::restore_version(&repo_path, &body.path, &body.commit))
        .await?;
    Ok(Json(serde_json::json!({ "status": "restored" })))
}
