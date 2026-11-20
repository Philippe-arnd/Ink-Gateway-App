const BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8790";

/// Mirrors `api/src/error.rs`'s `code` module. Branch on these, never on the
/// human-readable message.
export type ErrorCode =
  | "unauthenticated"
  | "not_found"
  | "validation"
  | "no_provider_key"
  | "provider_auth"
  | "draft_conflict"
  | "chapter_not_ready"
  | "needs_chapter_outline"
  | "rate_limited"
  | "limit_reached"
  | "internal"
  | "network";

export class ApiError extends Error {
  status: number;
  code: ErrorCode;
  details?: unknown;

  constructor(status: number, message: string, code: ErrorCode = "internal", details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Set by the app shell. Any 401 means the server-side session is gone — which
 * happens on every deploy, because sessions live in an in-memory store — so
 * this has to be handled centrally rather than per page.
 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

function parseErrorBody(body: unknown, fallback: string): { message: string; code: ErrorCode; details?: unknown } {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    return {
      message: typeof b.error === "string" ? b.error : fallback,
      code: (typeof b.code === "string" ? b.code : "internal") as ErrorCode,
      details: b.details,
    };
  }
  return { message: fallback, code: "internal" };
}

async function toApiError(res: Response): Promise<ApiError> {
  const body = await res.json().catch(() => null);
  const { message, code, details } = parseErrorBody(body, res.statusText || `HTTP ${res.status}`);
  if (res.status === 401) onUnauthorized?.();
  return new ApiError(res.status, message, res.status === 401 ? "unauthenticated" : code, details);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    // `init` is spread first so an explicit `headers` can be merged rather
    // than silently replacing content-type.
    res = await fetch(`${BASE}${path}`, {
      ...init,
      credentials: "include",
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "Connexion au serveur impossible.", "network");
  }

  if (!res.ok) throw await toApiError(res);

  // Several endpoints (logout, delete key, restore) answer 204 or an empty
  // body; calling res.json() on those threw a SyntaxError that escaped every
  // `instanceof ApiError` branch in the UI.
  if (res.status === 204) return undefined as T;
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export interface UserView {
  id: string;
  email: string;
}

export interface Book {
  id: string;
  title: string;
  created_at: string;
}

export interface FileContent {
  filename: string;
  content: string;
}

export interface ChapterInfo {
  path: string;
  content: string;
  modified_today: boolean;
}

export interface Comment {
  id: string;
  anchor_start: number;
  anchor_end: number;
  author: string;
  text: string;
  resolved: boolean;
  created_at: string;
}

export interface WordCount {
  total: number;
  target: number;
  remaining: number;
}

export interface BookContext {
  config: {
    target_length: number;
    chapter_count: number;
    chapter_structure: string;
    words_per_session: number;
    summary_context_entries: number;
    words_per_chapter: number;
    current_chapter: number;
  };
  global_material: FileContent[];
  current_chapter: ChapterInfo | null;
  current: string;
  comments: Comment[];
  word_count: WordCount;
}

export interface ChapterSummary {
  number: number;
  title: string;
  /** False for a chapter planned by `chapter_count` with no outline file. */
  has_outline: boolean;
  is_current: boolean;
  word_count: number;
}

export interface ChapterList {
  chapters: ChapterSummary[];
  current_chapter: number;
  chapter_count: number;
}

export interface ChapterDetail {
  number: number;
  path: string;
  title: string;
  content: string;
  modified_today: boolean;
}

/** `ink_core::maintenance::book_status` — the whole progress payload. */
export interface BookStats {
  initialized: boolean;
  complete: boolean;
  current_chapter: number;
  current_chapter_word_count: number;
  words_per_chapter: number;
  chapter_close_suggested: boolean;
  total_word_count: number;
  target_length: number;
  words_per_session: number;
  completion_ready: boolean;
}

export interface VersionEntry {
  commit: string;
  date: string;
  message: string;
}

export interface VersionPage {
  versions: VersionEntry[];
  next_cursor: number | null;
}

export interface ApiKeyStatus {
  configured: boolean;
  provider: string | null;
  key_type: string | null;
  last_four: string | null;
  last_error: string | null;
}

export interface OnboardingQuestion {
  question: string;
  hint: string;
  target_file: string;
  options?: string[];
}

export const api = {
  register: (email: string, password: string, invite_code: string) =>
    request<UserView>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, invite_code }),
    }),
  login: (email: string, password: string) =>
    request<UserView>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request("/auth/logout", { method: "POST" }),
  me: () => request<UserView>("/auth/me"),
  forgotPassword: (email: string) =>
    request("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) }),
  resetPassword: (token: string, new_password: string) =>
    request("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, new_password }),
    }),

  listBooks: () => request<Book[]>("/books"),
  createBook: (title: string, slug: string) =>
    request<Book>("/books", { method: "POST", body: JSON.stringify({ title, slug }) }),
  getBook: (id: string) => request<BookContext>(`/books/${id}`),
  saveGlobalMaterial: (id: string, path: string, content: string) =>
    request<{ word_count: number; char_count: number }>(`/books/${id}/global-material`, {
      method: "POST",
      body: JSON.stringify({ path, content }),
    }),

  insertText: (id: string, position: number, content: string) =>
    request(`/books/${id}/edit/insert`, {
      method: "POST",
      body: JSON.stringify({ position, content }),
    }),
  rewriteRange: (id: string, start: number, end: number, content: string) =>
    request(`/books/${id}/edit/rewrite`, {
      method: "POST",
      body: JSON.stringify({ start, end, content }),
    }),

  listComments: (id: string) => request<Comment[]>(`/books/${id}/comments`),
  addComment: (id: string, anchor_start: number, anchor_end: number, text: string) =>
    request<Comment>(`/books/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ anchor_start, anchor_end, text }),
    }),
  resolveComment: (id: string, commentId: string) =>
    request<Comment>(`/books/${id}/comments/${commentId}/resolve`, { method: "POST" }),

  listVersions: (id: string, path = "Review/current.md", limit?: number, cursor?: number) => {
    const params = new URLSearchParams({ path });
    if (limit !== undefined) params.set("limit", String(limit));
    if (cursor !== undefined) params.set("cursor", String(cursor));
    return request<VersionPage>(`/books/${id}/versions?${params}`);
  },
  restoreVersion: (id: string, commit: string, path = "Review/current.md") =>
    request(`/books/${id}/versions/restore`, {
      method: "POST",
      body: JSON.stringify({ path, commit }),
    }),

  listChapters: (id: string) => request<ChapterList>(`/books/${id}/chapters`),
  getChapter: (id: string, number: number) =>
    request<ChapterDetail>(`/books/${id}/chapters/${number}`),
  advanceChapter: (id: string) =>
    request<{ status: string }>(`/books/${id}/chapters/advance`, { method: "POST" }),
  getStats: (id: string) => request<BookStats>(`/books/${id}/stats`),

  getApiKey: () => request<ApiKeyStatus>("/settings/api-key"),
  setApiKey: (provider: string, api_key: string, key_type: "api_key" | "oauth_token" = "api_key") =>
    request<ApiKeyStatus>("/settings/api-key", {
      method: "POST",
      body: JSON.stringify({ provider, api_key, key_type }),
    }),
  deleteApiKey: () => request("/settings/api-key", { method: "DELETE" }),

  getSessionDiff: (bookId: string, tag: string) =>
    request<SessionDiff>(`/books/${bookId}/sessions/${encodeURIComponent(tag)}/diff`),

  getOnboardingQuestions: () => request<OnboardingQuestion[]>("/onboarding/questions"),
  startOnboarding: (title: string, author: string, slug: string, answers: [number, string][]) =>
    request<Book>("/onboarding/start", {
      method: "POST",
      body: JSON.stringify({ title, author, slug, answers }),
    }),
};

export interface RawSseEvent {
  event: string;
  data: string;
}

/**
 * Parses one SSE frame per the spec: strip at most one leading space after
 * `data:`, and join multiple `data:` lines with a newline.
 *
 * The previous implementation did `data += line.slice(5).trim()`, which threw
 * away every line break and every edge space in streamed prose — so a
 * multi-paragraph continuation arrived as one run-on line.
 */
export function parseSseFrame(raw: string): RawSseEvent | null {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue; // blank or comment/heartbeat
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }

  if (event === "message" && dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

/** Splits a buffer into complete frames, returning the unconsumed remainder. */
export function drainSseBuffer(buffer: string): { frames: RawSseEvent[]; rest: string } {
  const frames: RawSseEvent[] = [];
  // Normalise CRLF so a proxy that rewrites line endings can't hide the
  // frame separator from us.
  let rest = buffer.replace(/\r\n/g, "\n");
  let sep: number;
  while ((sep = rest.indexOf("\n\n")) !== -1) {
    const frame = parseSseFrame(rest.slice(0, sep));
    rest = rest.slice(sep + 2);
    if (frame) frames.push(frame);
  }
  return { frames, rest };
}

async function* streamSse(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<RawSseEvent> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "Connexion au serveur impossible.", "network");
  }

  if (!res.ok || !res.body) throw await toApiError(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = drainSseBuffer(buffer);
      buffer = rest;
      for (const frame of frames) yield frame;
    }
    // A final frame not terminated by a blank line was silently dropped.
    buffer += decoder.decode();
    const trailing = parseSseFrame(buffer);
    if (trailing) yield trailing;
  } finally {
    // Abandoning the generator (component unmount, user hit Stop) must also
    // release the connection, or the request keeps streaming in the
    // background.
    await reader.cancel().catch(() => {});
  }
}

/** Tool payloads arrive as JSON; a malformed frame must not kill the stream. */
function parseJsonData<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

export type ChatEvent =
  | { type: "text"; data: string }
  | { type: "tool_call"; data: { name: string; input: unknown } }
  | { type: "tool_result"; data: { name: string; output: string } }
  | { type: "error"; data: string }
  | { type: "done" };

export async function* streamChat(
  bookId: string,
  message: string,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  for await (const { event, data } of streamSse(`/books/${bookId}/chat`, { message }, signal)) {
    if (event === "text") yield { type: "text", data };
    else if (event === "tool_call") {
      const parsed = parseJsonData<{ name: string; input: unknown }>(data);
      if (parsed) yield { type: "tool_call", data: parsed };
    } else if (event === "tool_result") {
      const parsed = parseJsonData<{ name: string; output: string }>(data);
      if (parsed) yield { type: "tool_result", data: parsed };
    } else if (event === "error") yield { type: "error", data };
    else if (event === "done") yield { type: "done" };
  }
}

export type SessionIntent = "continue" | "correct" | "rewrite_selection" | "free" | "expand_foundations";

export interface StartSessionBody {
  intent: SessionIntent;
  instruction?: string;
  selection_start?: number;
  selection_end?: number;
}

export type SessionEvent =
  | { type: "text"; data: string }
  | { type: "tool_call"; data: { name: string; input: unknown } }
  | { type: "tool_result"; data: { name: string; output: string } }
  | { type: "error"; data: string }
  | { type: "session_done"; data: { tag: string } };

export async function* streamSession(
  bookId: string,
  body: StartSessionBody,
  signal?: AbortSignal,
): AsyncGenerator<SessionEvent> {
  for await (const { event, data } of streamSse(`/books/${bookId}/sessions`, body, signal)) {
    if (event === "text") yield { type: "text", data };
    else if (event === "tool_call") {
      const parsed = parseJsonData<{ name: string; input: unknown }>(data);
      if (parsed) yield { type: "tool_call", data: parsed };
    } else if (event === "tool_result") {
      const parsed = parseJsonData<{ name: string; output: string }>(data);
      if (parsed) yield { type: "tool_result", data: parsed };
    } else if (event === "error") yield { type: "error", data };
    else if (event === "session_done") {
      const parsed = parseJsonData<{ tag: string }>(data);
      if (parsed) yield { type: "session_done", data: parsed };
    }
  }
}

export interface FileDiff {
  path: string;
  before: string;
  after: string;
}

export interface SessionDiff {
  files: FileDiff[];
}
