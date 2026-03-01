# Ink-Gateway Web App - Project Context

## Project Overview
**Ink-Gateway Web App** is a paid platform designed for writers to compose novels and short stories with AI assistance. It builds upon the existing `ink-Gateway` project.

### Core Objectives
- Robust text editing (CKEditor 5).
- Advanced document versioning stored on Scaleway S3.
- AI orchestration via a specialized **Rust MCP (Message Control Protocol)**.
- Scalable backend supporting versioning and diff management.

### Technical Stack
- **Backend:** Rust (Axum or Actix-web).
- **Frontend:** JavaScript/TypeScript (React with CKEditor 5).
- **Database:** PostgreSQL (with Diesel ORM) for metadata and user management.
- **Storage:** Scaleway S3 (Object versioning by timestamp).
- **Asynchronous Tasks:** Redis for AI request queuing.
- **AI Integration:** Claude Code / Gemini APIs orchestrated by the Rust MCP.

## Repository Structure
- `Brainstorming/`: Contains architectural plans and specifications (`SPECS_V1.md`).
- `backend/`: (TODO) Rust backend API.
- `frontend/`: (TODO) Web application frontend.
- `mcp/`: (TODO) Rust MCP orchestrator.

## Building and Running
*Note: The project is currently in the initial setup/planning phase.*

### TODO: Define Commands
- **Backend:** `cd backend && cargo build`
- **Frontend:** `cd frontend && npm install && npm run dev`
- **Database Migrations:** `diesel migration run`

## Development Conventions
- **Versioning:** Every document save creates a new timestamped object in S3.
- **AI Orchestration:** All AI requests must pass through the Redis queue and be handled by the Rust MCP to ensure non-blocking UI and reliable rate-limiting.
- **Security:** S3 access must be strictly partitioned by user IDs stored in PostgreSQL.

## Key Files
- `Brainstorming/SPECS_V1.md`: The primary architectural reference and V1 roadmap.
- `.gitignore`: Standard exclusions for Rust, Node.js, and environment secrets.
