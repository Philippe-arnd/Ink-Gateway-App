//! The shared agent tool-use loop — used by both the live chat endpoint and
//! the writing-session endpoint. One code path so both always execute tools
//! identically and stream the same SSE event shapes to the browser.

use std::convert::Infallible;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use async_stream::stream;
use axum::response::sse::Event;
use futures::stream::Stream;
use serde_json::{Value, json};

use crate::auth::CurrentUser;
use crate::blocking;
use crate::error::{AppError, AppResult};
use crate::llm::anthropic::{AnthropicProvider, AuthMode};
use crate::llm::gemini::GeminiProvider;
use crate::llm::{LlmProvider, Turn, TurnEvent};
use crate::state::AppState;

const MAX_TOOL_TURNS: u8 = 6;

pub async fn load_provider(
    state: &AppState,
    user: &CurrentUser,
) -> AppResult<Box<dyn LlmProvider>> {
    let row = sqlx::query_as::<_, (String, String, String)>(
        "SELECT provider, key_type, encrypted_key FROM api_keys WHERE user_id = ?",
    )
    .bind(&user.id)
    .fetch_optional(&state.db)
    .await?;

    let (provider, key_type, encrypted_key) = row.ok_or_else(|| {
        AppError::bad_request(
            "no AI provider key configured — add one in Settings before chatting with the co-author",
        )
    })?;

    let credential = state.cipher.decrypt(&encrypted_key)?;

    Ok(match provider.as_str() {
        "anthropic" => {
            let auth_mode = match key_type.as_str() {
                "oauth_token" => AuthMode::OAuthToken,
                _ => AuthMode::ApiKey,
            };
            Box::new(AnthropicProvider::new(credential, auth_mode))
        }
        "gemini" => Box::new(GeminiProvider::new(credential)),
        other => return Err(AppError::bad_request(format!("unknown provider: {other}"))),
    })
}

/// Renders the shared "book context" block (global material + current
/// chapter outline + open comments) used by every system prompt, chat or
/// session. Keeps both entry points looking at the same information.
pub fn render_book_context(ctx: &ink_core::context::BookContext) -> String {
    let global: String = ctx
        .global_material
        .iter()
        .map(|f| format!("### {}\n{}", f.filename, f.content))
        .collect::<Vec<_>>()
        .join("\n\n");

    let chapter = ctx
        .current_chapter
        .as_ref()
        .map(|c| format!("### Current chapter outline ({})\n{}", c.path, c.content))
        .unwrap_or_default();

    let comments: String = ctx
        .comments
        .iter()
        .filter(|c| !c.resolved)
        .map(|c| {
            format!(
                "- [{}] chars {}-{}: {}",
                c.id, c.anchor_start, c.anchor_end, c.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "{global}\n\n{chapter}\n\n\
         ### Current draft (Review/current.md) — {char_count} characters, addressable by \
         character offset for insert_text/rewrite_range\n\
         ---\n{current}\n---\n\n\
         ### Open comment threads\n{comments}",
        char_count = ctx.current.chars().count(),
        current = ctx.current,
        comments = if comments.is_empty() {
            "(none)".to_string()
        } else {
            comments
        },
    )
}

pub async fn execute_tool(repo_path: PathBuf, name: &str, input: &Value) -> Result<String> {
    let str_field = |field: &str| -> Result<String> {
        input
            .get(field)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| anyhow::anyhow!("missing or non-string field: {field}"))
    };
    let uint_field = |field: &str| -> Result<usize> {
        input
            .get(field)
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
            .ok_or_else(|| anyhow::anyhow!("missing or non-integer field: {field}"))
    };

    let result: Value = match name {
        "replace_current" => {
            let content = str_field("content")?;
            blocking::run(move || {
                let current_path = repo_path.join("Review").join("current.md");
                // Missing file = legitimately empty draft (len 0). Any other
                // read error must propagate — silently treating it as "empty"
                // would make rewrite_range(0, 0, ..) *insert* at the start
                // instead of replacing, duplicating whatever's actually there.
                let len = match std::fs::read_to_string(&current_path) {
                    Ok(s) => s.chars().count(),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
                    Err(e) => {
                        return Err(e).context("failed to read Review/current.md");
                    }
                };
                ink_core::edit::rewrite_range(&repo_path, 0, len, &content)
            })
            .await?
        }
        "insert_text" => {
            let position = uint_field("position")?;
            let content = str_field("content")?;
            blocking::run(move || ink_core::edit::insert_text(&repo_path, position, &content))
                .await?
        }
        "rewrite_range" => {
            let start = uint_field("start")?;
            let end = uint_field("end")?;
            let content = str_field("content")?;
            blocking::run(move || ink_core::edit::rewrite_range(&repo_path, start, end, &content))
                .await?
        }
        "add_comment" => {
            let anchor_start = uint_field("anchor_start")?;
            let anchor_end = uint_field("anchor_end")?;
            let text = str_field("text")?;
            let comment = blocking::run(move || {
                ink_core::comments::add_comment(&repo_path, anchor_start, anchor_end, "ai", &text)
            })
            .await?;
            serde_json::to_value(comment)?
        }
        "resolve_comment" => {
            let id = str_field("id")?;
            let comment =
                blocking::run(move || ink_core::comments::resolve_comment(&repo_path, &id)).await?;
            serde_json::to_value(comment)?
        }
        other => bail!("unknown tool: {other}"),
    };

    Ok(result.to_string())
}

/// Runs the tool-use loop, yielding one SSE event per text chunk / tool call
/// / tool result. `allowed_tools`, when set, is passed to the provider so it
/// only ever *sees* (and therefore can only call) that subset — e.g. a
/// "correction only" session never has `replace_current` in its tool list,
/// rather than being told no after attempting it.
pub fn run_loop(
    provider: Box<dyn LlmProvider>,
    system_prompt: String,
    mut history: Vec<Turn>,
    repo_path: PathBuf,
    allowed_tools: Option<&'static [&'static str]>,
) -> impl Stream<Item = Result<Event, Infallible>> {
    stream! {
        for _ in 0..MAX_TOOL_TURNS {
            let events = match provider.run_turn(&system_prompt, &history, allowed_tools).await {
                Ok(events) => events,
                Err(err) => {
                    yield Ok(Event::default().event("error").data(err.to_string()));
                    return;
                }
            };

            let mut had_tool_call = false;

            for event in events {
                match event {
                    TurnEvent::Text(text) => {
                        history.push(Turn::AssistantText(text.clone()));
                        yield Ok(Event::default().event("text").data(text));
                    }
                    TurnEvent::ToolCall { id: call_id, name, input } => {
                        had_tool_call = true;
                        history.push(Turn::AssistantToolCall {
                            id: call_id.clone(),
                            name: name.clone(),
                            input: input.clone(),
                        });
                        yield Ok(Event::default()
                            .event("tool_call")
                            .data(json!({ "name": name, "input": input }).to_string()));

                        let output = match execute_tool(repo_path.clone(), &name, &input).await {
                            Ok(output) => output,
                            Err(err) => json!({ "error": err.to_string() }).to_string(),
                        };
                        history.push(Turn::ToolResult {
                            id: call_id,
                            name: name.clone(),
                            output: output.clone(),
                        });
                        yield Ok(Event::default()
                            .event("tool_result")
                            .data(json!({ "name": name, "output": output }).to_string()));
                    }
                }
            }

            if !had_tool_call {
                break;
            }
        }

        yield Ok(Event::default().event("done").data(""));
    }
}
