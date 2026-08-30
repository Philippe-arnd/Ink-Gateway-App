use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use serde_json::{Value, json};
use ureq::Agent;

use super::{LlmProvider, Turn, TurnEvent, tool_specs};

/// Anthropic accepts two credential shapes: a classic `sk-ant-...` API key
/// (metered billing, `x-api-key` header) or an OAuth token tied to a Claude
/// Pro/Max subscription (the "super-token" from `claude setup-token` /
/// logging into a Claude account — usage draws against the subscription
/// instead of pay-per-token billing). OAuth tokens go on `Authorization:
/// Bearer` plus the `anthropic-beta: oauth-2025-04-20` header — not a plain
/// key swap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    ApiKey,
    OAuthToken,
}

pub struct AnthropicProvider {
    credential: String,
    auth_mode: AuthMode,
    model: String,
    agent: Agent,
}

impl AnthropicProvider {
    pub fn new(credential: String, auth_mode: AuthMode) -> Self {
        let model =
            std::env::var("ANTHROPIC_MODEL").unwrap_or_else(|_| "claude-sonnet-5".to_string());
        // Read the body ourselves on non-2xx too, so API error messages are visible.
        let config = Agent::config_builder().http_status_as_error(false).build();
        Self {
            credential,
            auth_mode,
            model,
            agent: Agent::new_with_config(config),
        }
    }
}

/// Anthropic requires strict user/assistant alternation with tool_use in an
/// assistant message and the matching tool_result in the following user
/// message — merge consecutive same-role turns into one message.
fn to_messages(history: &[Turn]) -> Vec<Value> {
    let mut messages: Vec<(&'static str, Value)> = Vec::new();
    for turn in history {
        let (role, block) = match turn {
            Turn::User(text) => ("user", json!({ "type": "text", "text": text })),
            Turn::AssistantText(text) => ("assistant", json!({ "type": "text", "text": text })),
            Turn::AssistantToolCall { id, name, input } => (
                "assistant",
                json!({ "type": "tool_use", "id": id, "name": name, "input": input }),
            ),
            Turn::ToolResult { id, output, .. } => (
                "user",
                json!({ "type": "tool_result", "tool_use_id": id, "content": output }),
            ),
        };
        if let Some(last) = messages.last_mut()
            && last.0 == role
        {
            last.1
                .as_array_mut()
                .expect("content is always an array")
                .push(block);
            continue;
        }
        messages.push((role, Value::Array(vec![block])));
    }
    messages
        .into_iter()
        .map(|(role, content)| json!({ "role": role, "content": content }))
        .collect()
}

#[async_trait]
impl LlmProvider for AnthropicProvider {
    async fn run_turn(&self, system_prompt: &str, history: &[Turn]) -> Result<Vec<TurnEvent>> {
        let tools: Vec<Value> = tool_specs()
            .into_iter()
            .map(|t| {
                json!({ "name": t.name, "description": t.description, "input_schema": t.parameters })
            })
            .collect();

        let body = json!({
            "model": self.model,
            "max_tokens": 4096,
            "system": system_prompt,
            "messages": to_messages(history),
            "tools": tools,
        });

        let agent = self.agent.clone();
        let credential = self.credential.clone();
        let auth_mode = self.auth_mode;

        let payload: Value = tokio::task::spawn_blocking(move || -> Result<Value> {
            let mut request = agent
                .post("https://api.anthropic.com/v1/messages")
                .header("anthropic-version", "2023-06-01");
            request = match auth_mode {
                AuthMode::ApiKey => request.header("x-api-key", &credential),
                AuthMode::OAuthToken => request
                    .header("authorization", &format!("Bearer {credential}"))
                    .header("anthropic-beta", "oauth-2025-04-20"),
            };

            let mut resp = request
                .send_json(&body)
                .context("failed to reach the Anthropic API")?;

            let status = resp.status();
            let payload: Value = resp
                .body_mut()
                .read_json()
                .context("failed to parse the Anthropic API response")?;

            if !status.is_success() {
                let message = payload
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("unknown error");
                bail!("Anthropic API error ({status}): {message}");
            }

            Ok(payload)
        })
        .await
        .context("blocking task panicked")??;

        let content = payload
            .get("content")
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();

        let mut events = Vec::new();
        for block in content {
            match block.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                        events.push(TurnEvent::Text(text.to_string()));
                    }
                }
                Some("tool_use") => {
                    let id = block
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let name = block
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let input = block.get("input").cloned().unwrap_or(json!({}));
                    events.push(TurnEvent::ToolCall { id, name, input });
                }
                _ => {}
            }
        }

        Ok(events)
    }
}
