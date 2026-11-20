import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../../api";
import {
  chatReducer,
  initialChatState,
  summariseToolCall,
  turnChangedManuscript,
  type ChatState,
} from "./chatState";

const ID = "m1";

function send(text = "continue"): ChatState {
  return chatReducer(initialChatState, { type: "send", id: ID, text });
}

function feed(state: ChatState, ...events: ChatEvent[]): ChatState {
  return events.reduce((s, event) => chatReducer(s, { type: "event", id: ID, event }), state);
}

function assistant(state: ChatState) {
  const message = state.messages.find((m) => m.id === ID);
  if (message?.role !== "assistant") throw new Error("no assistant message");
  return message;
}

describe("chatReducer streaming", () => {
  it("adds a user message and a streaming assistant placeholder", () => {
    const state = send("écris la suite");
    expect(state.status).toBe("streaming");
    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(assistant(state).streaming).toBe(true);
  });

  it("accumulates text deltas into ONE message", () => {
    // The regression this guards: the editor pushed a new bubble per delta,
    // so a single paragraph rendered as a stack of dozens of boxes.
    const state = feed(
      send(),
      { type: "text", data: "Le phare " },
      { type: "text", data: "était " },
      { type: "text", data: "vide." },
    );
    expect(state.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(assistant(state).text).toBe("Le phare était vide.");
  });

  it("preserves newlines across deltas", () => {
    const state = feed(send(), { type: "text", data: "un\n\n" }, { type: "text", data: "deux" });
    expect(assistant(state).text).toBe("un\n\ndeux");
  });

  it("records a tool call as a pending action with a human summary", () => {
    const state = feed(send(), {
      type: "tool_call",
      data: { name: "insert_text", input: { position: 120, content: "one two three" } },
    });
    const [action] = assistant(state).actions;
    expect(action.name).toBe("insert_text");
    expect(action.summary).toBe("3 mots insérés au caractère 120");
    expect(action.ok).toBeUndefined();
  });

  it("resolves a tool result against its pending call", () => {
    const state = feed(
      send(),
      { type: "tool_call", data: { name: "insert_text", input: { position: 0, content: "x" } } },
      { type: "tool_result", data: { name: "insert_text", output: '{"word_count":1}' } },
    );
    expect(assistant(state).actions[0].ok).toBe(true);
  });

  it("marks a tool result carrying an error as failed", () => {
    const state = feed(
      send(),
      { type: "tool_call", data: { name: "rewrite_range", input: { start: 0, end: 5, content: "x" } } },
      { type: "tool_result", data: { name: "rewrite_range", output: '{"error":"out of range"}' } },
    );
    expect(assistant(state).actions[0]).toMatchObject({ ok: false, error: "out of range" });
  });

  it("resolves results in order when one tool is called repeatedly", () => {
    // There is no call id on the wire, so matching is by newest-pending.
    let state = feed(
      send(),
      { type: "tool_call", data: { name: "rewrite_range", input: { start: 0, end: 1, content: "a" } } },
      { type: "tool_result", data: { name: "rewrite_range", output: "{}" } },
      { type: "tool_call", data: { name: "rewrite_range", input: { start: 5, end: 6, content: "b" } } },
    );
    expect(state.messages.length).toBe(2);
    state = feed(state, {
      type: "tool_result",
      data: { name: "rewrite_range", output: '{"error":"nope"}' },
    });
    const actions = assistant(state).actions;
    expect(actions[0].ok).toBe(true);
    expect(actions[1].ok).toBe(false);
  });

  it("tolerates a result with no matching call", () => {
    const state = feed(send(), { type: "tool_result", data: { name: "ghost", output: "{}" } });
    expect(assistant(state).actions).toEqual([]);
  });

  it("tolerates unparseable tool output by treating it as success", () => {
    const state = feed(
      send(),
      { type: "tool_call", data: { name: "insert_text", input: { position: 0, content: "x" } } },
      { type: "tool_result", data: { name: "insert_text", output: "not json" } },
    );
    expect(assistant(state).actions[0].ok).toBe(true);
  });

  it("clears the streaming flag and status when settled", () => {
    const state = chatReducer(feed(send(), { type: "text", data: "done" }), { type: "settled" });
    expect(state.status).toBe("idle");
    expect(assistant(state).streaming).toBe(false);
  });

  it("tolerates a non-object tool input", () => {
    const state = feed(send(), {
      type: "tool_call",
      data: { name: "insert_text", input: "oops" },
    });
    expect(assistant(state).actions[0].input).toEqual({});
  });
});

describe("chatReducer failure", () => {
  it("drops an assistant turn that produced nothing, keeping only the error", () => {
    const state = chatReducer(send(), { type: "failed", id: ID, text: "pas de clé", code: "no_provider_key" });
    expect(state.status).toBe("idle");
    expect(state.messages.map((m) => m.role)).toEqual(["user", "error"]);
    const err = state.messages[1];
    expect(err.role === "error" && err.code).toBe("no_provider_key");
  });

  it("keeps a partial assistant turn alongside the error", () => {
    const partial = feed(send(), { type: "text", data: "j'ai commencé" });
    const state = chatReducer(partial, { type: "failed", id: ID, text: "coupé" });
    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant", "error"]);
  });
});

describe("summariseToolCall", () => {
  it("reports a rewrite as a signed character delta", () => {
    // Replacing 10 characters with 3 is a net loss of 7.
    expect(summariseToolCall("rewrite_range", { start: 0, end: 10, content: "abc" })).toBe(
      "Passage réécrit (−7 caractères)",
    );
    expect(summariseToolCall("rewrite_range", { start: 0, end: 1, content: "abcd" })).toBe(
      "Passage réécrit (+3 caractères)",
    );
  });

  it("uses the file's basename for a foundation rewrite", () => {
    expect(summariseToolCall("rewrite_global_file", { path: "Global Material/Soul.md", content: "a b" })).toBe(
      "Soul.md développé — 2 mots",
    );
  });

  it("singularises one word", () => {
    expect(summariseToolCall("insert_text", { position: 4, content: "mot" })).toBe(
      "1 mot inséré au caractère 4",
    );
  });

  it("quotes and truncates a long comment", () => {
    const summary = summariseToolCall("add_comment", { text: "x".repeat(200) });
    expect(summary.length).toBeLessThan(90);
    expect(summary.endsWith("… »")).toBe(true);
  });

  it("falls back to the raw name for an unknown tool", () => {
    expect(summariseToolCall("future_tool", {})).toBe("future_tool");
  });
});

describe("turnChangedManuscript", () => {
  it("is true when a writing tool succeeded", () => {
    const state = feed(
      send(),
      { type: "tool_call", data: { name: "insert_text", input: { position: 0, content: "x" } } },
      { type: "tool_result", data: { name: "insert_text", output: "{}" } },
    );
    expect(turnChangedManuscript(assistant(state))).toBe(true);
  });

  it("is false when the only writing tool failed", () => {
    const state = feed(
      send(),
      { type: "tool_call", data: { name: "insert_text", input: { position: 0, content: "x" } } },
      { type: "tool_result", data: { name: "insert_text", output: '{"error":"no"}' } },
    );
    expect(turnChangedManuscript(assistant(state))).toBe(false);
  });

  it("is false for a comment-only turn, which leaves the prose untouched", () => {
    const state = feed(
      send(),
      { type: "tool_call", data: { name: "add_comment", input: { text: "hmm" } } },
      { type: "tool_result", data: { name: "add_comment", output: "{}" } },
    );
    expect(turnChangedManuscript(assistant(state))).toBe(false);
  });
});
