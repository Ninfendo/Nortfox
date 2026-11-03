---
"@nortfox/server": minor
"@nortfox/client": minor
---

The API and MCP spine: every operation comes from one registry, and works by REST under `/v1`, through the generated client and as an MCP tool at `/mcp`. `docs/api.md` gives the rules.

- `getCompany` reads the company the request works in: its id, name, organisation number and database number. It needs the permission `company:read`. Login comes later, so until then the server knows no actor and answers 401 to every operation that reads or writes data. `GET /v1/health` and `/openapi.json` stay open.
- Every error on `/v1` is problem details (RFC 9457), with a stable `code` and a JSON Pointer to each field that is wrong. An unknown query parameter or body field is refused, and so is a JSON number for an amount: money travels as a decimal string with its currency code.
- A write takes an `Idempotency-Key`. The same key and request give the first answer again, and nothing is written twice.
- A list pages with `limit` and an opaque `cursor`, and gives the total.
- `/mcp` lists every operation as a tool, with its input and output schemas, for MCP clients of the 2026-07-28 revision and of the 2025 era. A tool call gives the same JSON as REST, and a refusal the same problem details, marked `isError`. A request from a browser origin that the install does not allow gets 403.
- The behandlingshistorik records the channel of each change, `rest` or `mcp`, beside the actor and its kind.
- The client has `getCompany()`, and an `ApiError` carries the problem details of a refused request in `problem`.
