use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use tower_sessions::Session;

use crate::auth::{CurrentUser, hash_password, set_session_user, verify_password};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct RegisterBody {
    pub email: String,
    pub password: String,
    /// Invite-only beta — see INK_GATEWAY_INVITE_CODE. Not a security boundary
    /// on its own (it's a shared secret), just a cheap gate against randoms
    /// finding the deployed URL and self-signing-up.
    pub invite_code: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginBody {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct UserView {
    pub id: String,
    pub email: String,
}

pub async fn register(
    State(state): State<AppState>,
    session: Session,
    Json(body): Json<RegisterBody>,
) -> AppResult<Json<UserView>> {
    let expected_invite = std::env::var("INK_GATEWAY_INVITE_CODE").map_err(|_| {
        AppError::bad_request("signups are disabled (INK_GATEWAY_INVITE_CODE not configured)")
    })?;
    if body.invite_code != expected_invite {
        return Err(AppError::unauthorized("invalid invite code"));
    }
    if body.password.len() < 8 {
        return Err(AppError::bad_request(
            "password must be at least 8 characters",
        ));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let password_hash = hash_password(&body.password)?;
    let created_at = chrono::Utc::now().to_rfc3339();

    sqlx::query("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
        .bind(&id)
        .bind(&body.email)
        .bind(&password_hash)
        .bind(&created_at)
        .execute(&state.db)
        .await
        .map_err(|_| AppError::bad_request("an account with that email already exists"))?;

    set_session_user(&session, &id).await?;

    Ok(Json(UserView {
        id,
        email: body.email,
    }))
}

pub async fn login(
    State(state): State<AppState>,
    session: Session,
    Json(body): Json<LoginBody>,
) -> AppResult<Json<UserView>> {
    let row = sqlx::query_as::<_, (String, String, String)>(
        "SELECT id, email, password_hash FROM users WHERE email = ?",
    )
    .bind(&body.email)
    .fetch_optional(&state.db)
    .await?;

    let (id, email, password_hash) =
        row.ok_or_else(|| AppError::unauthorized("invalid credentials"))?;

    if !verify_password(&body.password, &password_hash) {
        return Err(AppError::unauthorized("invalid credentials"));
    }

    set_session_user(&session, &id).await?;

    Ok(Json(UserView { id, email }))
}

pub async fn logout(session: Session) -> AppResult<Json<serde_json::Value>> {
    session.flush().await.map_err(anyhow::Error::from)?;
    Ok(Json(serde_json::json!({ "status": "logged_out" })))
}

pub async fn me(user: CurrentUser) -> Json<UserView> {
    Json(UserView {
        id: user.id,
        email: user.email,
    })
}
