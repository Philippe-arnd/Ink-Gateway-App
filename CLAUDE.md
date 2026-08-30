# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Ink-Gateway Web App** turns the [`ink-gateway`](https://github.com/Philippe-arnd/Ink-Gateway) Rust CLI into a real product: a browser-based prose editor, real versioning, and first-class human/AI collaboration (Anthropic or Gemini, user's own key). Personal/invite-only beta — no billing, no multi-tenant quotas.

An earlier plan (`Brainstorming/SPECS_V1.md`, `Brainstorming/ARCHITECTURE.md`) proposed Postgres + S3 + Redis + Stripe. That was superseded — see the architecture note below.

## Repository Structure

```
landing/    # Astro marketing site (unchanged, existing)
api/        # Rust API (Axum), depends on ink-gateway's `ink_core` lib as a git dependency
app/        # React + Vite + TypeScript + TipTap frontend
```

## Architecture

**Git-native, not database-native.** Every book is a git working copy on disk — the same model `ink-cli` already uses for its scheduled writing sessions. The web API depends on `Ink-Gateway`'s `ink_core` library crate directly (git dependency, no subprocess shelling) and calls its granular live-edit primitives (`edit::insert_text`, `edit::rewrite_range`, `comments::*`, `git::list_versions`/`restore_version`, `context::get_book_context`).

| Concern | How |
|---|---|
| Prose content | Git working copy per book, managed by `ink_core` |
| Versioning | Every edit is a git commit; version history = `git log`; restore = forward-only new commit from an old blob |
| Comments/highlights | `Comments/current.yml`, git-tracked (generalizes the CLI's `<!-- INK: -->` marker) |
| Users, sessions, book registry | SQLite (`api/src/db.rs`) — the only thing not in git |
| AI provider keys | AES-256-GCM encrypted in SQLite (`api/src/crypto.rs`), master key from `INK_GATEWAY_MASTER_KEY` env var, never returned to the browser after save |
| AI collaboration | `api/src/llm/` — a provider-agnostic tool-use loop (`anthropic.rs` / `gemini.rs`, user picks one), tools = the same `ink_core` primitives the editor UI calls, streamed to the browser over SSE (`api/src/routes/chat.rs`) |

No Postgres, no S3, no Redis, no Stripe. `Ink-Gateway`'s `ink-gateway-mcp` binary is untouched — it keeps serving scheduled/IDE-driven sessions independently of this web app.

## Commands

```bash
# API
cd api && cargo build
cd api && cargo test
cd api && cargo clippy --all-targets -- -D warnings
cd api && cargo run   # reads api/.env — see api/.env.example

# Frontend
cd app && npm install
cd app && npm run dev
cd app && npm run build   # runs `tsc -b` type-check + vite build
```

## Key Files

- `api/src/main.rs` — router assembly, CORS (must be explicit origin/headers when `allow_credentials(true)` — no `Any` wildcards, tower-http rejects that combination at runtime)
- `api/src/routes/books.rs` — `load_owned_repo_path` is the shared ownership check every book-scoped route uses; books are registered by `slug` (directory name under `books_dir`), never a raw client-supplied path
- `api/src/routes/chat.rs` — the tool-use loop: non-streaming per-turn provider calls, looped up to `MAX_TOOL_TURNS`, each turn's text/tool_call/tool_result forwarded to the browser as its own SSE event
- `api/src/llm/mod.rs` — `Turn`/`TurnEvent`/`LlmProvider` — the internal provider-agnostic shape; `anthropic.rs` and `gemini.rs` each translate it to/from their own wire format
- `app/src/plainText.ts` — the editor's TipTap schema is intentionally `doc(block(text*))` (one block, no marks) so a ProseMirror position always equals `charOffset + 1` — no separator bookkeeping between paragraphs. This is also what makes it prose-only with no formatting toolbar, matching the original spec's intent.
- `app/src/pages/Editor.tsx` — `diffRange` (common-prefix/suffix) turns a full-text edit into a single `rewrite_range` call, debounced 1.2s after typing stops

## Deployment

Docker Compose (`docker-compose.yml`), two services (`api`, `app`) + one named volume for SQLite + book git repos. `api/.env.example` documents the required secrets. No deploy has been run from this environment — Coolify/VPS access belongs to Phil.
