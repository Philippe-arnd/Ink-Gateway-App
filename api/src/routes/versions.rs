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

/// `git log` over a long-lived manuscript is unbounded, and the sidebar only
/// ever rendered the first handful. Page it server-side instead of shipping
/// the whole history every refresh.
const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;

#[derive(Debug, Deserialize)]
pub struct PathQuery {
    #[serde(default = "default_path")]
    pub path: String,
    #[serde(default)]
    pub limit: Option<usize>,
    /// Offset into the history, as returned in `next_cursor`.
    #[serde(default)]
    pub cursor: Option<usize>,
}

fn default_path() -> String {
    DEFAULT_PATH.to_string()
}

#[derive(Debug, serde::Serialize)]
pub struct VersionPage {
    pub versions: Vec<VersionEntry>,
    pub next_cursor: Option<usize>,
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
) -> AppResult<Json<VersionPage>> {
    let repo_path = load_owned_repo_path(&state, &user, &id).await?;
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = query.cursor.unwrap_or(0);

    let all = blocking::run(move || ink_core::git::list_versions(&repo_path, &query.path)).await?;

    // Fetch one extra to learn whether another page exists without a second
    // `git log`.
    let mut versions: Vec<VersionEntry> = all.into_iter().skip(offset).take(limit + 1).collect();
    let next_cursor = if versions.len() > limit {
        versions.truncate(limit);
        Some(offset + limit)
    } else {
        None
    };

    Ok(Json(VersionPage {
        versions,
        next_cursor,
    }))
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
