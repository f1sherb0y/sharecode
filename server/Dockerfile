# syntax=docker/dockerfile:1.6

# Base stage with bun runtime
FROM oven/bun:1.2.2-alpine AS base
WORKDIR /app

# Dependencies stage - installs all dependencies including dev
FROM base AS deps
# Copy dependency files (least frequently changed)
COPY bun.lock package.json ./
COPY prisma ./prisma

# Install dependencies with cache mount for faster rebuilds
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# Generate Prisma client in separate layer
RUN bunx prisma generate

# Production dependencies - only production deps for smaller image
FROM base AS prod-deps
COPY bun.lock package.json ./
COPY prisma ./prisma

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

RUN bunx prisma generate

# Production runner - minimal final image
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app

# Copy only production dependencies
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/bun.lock ./bun.lock
COPY --from=prod-deps /app/package.json ./package.json

# Copy config files (occasionally changed)
COPY tsconfig.json ./tsconfig.json
COPY prisma ./prisma

# Copy source code last (most frequently changed - enables fast rebuilds)
COPY src ./src
COPY index.ts ./index.ts

EXPOSE 3001

# Run migrations and start server
CMD ["sh", "-c", "bunx prisma migrate deploy && bun run src/index.ts"]
