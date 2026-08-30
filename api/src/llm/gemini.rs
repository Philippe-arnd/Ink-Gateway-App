use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use serde_json::{Value, json};
use ureq::Agent;

use super::{LlmProvider, Turn, TurnEvent, tool_specs};

pub struct GeminiProvider {
    api_key: String,
    model: String,
    agent: Agent,
}

impl GeminiProvider {
    pub fn new(api_key: String) -> Self {
        let model =
            std::env::var("GEMINI_MODEL").unwrap_or_else(|_| "gemini-2.5-flash".to_string());
        let config = Agent::config_builder().http_status_as_error(false).build();
        Self {
            api_key,
            model,
            agent: Agent::new_with_config(config),
        }
    }
}

fn to_contents(history: &[Turn]) -> Vec<Value> {
    let mut contents: Vec<(&'static str, Value)> = Vec::new();
    for turn in history {
        let (role, part) = match turn {
            Turn::User(text) => ("user", json!({ "text": text })),
            Turn::AssistantText(text) => ("model", json!({ "text": text })),
            Turn::AssistantToolCall { name, input, .. } => (
                "model",
                json!({ "functionCall": { "name": name, "args": input } }),
            ),
            Turn::ToolResult { name, output, .. } => (
                "function",
                json!({ "functionResponse": { "name": name, "response": { "result": output } } }),
            ),
        };
        if let Some(last) = contents.last_mut()
            && last.0 == role
        {
            last.1
                .as_array_mut()
                .expect("parts is always an array")
                .push(part);
            continue;
        }
        contents.push((role, Value::Array(vec![part])));
    }
    contents
        .into_iter()
        .map(|(role, parts)| json!({ "role": role, "parts": parts }))
        .collect()
}

#[async_trait]
impl LlmProvider for GeminiProvider {
    async fn run_turn(&self, system_prompt: &str, history: &[Turn]) -> Result<Vec<TurnEvent>> {
        let function_declarations: Vec<Value> = tool_specs()
            .into_iter()
            .map(|t| {
                json!({ "name": t.name, "description": t.description, "parameters": t.parameters })
            })
            .collect();

        let body = json!({
            "system_instruction": { "parts": [{ "text": system_prompt }] },
            "contents": to_contents(history),
            "tools": [{ "functionDeclarations": function_declarations }],
        });

        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
            self.model
        );

        let agent = self.agent.clone();
        let api_key = self.api_key.clone();

        let payload: Value = tokio::task::spawn_blocking(move || -> Result<Value> {
            let mut resp = agent
                .post(&url)
                .header("x-goog-api-key", &api_key)
                .send_json(&body)
                .context("failed to reach the Gemini API")?;

            let status = resp.status();
            let payload: Value = resp
                .body_mut()
                .read_json()
                .context("failed to parse the Gemini API response")?;

            if !status.is_success() {
                let message = payload
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("unknown error");
                bail!("Gemini API error ({status}): {message}");
            }

            Ok(payload)
        })
        .await
        .context("blocking task panicked")??;

        let parts = payload
            .get("candidates")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("content"))
            .and_then(|c| c.get("parts"))
            .and_then(|p| p.as_array())
            .cloned()
            .unwrap_or_default();

        let mut events = Vec::new();
        for (i, part) in parts.iter().enumerate() {
            if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                events.push(TurnEvent::Text(text.to_string()));
            } else if let Some(call) = part.get("functionCall") {
                let name = call
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let input = call.get("args").cloned().unwrap_or(json!({}));
                // Gemini doesn't assign call ids — synthesize a stable one per response.
                events.push(TurnEvent::ToolCall {
                    id: format!("call-{i}"),
                    name,
                    input,
                });
            }
        }

        Ok(events)
    }
}
