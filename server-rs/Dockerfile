# syntax=docker/dockerfile:1.6

FROM rust:1.93-slim-bookworm AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./

# Create dummy source to build dependencies
RUN mkdir src && \
    echo "fn main() {}" > src/main.rs

# Build dependencies
# We mount the registry to speed up downloads, but we do NOT mount target
# so that the compiled dependencies are saved in this Docker layer.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo build --release --locked

# Remove dummy source
RUN rm -rf src

COPY src ./src

# Touch main.rs to prevent cached timestamp issues (optional but safe)
RUN touch src/main.rs

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo build --release --locked \
    && cp target/release/sharecode-server /app/sharecode-server

FROM debian:bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/sharecode-server /app/sharecode-server

EXPOSE 3001

CMD ["./sharecode-server"]
