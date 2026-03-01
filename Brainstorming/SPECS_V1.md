# Ink-Gateway Web App - V1 Specifications (March 2026)

## 1. Project Overview

- **Name:** Ink-Gateway Web App
- **Objective:** A paid web platform for writing novels and short stories, assisted by AI (Claude).
- **Foundation:** Builds upon the existing `ink-gateway` Rust CLI and `ink-gateway-mcp` server.
- **Launch:** Closed beta with 5 non-paying users, then Stripe-gated public access.
- **Target Concurrent Users:** Peaks of 50 users. Average book: 300 pages.

---

## 2. Technical Stack

| Layer | Technology |
|---|---|
| Backend API | Rust (Axum) |
| ORM | Diesel (PostgreSQL) |
| Frontend | React + Vite + TypeScript |
| Editor | CKEditor 5 (minimal, prose-only config) |
| Database | PostgreSQL |
| Object Storage | Scaleway S3 (`aws-sdk-rust`) |
| Autosave Buffer + AI Queue | Redis |
| AI Orchestration | `ink-gateway-mcp` (Anthropic MCP standard) |
| AI Provider | Claude only (Haiku + Sonnet) |
| Payments | Stripe |
| Deployment | Coolify on VPS (Docker) |

---

## 3. Architecture & Data Flow

```
[React + CKEditor 5]
        │
        │ HTTP (JWT auth)
        ▼
[Rust API — Axum]
        │
        ├──► [PostgreSQL]  — users, sessions, version metadata, token quotas, billing
        │
        ├──► [Scaleway S3] — document content (explicit saves only, one object per version)
        │
        ├──► [Redis]       — 30s autosave buffer + AI request queue
        │
        └──► [ink-gateway-mcp]
                    │
                    ├── quota check → PostgreSQL
                    └── Claude API (Haiku / Sonnet)
```

### Request Flows

**Autosave (every 30s):**
Frontend → API → Redis (buffer only, no S3 write)

**Explicit Save:**
Frontend → API → S3 (new versioned object) + PostgreSQL (version metadata row)

**AI Request:**
Frontend → API → Redis queue → MCP → quota check → Claude API → result → API → Frontend

---

## 4. Document Model

The web app maps the CLI's file-based book structure to a relational model:

| CLI Concept | Web Equivalent |
|---|---|
| Book repository | `documents` table + S3 prefix |
| Soul.md, Outline.md, Characters.md, Lore.md | Structured fields or sub-documents per book |
| Full_Book.md | Latest S3 object for the document |
| Session open/close | Autosave buffer flush + explicit save |
| Rollback | Version restore (creates new forward version) |
| `<!-- INK: [instruction] -->` comments | AI request trigger in editor |

---

## 5. Versioning Rules

- **Autosave:** Every 30 seconds → written to Redis/PostgreSQL buffer. Never to S3.
- **Explicit save:** Creates a new timestamped S3 object + a metadata row in PostgreSQL.
- **Version restore:** Copies the old version's content into a new S3 object (forward-only history, no mutation).
- **Retention:** Keep last 20 versions per document. Users can **pin** versions to exempt them from cleanup. A background job purges unpinned versions beyond the limit.

---

## 6. Editor (CKEditor 5)

CKEditor 5 is configured in **minimal prose mode**:
- Plain text input with chapter/section structure navigation only.
- No formatting toolbar (no bold, italic, headings, track changes, inline comments).
- Rationale: preserving clean, consistent content that the MCP engine can reliably process.

---

## 7. AI Integration

### Model Routing (via MCP)
| Task Type | Model |
|---|---|
| Short suggestions, autocomplete | Claude Haiku |
| Full rewrites, style analysis, generation | Claude Sonnet |

The MCP routes requests by task type — never defaults to Sonnet for lightweight tasks.

### Token Quota System
- Each user has a monthly token budget stored in PostgreSQL.
- The MCP checks the remaining quota **before every Claude API call**.
- If quota is exhausted, the request is rejected with a clear user-facing message.
- Usage is logged per call (model, tokens in/out, timestamp) for billing and abuse tracking.
- No user-provided API keys — the platform absorbs AI costs within the quota model.

### Cost Target
- Platform cost per page: ≤ €0.01
- User price: €0.10–€0.20 per page
- Achieved by: Haiku for routine tasks, Sonnet rate-limited, quota enforcement.

---

## 8. Authentication & Billing

- **Auth:** JWT-based session tokens. User records in PostgreSQL.
- **Billing:** Stripe integration for subscription management.
- **Beta:** Closed beta (5 users, no payment). PostgreSQL schema is billing-ready from day one.

### PostgreSQL Schema (key tables)
- `users` — id, email, password_hash, stripe_customer_id, created_at
- `subscriptions` — user_id, stripe_subscription_id, status, token_quota_monthly
- `token_usage` — user_id, model, tokens_in, tokens_out, called_at
- `documents` — id, user_id, title, created_at, updated_at
- `versions` — id, document_id, s3_path, created_at, is_pinned, is_restore
- `autosave_buffer` — document_id, content, saved_at (Redis or PG, flushed on explicit save)

---

## 9. S3 Security

- S3 object paths are namespaced by user ID: `users/{user_id}/documents/{doc_id}/{timestamp}.json`
- The API enforces ownership checks against PostgreSQL before any S3 read/write.
- No direct S3 access from the frontend — all operations go through the Rust API.

---

## 10. Deployment

- **Host:** Coolify on a personal VPS.
- **Containers (Docker Compose):**
  - `api` — Rust Axum backend
  - `frontend` — React/Vite (served via Nginx or Coolify static)
  - `mcp` — ink-gateway-mcp server
  - `postgres` — PostgreSQL
  - `redis` — Redis
- **External:** Scaleway S3 (object storage only, not compute)

---

## 11. Implementation Phases

### Phase 1 — Core Foundations
1. Rust API (Axum) with JWT authentication.
2. PostgreSQL setup with Diesel: users, documents, versions, token_usage tables.
3. Scaleway S3 integration: explicit save and version retrieval.
4. Redis autosave buffer (30s write, flush on explicit save).
5. Docker Compose setup for local development and Coolify deployment.

### Phase 2 — Editor & Versioning UI
1. React + Vite + TypeScript frontend scaffold.
2. CKEditor 5 integration in minimal prose-only mode.
3. Chapter/section navigation.
4. Version history list (from PostgreSQL metadata) + restore flow.
5. Autosave indicator and explicit save button.

### Phase 3 — AI Co-pilot
1. Adapt `ink-gateway-mcp` for web: connect to Redis queue, read from API context.
2. Token quota system: enforcement in MCP, tracking in PostgreSQL.
3. Model routing: Haiku vs Sonnet by task type.
4. Initial AI feature: prose generation / continuation triggered from editor.
5. Result delivery back to editor (streamed or polled).

### Phase 4 — Billing & Launch
1. Stripe integration: subscription creation, webhook handling, quota assignment.
2. Usage dashboard for users (tokens remaining, version history).
3. Beta → public launch.
