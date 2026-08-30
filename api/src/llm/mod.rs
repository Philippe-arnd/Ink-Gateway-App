//! Provider-agnostic AI co-author loop.
//!
//! Phil wants to bring either an Anthropic or a Gemini key — the tool-use
//! semantics differ enough between the two APIs (content-block tool_use vs.
//! functionCall parts) that we keep a small internal turn representation and
//! a translator per provider, rather than leaking either wire format into
//! the route handler.

pub mod anthropic;
pub mod gemini;

use anyhow::Result;
use async_trait::async_trait;
use serde_json::{Value, json};

#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: Value,
}

/// One entry in the conversation, in our own provider-agnostic shape.
#[derive(Debug, Clone)]
pub enum Turn {
    User(String),
    AssistantText(String),
    AssistantToolCall {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        id: String,
        name: String,
        output: String,
    },
}

#[derive(Debug, Clone)]
pub enum TurnEvent {
    Text(String),
    ToolCall {
        id: String,
        name: String,
        input: Value,
    },
}

#[async_trait]
pub trait LlmProvider: Send + Sync {
    /// Runs exactly one API round-trip and returns the events it produced
    /// (text and/or tool calls). Non-streaming — the route handler loops
    /// this as needed and streams progress to the browser over its own SSE
    /// connection.
    ///
    /// `allowed_tools`, when set, restricts which tools the provider is
    /// even *offered* — a constrained session (e.g. "correction only")
    /// never sees `replace_current` in its tool list, rather than being
    /// told no after attempting it.
    async fn run_turn(
        &self,
        system_prompt: &str,
        history: &[Turn],
        allowed_tools: Option<&[&str]>,
    ) -> Result<Vec<TurnEvent>>;
}

/// Tools mapped 1:1 onto `ink_core::edit` / `ink_core::comments` — the same
/// primitives the browser editor itself calls, so AI edits and human edits
/// go through the identical git-committed code path.
pub fn tool_specs(allowed: Option<&[&str]>) -> Vec<ToolSpec> {
    all_tool_specs()
        .into_iter()
        .filter(|t| allowed.is_none_or(|names| names.contains(&t.name)))
        .collect()
}

fn all_tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "replace_current",
            description: "Replace the ENTIRE current draft (Review/current.md) with new \
                content. Use this to continue the story or rewrite the whole chapter draft.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "The full new draft text." }
                },
                "required": ["content"]
            }),
        },
        ToolSpec {
            name: "insert_text",
            description: "Insert text at a specific character position in the current draft, \
                without touching the rest.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "position": { "type": "integer", "description": "Character offset to insert at." },
                    "content": { "type": "string" }
                },
                "required": ["position", "content"]
            }),
        },
        ToolSpec {
            name: "rewrite_range",
            description: "Replace the character range [start, end) of the current draft with \
                new content.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "start": { "type": "integer" },
                    "end": { "type": "integer" },
                    "content": { "type": "string" }
                },
                "required": ["start", "end", "content"]
            }),
        },
        ToolSpec {
            name: "add_comment",
            description: "Leave a comment anchored to a character range of the current draft, \
                visible to the human author (e.g. a question or a suggestion you didn't apply).",
            parameters: json!({
                "type": "object",
                "properties": {
                    "anchor_start": { "type": "integer" },
                    "anchor_end": { "type": "integer" },
                    "text": { "type": "string" }
                },
                "required": ["anchor_start", "anchor_end", "text"]
            }),
        },
        ToolSpec {
            name: "resolve_comment",
            description: "Mark an existing comment thread resolved by its id.",
            parameters: json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }),
        },
    ]
}
