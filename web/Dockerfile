# One nginx image serving both the Astro marketing site (at /) and the React
# SPA (at /app/). These used to be two containers, two nginx instances and two
# Traefik routers — until #34 showed that three services fighting over one
# Coolify-managed domain is exactly what its path routing can't disambiguate.
# The landing is a single static page with no runtime dependencies, so none of
# that was buying anything.
#
# The sources stay separate and unchanged (`landing/` is still Astro, `app/` is
# still Vite) — only the build artifacts merge. Build context is the repo root,
# hence the `landing/`- and `app/`-prefixed COPY paths; see `.dockerignore`.

FROM node:22-bookworm-slim AS landing
WORKDIR /build
COPY landing/package.json landing/package-lock.json ./
RUN npm ci
COPY landing/ .
ARG PUBLIC_APP_URL=https://ink-gateway.philapps.com/app
ENV PUBLIC_APP_URL=$PUBLIC_APP_URL
RUN npm run build

FROM node:22-bookworm-slim AS app
WORKDIR /build
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ .
# Ends in /api because Coolify's Domains entry for the api service is
# https://<domain>/api, which always generates a stripprefix — Axum's own
# routes are unprefixed (api/src/routes/mod.rs) and only ever see the path
# after Traefik removes /api. See DEPLOYMENT.md.
ARG VITE_API_BASE=https://ink-gateway.philapps.com/api
ENV VITE_API_BASE=$VITE_API_BASE
ARG VITE_BASE_PATH=/app/
ENV VITE_BASE_PATH=$VITE_BASE_PATH
RUN npm run build

FROM nginx:1-alpine
# The SPA lands in a real `app/` subdirectory rather than being aliased there,
# so the URL path and the filesystem path line up — see nginx.conf.
COPY --from=landing /build/dist /usr/share/nginx/html
COPY --from=app /build/dist /usr/share/nginx/html/app
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
# 127.0.0.1, never `localhost`: nginx.conf listens on IPv4 only, and this
# image's 10-listen-on-ipv6-by-default.sh skips a customised conf, so it never
# gains a `listen [::]:80`. Alpine's /etc/hosts maps localhost to ::1 as well,
# and busybox wget does not fall back to the IPv4 address when that fails — the
# probe then fails forever, Traefik drops the container from its load balancer,
# and the domain serves "no available server" while nginx sits there perfectly
# healthy. Keep this in sync with the healthcheck in docker-compose.yml, which
# is the one Coolify actually reads.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD wget -qO- http://127.0.0.1/ || exit 1
