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
use crate::llm::{DEFAULT_TOOLS, Turn};
use crate::state::AppState;

const CORRECTION_TOOLS: &[&str] = &["rewrite_range", "add_comment"];
const SELECTION_TOOLS: &[&str] = &["rewrite_range"];
const EXPAND_FOUNDATIONS_TOOLS: &[&str] = &["rewrite_global_file"];

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
            Ok((system, Turn::User(user), Some(DEFAULT_TOOLS)))
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
            Ok((
                system,
                Turn::User(instruction.to_string()),
                Some(DEFAULT_TOOLS),
            ))
        }
        "expand_foundations" => {
            let system = format!(
                "You are helping the author flesh out their book's foundational files, right \
                 after their initial setup questionnaire. Soul.md, Characters.md, Outline.md, \
                 Lore.md, and Chapter_01.md below currently hold only the author's short, \
                 one-line answers, written down verbatim. Expand EACH of these 5 files into a \
                 substantially richer, more detailed draft — several developed paragraphs per \
                 file, not a rewrite of the premise, only an elaboration faithful to what the \
                 author already said (don't invent contradictory facts). Call \
                 `rewrite_global_file` once per file with that file's full new content. Cover \
                 all 5 files before finishing.\n\n{context}"
            );
            let user = "Expand the current one-line answers in Soul.md, Characters.md, \
                Outline.md, Lore.md, and Chapter_01.md into detailed, well-developed \
                foundational documents."
                .to_string();
            Ok((system, Turn::User(user), Some(EXPAND_FOUNDATIONS_TOOLS)))
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
        state,
        user.id,
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
pub struct FileDiff {
    pub path: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Serialize)]
pub struct DiffResponse {
    pub files: Vec<FileDiff>,
}

pub async fn diff(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((id, tag)): Path<(String, String)>,
) -> AppResult<Json<DiffResponse>> {
    let repo_path = load_owned_repo_path(&state, &user, &id).await?;

    let paths = {
        let (repo, tag) = (repo_path.clone(), tag.clone());
        blocking::run(move || ink_core::git::changed_files(&repo, &tag)).await?
    };

    let mut files = Vec::with_capacity(paths.len());
    for path in paths {
        let before = {
            let (repo, tag, path) = (repo_path.clone(), tag.clone(), path.clone());
            blocking::run(move || {
                match ink_core::git::run_git(&repo, &["show", &format!("{tag}:{path}")]) {
                    Ok(content) => Ok(content),
                    // Path didn't exist yet at the snapshot tag — no prior content to
                    // show, rather than failing the whole diff over a brand-new file.
                    Err(e) if e.to_string().contains("does not exist") => Ok(String::new()),
                    Err(e) => Err(e),
                }
            })
            .await?
        };
        let after = {
            let full_path = repo_path.join(&path);
            blocking::run(move || std::fs::read_to_string(&full_path).map_err(anyhow::Error::from))
                .await?
        };
        files.push(FileDiff {
            path,
            before,
            after,
        });
    }

    Ok(Json(DiffResponse { files }))
}
