//! The freeform conversational co-author: SSE stream of the shared agent
//! loop (`crate::agent`), unrestricted tool access, no diff-review ceremony
//! — for quick back-and-forth, as opposed to the intent-typed writing
//! sessions in `sessions.rs` which snapshot before and surface a diff after.

use std::convert::Infallible;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use futures::stream::Stream;
use serde::Deserialize;

use super::books::load_owned_repo_path;
use crate::agent::{load_provider, render_book_context, run_loop};
use crate::auth::CurrentUser;
use crate::blocking;
use crate::error::AppResult;
use crate::llm::{DEFAULT_TOOLS, Turn};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct ChatBody {
    pub message: String,
}

fn build_system_prompt(ctx: &ink_core::context::BookContext) -> String {
    format!(
        "You are the AI co-author for this book, collaborating directly with a human \
         writer through a live editor. You edit the manuscript yourself using the tools \
         available to you — you don't just describe changes, you make them.\n\n\
         {context}\n\n\
         Guidelines: stay in the established voice and tone. Prefer `replace_current` for \
         continuing the story or large rewrites; use `insert_text`/`rewrite_range` for small, \
         surgical edits. Use `add_comment` for a question or a note you don't want to resolve \
         by editing directly. After acting, briefly explain what you did in plain text.",
        context = render_book_context(ctx),
    )
}

pub async fn chat(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<ChatBody>,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let repo_path = load_owned_repo_path(&state, &user, &id).await?;
    let provider = load_provider(&state, &user).await?;

    let ctx_path = repo_path.clone();
    let ctx = blocking::run(move || ink_core::context::get_book_context(&ctx_path)).await?;
    let system_prompt = build_system_prompt(&ctx);
    let history = vec![Turn::User(body.message)];

    let stream = run_loop(
        provider,
        system_prompt,
        history,
        repo_path,
        Some(DEFAULT_TOOLS),
        state,
        user.id,
    );
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}
