# syntax=docker/dockerfile:1.6

ARG VITE_API_URL
ARG VITE_WS_URL
ARG VITE_ALLOW_REGISTRATION

# Build stage
FROM oven/bun:1.2.2-alpine AS build
WORKDIR /app
ARG VITE_API_URL
ARG VITE_WS_URL
ARG VITE_ALLOW_REGISTRATION

ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_WS_URL=${VITE_WS_URL}
ENV VITE_ALLOW_REGISTRATION=${VITE_ALLOW_REGISTRATION}

# Copy dependency files (least frequently changed)
COPY bun.lock package.json ./

# Install dependencies with cache mount for faster rebuilds
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install

# Copy config files (occasionally changed)
COPY tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY vite.config.ts eslint.config.js ./
COPY index.html ./

# Copy source code last (most frequently changed - enables fast rebuilds)
COPY public ./public
COPY src ./src

RUN echo ${VITE_ALLOW_REGISTRATION}
# Build the application
RUN bun run build

# Production stage - minimal nginx image
FROM nginx:1.27-alpine AS runner

# Copy nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy only the built assets from build stage
COPY --from=build /app/dist /usr/share/nginx/html

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost/ || exit 1

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
