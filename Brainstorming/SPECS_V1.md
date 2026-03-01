# Ink-Gateway Web App - V1 Specifications (March 2026)

## 1. Project Overview

*   **Name:** Ink-Gateway Web App
*   **Objective:** A paid web platform for writing novels and short stories, assisted by AI.
*   **Target Audience:** Writers seeking a robust text editor with versioning capabilities and AI assistance (Claude Code / Gemini).

## 2. Validated Technical Choices for V1

*   **Front-end:** Text editor (to be developed, CKEditor 5 recommended).
*   **Back-end Core:** Rust (Existing Ink-Gateway CLI, MCP to be integrated).
*   **User Authentication:** PostgreSQL.
*   **User Document Versioning Management:**
    *   **Document Content:** Stored on Scaleway S3 (objects versioned by timestamp).
    *   **Version Metadata (timestamps, doc ID, user ID, S3 path):** Stored in PostgreSQL.
*   **AI Integration:** Via Claude Code or Gemini API keys, orchestrated by the Rust MCP.

## 3. V1 Constraints and Performance Objectives

*   **Target Concurrent Users:** Peaks of 50 users.
*   **Average Book Size:** 300 pages.
*   **User Session Activity:** 5 pages modified/produced per session.

## 4. Key Areas to Deepen and Technical Challenges

*   **Diff Management:** Implement backend logic (potentially within the Rust CLI) to calculate and present differences between two document versions, providing a user experience similar to a "git diff" but without the underlying complexity.
*   **Scaleway S3 Costs:** Evaluate the financial impact of object storage and requests (PUT/GET) for a volume of 50 users x 300 pages x N versions. Optimize automatic save frequency.
*   **Save Latency:** Ensure that the process of saving to S3 and updating PostgreSQL does not introduce noticeable latency that would degrade the writer's experience. Optimize I/O.
*   **CLI/MCP Orchestration:** Precisely define how the front-end and back-end will interact with the Rust CLI (for saving/reading) and the Rust MCP (for AI calls). Manage queues for AI requests.
*   **S3 Permissions:** Implement a robust security policy on Scaleway S3 to ensure users can only access their own documents.
*   **Editor Features:** What specific features (formatting, chaptering, comments) will be supported by the text editor to effectively integrate with the versioning system and AI.

## 5. Backend and AI Technical Components (Proposals)

*   **Rust Web Framework (API):** Actix-web or Axum (recommended choice for performance and security).
*   **Rust ORM for PostgreSQL:** Diesel (for type-safe and efficient DB interaction).
*   **Asynchronous Task Queue (for AI tasks):** Redis (for asynchronous AI request management and smooth UX).
*   **Rust S3 Client:** `rusoto_s3` or `aws-sdk-rust` (for Scaleway S3 integration).
*   **AI Orchestration:** The Rust MCP (Message Control Protocol) will be at the heart of the interaction with Claude/Gemini.

## 6. V1 Implementation Plan (Phased)

### Phase 1: Robust Foundations ("Core Gameplay")

1.  **Set up the Rust Backend API:**
    *   Choose and configure Actix-web/Axum.
    *   Define basic endpoints (authentication, document creation/reading/saving).
2.  **PostgreSQL and Authentication Integration:**
    *   Set up the PostgreSQL database.
    *   Use Diesel to manage users and their sessions.
    *   Implement a robust authentication system (e.g., JWT).
3.  **S3 Storage Management:**
    *   Configure the Rust S3 client for Scaleway.
    *   Implement logic for saving and retrieving documents (one version per S3 object, metadata in PG).

### Phase 2: The "Story Mode" (Editor and UX)

1.  **Front-end Development (CKEditor) :**
    *   Integrate CKEditor 5.
    *   Implement basic editing functions, automatic/manual saving.
2.  **Version History Display:**
    *   Develop the user interface to list document versions (via PG metadata).
    *   Implement the function to restore an older version.
3.  **Basic Diff Management:**
    *   Display a simple comparison between two text versions (can be a raw diff initially, improved later).

### Phase 3: The "AI Co-pilot" (AI and Collaboration)

1.  **Rust MCP and AI Queue Integration:**
    *   Connect the Rust MCP to the backend via internal calls or a messaging system.
    *   Set up Redis as a queue for AI requests.
    *   Implement the MCP's logic to send requests to Claude/Gemini APIs and handle responses.
2.  **Initial AI Features:**
    *   Implement a simple feature like "suggestion generation" or "style revision" via AI.
    *   Integrate AI results into the editor (e.g., comments, highlights, insertion suggestions).
3.  **Comments and Highlighting Management (CKEditor):**
    *   Use CKEditor plugins for comments and highlighting, linking them to the user authentication and versioning system.

## 7. Connecting to the Claude or Gemini API

The core of the interaction with the Claude or Gemini APIs will be managed by your **Rust MCP (Message Control Protocol)**.

*   **The MCP's Role:** The MCP will act as an "intelligent proxy" or "orchestrator" for all AI requests.
*   **Workflow:**
    1.  The front-end sends a request for an AI task (e.g., "generate next part", "revise this paragraph") to your Rust API.
    2.  The API places this request in the **Redis queue**.
    3.  The **Rust MCP**, listening to the queue, retrieves the task.
    4.  The MCP uses the **API keys** provided by the user (or system keys if it's an included service) to call the Claude or Gemini API. For this, it will use a Rust HTTP client (like `reqwest`) and construct JSON requests according to the model's API documentation.
    5.  Once the AI's response is received, the MCP processes it (parses JSON, formats the response).
    6.  The MCP returns the result (via a "callback" to the API, another queue, or by directly updating the DB/S3 if it's a background task). The API can then notify the front-end.
*   **API Key Management:** Claude/Gemini API keys should be stored securely (e.g., encrypted in PostgreSQL linked to the user, or as environment variables for system keys). The MCP will access these keys when making the call.
*   **Rate Limit and Cost Management:** The MCP will also be responsible for managing AI API "rate limits" and potentially tracking usage for user billing.

This plan allows for decoupling AI calls from the main API, ensuring the resilience and scalability of the entire system, even when facing variable response times from AI models.
