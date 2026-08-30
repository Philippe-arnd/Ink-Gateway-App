FROM rust:1-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/target/release/ink-gateway-api /usr/local/bin/ink-gateway-api
WORKDIR /data
EXPOSE 8787
CMD ["ink-gateway-api"]
