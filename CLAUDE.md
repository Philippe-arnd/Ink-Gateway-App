# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Ink-Gateway Web App** is a paid platform for writers to compose novels/short stories with AI assistance (Claude only). It builds upon the existing `ink-gateway` Rust CLI and `ink-gateway-mcp` server.

The project is currently in the **planning/pre-implementation phase**. The primary reference is `Brainstorming/SPECS_V1.md`. Now we are working on the landing page.

## Planned Repository Structure

```
backend/    # Rust API (Axum + Diesel ORM)
frontend/   # React + Vite + TypeScript + CKEditor 5
mcp/        # ink-gateway-mcp (Anthropic MCP standard, adapted for web)
```

## Planned Commands (once implemented)

```bash
# Backend
cd backend && cargo build
cd backend && cargo test
cd backend && cargo test <test_name>   # run a single test

# Frontend
cd frontend && npm install
cd frontend && npm run dev
cd frontend && npm test

# Database migrations
diesel migration run
diesel migration revert
```

## Architecture

### Data Flow
1. React + CKEditor 5 → Rust API (Axum) via JWT-authenticated HTTP
2. API → PostgreSQL (users, version metadata, token quotas, billing)
3. API → Scaleway S3 (document content — explicit saves only, never autosave)
4. Autosave (30s) → Redis buffer only; flushed to S3 on explicit save
5. AI requests → Redis queue → `ink-gateway-mcp` → quota check → Claude API → Frontend

### Core Design Decisions
- **Autosave ≠ versioning:** 30s autosave writes to Redis/PostgreSQL buffer only. S3 versions are created only on explicit user saves.
- **Version restore is forward-only:** Restoring an old version creates a new S3 object — history is never mutated.
- **Version retention:** Last 20 versions per document. Users can pin versions. A background job purges unpinned excess.
- **AI is always async:** All Claude calls go through Redis → MCP. Never call Claude directly from API handlers.
- **Token quota enforced by MCP:** The MCP checks PostgreSQL quota before every Claude API call. Exhausted quota = rejected request with user message.
- **Model routing:** Claude Haiku for short suggestions/autocomplete; Claude Sonnet for rewrites/generation. Never default to Sonnet for lightweight tasks.
- **S3 is user-scoped:** Paths follow `users/{user_id}/documents/{doc_id}/{timestamp}.json`. API enforces ownership before any S3 operation.
- **Editor is prose-only:** CKEditor 5 in minimal mode — no formatting toolbar, no track changes, no inline comments. Clean content is required for the MCP engine to function reliably.

### Key PostgreSQL Tables
- `users`, `subscriptions` — auth and Stripe billing
- `token_usage` — per-call logging (model, tokens in/out) for quota tracking
- `documents`, `versions` — document metadata and S3 paths
- `autosave_buffer` — temporary 30s autosave state

### Deployment
- Coolify on a personal VPS using Docker Compose
- Services: `api`, `frontend`, `mcp`, `postgres`, `redis`
- External: Scaleway S3 for object storage only

## Implementation Order
1. Rust API + PostgreSQL + S3 + Redis (Phase 1)
2. React frontend + CKEditor 5 + version history UI (Phase 2)
3. MCP adaptation + token quota + AI features (Phase 3)
4. Stripe billing + launch (Phase 4)
