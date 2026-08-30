use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use tower_sessions::Session;

use crate::auth::{
    CurrentUser, generate_reset_token, hash_password, hash_token, set_session_user, verify_password,
};
use crate::email;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// How long a password-reset link stays valid.
const RESET_TOKEN_TTL_MINUTES: i64 = 60;

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

#[derive(Debug, Deserialize)]
pub struct ForgotPasswordBody {
    pub email: String,
}

/// Always returns the same success response whether or not the email is
/// registered — a differing response (or timing) here is a classic
/// email-enumeration oracle. Actual failures (bad Resend config, API
/// outage) are logged server-side, never surfaced to the caller.
pub async fn forgot_password(
    State(state): State<AppState>,
    Json(body): Json<ForgotPasswordBody>,
) -> Json<serde_json::Value> {
    if let Err(err) = try_send_reset(&state, &body.email).await {
        tracing::warn!(error = %err, "password reset request failed");
    }
    Json(serde_json::json!({
        "status": "if_registered_email_sent"
    }))
}

async fn try_send_reset(state: &AppState, email_addr: &str) -> anyhow::Result<()> {
    let row = sqlx::query_as::<_, (String,)>("SELECT id FROM users WHERE email = ?")
        .bind(email_addr)
        .fetch_optional(&state.db)
        .await?;
    let Some((user_id,)) = row else {
        return Ok(()); // no such account — silently no-op, see doc comment above
    };

    let token = generate_reset_token();
    let token_hash = hash_token(&token);
    let expires_at =
        (chrono::Utc::now() + chrono::Duration::minutes(RESET_TOKEN_TTL_MINUTES)).to_rfc3339();

    // One outstanding reset per user — a fresh request invalidates any prior
    // unused link instead of accumulating rows forever.
    sqlx::query("DELETE FROM password_resets WHERE user_id = ?")
        .bind(&user_id)
        .execute(&state.db)
        .await?;
    sqlx::query("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .bind(&token_hash)
        .bind(&user_id)
        .bind(&expires_at)
        .execute(&state.db)
        .await?;

    let frontend_origin =
        std::env::var("FRONTEND_ORIGIN").unwrap_or_else(|_| "http://localhost:5173".to_string());
    let reset_url = format!("{frontend_origin}/reset-password?token={token}");

    // Blocking HTTP call (ureq) — password reset requests are rare and
    // low-latency-sensitive enough that a dedicated spawn_blocking isn't
    // worth the ceremony here, unlike the book-editing hot path.
    let email_addr = email_addr.to_string();
    tokio::task::spawn_blocking(move || email::send_password_reset(&email_addr, &reset_url))
        .await??;

    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct ResetPasswordBody {
    pub token: String,
    pub new_password: String,
}

pub async fn reset_password(
    State(state): State<AppState>,
    Json(body): Json<ResetPasswordBody>,
) -> AppResult<Json<serde_json::Value>> {
    if body.new_password.len() < 8 {
        return Err(AppError::bad_request(
            "password must be at least 8 characters",
        ));
    }

    let token_hash = hash_token(&body.token);
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT user_id, expires_at FROM password_resets WHERE token_hash = ?",
    )
    .bind(&token_hash)
    .fetch_optional(&state.db)
    .await?;

    let (user_id, expires_at) =
        row.ok_or_else(|| AppError::bad_request("invalid or expired reset link"))?;

    let expires_at: chrono::DateTime<chrono::Utc> = expires_at
        .parse()
        .map_err(|_| anyhow::anyhow!("corrupt expires_at in password_resets"))?;
    if expires_at < chrono::Utc::now() {
        sqlx::query("DELETE FROM password_resets WHERE token_hash = ?")
            .bind(&token_hash)
            .execute(&state.db)
            .await?;
        return Err(AppError::bad_request("invalid or expired reset link"));
    }

    let password_hash = hash_password(&body.new_password)?;
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?")
        .bind(&password_hash)
        .bind(&user_id)
        .execute(&state.db)
        .await?;

    // Single-use: burn every outstanding token for this user, not just the
    // one that was redeemed.
    sqlx::query("DELETE FROM password_resets WHERE user_id = ?")
        .bind(&user_id)
        .execute(&state.db)
        .await?;

    Ok(Json(serde_json::json!({ "status": "password_reset" })))
}
