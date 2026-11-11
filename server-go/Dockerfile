# syntax=docker/dockerfile:1.6

FROM golang:1.26-bookworm AS builder
WORKDIR /app

# Dependencies first, so that they are a layer of their own.
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY cmd ./cmd
COPY internal ./internal
COPY migrations ./migrations

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /app/sharecode-server ./cmd/sharecode-server

FROM debian:bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/sharecode-server /app/sharecode-server

EXPOSE 3001

CMD ["./sharecode-server"]
