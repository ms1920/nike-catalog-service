# syntax=docker/dockerfile:1

# Multi-stage so the runtime image carries no compiler, no dev dependencies and no
# TypeScript sources. Build tooling in a production image is both dead weight and
# extra attack surface.

# ---------------------------------------------------------------- deps
FROM node:22-alpine AS deps
WORKDIR /app
# Copy only manifests first: this layer is cached until dependencies actually
# change, so editing source does not trigger a reinstall.
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# ---------------------------------------------------------------- build
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm run build:web

# ---------------------------------------------------------------- prod deps
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# ---------------------------------------------------------------- api runtime
FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=production

# Run unprivileged. The node image ships a `node` user precisely so images do not
# have to run as root.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# The datastore is written at runtime, so its directory must be writable by the
# unprivileged user. Declared as a volume so data survives container replacement.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

USER node
EXPOSE 3000

# Hits the readiness endpoint, not liveness: readiness is the one that proves the
# datastore decrypted and the repositories hydrated.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `node dist/server.js` directly rather than through npm: npm would sit between
# the init process and node, swallowing SIGTERM and defeating graceful shutdown.
CMD ["node", "dist/server.js"]

# ---------------------------------------------------------------- web runtime
FROM nginx:1.27-alpine AS web
COPY --from=build /app/dist-web /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
