# SPDX-License-Identifier: AGPL-3.0-only
#
# The NortFox server image. The compose file's one-shot migrate step runs
# apps/server/dist/db/migrate-main.js from it. The server itself comes with
# slice 2b. Build it from the repository root:
#
#   docker build --file deploy/server/Dockerfile .
#
# The base image is pinned by its digest (scripts/guards/images.ts). pnpm is
# the version that package.json names (scripts/guards/deploy.ts checks it).
# Each install keeps to pnpm-lock.yaml and runs no install script. The image
# holds the server's build, its production dependencies and the migrations.

FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS source
RUN npm install --global --no-fund --no-audit pnpm@12.16.1
WORKDIR /nortfox
COPY . .

FROM source AS build
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @nortfox/server \
  && pnpm --filter @nortfox/server run build

FROM source AS dependencies
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter @nortfox/server

FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
ENV NODE_ENV=production
WORKDIR /nortfox
COPY --from=dependencies /nortfox/node_modules node_modules
COPY --from=dependencies /nortfox/apps/server/node_modules apps/server/node_modules
COPY --from=build /nortfox/apps/server/dist apps/server/dist
COPY apps/server/package.json apps/server/package.json
COPY db/migrations db/migrations
USER node
CMD ["node", "apps/server/dist/main.js"]
