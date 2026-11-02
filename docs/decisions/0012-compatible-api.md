# 12. The compatible API

Status: accepted, 2026-11-02

## Context

Many companies and their accountants use programs that talk to the established Swedish accounting system through its API, the established API. A company that moves to NortFox should keep those programs. The owner chose that NortFox's API should work as a drop-in replacement for the established API, with more on top.

## Decision

- NortFox has a second API surface, the compatible API. It follows the established API: its paths, its resource and field names, its JSON shapes, its paging, its error format and codes, and its login flow ([decision 8](0008-authentication.md)). An integration that works with the established API then only changes its base address.
- One operation registry ([decision 3](0003-contract-first-rest-and-mcp.md)) serves the native API under `/v1`, the compatible API and MCP. A compatible endpoint maps its request onto an operation in the registry, and the operation's answer back onto the established API's shape. So each rule is enforced once, and every permission and every database check is the same on each surface.
- The compatible API takes money as JSON numbers, as the established API does. It reads each amount exactly, from the number's own text in the request, never through a float. It writes each amount in its answers from the exact value ([decision 5](0005-money.md)).
- The native API stays as decided: contract first, money as decimal strings, problem details and idempotency keys. What the established API lacks is on `/v1` and in MCP only.
- The compatible API starts in slice 2e of the [plan](../plan.md#step-2-the-foundation). That slice builds its shared parts: the routing, the paging, the error format and codes, the money reader and the login flow. It also adds the compatible endpoints for the operations of the slices before it. No slice before 2e ships a compatible endpoint.
- From 2e on, each slice that adds an operation the established API also has adds its compatible endpoint in the same PR.
- The two surfaces over one registry, with a compatible endpoint in each slice, are the starting design. The owner may change it.
- The compatible API is an adapter. Its code lives in one folder, named by a neutral id, and its one docs page lives in that folder. That folder is the second exception to the names rule ([decision 11](0011-names-policy.md)): inside it, the adapter may name the established system. The PR that creates the folder adds it to the marker allowlist and puts the `.protected-name-ok` marker in it. Both are owner paths, so that PR needs the owner's owner-ok label.
- The public tests of the compatible API use hand-written fixtures with made-up data. The parity tests, which compare NortFox with the established system itself, are kept outside this repository. Public CI never calls the established system.

## Consequences

- An integration written for the established API works with NortFox after a change of base address, for the operations that NortFox has.
- A rule cannot differ between the surfaces, because each calls the same operation.
- Outside the adapter's folder, nothing names the established system. Nothing from the folder that names it reaches `openapi.json`, the client, `packages/i18n`, `docs/system` or a changeset.
- The PR that adds the folder uses neutral words in its title, body, branch name, commits and changeset, because a squash merge copies the title and body into `main`.
- Caddy passes the compatible API's paths and its login paths to the server, as it does `/v1` ([decision 7](0007-self-hosting-and-backups.md)).
- A compatible endpoint keeps two promises: its operation's rules, and the established API's shape. Its tests pin the shape.
