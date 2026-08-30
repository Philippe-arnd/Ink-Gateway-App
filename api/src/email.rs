//! Transactional email via Resend's REST API. Plain `ureq` POST — same
//! reasoning as the LLM providers (`llm/anthropic.rs`, `llm/gemini.rs`):
//! one small HTTP call doesn't earn a dedicated SDK dependency.

use anyhow::{Context, Result};
use serde_json::json;

/// Sends the password-reset email. Returns an error if `RESEND_API_KEY` /
/// `RESEND_FROM_EMAIL` aren't configured or the API call fails — callers
/// decide how loudly to surface that (see `routes/auth.rs::forgot_password`,
/// which logs but never lets it leak into the HTTP response, to avoid
/// turning a mail-provider outage into an email-enumeration oracle).
pub fn send_password_reset(to: &str, reset_url: &str) -> Result<()> {
    let api_key = std::env::var("RESEND_API_KEY").context("RESEND_API_KEY is not set")?;
    let from = std::env::var("RESEND_FROM_EMAIL").context("RESEND_FROM_EMAIL is not set")?;

    let body = json!({
        "from": from,
        "to": [to],
        "subject": "Réinitialise ton mot de passe — Ink Gateway",
        "html": format!(
            "<p>Un lien pour réinitialiser ton mot de passe Ink Gateway :</p>\
             <p><a href=\"{reset_url}\">{reset_url}</a></p>\
             <p>Ce lien expire dans une heure. Si tu n'es pas à l'origine de cette demande, \
             ignore cet email.</p>"
        ),
    });

    ureq::post("https://api.resend.com/emails")
        .header("Authorization", &format!("Bearer {api_key}"))
        .send_json(&body)
        .context("Resend API call failed")?;

    Ok(())
}
