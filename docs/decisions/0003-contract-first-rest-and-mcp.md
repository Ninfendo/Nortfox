# 3. Contract-first REST and MCP from one registry

Status: accepted, 2026-11-01

## Context

Everything in NortFox must work through the API and through MCP. A screen must never be the only way in. When REST, MCP and the client are written by hand, they drift apart.

## Decision

- Each operation is a `createRoute` object from `@hono/zod-openapi`, kept in `packages/contract`. Together these objects are the operation registry.
- An operation declares its id, method and path, input and output shapes, the permission it needs, and the text for its MCP tool.
- REST paths are versioned: `/v1/...`. A breaking change gets a new version beside the old one.
- `openapi.json` is generated from the registry and committed. The TypeScript client in `packages/client` is generated from `openapi.json`.
- MCP at `/mcp` offers the same operations as tools, built from the same registry.
- The server is Hono 4 on Node, in one process.
- The web app calls the server only through the generated client.

## Consequences

- A new feature starts as a new operation. REST, the API description, the client and the MCP tool follow from it.
- CI fails when `openapi.json` or the client is out of date, or when an operation has no permission or no MCP tool.
- The diff of `openapi.json` in a PR shows a reviewer every change to the API.
- Operation names and texts must be good, because agents read them.
