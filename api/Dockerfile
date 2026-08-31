FROM rust:1-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/target/release/ink-gateway-api /usr/local/bin/ink-gateway-api
WORKDIR /data
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD curl -f http://localhost:8787/ || exit 1
CMD ["ink-gateway-api"]
