# 3. Contract-first REST and MCP from one registry

Status: accepted, 2026-11-01. Amended 2026-11-02: the compatible API serves the same operations. Amended 2026-11-04, in slice 2c: the marks of an operation that runs before sign-in, that needs only a signed-in person, or that serves the browser's session, and the credential in `openapi.json`. Amended 2026-11-05, in slice 2c: a `signed-in` operation may work in a company, by its company source. Amended 2026-11-10, in slice 2c: the scope a token needs, the mark of an operation that needs a browser session, and the secret fields of an answer.

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
- Besides a permission, an operation may need none, because it runs before there is an actor, such as a sign-in (`none`), or only a signed-in person, with no permission in a company (`signed-in`). A `signed-in` operation works in no company by default, or in the company its company source names: the credential's (`current`), the one it makes (`new`), or the one its input names, where the person must be an active member. `session` marks an operation that serves the browser's session, such as a sign-in or a logout. Its MCP tool stays in the list, and refuses every call, since an MCP client signs in through OAuth and a session's secret must never reach it. `company` says where the request's company comes from. `openapi.json` names the credential of each operation that needs an actor under `security`. The registry guard holds these together ([docs/api.md](../api.md#the-marks)).
- Each operation that a token may call names the scope the token needs, one of `SCOPES` in `packages/contract`, beside its permission. A `public` operation names none, and so does one that serves the browser's session or needs one (`session: only`, such as `listRecentCompanies`), which no token may call. `secretOutput` lists the fields of the answer that work as a credential, such as a token shown once. The server keeps a write's answer without them, and no operation that a token may call has one, so no token and no MCP client gets a credential in an answer. The registry guard holds these together too.
- REST and MCP call one runner with the same handler, so a refusal is the same problem details on both, and each field problem points into the operation's input, which is the tool's arguments ([docs/api.md](../api.md)).
- The diff of `openapi.json` in a PR shows a reviewer every change to the API.
- Operation names and texts must be good, because agents read them.
- The registry is also the list of what the assistant may do. Approvals, payments, supplier payment details, tokens, memberships, webhooks and settings stay closed to it, because the assistant reads text that outsiders wrote, such as supplier invoices.
