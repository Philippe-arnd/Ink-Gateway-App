# Deployment

Two containers (`web`, `api`), one volume. No Postgres, no Redis, no S3 —
book content lives in git working copies on disk, the only database is a
small SQLite file for users/sessions/the book registry. See `CLAUDE.md` for
why.

```
                         ┌──────────────┐
  browser ───HTTPS───▶   │  web (nginx) │  Astro marketing site, at /
                         │              │  React SPA build,      at /app
                         └──────────────┘
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

Both services build from this repo's `docker-compose.yml` and share a
**single domain**, split by path prefix (`/`, `/app`, `/api`) rather than by
subdomain — same origin end to end, so the app's session cookie and the
api's CORS config don't have to deal with cross-origin at all.

The marketing site and the SPA are two separate source trees (`landing/` is
Astro, `app/` is Vite) that build into **one** nginx image (`web/Dockerfile`,
a stage each, artifacts merged in the final stage). They were two containers
until #34: the landing is a single static page with no runtime dependencies,
and giving it its own container, nginx and Traefik router bought nothing
except a third service competing for the same domain.

## Prerequisites

- A reverse proxy in front of both containers that terminates TLS, routes
  `/api` to `api` (**unstripped** — `api`'s own routes are already prefixed
  `/api/...`, see `api/src/routes/mod.rs`) and everything else to `web`, and
  sets `X-Forwarded-For` correctly (Coolify's built-in Traefik does all of
  this). **The `api` container must never be reachable directly, bypassing
  the proxy** — the auth rate limiter trusts `X-Forwarded-For`/`Forwarded` to
  identify clients (`SmartIpKeyExtractor`), and a client that can reach the
  API directly could forge that header to dodge the limit entirely.
- One domain. `web` owns it as the catch-all — on Coolify, assign the domain
  to `web` in the application's Domains tab, nothing more. `api` is routed to
  `/api` by **explicit Traefik labels in `docker-compose.yml`**
  (`ink-gateway-api` router, `priority=100`) rather than by its Domains-tab
  entry: relying on the Domains tab alone to split one domain across several
  compose services doesn't reliably disambiguate the paths (see
  [Ink-Gateway-App#34](https://github.com/Philippe-arnd/Ink-Gateway-App/issues/34)),
  every path fell through to whichever service owned the bare `Host()` rule.
  If you deploy to a domain other than `ink-gateway.philapps.com`, set the
  `DOMAIN` env var (build/runtime variable in Coolify) so the label matches.
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

### Build args (`web`, set via `docker-compose.yml` / Coolify build variables)

Both frontends are compiled into the `web` image, so all of these are
**build-time** — changing any of them means rebuilding `web`, not restarting it.

| Variable | Required | Notes |
|---|---|---|
| `API_PUBLIC_URL` | **yes** | The public URL of the `api` service (e.g. `https://yourdomain.com/api`), baked into the SPA build (Vite env vars are compile-time). |
| `FRONTEND_ORIGIN` | **yes** (on `api`) | The public origin serving the SPA — since `web`/`api` share one domain, this is just that domain (e.g. `https://yourdomain.com`, no path, no trailing slash). Used for CORS `allow_origin` and the link inside password-reset emails. |
| `APP_PUBLIC_URL` | recommended | The public URL of the SPA (e.g. `https://yourdomain.com/app`), baked into the Astro build so its Sign in/up links point at the right place. |
| `VITE_BASE_PATH` (on `web/Dockerfile`, not compose) | no | Where the SPA is served from; defaults to `/app/`. Moving it means updating three things in step: this arg, the `COPY --from=app` destination in `web/Dockerfile`, and the `location /app/` block in `web/nginx.conf`. |

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
