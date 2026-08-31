# Deployment

Three containers (`landing`, `api`, `app`), one shared volume. No Postgres,
no Redis, no S3 — book content lives in git working copies on disk, the
only database is a small SQLite file for users/sessions/the book registry.
See `CLAUDE.md` for why.

```
                         ┌─────────────┐
  browser ───HTTPS───▶   │landing(nginx)│  static Astro marketing site, at /
                         └─────────────┘  Sign in/up links out to /app
                                │
                                ▼
                         ┌─────────────┐
                         │  app (nginx) │  static React build, at /app
                         └─────────────┘
                                │  fetch() same-origin, credentials: include
                                ▼
                         ┌─────────────┐        ┌─────────────────────┐
                         │  api (Axum)  │───────▶│ /data/ink-gateway.db │ (SQLite)
                         └─────────────┘, at /api│ /data/books/*        │ (git repos)
                                │                └─────────────────────┘
                                ▼
                    Anthropic / Gemini / Resend
                    (outbound only, user's own keys)
```

All three services build from this repo's `docker-compose.yml` and share a
**single domain**, split by path prefix (`/`, `/app`, `/api`) rather than by
subdomain — same origin end to end, so the app's session cookie and the
api's CORS config don't have to deal with cross-origin at all. Nothing here
has been deployed from the environment that wrote it — this is the reference
for whoever runs it (Coolify or otherwise), not a record of an actual run.

## Prerequisites

- A reverse proxy in front of all three containers that terminates TLS,
  routes by path prefix (`/` → `landing`, `/app` → `app`, `/api` → `api`,
  **unstripped** — `api`'s own routes are already prefixed `/api/...`, see
  `api/src/routes/mod.rs`), and sets `X-Forwarded-For` correctly (Coolify's
  built-in Traefik does all of this). **The `api` container must never be
  reachable directly, bypassing the proxy** — the auth rate limiter trusts
  `X-Forwarded-For`/`Forwarded` to identify clients (`SmartIpKeyExtractor`),
  and a client that can reach the API directly could forge that header to
  dodge the limit entirely.
- One domain, with all three services assigned to it under their path
  prefix. On Coolify this is set per-service in the application's Domains
  tab (each service gets the same host, with `/app` and `/api` as the
  path) — the compose file itself doesn't pin these.
