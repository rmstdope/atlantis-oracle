# atlantis-oracle worker image: a headless Discord bot (no ports).
# Runtime needs git (repo sync) and make + g++ (rules and compendium build).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY guides ./guides
COPY native ./native
# /app/data is the state volume (game clone, built rules, JSON stores). Created
# here so a fresh named volume starts out owned by the unprivileged user.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/rmstdope/atlantis-oracle" \
      org.opencontainers.image.revision="${VCS_REF}"
# The deployment's compose file sets its own timings; these are for plain `docker run`.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20m \
    CMD ["node", "dist/health.js"]
CMD ["node", "dist/index.js"]
