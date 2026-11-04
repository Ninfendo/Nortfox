# The API

Everything in NortFox works through the API and through MCP. A screen is one client of the API, never the only way in. This page gives the rules that every operation follows, for anyone who writes a program or an agent against NortFox.

The server has two ways in, built from one list of operations:

- **REST under `/v1`.** Its description is at `/openapi.json`, and the repository commits it as `packages/client/openapi.json`. The TypeScript client in `packages/client` is generated from it.
- **MCP at `/mcp`.** Each operation is an MCP tool.

The compatible API, which follows the established system's API so that an existing integration keeps its own code, comes in slice 2e ([decision 12](decisions/0012-compatible-api.md)). It calls the same operations.

## Operations

Each operation is one entry in the registry in `packages/contract` ([decision 3](decisions/0003-contract-first-rest-and-mcp.md)). An entry declares:

- its id, which is also the MCP tool's name and the client's method name;
- its method and its path under `/v1`, with each path parameter as `{name}`;
- the shapes of its input and its output, and its success status;
- who may call it (`permission`);
- the text of its MCP tool;
- whether it writes;
- whether it is a list;
- whether the AI assistant may call it. An operation is closed to the assistant unless it says otherwise;
- whether it serves the browser's session (`session`);
- where its company comes from (`company`).

`openapi.json` shows these facts on each operation, under `x-nortfox`. So the diff of `openapi.json` in a pull request shows a reviewer every change, a changed permission too.

### The marks

| Mark | Value | Meaning |
| --- | --- | --- |
| `permission` | `public` | Reads and writes no data. Anyone may call it, and it never asks for an actor. |
| | `none` | Runs before there is an actor, such as a sign-in. Anyone may call it. It serves the browser's session, and it takes no idempotency key. |
| | `signed-in` | Needs a signed-in person, and no permission in a company. |
| | a permission, such as `company:read` | Needs that permission in the credential's company. |
| `session` | `flow` | Serves the browser's session, such as a sign-in or a logout. Its MCP tool refuses every call. |
| | `null` | Any other operation. |
| `company` | `none` | Works in no company: every `public`, `none` and `signed-in` operation. |
| | `credential` | Works in the company that the request's credential names: every operation with a permission. |

The registry guard holds these together. An operation that runs before sign-in serves the browser's session. Only a `none` or a `signed-in` operation may serve it. An operation with a permission takes its company from the credential, and no other operation does. A write takes an idempotency key, unless it runs before sign-in. A `GET` writes only when it runs before sign-in and answers 303. Two operations of one method never answer the same path, so `/v1/users/{userId}` and `/v1/users/me` cannot both be `GET`.

The server serves only what the registry holds. It refuses to start when a route under `/v1` is not in the registry.

| Operation | Method and path | Output | Permission | Open to the assistant |
| --- | --- | --- | --- | --- |
| `getHealth` | `GET /v1/health` | `Health`: `status` and `version` | `public` | no |
| `getCompany` | `GET /v1/company` | `Company`: `id`, `name`, `organizationNumber` and `databaseNumber` | `company:read` | yes |

Field names are camelCase. An answer is the object itself, with no wrapper around it.

## Who acts

Every operation with a permission acts as one actor in one company. The company comes from the request's credential, never from the path or the body. A path holds no company id. A `signed-in` operation acts as the signed-in person in no company. A `none` operation runs before there is an actor.

Login and API tokens come in slice 2c. Until its sessions are built the server knows no actor: every operation that needs one answers 401, by REST with the challenge `WWW-Authenticate: Bearer`, and by MCP in a tool result marked `isError`. `GET /v1/health` and `/openapi.json` need no actor.

The server checks the actor and the permission before it reads the rest of the request: on REST before the path parameters, the query and the body, on MCP before the tool's arguments. So a request with no actor gets 401, a credential that names no company gets 403 `company-required` for an operation that works in a company, and an actor without the permission gets 403 `permission-missing`, even when the rest of the request is wrong. None of them touches the database.

Each request runs in one database transaction, with the company, the actor, the actor's kind (`user`, `system` or `integration`) and the channel (`rest` or `mcp`) set for that transaction only. A `signed-in` operation's transaction sets no company. A `none` operation opens its own transactions. A read sees one snapshot, so a page and its total agree. The behandlingshistorik records the actor, its kind and the channel of every change ([db/README.md](../db/README.md)).

## Requests on `/v1`

- Paths and names are case-sensitive. A path has no trailing slash. An unknown path gets 404 `not-found`. A known path with another method gets 405 `method-not-allowed`, with the methods it takes in `Allow`.
- A path parameter is one segment of the path, such as the id in `/v1/users/{userId}`. Its value is checked like any field: a bad one is a field problem at `/userId`.
- A query parameter that the operation does not declare is refused, and so is a parameter given twice.
- A body is JSON in UTF-8, sent as `application/json`. Another media type gets 415 `unsupported-media-type`. A body that does not parse gets 400 `malformed-json`. A body over 1 MiB gets 413 `payload-too-large`.
- A body field that the operation does not declare is refused, at any depth.

