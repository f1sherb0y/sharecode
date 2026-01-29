# syntax=docker/dockerfile:1.6

FROM rust:1.93-slim-bookworm AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Use BuildKit cache mounts for incremental builds
ENV CARGO_TARGET_DIR=/app/target

# 1) Cache dependencies
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src && printf "fn main() {}\n" > src/main.rs
RUN cargo build --release

# 2) Build actual sources
RUN rm -rf src
COPY src ./src

RUN cargo build --release \
    && cp /app/target/release/sharecode-server /app/sharecode-server

FROM debian:bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/sharecode-server /app/sharecode-server

EXPOSE 3001

CMD ["./sharecode-server"]
