//! Intent-typed writing sessions: snapshot the book before the agent starts,
//! run the shared tool-use loop under an intent-specific system prompt (and,
//! for constrained intents, a restricted tool list), then let the author
//! review a diff against the snapshot before it's kept or rolled back.
//!
//! "Rolled back" reuses `versions::restore` (Phase 1) — the snapshot tag
//! already gives us a forward-only undo point, no new machinery needed.

use std::convert::Infallible;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use futures::stream::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::books::load_owned_repo_path;
use crate::agent::{load_provider, render_book_context, run_loop};
use crate::auth::CurrentUser;
use crate::blocking;
use crate::error::{AppError, AppResult};
use crate::llm::Turn;
use crate::state::AppState;

const CURRENT_PATH: &str = "Review/current.md";
const CORRECTION_TOOLS: &[&str] = &["rewrite_range", "add_comment"];
const SELECTION_TOOLS: &[&str] = &["rewrite_range"];

#[derive(Debug, Deserialize)]
pub struct StartSession {
    /// "continue" | "correct" | "rewrite_selection" | "free"
    pub intent: String,
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub selection_start: Option<usize>,
    #[serde(default)]
    pub selection_end: Option<usize>,
}

fn build_session(
    ctx: &ink_core::context::BookContext,
    body: &StartSession,
) -> AppResult<(String, Turn, Option<&'static [&'static str]>)> {
    let context = render_book_context(ctx);

    match body.intent.as_str() {
        "continue" => {
            let steer = body
                .instruction
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .map(|s| format!(" The author adds this direction: \"{s}\"."))
                .unwrap_or_default();
            let system = format!(
                "You are the AI co-author for this book. Continue the story from where the \
                 current draft leaves off — advance the plot naturally in the established \
                 voice and tone. Use `replace_current` for a substantial continuation, or \
                 `insert_text`/`rewrite_range` for smaller additions.\n\n{context}"
            );
            let user = format!("Continue the story from where it currently stands.{steer}");
            Ok((system, Turn::User(user), None))
        }
        "correct" => {
            let system = format!(
                "You are proofreading this manuscript — nothing else. Fix ONLY spelling, \
                 grammar, and punctuation errors. Do NOT change plot, dialogue meaning, \
                 character voice, or any style choice that isn't an outright error. Make each \
                 fix with a separate, narrowly-scoped `rewrite_range` call covering just the \
                 broken text — never rewrite a whole paragraph to fix one word. If something \
                 looks off but you're not certain it's wrong, leave it and use `add_comment` \
                 instead of changing it.\n\n{context}"
            );
            let user = "Proofread the current draft and fix any spelling, grammar, or \
                punctuation errors you find."
                .to_string();
            Ok((system, Turn::User(user), Some(CORRECTION_TOOLS)))
        }
        "rewrite_selection" => {
            let (start, end) = match (body.selection_start, body.selection_end) {
                (Some(s), Some(e)) if s < e => (s, e),
                _ => {
                    return Err(AppError::bad_request(
                        "rewrite_selection requires selection_start < selection_end",
                    ));
                }
            };
            let instruction = body
                .instruction
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| {
                    AppError::bad_request("rewrite_selection requires an instruction")
                })?;
            let system = format!(
                "You are rewriting one specific passage of this manuscript at the author's \
                 request. Use `rewrite_range` on (at most) characters {start}-{end} of the \
                 current draft — don't touch text outside that range unless strictly necessary \
                 for grammatical continuity at the edges.\n\n{context}"
            );
            let user = format!(
                "Rewrite characters {start}-{end} of the current draft. Instruction: \"{instruction}\""
            );
            Ok((system, Turn::User(user), Some(SELECTION_TOOLS)))
        }
        "free" => {
            let instruction = body
                .instruction
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| AppError::bad_request("free intent requires an instruction"))?;
            let system = format!(
                "You are the AI co-author for this book, acting on a direct instruction from \
                 the author. Use the tools available to you to carry it out.\n\n{context}"
            );
            Ok((system, Turn::User(instruction.to_string()), None))
        }
        other => Err(AppError::bad_request(format!("unknown intent: {other}"))),
    }
}

pub async fn start(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<StartSession>,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let repo_path = load_owned_repo_path(&state, &user, &id).await?;
    let provider = load_provider(&state, &user).await?;

    let ctx_path = repo_path.clone();
    let ctx = blocking::run(move || ink_core::context::get_book_context(&ctx_path)).await?;
    let (system_prompt, user_turn, allowed_tools) = build_session(&ctx, &body)?;

    let tag_path = repo_path.clone();
    let tag = blocking::run(move || ink_core::git::create_snapshot_tag(&tag_path)).await?;

    let inner = run_loop(
        provider,
        system_prompt,
        vec![user_turn],
        repo_path,
        allowed_tools,
    );

    let stream = async_stream::stream! {
        futures::pin_mut!(inner);
        while let Some(event) = inner.next().await {
            yield event;
        }
        yield Ok(Event::default()
            .event("session_done")
            .data(json!({ "tag": tag }).to_string()));
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

#[derive(Debug, Serialize)]
pub struct DiffResponse {
    pub before: String,
    pub after: String,
}

pub async fn diff(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((id, tag)): Path<(String, String)>,
) -> AppResult<Json<DiffResponse>> {
    let repo_path = load_owned_repo_path(&state, &user, &id).await?;

    let before_repo = repo_path.clone();
    let before_tag = tag.clone();
    let before = blocking::run(move || {
        ink_core::git::run_git(
            &before_repo,
            &["show", &format!("{before_tag}:{CURRENT_PATH}")],
        )
    })
    .await?;

    let after_path = repo_path.join("Review").join("current.md");
    let after =
        blocking::run(move || std::fs::read_to_string(&after_path).map_err(anyhow::Error::from))
            .await?;

    Ok(Json(DiffResponse { before, after }))
}