## Answers on `/v1`

| Status | When | Body |
| --- | --- | --- |
| 200 | Most successes. | Plain JSON. |
| 201 | An operation that creates something. | Plain JSON. |
| 202 | An operation whose work goes on after the answer. | None. |
| 204 | An operation that has nothing to answer, such as a removal. | None. |
| 303 | A `GET` that runs before sign-in and sends the browser on, such as to an identity provider. | The `Location` header, and the same location as JSON: `{ "location": "..." }`. |

- Every answer carries `Cache-Control: no-store`, a problem too, since it may hold the request's own data.
- An operation that serves the browser's session may set or clear its cookies with `Set-Cookie`. No answer body holds what a cookie holds.
- On MCP, an answer with no body is an empty object.

## Money

An amount is an object with the amount as a decimal string and the currency's ISO 4217 code ([decision 5](decisions/0005-money.md)):

```json
{ "amount": "1234.50", "currency": "SEK" }
```

An amount is never a JSON number, in a request or in an answer. The install knows SEK. Each refusal is a field problem at the amount's pointer:

| Code | When |
| --- | --- |
| `invalid-type` | The amount is a JSON number, or the amount object is not an object. |
| `bad-format` | The amount is not a decimal string such as `"1234.50"` or `"-0.05"`: no `+`, no exponent, no comma, no leading zero, no space. |
| `fraction-of-ore` | The amount has more decimals than its currency. SEK has two. |
| `unknown-currency` | The code is not one the install knows. Codes are upper case. |
| `out-of-range` | The amount is outside -92233720368547758.08 to 92233720368547758.07, the range the database stores. |

## Errors

Every error on `/v1` is problem details (RFC 9457), as `application/problem+json`:

```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "The request does not fit the operation. Each field problem names its field.",
  "code": "invalid-request",
  "errors": [
    { "code": "unknown-field", "detail": "The field /note is not part of this operation.", "pointer": "/note" },
    { "code": "invalid-type", "detail": "The field /description must be a string.", "pointer": "/description", "data": { "expected": "string" } }
  ]
}
```

- `type` is always `about:blank`, so `title` is the status's phrase.
- `code` is stable and kebab-case. Programs rely on `code`, never on `detail`. The texts are English until slice 2d brings the Swedish ones.
- `errors` lists every field problem of a 400 `invalid-request`. Each has its own `code`, a `detail`, a `pointer` and, when there are any, its facts in `data`: `expected` (the JSON type the field takes), `minimum`, `maximum` and `allowed` (the values it takes).
- `permission` names the permission a 403 `permission-missing` lacks.
- A rule's refusal, 422, has the rule's `code`, its facts in `data`, and a `pointer` when it is about one field, so a screen can show it on that field.
- A 500 `internal-error` holds nothing of the error. The server logs it.
- An answer never repeats the values the request sent.

### Pointers

A pointer is a JSON Pointer (RFC 6901), in its string form, into the operation's flat input. The flat input is one object with the path parameters, the query parameters, the body's fields and, for a write, `idempotencyKey`. It is the same object that the operation's MCP tool takes. So:

- `/userId` is the path parameter `userId`;
- `/limit` is the query parameter `limit`;
- `/amount/amount` is the field `amount` inside the body field `amount`;
- `/idempotencyKey` is the `Idempotency-Key` header on REST and the argument on MCP;
- `""`, the root, is a body that is not an object.

The registry keeps the names apart, so a pointer is never ambiguous. The same request gives the same problem details by REST and by MCP.

