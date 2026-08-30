# Ink-Gateway Web App

A web platform for writing novels and short stories with an AI co-author. Built on top of the [`ink-gateway`](https://github.com/Philippe-arnd/Ink-Gateway) CLI's `ink_core` library — git-native versioning, no separate database for book content.

## What it is

Writers get a distraction-free prose editor with two ways to bring in the AI (Claude or Gemini — bring your own API key):

- **A "Nouvelle session d'écriture" flow** — pick an intent (continue the story, proofread-only, rewrite the current selection, or a free instruction), watch it work, then review a **diff** before it sticks. Reject rolls back to a git snapshot taken right before the session started.
- **A freeform chat** for quick back-and-forth that doesn't need the checkpoint ceremony.

Both act directly on the manuscript — inserting prose, rewriting sections, leaving comments — using the exact same tools the editor UI itself calls. Every edit, human or AI, is a git commit.

## Stack

| Layer | Technology |
|---|---|
| Backend API | Rust (Axum), depends on `ink_core` (git dependency on `Ink-Gateway`) |
| Frontend | React + Vite + TypeScript |
| Editor | TipTap, single-block plain-text schema (prose-only, no formatting toolbar) |
| Storage | Git working copies per book (content) + SQLite (users/sessions/registry/password-reset tokens) |
| AI Orchestration | `api/src/agent.rs` — one tool-use loop shared by chat and writing sessions, Anthropic or Gemini |
| Email | Resend (password reset) |
| Deployment | Docker Compose on a personal VPS (Coolify) |

## Status

**Personal/invite-only beta.** No billing, no multi-tenant quotas — see `CLAUDE.md` for the full architecture and `DEPLOYMENT.md` for env vars, deploy steps, and known limitations.

## Local development

```bash
# API
cd api && cp .env.example .env   # fill in every required var — see .env.example
cargo run

# Frontend
cd app && npm install && npm run dev
```

Register a book by pointing `INK_GATEWAY_BOOKS_DIR` (or the default `api/data/books/`) at a directory scaffolded by `ink-cli init`, then register it via `POST /api/books` with that directory's name as `slug`.

## Deployment

See [`DEPLOYMENT.md`](DEPLOYMENT.md).
