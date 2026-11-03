# SPDX-License-Identifier: AGPL-3.0-only
#
# The NortFox server image. Its command starts the server: the API under
# /v1 and MCP at /mcp. The compose file's one-shot migrate step runs
# apps/server/dist/db/migrate-main.js from it, and the compose file runs the
# server itself from slice 2c on, with Caddy in front of it. Build it from the
# repository root:
#
#   docker build --file deploy/server/Dockerfile .
#
# The base image is pinned by its digest (scripts/guards/images.ts). pnpm is
# the version that package.json names (scripts/guards/deploy.ts checks it).
# Each install keeps to pnpm-lock.yaml and runs no install script. The image
# holds the server's build, the builds of the workspace packages it runs on
# (the engine and the contract), their production dependencies and the
# migrations. "@nortfox/server..." selects the server and the workspace
# packages it depends on; --filter-prod leaves out those it needs only for
# its tests.

FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS source
RUN npm install --global --no-fund --no-audit pnpm@12.16.1
WORKDIR /nortfox
COPY . .

FROM source AS build
RUN pnpm install --frozen-lockfile --ignore-scripts --filter-prod "@nortfox/server..." \
  && pnpm --filter-prod "@nortfox/server..." run build

FROM source AS dependencies
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter-prod "@nortfox/server..."

FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
ENV NODE_ENV=production
WORKDIR /nortfox
COPY --from=dependencies /nortfox/node_modules node_modules
COPY --from=dependencies /nortfox/apps/server/node_modules apps/server/node_modules
COPY --from=dependencies /nortfox/packages/contract/node_modules packages/contract/node_modules
COPY --from=build /nortfox/apps/server/dist apps/server/dist
COPY --from=build /nortfox/packages/contract/dist packages/contract/dist
COPY --from=build /nortfox/packages/engine/dist packages/engine/dist
COPY apps/server/package.json apps/server/package.json
COPY packages/contract/package.json packages/contract/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY db/migrations db/migrations
USER node
CMD ["node", "apps/server/dist/main.js"]
