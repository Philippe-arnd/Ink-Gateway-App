# Ink-Gateway Web App - V1 Specifications (March 2026)

## 1. Project Overview

- **Name:** Ink-Gateway Web App
- **Objective:** A paid web platform for writing novels and short stories, assisted by AI (Claude).
- **Foundation:** Builds upon the existing `ink-gateway` Rust CLI and `ink-gateway-mcp` server.
- **Launch:** Closed beta with 5 non-paying users → V0 public (editor + versioning, no AI) → V1 full (AI + Stripe).
- **Target Concurrent Users:** Peaks of 50 users. Average book: 300 pages.

### Value Proposition vs the CLI

The existing `ink-gateway` CLI targets technical users comfortable with GitHub and a terminal. The web app targets **non-technical writers** who want to focus solely on writing:

| CLI | Web App |
|---|---|
| Requires GitHub account + terminal | Browser only |
| Manual git commits as versioning | Integrated visual version history |
| Markdown files edited in IDE | Dedicated prose editor (TipTap) |
| Single-user, local setup | Cloud-hosted, accessible anywhere |

These are two distinct markets — the web app is not a replacement for the CLI but an accessible entry point for a broader audience.

---

## 2. Technical Stack

| Layer | Technology | Rationale |
|---|---|---|
| Backend API | Rust (Axum) | Performance, existing CLI foundation |
| ORM | SQLx (async) | Natively async with Axum, avoids thread-blocking of Diesel |
| Frontend | React + Vite + TypeScript | Familiarity, CKEditor ecosystem |
| Editor | TipTap (MIT) | MIT licence, React-native, prose-only config — replaces CKEditor 5 whose commercial licence costs several hundred €/month |
| Database | PostgreSQL | |
| Object Storage | Scaleway S3 (`aws-sdk-rust`) | |
| AI Job Queue | `apalis` (Redis-backed) | Production-grade queue with retry, ACK, dead-letter — avoids custom Redis queue |
| Autosave Buffer | PostgreSQL (`autosave_buffer` table) | Durable by default — Redis alone risks data loss on crash |
| AI Orchestration | `ink-gateway-mcp` (Anthropic MCP standard) | Existing server, refactored for web multi-tenant context |
| AI Provider | Claude only — Haiku + Sonnet | |
| Payments | Stripe (subscription model) | |
| Deployment | Coolify on VPS (Docker Compose) | |

---

## 3. Architecture & Data Flow

```
[React + TipTap Canvas]  ◄──── SSE (live editor updates)
[Chat Agent Panel]       ◄──── SSE (streaming chat + tool results)
        │
        │ HTTP + SSE (JWT auth)
        ▼
[Rust API — Axum]
        │
        ├──► [PostgreSQL]   — users, sessions, sub-documents, version metadata,
        │                     token quotas, billing, autosave_buffer, chat_sessions
        │
        ├──► [Scaleway S3]  — document content (explicit saves only, one object per version)
        │
        ├──► [apalis/Redis] — AI job queue (retry, ACK, dead-letter)
        │
        └──► [ink-gateway-mcp]  ← agent with registered tools
                    │
                    ├── tool: get_context() → PostgreSQL
                    ├── tool: insert_text() → SSE → TipTap Canvas
                    ├── tool: rewrite_selection() → SSE → TipTap Canvas
                    ├── tool: create_chapter() → PostgreSQL + SSE
                    ├── tool: get_version_history() → PostgreSQL
                    ├── tool: restore_version() → S3 + PostgreSQL
                    ├── tool: save_explicit() → S3 + PostgreSQL
                    ├── atomic quota decrement → PostgreSQL
                    ├── log token usage + chat messages → PostgreSQL
                    └── Claude API (Haiku / Sonnet) with tool_use
                                │
                         SSE stream → API → Frontend (chat + canvas)
```

### Request Flows

**Autosave (every 30s):**
Frontend → API → PostgreSQL `autosave_buffer` (upsert, no S3 write)

**Explicit Save:**
Frontend → API → S3 (new versioned object) + PostgreSQL (version metadata row) + clear autosave_buffer

**Agentic Chat Message:**
User types in chat → API → apalis enqueue → MCP dequeues → atomic quota decrement
→ Claude API (with tools + chat history + book context)
→ Claude calls tools (e.g. `rewrite_selection`) → tool executes → SSE pushes live update to TipTap Canvas
→ Claude streams chat response → SSE pushes to chat panel
→ chat message + tool calls logged to `chat_messages`

**Version Restore:**
Frontend → API → read old S3 object → write as new S3 object (forward-only) + new PG version row flagged `is_restore = true`

---

## 4. Book Structure & Document Model

