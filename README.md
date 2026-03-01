# Ink-Gateway Web App

A paid web platform for writing novels and short stories with an AI co-author. Built on top of the [`ink-gateway`](https://github.com/Philippe-arnd/Ink-Gateway) CLI and its MCP server.

## What it is

Writers get a distraction-free prose editor paired with a **Chat Agent** powered by Claude. The agent doesn't just suggest text — it acts directly on the document in real time: inserting prose, rewriting sections, managing chapters, updating story context, and restoring past versions. The editor is the canvas; the chat is the co-author.

## Stack

| Layer | Technology |
|---|---|
| Backend API | Rust (Axum + SQLx) |
| Frontend | React + Vite + TypeScript |
| Editor | TipTap (prose-only, no formatting toolbar) |
| AI Orchestration | `ink-gateway-mcp` (Anthropic MCP) |
| AI Provider | Claude (Haiku + Sonnet) |
| Database | PostgreSQL |
| Object Storage | Scaleway S3 |
| Job Queue | `apalis` (Redis-backed) |
| Payments | Stripe |
| Deployment | Coolify on VPS (Docker Compose) |

## Status

**Pre-implementation — planning phase.**

See [`Brainstorming/SPECS_V1.md`](Brainstorming/SPECS_V1.md) for the full technical specification and [`Brainstorming/ARCHITECTURE.md`](Brainstorming/ARCHITECTURE.md) for the architecture diagram.

## Roadmap

- **V0** — Editor + versioning (no AI): TipTap canvas, chapter management, autosave, S3 versioning, export
- **Phase 1** — AI Agent: Chat panel, MCP tool suite, SSE live canvas updates, token quota system
- **Phase 2** — Billing & launch: Stripe subscriptions, user dashboard, RGPD, public launch
