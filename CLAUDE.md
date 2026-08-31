# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Ink-Gateway Web App** turns the [`ink-gateway`](https://github.com/Philippe-arnd/Ink-Gateway) Rust CLI into a real product: a browser-based prose editor, real versioning, and first-class human/AI collaboration (Anthropic or Gemini, user's own key). Personal/invite-only beta — no billing, no multi-tenant quotas.

An earlier plan (`Brainstorming/SPECS_V1.md`, `Brainstorming/ARCHITECTURE.md`) proposed Postgres + S3 + Redis + Stripe. That was superseded — see the architecture note below.

## Repository Structure

```
landing/    # Astro marketing site (static, no runtime deps)
api/        # Rust API (Axum), depends on ink-gateway's `ink_core` lib as a git dependency
app/        # React + Vite + TypeScript + TipTap frontend
web/        # Dockerfile + nginx.conf building landing/ and app/ into ONE image
```

`landing/` and `app/` stay separate source trees but ship as a single nginx
container (`web`), serving the marketing site at `/` and the SPA at `/app`.
They were two containers until #34 — three services sharing one Coolify
domain is what broke path routing there.

## Architecture

**Git-native, not database-native.** Every book is a git working copy on disk. The web API depends on `Ink-Gateway`'s `ink_core` library crate directly (git dependency, no subprocess shelling) and calls its granular live-edit primitives (`edit::insert_text`, `edit::rewrite_range`, `comments::*`, `git::list_versions`/`restore_version`/`create_snapshot_tag`, `context::get_book_context`).

**`Ink-Gateway`'s own autonomous scheduled-session mechanism (the `ink-engine` cron loop, `session-open`/`session-close`/`complete`) has been removed** — it's superseded by this app's live, human-reviewed sessions below. `ink-gateway-mcp` still exists, but only for the maintenance commands that remain (`init`, `advance-chapter`, `status`, `doctor`, `apply-format`, `update-agents`) — it no longer drives an unattended writing loop.

| Concern | How |
|---|---|
| Prose content | Git working copy per book, managed by `ink_core` |
| Versioning | Every edit is a git commit; version history = `git log`; restore = forward-only new commit from an old blob |
| Comments/highlights | `Comments/current.yml`, git-tracked |
| Users, sessions, book registry, password-reset tokens | SQLite (`api/src/db.rs`) — the only thing not in git |
| AI provider keys | AES-256-GCM encrypted in SQLite (`api/src/crypto.rs`), master key from `INK_GATEWAY_MASTER_KEY`, never returned to the browser after save. Anthropic supports both a classic API key and a Claude Pro/Max OAuth "super-token" (`api/src/llm/anthropic.rs::AuthMode`). |
| AI collaboration | Two entry points sharing one tool-use loop (`api/src/agent.rs`) — see below |
| Password reset | Resend REST API (`api/src/email.rs`), hashed single-use tokens, no email-enumeration leak (`api/src/routes/auth.rs`) |
| Rate limiting | Per-IP on the auth surface only (`tower_governor`, `routes/mod.rs`) |

No Postgres, no S3, no Redis, no Stripe.

### Two ways to talk to the AI co-author

1. **Freeform chat** (`routes/chat.rs`) — unrestricted tool access, no diff-review ceremony, for quick back-and-forth that doesn't need a checkpoint.
2. **Intent-typed writing sessions** (`routes/sessions.rs`) — the primary flow. A modal picks an intent (`continue` / `correct` / `rewrite_selection` / `free`); the API tags a git snapshot (`ink_core::git::create_snapshot_tag`) before running, then runs the loop under an intent-specific system prompt and (for `correct`/`rewrite_selection`) a **restricted tool list** — e.g. `correct` never even has `replace_current` in its tool set, so the model can't touch anything beyond narrow `rewrite_range` fixes. When the loop finishes, the frontend fetches a before/after diff (`GET .../sessions/:tag/diff`) and the author accepts (no-op, already committed) or rejects (`POST .../versions/restore` with the snapshot tag — reuses Phase 1's restore, no new rollback code).

Both routes call the same `agent::run_loop` — one tool-execution code path, one event shape streamed over SSE either way.

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

- `api/src/agent.rs` — the shared tool-use loop (`run_loop`) and tool executor (`execute_tool`), used by both `routes/chat.rs` and `routes/sessions.rs`
- `api/src/routes/sessions.rs` — intent → (system prompt, first user turn, allowed-tools) mapping (`build_session`); the diff endpoint reads the snapshot tag's blob via `ink_core::git::run_git(["show", ...])` and compares it to the live file (always in sync — every tool call commits immediately)
- `api/src/llm/mod.rs` — `Turn`/`TurnEvent`/`LlmProvider` — `run_turn` takes an `allowed_tools: Option<&[&str]>` filter so a provider only ever *sees* the tools a session's intent permits; `anthropic.rs`/`gemini.rs` translate to/from each provider's wire format
- `api/src/main.rs` — router assembly, CORS (explicit origin/headers required with `allow_credentials(true)`), `SmartIpKeyExtractor`-based rate limiting requires `into_make_service_with_connect_info` and a trusted reverse proxy in front — see DEPLOYMENT.md
- `api/src/routes/books.rs` — `load_owned_repo_path` is the shared ownership check every book-scoped route uses; books are registered by `slug` (directory name under `books_dir`), never a raw client-supplied path
- `app/src/plainText.ts` — the editor's TipTap schema is intentionally `doc(block(text*))` (one block, no marks) so a ProseMirror position always equals `charOffset + 1`
- `app/src/pages/Editor.tsx` — `diffRange` (common-prefix/suffix) turns a full-text edit into a single `rewrite_range` call for autosave; the session state machine (`idle`/`running`/`error`/`diff`) drives `SessionModal`/`DiffView`

## Known limitations (see DEPLOYMENT.md for the full list)

- Sessions are in-memory (`MemoryStore`) — every restart logs everyone out. A persistent SQLite-backed store was evaluated and reverted: `tower-sessions-sqlx-store` 0.15.0 pins an incompatible `tower-sessions-core` against `tower-sessions` 0.15.0 (real upstream conflict).
- Nothing writes `Ink-Gateway`'s `Full_Book.md` automatically anymore, now that its autonomous engine is gone — a publish/export step is a known gap, not built.

## Deployment

Docker Compose (`docker-compose.yml`), two services (`web`, `api`) + one named volume for SQLite + book git repos. Deployed on Coolify at `ink-gateway.philapps.com`: `web` owns the bare domain via its Domains-tab entry, `api` is pinned to `/api` by explicit Traefik labels in the compose file (Coolify's auto-generated routers couldn't split one domain across services — #34). **See `DEPLOYMENT.md`** for the full env var reference, the reverse-proxy requirement (rate limiting trusts `X-Forwarded-For`), and backup guidance.