Each book has a **structured set of sub-documents** (mapped from the CLI's file structure) managed as separate editable sections in the UI:

| CLI File | Web Sub-document | Role |
|---|---|---|
| `Soul.md` | Soul | Voice, tone, authorial intent |
| `Outline.md` | Outline | Chapter plan and story arc |
| `Characters.md` | Characters | Character sheets |
| `Lore.md` | Lore | World-building, rules, glossary |
| `Full_Book.md` | Prose (main editor) | The actual manuscript |

### UI Navigation
- Sidebar with tabs: **Prose** / **Soul** / **Outline** / **Characters** / **Lore**
- Each tab opens the corresponding sub-document in TipTap
- Sub-documents are stored in PostgreSQL (they are short, structured, not versioned like the prose)
- Only the **Prose** tab has the full versioning system (S3 + version history)

### PostgreSQL Schema (key tables)
- `users` — id, email, password_hash, stripe_customer_id, created_at
- `subscriptions` — user_id, stripe_subscription_id, status, token_quota_monthly, tokens_remaining
- `token_usage` — user_id, model, tokens_in, tokens_out, called_at
- `books` — id, user_id, title, language, target_length, created_at, updated_at
- `book_subdocs` — id, book_id, type (soul/outline/characters/lore), content, updated_at
- `chapters` — id, book_id, position, title
- `versions` — id, book_id, chapter_id, s3_path, word_count, created_at, is_pinned, is_restore
- `autosave_buffer` — book_id, chapter_id, content, saved_at
- `chat_sessions` — id, user_id, book_id, created_at, last_active_at
- `chat_messages` — id, session_id, role (user/assistant/tool), content, tool_name, created_at

---

## 5. Editor & Chat Agent (Canvas Model)

### Layout

```
┌──────────────────────────────────┬─────────────────────────────┐
│  Sidebar                         │                             │
│  ─────────                       │   TipTap Canvas             │
│  📖 Chapter 1                    │                             │
│  📖 Chapter 2  ←active           │   [prose text — updated     │
│  📖 Chapter 3                    │    live by the agent        │
│  + New chapter                   │    via SSE]                 │
│                                  │                             │
│  ─────────                       ├─────────────────────────────┤
│  Soul / Outline                  │   Chat Agent                │
│  Characters / Lore               │                             │
│                                  │  Claude: I rewrote §2 with  │
│  ─────────                       │  a darker tone. Accept?     │
│  📋 Version history              │                             │
│  💾 Save    📤 Export            │  [_____________________] ➤  │
└──────────────────────────────────┴─────────────────────────────┘
```

### TipTap Canvas
- Configured in **minimal prose mode**: no formatting toolbar, no track changes, no comments.
- Rationale: clean, consistent content required for the MCP engine to process reliably.
- **Receives live updates from the agent via SSE** — when Claude calls a tool like `rewrite_selection`, the result appears directly in the editor in real-time without user copy-paste.
- Changes made by the agent are visually highlighted until the user confirms or undoes them (TipTap `Transaction` + custom decoration).

### Chapter Management
- Chapters created manually via "+ New chapter" in the sidebar.
- Each chapter has its own version history (S3 + PG versions table).
- Navigation and reordering via sidebar list.

### Chat Agent Panel
- Persistent chat panel alongside the editor — the core AI interaction surface.
- The user writes natural-language instructions: *"Continue this scene"*, *"Rewrite §2 with a darker tone"*, *"Add a character named Aria to Characters"*.
- Claude receives the full book context automatically on every message: Soul + Outline + Characters + Lore + current chapter content (via `get_context` tool).
- Claude decides autonomously which tool(s) to call based on the instruction.
- Chat history is **persistent per writing session** (`chat_sessions` + `chat_messages` in PostgreSQL), giving Claude memory within a session.
- A new session starts when the user opens a book. Previous sessions are archived and browsable.
- The `<!-- INK: [instruction] -->` CLI convention is fully replaced by this chat interface.

---

## 6. Versioning Rules

- **Autosave:** Every 30 seconds → upsert into PostgreSQL `autosave_buffer`. Never to S3.
- **Explicit save:** Creates a new timestamped S3 object + PostgreSQL version row. Clears the autosave buffer for that chapter.
- **Version restore:** Reads old S3 object → writes as new S3 object → new PG row with `is_restore = true` (forward-only, history never mutated).
- **Retention:** Keep last 20 versions per chapter. Users can **pin** versions. A background job (`apalis` scheduled task) purges unpinned excess versions + their S3 objects.

---

## 7. AI Integration

### Agentic Architecture

The MCP acts as a **Claude agent with registered tools**. Each chat message triggers a full agentic loop:

1. MCP sends to Claude: system prompt + chat history + current message
2. Claude reasons and calls one or more tools
3. MCP executes the tool (DB read/write, SSE push to editor)
4. Tool result is fed back to Claude
5. Claude continues until it has a final response to stream in chat

Claude has access to the full book context on every turn via `get_context` — it never needs the user to copy-paste content.

### MCP Registered Tools

| Tool | Description |
|---|---|
| `get_context(book_id)` | Reads Soul + Outline + Characters + Lore from PostgreSQL |
| `get_chapter(chapter_id)` | Reads current chapter content |
| `insert_text(chapter_id, position, content)` | Inserts text at a position → SSE push to Canvas |
| `rewrite_selection(chapter_id, start, end, instruction)` | Rewrites a text range → SSE push to Canvas |
| `append_to_chapter(chapter_id, content)` | Appends generated prose → SSE push to Canvas |
| `create_chapter(book_id, title, after_id)` | Creates a new chapter |
| `update_subdoc(book_id, type, content)` | Updates Soul / Outline / Characters / Lore |
| `get_version_history(chapter_id)` | Lists saved versions |
| `restore_version(version_id)` | Restores a past version (creates new forward version) |
| `save_explicit(chapter_id)` | Triggers an explicit S3 save + version row |

### Model Routing (via MCP)
| Task Type | Model |
|---|---|
| Clarifying questions, short suggestions | Claude Haiku |
| Prose generation, rewrites, style analysis | Claude Sonnet |

The MCP inspects the tool being called and the instruction length to route to the appropriate model.

### Token Quota — Atomic Enforcement
- Each user has a monthly token budget (`tokens_remaining`) in the `subscriptions` table.
- Before every Claude call, the MCP runs an **atomic SQL decrement**:
  ```sql
  UPDATE subscriptions
  SET tokens_remaining = tokens_remaining - $estimated_cost
  WHERE user_id = $uid AND tokens_remaining >= $estimated_cost
  RETURNING tokens_remaining;
  ```
- If no row is returned (quota exhausted), the job is rejected immediately with a user-facing message.
- Actual usage is logged post-call in `token_usage`. Delta vs estimate is corrected on the next call.
- This prevents race conditions from concurrent AI requests.

### MCP Refactoring Scope
The existing `ink-gateway-mcp` was designed for single-user CLI use. Adapting it for web requires:
- Multi-tenant context: user_id scoping on every call
- Registered tool suite (see above) replacing file-based operations
- Reading/writing sub-document context from PostgreSQL (not local files)
- `apalis` job queue integration (listen → agentic loop → SSE stream)
- Atomic quota management
- Chat history persistence in `chat_messages`
- This is a **significant refactoring effort**, not a simple integration.

### Cost Target
- Platform cost per page: ≤ €0.01
- Haiku for lightweight turns + Sonnet for generation + atomic quota enforcement

### AI Failure Handling
- If Claude API times out or errors: retried up to 3 times via `apalis` retry policy.
- After 3 failures: job moves to dead-letter queue, user receives error notification in chat.
- Tokens estimated for a failed call are refunded (compensating SQL update).
- Partial tool executions (e.g. text inserted but quota fails mid-loop): the canvas change is preserved but flagged — user can undo via TipTap history.

---

## 8. Pricing & Billing

### Model: Monthly Subscription
Pay-as-you-go per page is unpredictable for users. A subscription is better for retention and revenue forecasting.

| Tier | Price | Token Quota | Pages (approx.) |
|---|---|---|---|
| Starter | €9.90/month | 500k tokens | ~50 pages AI-generated |
| Writer | €19.90/month | 1.5M tokens | ~150 pages AI-generated |
| Pro | €39.90/month | 4M tokens | ~400 pages AI-generated |

- Stripe handles subscription creation, renewals, and webhooks.
- On `invoice.paid` webhook: reset `tokens_remaining` to the plan's monthly quota.
- On `customer.subscription.deleted`: set account to read-only (no AI, no new saves, data retained).
- **Beta:** 5 users on a manual Writer-tier grant (no Stripe, quota set directly in DB).

---

## 9. Export

Users can export their manuscript in:
- **Markdown** (plain text, immediate, no processing)
- **PDF** (via a Rust PDF generation library, e.g. `printpdf`)
- EPUB and DOCX deferred to post-V1.

Export includes Prose only (not sub-documents). All chapters concatenated in order.

---

## 10. S3 Security

- Object paths namespaced by user: `users/{user_id}/books/{book_id}/chapters/{chapter_id}/{timestamp}.json`
- API enforces ownership via PostgreSQL join before every S3 read/write.
- No direct S3 access from the frontend — all operations through the Rust API.
- PostgreSQL backup: automated daily `pg_dump` to a separate Scaleway S3 bucket, retained 30 days.

---

## 11. Observability & Security

### Monitoring
- Structured JSON logs from the Rust API (tracing + tracing-subscriber).
- Key metrics exposed: API latency, AI job queue depth, quota exhaustion rate, S3 error rate.
- Uptime monitoring via Coolify health checks.

### Security
- JWT access tokens (short-lived, 15 min) + refresh tokens (stored in HttpOnly cookie).
- API rate limiting per IP and per user (Axum middleware).
- All secrets (Stripe keys, Claude API key, S3 credentials) via environment variables, never in code.

### RGPD
- Privacy policy and right to deletion implemented at launch.
- Account deletion: purges all S3 objects, PostgreSQL rows, and Stripe customer data.
- Data portability: export endpoint provides full book data as ZIP (Markdown files).

---

## 12. Testing Strategy

### V0 — Backend only
- **Unit tests** (`cargo test`): business logic — quota decrement, versioning rules, JWT validation, autosave flush logic.
- **Integration tests**: API endpoints tested against a dedicated PostgreSQL test database (spun up via Docker in CI). Key flows covered:
  - Auth (register, login, token refresh)
  - Book + chapter CRUD
  - Explicit save → S3 write + version row
  - Version restore → new forward version
  - Autosave buffer upsert + flush

### Phase 1 — AI & Agent
- **MCP tool unit tests**: each registered tool tested in isolation (mock PostgreSQL + mock SSE sink).
- **Agentic loop integration tests**: mock Claude API responses with tool_use blocks, verify correct tool execution and SSE output.
- **Quota enforcement tests**: concurrent request simulation, verify atomic decrement prevents over-spend.

### Post-V1
- E2E frontend tests (Playwright) for critical user flows: login, write, chat with agent, save, restore version, export.

---

## 13. Backup Strategy

### PostgreSQL
- **Daily automated `pg_dump`** scheduled via an `apalis` cron job inside the API container.
- Dump compressed (gzip) and uploaded to a **dedicated Scaleway S3 bucket** (`ink-gateway-backups`), separate from document storage.
- **Retention:** 30 daily backups kept. Older backups purged automatically.
- **Restore procedure** documented in the ops runbook (manual `pg_restore` on the VPS).

### Scaleway S3 (documents)
- Document versions are inherently append-only (each explicit save = new object). Data loss requires actively deleting objects.
- The `ink-gateway-backups` S3 bucket has **versioning enabled** on Scaleway side as an additional safety net.
- Bucket access restricted to API service account only (no public access, no delete from application code — only the background cleanup job can delete, and only unpinned versions beyond the 20-version limit).

### Redis
- Not backed up — contains only the `apalis` job queue. Failed jobs land in the dead-letter queue (PostgreSQL-backed via apalis) and are recoverable.
- `autosave_buffer` lives in PostgreSQL, not Redis — already covered by PG backup.

---

## 14. Deployment

- **Host:** Coolify on a personal VPS.
- **Containers (Docker Compose):**
  - `api` — Rust Axum backend
  - `frontend` — React/Vite (Nginx)
  - `mcp` — ink-gateway-mcp (refactored)
  - `postgres` — PostgreSQL
  - `redis` — Redis (apalis queue only, not autosave)
- **External:** Scaleway S3 (documents + PG backups)
- **Backups:** Daily automated `pg_dump` → Scaleway S3 bucket, 30-day retention.

---

## 15. Implementation Phases

### V0 — Usable Editor (target: 6 weeks)
Goal: validate the core writing loop before building AI complexity.
1. Rust API (Axum) + SQLx + JWT auth.
2. PostgreSQL schema: users, books, chapters, versions, autosave_buffer.
3. TipTap editor: prose-only, chapter navigation, sub-document tabs.
4. Autosave (30s → PG buffer) + explicit save (→ S3 + version row).
5. Version history list + restore.
6. Markdown export.
7. Docker Compose + Coolify deployment.
8. Closed beta: 5 users, no payment.

### Phase 1 — AI Agent & Canvas
1. Refactor `ink-gateway-mcp` for multi-tenant web use with registered tool suite.
2. `apalis` job queue integration (enqueue, dequeue, retry, dead-letter).
3. Atomic token quota system.
4. Chat Agent panel UI (React) + SSE streaming (chat responses + canvas updates).
5. TipTap Canvas live update integration (SSE → TipTap Transaction → highlight pending changes).
6. Chat session persistence (`chat_sessions` + `chat_messages`).
7. Model routing (Haiku / Sonnet by task type).
8. PDF export.

### Phase 2 — Billing & Public Launch
1. Stripe subscription integration (webhooks, quota reset on renewal).
2. User dashboard: tokens remaining, version history, subscription status.
3. Account deletion (RGPD).
4. Data portability export (ZIP).
5. Beta → public launch.
