# syntax=docker/dockerfile:1.6

FROM oven/bun:1.2.2 AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY bun.lock package.json tsconfig.json ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

# Production runner
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app

# copy dependency artifacts
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/bun.lock ./bun.lock
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/tsconfig.json ./tsconfig.json
COPY --from=deps /app/prisma ./prisma

# application source
COPY src ./src
COPY index.ts ./index.ts

EXPOSE 3001

CMD ["sh", "-c", "bunx prisma migrate deploy && bunx prisma generate && bun run src/index.ts"]
