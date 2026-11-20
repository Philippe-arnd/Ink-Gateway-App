import type { ChatEvent } from "../../api";

/**
 * The agent's tool calls, rendered as things a person did to the manuscript
 * rather than as function signatures. The editor previously dumped
 * `name({"content":"...the entire manuscript..."})` into a 0.75rem monospace
 * line, which told the author nothing about what had changed.
 */
export interface ToolAction {
  id: string;
  name: string;
  /** Human summary, e.g. "340 mots insérés". */
  summary: string;
  input: Record<string, unknown>;
  /** undefined while the tool is still running. */
  ok?: boolean;
  error?: string;
}

export type ChatMessage =
  | { id: string; role: "user"; text: string }
  | {
      id: string;
      role: "assistant";
      text: string;
      actions: ToolAction[];
      /** True while deltas are still arriving, to drive the caret. */
      streaming: boolean;
    }
  | { id: string; role: "error"; text: string; code?: string };

export interface ChatState {
  messages: ChatMessage[];
  status: "idle" | "streaming";
}

export const initialChatState: ChatState = { messages: [], status: "idle" };

export type ChatAction =
  | { type: "send"; id: string; text: string }
  | { type: "event"; id: string; event: ChatEvent }
  | { type: "failed"; id: string; text: string; code?: string }
  | { type: "settled" }
  | { type: "reset" }
  | { type: "restore"; messages: ChatMessage[] };

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Turns a tool call into a sentence. The server knows more than the browser
 * does here (exact char deltas), so this is a best effort from the arguments
 * until the API grows a `summary` field.
 */
export function summariseToolCall(name: string, input: Record<string, unknown>): string {
  const content = typeof input.content === "string" ? input.content : undefined;
  const text = typeof input.text === "string" ? input.text : undefined;
  const path = typeof input.path === "string" ? input.path : undefined;
  const words = content !== undefined ? wordCount(content) : 0;
  const plural = words === 1 ? "" : "s";

  switch (name) {
    case "replace_current":
      return `Brouillon réécrit — ${words} mot${plural}`;
    case "insert_text": {
      const at = typeof input.position === "number" ? input.position : undefined;
      return at === undefined
        ? `${words} mot${plural} inséré${plural}`
        : `${words} mot${plural} inséré${plural} au caractère ${at}`;
    }
    case "rewrite_range": {
      const start = typeof input.start === "number" ? input.start : undefined;
      const end = typeof input.end === "number" ? input.end : undefined;
      if (start === undefined || end === undefined) return "Passage réécrit";
      const delta = (content?.length ?? 0) - (end - start);
      const sign = delta >= 0 ? "+" : "−";
      return `Passage réécrit (${sign}${Math.abs(delta)} caractères)`;
    }
    case "add_comment":
      return text ? `Commentaire laissé : « ${truncate(text, 60)} »` : "Commentaire laissé";
    case "resolve_comment":
      return "Commentaire marqué résolu";
    case "rewrite_global_file":
      return path ? `${basename(path)} développé — ${words} mot${plural}` : "Document de fond mis à jour";
    default:
      return name;
  }
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Tools that change the manuscript, so the UI can offer to re-read it. */
export const WRITING_TOOLS = new Set([
  "replace_current",
  "insert_text",
  "rewrite_range",
  "rewrite_global_file",
]);

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "reset":
      return initialChatState;

    case "restore":
      return { messages: action.messages, status: "idle" };

    case "send":
      return {
        status: "streaming",
        messages: [
          ...state.messages,
          { id: `${action.id}-u`, role: "user", text: action.text },
          { id: action.id, role: "assistant", text: "", actions: [], streaming: true },
        ],
      };

    case "failed":
      return {
        status: "idle",
        messages: [
          ...dropEmptyAssistant(state.messages, action.id),
          { id: `${action.id}-e`, role: "error", text: action.text, code: action.code },
        ],
      };

    case "settled":
      return {
        status: "idle",
        messages: state.messages.map((m) =>
          m.role === "assistant" && m.streaming ? { ...m, streaming: false } : m,
        ),
      };

    case "event":
      return { ...state, messages: applyEvent(state.messages, action.id, action.event) };
  }
}

/** An assistant turn that produced nothing at all is noise next to the error. */
function dropEmptyAssistant(messages: ChatMessage[], id: string): ChatMessage[] {
  return messages.filter(
    (m) => !(m.id === id && m.role === "assistant" && !m.text && m.actions.length === 0),
  );
}

function applyEvent(messages: ChatMessage[], id: string, event: ChatEvent): ChatMessage[] {
  return messages.map((message) => {
    if (message.id !== id || message.role !== "assistant") return message;

    switch (event.type) {
      case "text":
        // Appended to the message already in flight. The editor used to push
        // a new bubble per delta, so one paragraph rendered as a stack of
        // dozens of separate boxes.
        return { ...message, text: message.text + event.data };

      case "tool_call": {
        const input =
          event.data.input && typeof event.data.input === "object"
            ? (event.data.input as Record<string, unknown>)
            : {};
        return {
          ...message,
          actions: [
            ...message.actions,
            {
              id: `${id}-t${message.actions.length}`,
              name: event.data.name,
              summary: summariseToolCall(event.data.name, input),
              input,
            },
          ],
        };
      }

      case "tool_result": {
        // Matched to the newest unresolved call of that name — the wire
        // carries no call id, so position is all we have.
        const index = findPendingAction(message.actions, event.data.name);
        if (index === -1) return message;
        const parsed = safeParse(event.data.output);
        const errored = typeof parsed?.error === "string";
        const actions = [...message.actions];
        actions[index] = {
          ...actions[index],
          ok: !errored,
          error: errored ? (parsed?.error as string) : undefined,
        };
        return { ...message, actions };
      }

      default:
        return message;
    }
  });
}

function findPendingAction(actions: ToolAction[], name: string): number {
  for (let i = actions.length - 1; i >= 0; i--) {
    if (actions[i].name === name && actions[i].ok === undefined) return i;
  }
  return -1;
}

function safeParse(output: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(output);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Whether this turn touched the manuscript, so the canvas needs re-reading. */
export function turnChangedManuscript(message: ChatMessage): boolean {
  return (
    message.role === "assistant" &&
    message.actions.some((a) => a.ok !== false && WRITING_TOOLS.has(a.name))
  );
}
