use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::llm::anthropic::{self, AuthMode};
use crate::llm::gemini;
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct ApiKeyStatus {
    pub configured: bool,
    pub provider: Option<String>,
    pub key_type: Option<String>,
    /// Last 4 characters only — the raw key is never sent back to the browser
    /// once saved, only this fingerprint for display ("...ab12").
    pub last_four: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SetApiKey {
    pub provider: String,
    /// "api_key" (default) or "oauth_token" — only meaningful for
    /// provider == "anthropic". An OAuth token is the "super-token" from
    /// `claude setup-token` / a Claude Pro-Max login: usage draws against
    /// the subscription instead of pay-per-token billing.
    #[serde(default = "default_key_type")]
    pub key_type: String,
    pub api_key: String,
}

fn default_key_type() -> String {
    "api_key".to_string()
}

pub async fn get_api_key(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<ApiKeyStatus>> {
    let row = sqlx::query_as::<_, (String, String, String)>(
        "SELECT provider, key_type, last_four FROM api_keys WHERE user_id = ?",
    )
    .bind(&user.id)
    .fetch_optional(&state.db)
    .await?;

    Ok(Json(match row {
        Some((provider, key_type, last_four)) => ApiKeyStatus {
            configured: true,
            provider: Some(provider),
            key_type: Some(key_type),
            last_four: Some(last_four),
        },
        None => ApiKeyStatus {
            configured: false,
            provider: None,
            key_type: None,
            last_four: None,
        },
    }))
}

pub async fn set_api_key(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<SetApiKey>,
) -> AppResult<Json<ApiKeyStatus>> {
    if body.provider != "anthropic" && body.provider != "gemini" {
        return Err(AppError::bad_request(
            "provider must be \"anthropic\" or \"gemini\"",
        ));
    }
    if body.key_type != "api_key" && body.key_type != "oauth_token" {
        return Err(AppError::bad_request(
            "key_type must be \"api_key\" or \"oauth_token\"",
        ));
    }
    if body.key_type == "oauth_token" && body.provider != "anthropic" {
        return Err(AppError::bad_request(
            "oauth_token is only supported for the anthropic provider",
        ));
    }
    if body.api_key.trim().len() < 8 {
        return Err(AppError::bad_request(
            "that doesn't look like a real credential",
        ));
    }

    let trimmed = body.api_key.trim();
    match body.provider.as_str() {
        "anthropic" => {
            let auth_mode = if body.key_type == "oauth_token" {
                AuthMode::OAuthToken
            } else {
                AuthMode::ApiKey
            };
            anthropic::validate_credential(trimmed, auth_mode)
                .await
                .map_err(|e| AppError::bad_request(e.to_string()))?;
        }
        "gemini" => {
            gemini::validate_api_key(trimmed)
                .await
                .map_err(|e| AppError::bad_request(e.to_string()))?;
        }
        _ => unreachable!("provider already validated above"),
    }

    let encrypted = state.cipher.encrypt(body.api_key.trim())?;
    let last_four = {
        let trimmed = body.api_key.trim();
        trimmed[trimmed.len().saturating_sub(4)..].to_string()
    };
    let updated_at = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO api_keys (user_id, provider, key_type, encrypted_key, last_four, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?) \
         ON CONFLICT(user_id) DO UPDATE SET \
            provider = excluded.provider, \
            key_type = excluded.key_type, \
            encrypted_key = excluded.encrypted_key, \
            last_four = excluded.last_four, \
            updated_at = excluded.updated_at",
    )
    .bind(&user.id)
    .bind(&body.provider)
    .bind(&body.key_type)
    .bind(&encrypted)
    .bind(&last_four)
    .bind(&updated_at)
    .execute(&state.db)
    .await?;

    Ok(Json(ApiKeyStatus {
        configured: true,
        provider: Some(body.provider),
        key_type: Some(body.key_type),
        last_four: Some(last_four),
    }))
}

pub async fn delete_api_key(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<serde_json::Value>> {
    sqlx::query("DELETE FROM api_keys WHERE user_id = ?")
        .bind(&user.id)
        .execute(&state.db)
        .await?;
    Ok(Json(serde_json::json!({ "status": "deleted" })))
}
