# DeEEP Network Service for homework

# ----------------------------------------
# Builder Stage
# ----------------------------------------
FROM node:22-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy source code and config
COPY tsconfig.json ./
COPY tsup.config.ts ./
COPY src ./src

# Build the application
RUN npm run build
RUN npm prune --omit=dev

# ----------------------------------------
# Third-party Base
# ----------------------------------------
FROM node:22-alpine AS homework-base

# Install system dependencies needed for homework service
RUN apk add --no-cache \
    curl \
    bash \
    procps \
    ca-certificates \
    libc6-compat \
    # For process monitoring
    htop \
    # For debugging
    strace

WORKDIR /app

# Add homework-specific setup
# Copy the binary and set proper permissions
COPY binary /app/binary

# Set secure permissions (executable but not writable by others)
RUN chmod 755 /app/binary && \
    # Create necessary directories
    mkdir -p /app/logs /app/tmp && \
    # Set ownership for riptide user
    chown -R 1005:1005 /app && \
    # Ensure binary is executable
    chmod +x /app/binary

# ----------------------------------------
# Riptide Runtime Layer
# ----------------------------------------
FROM homework-base AS riptide
RUN addgroup -g 1005 riptide && adduser -u 1005 -G riptide -D riptide
COPY --from=quay.io/nerdnode/riptide:latest /usr/local/bin/riptide /usr/local/bin/riptide
COPY --from=quay.io/nerdnode/riptide:latest /riptide-runtime/ /riptide-runtime/
RUN chmod +x /usr/local/bin/riptide
ENV PATH="/usr/local/bin:$PATH"
RUN mkdir -p /riptide && chown -R riptide:riptide /riptide
COPY --from=builder --chown=riptide:riptide /app/dist /riptide/dist
COPY --from=builder --chown=riptide:riptide /app/node_modules /riptide/node_modules
COPY --from=builder --chown=riptide:riptide /app/package.json /riptide/package.json
COPY --chown=riptide:riptide riptide.config.json /riptide/riptide.config.json

EXPOSE 3000
WORKDIR /riptide
USER riptide
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD /usr/local/bin/riptide health || exit 1

# Entry point
ENTRYPOINT ["/usr/local/bin/riptide"]
CMD ["start", "--config", "/riptide/riptide.config.json", "--hooks", "/riptide/dist/hooks.js"]
