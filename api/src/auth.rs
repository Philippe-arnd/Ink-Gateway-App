use argon2::Argon2;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use serde::Serialize;
use tower_sessions::Session;

use crate::error::AppError;
use crate::state::AppState;

const SESSION_USER_KEY: &str = "user_id";

pub fn hash_password(password: &str) -> anyhow::Result<String> {
    // `hash_password` (getrandom feature, default-on) generates a fresh random
    // salt internally — no salt plumbing needed on our end.
    let hash = Argon2::default()
        .hash_password(password.as_bytes())
        .map_err(|e| anyhow::anyhow!("failed to hash password: {e}"))?;
    Ok(hash.to_string())
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    Argon2::default()
        .verify_password(password.as_bytes(), hash)
        .is_ok()
}

pub async fn set_session_user(session: &Session, user_id: &str) -> anyhow::Result<()> {
    session.insert(SESSION_USER_KEY, user_id).await?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct CurrentUser {
    pub id: String,
    pub email: String,
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let session = Session::from_request_parts(parts, state)
            .await
            .map_err(|_| AppError::unauthorized("no session"))?;

        let user_id: String = session
            .get(SESSION_USER_KEY)
            .await
            .map_err(|_| AppError::unauthorized("invalid session"))?
            .ok_or_else(|| AppError::unauthorized("not logged in"))?;

        let State(state) = State::<AppState>::from_request_parts(parts, state)
            .await
            .map_err(|_| AppError::unauthorized("no app state"))?;

        let row = sqlx::query_as::<_, (String, String)>("SELECT id, email FROM users WHERE id = ?")
            .bind(&user_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|_| AppError::unauthorized("session user no longer exists"))?;

        let (id, email) =
            row.ok_or_else(|| AppError::unauthorized("session user no longer exists"))?;
        Ok(CurrentUser { id, email })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_then_verify_roundtrips() {
        let hash = hash_password("correct horse battery staple").unwrap();
        assert!(verify_password("correct horse battery staple", &hash));
        assert!(!verify_password("wrong password", &hash));
    }

    #[test]
    fn hashing_the_same_password_twice_yields_different_hashes() {
        // Random salt per hash — never compare stored hashes to fingerprint passwords.
        let a = hash_password("same-password").unwrap();
        let b = hash_password("same-password").unwrap();
        assert_ne!(a, b);
    }
}