- A [Resend](https://resend.com) account + a verified sending domain, for
  password-reset emails.
- An Anthropic and/or Gemini API key is **not** an operator secret — each
  user brings their own via Settings, encrypted at rest. Nothing to
  provision here.

## Environment variables

### `api/.env` (copy from `api/.env.example`)

| Variable | Required | Notes |
|---|---|---|
| `INK_GATEWAY_MASTER_KEY` | **yes** | Encrypts stored AI provider keys (AES-256-GCM). Generate with `openssl rand -base64 32`. **Losing this means every user has to re-enter their AI key** — back it up like any other secret, but never alongside the database backup itself. |
| `INK_GATEWAY_INVITE_CODE` | **yes** | Shared secret gating `/register`. Not a strong security boundary on its own — it's a beta gate, not a password. Rotate it if it leaks. |
| `RESEND_API_KEY` | **yes** | From resend.com. Without it, forgot-password requests are silently logged as failures server-side and the user never gets an email (the API response looks identical either way, by design — see `routes/auth.rs`). |
| `RESEND_FROM_EMAIL` | **yes** | Must be on a domain verified with Resend, e.g. `Ink Gateway <noreply@yourdomain.com>`. |
| `INK_GATEWAY_SECURE_COOKIES` | recommended | Set `"true"` in production — marks the session cookie `Secure` (HTTPS-only). `docker-compose.yml` already sets this. |
| `ANTHROPIC_MODEL` | optional | Overrides the default (`claude-sonnet-5`) for every user on this deployment. |
| `GEMINI_MODEL` | optional | Overrides the default (`gemini-2.5-flash`). |
| `DATABASE_URL`, `INK_GATEWAY_BOOKS_DIR`, `BIND_ADDR`, `FRONTEND_ORIGIN`, `RUST_LOG` | set by `docker-compose.yml` | Only override these for non-Docker deployment. |

### Build args (`app`/`landing`, set via `docker-compose.yml` / Coolify build variables)

| Variable | Required | Notes |
|---|---|---|
| `API_PUBLIC_URL` | **yes** | The public URL of the `api` service (e.g. `https://yourdomain.com/api`), baked into the `app` frontend build at build time (Vite env vars are compile-time). Changing it means rebuilding the `app` image. |
| `FRONTEND_ORIGIN` | **yes** (on `api`) | The public origin serving `app` — since `app`/`api`/`landing` share one domain, this is just that domain (e.g. `https://yourdomain.com`, no path, no trailing slash). Used for CORS `allow_origin` and the link inside password-reset emails. |
| `APP_PUBLIC_URL` | recommended | The public URL of `app` (e.g. `https://yourdomain.com/app`), baked into the `landing` build so its Sign in/up links point at the right place. |
| `VITE_BASE_PATH` (on `app`'s own Dockerfile, not compose) | no | Where `app` is served from; defaults to `/app/`. Only needed if you move `app` off that path — also update `nginx.conf`'s `location /app/` block to match. |

## Deploy

1. `cp api/.env.example api/.env`, fill in every **yes** row above.
2. Set `FRONTEND_ORIGIN`, `API_PUBLIC_URL`, `APP_PUBLIC_URL` (Coolify: as
   build/runtime variables on the respective service; plain Docker Compose:
   export them before `docker compose up` or put them in a root `.env`).
3. `docker compose up -d --build`.
4. Point DNS at the proxy; issue a TLS cert (Coolify does this
   automatically via Traefik/Let's Encrypt).
5. Register the first account at `https://<domain>/app/login` using
   `INK_GATEWAY_INVITE_CODE`.
6. Scaffold a book on the server (`ink-cli init` from the `Ink-Gateway`
   repo) under the path mounted as `INK_GATEWAY_BOOKS_DIR` (`/data/books`
   inside the container — mount or `docker compose exec` in to run it), then
   register it in the app via "Enregistrer un livre existant" with that
   directory's name as the slug.

## Known limitations

- **Sessions are in-memory** (`tower_sessions::MemoryStore`). Every deploy /
  container restart logs everyone out. A persistent store
  (`tower-sessions-sqlx-store`) was evaluated and rejected for now — its
  published version pins an incompatible `tower-sessions-core` against the
  `tower-sessions` version this API uses (an upstream version conflict, not
  a design choice). Revisit when either crate publishes a compatible pair.
- **No CSRF tokens.** Mitigated instead by `SameSite=Strict` session cookies
  + CORS restricted to exactly `FRONTEND_ORIGIN` — sufficient for a
  same-site SPA+API pair, but don't add a second frontend origin without
  reconsidering this.
- **No 2FA, no email verification on signup** — acceptable for an
  invite-only beta with a handful of trusted authors, not for open
  registration.
- **Rate limiting is per-process, in-memory** (`tower_governor`). Restarting
  `api` resets every client's bucket; running more than one `api` replica
  would give each replica its own independent limit rather than a shared
  one.

## Backups

- **`/data/ink-gateway.db`** (SQLite): users, sessions-in-flight, the book
  registry, encrypted AI keys. Back up regularly; losing it loses the user
  list and book registry (book *content* is separately recoverable from
  git, see below).
- **`/data/books/*`**: each book is a full git repository — history,
  comments, everything. A `git bundle` or plain directory copy per book is
  a complete backup; nothing book-related lives only in SQLite.
- **`INK_GATEWAY_MASTER_KEY`**: back up separately from the database dump.
  A leaked *database* backup without this key doesn't expose usable AI
  provider keys; a leaked *master key* without the database is useless on
  its own. Keeping them apart is the point.
