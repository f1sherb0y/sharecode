# syntax=docker/dockerfile:1.6

# Build stage
FROM oven/bun:1 AS builder

WORKDIR /app
ENV BUN_INSTALL_CACHE_DIR=/root/.bun/install/cache

# Copy package files
COPY package.json bun.lock ./

# Install dependencies
RUN --mount=type=cache,target=/root/.bun/install/cache \
    --mount=type=cache,target=/root/.cache/bun \
    bun install --frozen-lockfile

# Copy source
COPY . .

# Build args for environment variables
ARG VITE_API_URL
ARG VITE_WS_URL
ARG VITE_ALLOW_REGISTRATION

# Build the app
RUN --mount=type=cache,target=/root/.bun/install/cache \
    --mount=type=cache,target=/root/.cache/bun \
    bun run build

# Production stage
FROM nginx:alpine

# Copy built files
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
