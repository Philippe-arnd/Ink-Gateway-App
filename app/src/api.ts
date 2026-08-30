const BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8790";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
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

export interface VersionEntry {
  commit: string;
  date: string;
  message: string;
}

export interface ApiKeyStatus {
  configured: boolean;
  provider: string | null;
  key_type: string | null;
  last_four: string | null;
}

export const api = {
  register: (email: string, password: string, invite_code: string) =>
    request<UserView>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, invite_code }),
    }),
  login: (email: string, password: string) =>
    request<UserView>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
  me: () => request<UserView>("/api/auth/me"),
  forgotPassword: (email: string) =>
    request("/api/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) }),
  resetPassword: (token: string, new_password: string) =>
    request("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, new_password }),
    }),

  listBooks: () => request<Book[]>("/api/books"),
  createBook: (title: string, slug: string) =>
    request<Book>("/api/books", { method: "POST", body: JSON.stringify({ title, slug }) }),
  getBook: (id: string) => request<BookContext>(`/api/books/${id}`),

  insertText: (id: string, position: number, content: string) =>
    request(`/api/books/${id}/edit/insert`, {
      method: "POST",
      body: JSON.stringify({ position, content }),
    }),
  rewriteRange: (id: string, start: number, end: number, content: string) =>
    request(`/api/books/${id}/edit/rewrite`, {
      method: "POST",
      body: JSON.stringify({ start, end, content }),
    }),

  listComments: (id: string) => request<Comment[]>(`/api/books/${id}/comments`),
  addComment: (id: string, anchor_start: number, anchor_end: number, text: string) =>
    request<Comment>(`/api/books/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ anchor_start, anchor_end, text }),
    }),
  resolveComment: (id: string, commentId: string) =>
    request<Comment>(`/api/books/${id}/comments/${commentId}/resolve`, { method: "POST" }),

  listVersions: (id: string, path = "Review/current.md") =>
    request<VersionEntry[]>(`/api/books/${id}/versions?path=${encodeURIComponent(path)}`),
  restoreVersion: (id: string, commit: string, path = "Review/current.md") =>
    request(`/api/books/${id}/versions/restore`, {
      method: "POST",
      body: JSON.stringify({ path, commit }),
    }),

  getApiKey: () => request<ApiKeyStatus>("/api/settings/api-key"),
  setApiKey: (provider: string, api_key: string, key_type: "api_key" | "oauth_token" = "api_key") =>
    request<ApiKeyStatus>("/api/settings/api-key", {
      method: "POST",
      body: JSON.stringify({ provider, api_key, key_type }),
    }),
  deleteApiKey: () => request("/api/settings/api-key", { method: "DELETE" }),

  getSessionDiff: (bookId: string, tag: string) =>
    request<SessionDiff>(`/api/books/${bookId}/sessions/${encodeURIComponent(tag)}/diff`),
};

interface RawSseEvent {
  event: string;
  data: string;
}

async function* streamSse(path: string, body: unknown): AsyncGenerator<RawSseEvent> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const errBody = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, errBody.error ?? res.statusText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIndex: number;
    while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);

      let event = "message";
      let data = "";
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      yield { event, data };
    }
  }
}

export type ChatEvent =
  | { type: "text"; data: string }
  | { type: "tool_call"; data: { name: string; input: unknown } }
  | { type: "tool_result"; data: { name: string; output: string } }
  | { type: "error"; data: string }
  | { type: "done" };

export async function* streamChat(bookId: string, message: string): AsyncGenerator<ChatEvent> {
  for await (const { event, data } of streamSse(`/api/books/${bookId}/chat`, { message })) {
    if (event === "text") yield { type: "text", data };
    else if (event === "tool_call") yield { type: "tool_call", data: JSON.parse(data) };
    else if (event === "tool_result") yield { type: "tool_result", data: JSON.parse(data) };
    else if (event === "error") yield { type: "error", data };
    else if (event === "done") yield { type: "done" };
  }
}

export type SessionIntent = "continue" | "correct" | "rewrite_selection" | "free";

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
): AsyncGenerator<SessionEvent> {
  for await (const { event, data } of streamSse(`/api/books/${bookId}/sessions`, body)) {
    if (event === "text") yield { type: "text", data };
    else if (event === "tool_call") yield { type: "tool_call", data: JSON.parse(data) };
    else if (event === "tool_result") yield { type: "tool_result", data: JSON.parse(data) };
    else if (event === "error") yield { type: "error", data };
    else if (event === "session_done") yield { type: "session_done", data: JSON.parse(data) };
  }
}

export interface SessionDiff {
  before: string;
  after: string;
}