### Codes

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid-request` | The request does not fit the operation. `errors` says where. |
| 400 | `malformed-json` | The body is not JSON in UTF-8. |
| 401 | `authentication-required` | The request names no actor. |
| 403 | `company-required` | The operation works in a company, and the request's credential names none. |
| 403 | `permission-missing` | The actor lacks the operation's permission. |
| 403 | `origin-not-allowed` | A request to `/mcp` from a browser origin that may not call it. |
| 403 | `browser-only` | An MCP call of an operation that serves the browser's session. |
| 404 | `not-found` | No operation has the path. |
| 405 | `method-not-allowed` | The path takes another method. |
| 409 | `idempotency-key-in-use` | Another request with the same idempotency key is still running. |
| 413 | `payload-too-large` | The body is over 1 MiB. |
| 415 | `unsupported-media-type` | The body is not `application/json`. |
| 422 | `idempotency-key-reused` | The idempotency key belongs to another request. |
| 422 | a rule's code | A rule refuses the request, such as `period-locked-manual`. |
| 500 | `internal-error` | The server failed. |

The field problems:

| Code | When |
| --- | --- |
| `unknown-parameter` | A query parameter that the operation does not declare (REST). |
| `repeated-parameter` | A query parameter given more than once (REST). |
| `unknown-field` | A body field or a tool argument that the operation does not declare. |
| `missing-field` | A field that the operation needs is missing. |
| `invalid-type` | A field has the wrong JSON type. `data.expected` names the right one. |
| `invalid-value` | A field holds a value it does not take. `data.allowed` lists the values when there is a list. |
| `too-short`, `too-long` | A text or a list is shorter or longer than it may be. |
| `not-an-integer` | A number that must be whole is not. |
| `out-of-range` | A number or an amount is outside its bounds. |
| `bad-format`, `fraction-of-ore`, `unknown-currency` | An amount is wrong (above). |
| `cursor-invalid` | A cursor that this server did not make for this list and this company. |
| `idempotency-key-missing`, `idempotency-key-invalid` | A write's key is missing, or is not a key (below). |

The rules of the ledger live in the database. When one refuses a request, the answer is 422 with the rule's reason in kebab-case as its code, such as `unbalanced`, `period-locked-manual` or `date-outside-fiscal-year`, and the rule's facts in `data` with camelCase keys. An amount among the facts is Money. [db/README.md](../db/README.md) lists every reason.

## Writes and idempotency keys

A write takes an idempotency key: the `Idempotency-Key` header on REST, and the `idempotencyKey` argument on MCP. A key is 1 to 255 characters of visible ASCII without `"` and `\`, such as a random UUID. The header takes the key bare or in double quotes, as the IETF draft writes it. A write that runs before sign-in takes no key, since there is no actor to keep it for.

- The same key with the same request gives the first answer again, and nothing is written twice. An answer without a body is given again with no body.
- The same key with another request gets 422 `idempotency-key-reused`. Another operation, another path parameter, another body or another query is another request, and so is `"1.5"` beside `"1.50"`.
- A request whose key a running request holds gets 409 `idempotency-key-in-use`, and writes nothing. Send it again once the first has ended.
- A write with no key gets 400, with the field problem `idempotency-key-missing` at `/idempotencyKey`. A key that is not a key gets `idempotency-key-invalid` there.
- Keys belong to one company and one actor. The same key in another company, or from another actor, is another key. A signed-in person's write that works in no company keeps its keys for the person alone.
- The key and the first answer are stored in the write's own transaction. A write that is refused or fails stores no key, so a retry with the key runs again.
- REST and MCP share the keys: the same input by either gives the same answer.
- Keys do not expire yet.

## Lists

A list takes `limit` and `cursor`, and answers its items, `nextCursor` while more follow, and `total`, the number of items in the whole list:

```json
{ "items": [], "nextCursor": "eyJ2IjoxLC...", "total": 250 }
```

- `limit` is 1 to 500, and 100 by default. Any other whole number gives 100 too. A limit that is not a whole number gets 400 at `/limit`.
- Pass the page's `nextCursor` as `cursor` to get the next page. The last page has no `nextCursor`.
- A cursor is opaque. It works only for the list and the company it came from, and only until the server restarts. Any other cursor gets 400 `cursor-invalid`; start the list again without it.
- Every item comes exactly once across the pages, in the list's order.

## MCP

`/mcp` serves MCP's Streamable HTTP transport, in the 2026-07-28 revision and, without sessions, for clients of the 2025 era. Each message is its own HTTP request. A request of the 2026-07-28 revision gets one JSON body. A request of the 2025 era gets an event stream that holds its one answer, as that era's transport allows. `GET` and `DELETE`, the 2025 session operations, get 405.

`tools/list` lists exactly the registry, in its order:

- the tool's `name` is the operation's id, its `title` the operation's summary, and its `description` the operation's tool text;
- its `inputSchema` is the flat input as one strict JSON Schema object: the path parameters, the query parameters, the body's fields and, for a write, the required `idempotencyKey`;
- its `outputSchema` is the REST answer's shape, and an empty object for an operation that answers with no body;
- `annotations.readOnlyHint` is true for an operation that does not write.

A tool call answers the same JSON as the REST call, as structured content and as the same JSON in one text block. A refusal answers the same problem details as `/v1`, in a result marked `isError`. A tool name that the registry does not hold is a protocol error. Each tool call is one request, with one transaction and the same rules as REST.

The tool of an operation that serves the browser's session, such as a sign-in, is listed like any other, and refuses every call with 403 `browser-only` before it reads an argument. An MCP client signs in through OAuth instead.

The arguments take JSON's own types: on MCP, `limit` is a JSON number, and the key is the argument as it is, without the header's quotes.

`/mcp` checks the `Origin` header before anything else, as the MCP specification asks against DNS rebinding. A request whose `Origin` the install does not allow gets 403 `origin-not-allowed`, and nothing runs for it. A request with no `Origin`, as a program that is not a browser sends, is not refused for that. Until slice 2c, the install allows no browser origin.

## The assistant

The registry is also the list of what the AI assistant may do ([decision 3](decisions/0003-contract-first-rest-and-mcp.md)). Today `getCompany` is the one operation open to it. The assistant itself comes in slice 4i.
