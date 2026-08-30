# Ink-Gateway Web App

A web platform for writing novels and short stories with an AI co-author. Built on top of the [`ink-gateway`](https://github.com/Philippe-arnd/Ink-Gateway) CLI's `ink_core` library — git-native versioning, no separate database for book content.

## What it is

Writers get a distraction-free prose editor paired with a **Chat Agent** (Claude or Gemini — bring your own API key). The agent doesn't just suggest text — it acts directly on the manuscript: inserting prose, rewriting sections, leaving comments, restoring past versions. Every edit, human or AI, is a git commit.

## Stack

| Layer | Technology |
|---|---|
| Backend API | Rust (Axum), depends on `ink_core` (git dependency on `Ink-Gateway`) |
| Frontend | React + Vite + TypeScript |
| Editor | TipTap, single-block plain-text schema (prose-only, no formatting toolbar) |
| Storage | Git working copies per book (content) + SQLite (users/sessions/registry) |
| AI Orchestration | `api/src/llm/` — provider-agnostic tool-use loop, Anthropic or Gemini |
| Deployment | Docker Compose on a personal VPS (Coolify) |

## Status

**Personal/invite-only beta.** No billing, no multi-tenant quotas — see `CLAUDE.md` for the full architecture and how it diverges from the earlier `Brainstorming/` spec.

## Local development

```bash
# API
cd api && cp .env.example .env   # fill in INK_GATEWAY_MASTER_KEY, INK_GATEWAY_INVITE_CODE
cargo run

# Frontend
cd app && npm install && npm run dev
```

Register a book by pointing `INK_GATEWAY_BOOKS_DIR` (or the default `api/data/books/`) at a directory scaffolded by `ink-cli init`, then register it via `POST /api/books` with that directory's name as `slug`.
