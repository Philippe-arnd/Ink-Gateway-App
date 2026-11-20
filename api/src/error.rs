use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

/// Machine-readable error classes. The browser branches on `code`, never on
/// the human message — before this existed the frontend string-matched
/// "no AI provider key configured" to decide whether to deep-link Settings.
///
/// This is the complete wire vocabulary, kept here as one list so it stays in
/// step with the frontend's mapping of code to user-facing copy. Some codes
/// are only raised by routes that land in later phases, hence the allow.
#[allow(dead_code)]
pub mod code {
    pub const UNAUTHENTICATED: &str = "unauthenticated";
    pub const NOT_FOUND: &str = "not_found";
    pub const VALIDATION: &str = "validation";
    pub const NO_PROVIDER_KEY: &str = "no_provider_key";
    pub const PROVIDER_AUTH: &str = "provider_auth";
    pub const DRAFT_CONFLICT: &str = "draft_conflict";
    pub const CHAPTER_NOT_READY: &str = "chapter_not_ready";
    pub const NEEDS_CHAPTER_OUTLINE: &str = "needs_chapter_outline";
    pub const RATE_LIMITED: &str = "rate_limited";
    pub const LIMIT_REACHED: &str = "limit_reached";
    pub const INTERNAL: &str = "internal";
}

pub struct AppError {
    status: StatusCode,
    code: &'static str,
    message: String,
    /// Structured payload the UI can render directly — e.g. how many words
    /// are still missing before a chapter can advance, or the server's
    /// current draft text on a conflict.
    details: Option<Value>,
}

impl AppError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code::VALIDATION, message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, code::UNAUTHENTICATED, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, code::NOT_FOUND, message)
    }

    pub fn no_provider_key() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            code::NO_PROVIDER_KEY,
            "no AI provider key configured — add one in Settings before writing with the co-author",
        )
    }
}

impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        // Full detail goes to the server log; the client only ever sees a
        // generic message, in case the error chain ever embeds anything
        // sensitive (git output, decrypted key material, etc).
        tracing::error!(error = %err, "request failed");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            code::INTERNAL,
            "internal error",
        )
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        anyhow::Error::from(err).into()
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let mut body = json!({ "error": self.message, "code": self.code });
        if let Some(details) = self.details {
            body["details"] = details;
        }
        (self.status, Json(body)).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
