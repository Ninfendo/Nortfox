# 3. Contract-first REST and MCP from one registry

Status: accepted, 2026-11-01. Amended 2026-11-02: the compatible API serves the same operations. Amended 2026-11-04, in slice 2c: the marks of an operation that runs before sign-in, that needs only a signed-in person, or that serves the browser's session, and the credential in `openapi.json`.

## Context

Everything in NortFox must work through the API and through MCP. A screen must never be the only way in. When REST, MCP and the client are written by hand, they drift apart.

## Decision

- Each operation is a `createRoute` object from `@hono/zod-openapi`, kept in `packages/contract`. Together these objects are the operation registry.
- An operation declares its id, method and path, input and output shapes, the permission it needs, the text for its MCP tool, and whether the AI assistant may call it. An operation is closed to the assistant unless it says otherwise.
- REST paths are versioned: `/v1/...`. A breaking change gets a new version beside the old one.
- `openapi.json` is generated from the registry and committed. The TypeScript client in `packages/client` is generated from `openapi.json`.
- MCP at `/mcp` offers the same operations as tools, built from the same registry.
- The compatible API ([decision 12](0012-compatible-api.md)) serves the same operations in the established API's shapes. It calls the operations in this registry and adds no rules of its own: every check stays in the operation and in the database.
- The server is Hono 4 on Node, in one process.
- The web app calls the server only through the generated client.

## Consequences

- A new feature starts as a new operation. REST, the API description, the client and the MCP tool follow from it.
- CI fails when `openapi.json` or the client is out of date, or when an operation has no permission or no MCP tool.
- An operation also declares whether it writes. A write takes an idempotency key: the `Idempotency-Key` header on `/v1`, the `idempotencyKey` argument on MCP. A guard refuses a write that takes none, and the server refuses to start with a `/v1` route that is not in the registry.
- `openapi.json` carries each operation's permission, its flags and its tool text, under `x-nortfox`.
- Besides a permission, an operation may need none, because it runs before there is an actor, such as a sign-in (`none`), or only a signed-in person, in no company (`signed-in`). `session` marks an operation that serves the browser's session, such as a sign-in or a logout. Its MCP tool stays in the list, and refuses every call, since an MCP client signs in through OAuth and a session's secret must never reach it. `company` says where the request's company comes from. `openapi.json` names the credential of each operation that needs an actor under `security`. The registry guard holds these together ([docs/api.md](../api.md#the-marks)).
- REST and MCP call one runner with the same handler, so a refusal is the same problem details on both, and each field problem points into the operation's input, which is the tool's arguments ([docs/api.md](../api.md)).
- The diff of `openapi.json` in a PR shows a reviewer every change to the API.
- Operation names and texts must be good, because agents read them.
- The registry is also the list of what the assistant may do. Approvals, payments, supplier payment details, tokens, memberships, webhooks and settings stay closed to it, because the assistant reads text that outsiders wrote, such as supplier invoices.
