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
- where its company comes from (`company`);
- which fields of its answer are a person's contact data (`personalOutput`).

`openapi.json` shows these facts on each operation, under `x-nortfox`, and names the credential of each operation that needs an actor under OpenAPI's own `security` (Who acts, below). So the diff of `openapi.json` in a pull request shows a reviewer every change, a changed permission too.

### The marks

| Mark | Value | Meaning |
| --- | --- | --- |
| `permission` | `public` | Reads and writes no data. Anyone may call it, and it never asks for an actor. |
| | `none` | Runs before there is an actor, such as a sign-in. Anyone may call it. It serves the browser's session, and it takes no idempotency key. |
| | `signed-in` | Needs a signed-in person, and no permission in a company. |
| | a permission, such as `company:read` | Needs that permission in the credential's company. |
| `session` | `flow` | Serves the browser's session, such as a sign-in or a logout. Its MCP tool refuses every call. |
| | `null` | Any other operation. |
| `company` | `none` | Works in no company: every `public` and `none` operation, and a `signed-in` one by default. |
| | `credential` | Works in the company that the request's credential names: every operation with a permission. |
| | `current` | A `signed-in` operation that works in the credential's company when it names one, and in none otherwise, such as `getMe`. |
| | `new` | A `signed-in` operation that works in the company it makes: `createCompany`. The server picks the company's id. |
| | `{"input": "companyId"}` | A `signed-in` operation that works in the company that a field of its input names, where the person must be an active member, such as `selectCompany`. Any other company, also one that does not exist, gets 422 `company-not-available` at the field's pointer. |
| `personalOutput` | a list of JSON Pointers | The fields of the answer that hold a person's contact data: a person's name, an e-mail address, a phone or mobile number, a personnummer. The registry derives the list from the answer's schema, and `*` stands for each item of a list or a tuple and each value of a record. A write keeps the answer of its key outside every company table when the list is not empty (Writes and idempotency keys). |

The registry guard holds these together. An operation that runs before sign-in serves the browser's session. Only a `none` or a `signed-in` operation may serve it. An operation with a permission takes its company from the credential, and no other operation does. Only a `signed-in` operation takes its company from `current`, `new` or its input, and the input's field is a required string. A write takes an idempotency key, unless it runs before sign-in. A `GET` writes only when it runs before sign-in and answers 303. Two operations of one method never answer the same path, so `/v1/users/{userId}` and `/v1/users/me` cannot both be `GET`. Two operations whose paths differ only in a parameter's name are one path, so they give the parameter one name: `GET /v1/users/{userId}` and `PATCH /v1/users/{id}` cannot both be in the registry. An operation that needs an actor, `signed-in` or with a permission, names its credential in `security`, and a `public` or `none` operation names none.

The server serves only what the registry holds. It refuses to start when a route under `/v1` is not in the registry.

| Operation | Method and path | Output | Permission | Open to the assistant |
| --- | --- | --- | --- | --- |
| `getHealth` | `GET /v1/health` | `Health`: `status` and `version` | `public` | no |
| `getCompany` | `GET /v1/company` | `Company`: `id`, `name`, `organizationNumber` and `databaseNumber` | `company:read` | yes |
| `completeSetup` | `POST /v1/setup/{token}` | `SetupResult`: `user` and `totpEnrolment` | `none` | no |
| `loginWithPassword` | `POST /v1/auth/password` | `PasswordSignIn`: `outcome` and, for the TOTP step, `challenge` | `none` | no |
| `verifyTotp` | `POST /v1/auth/totp` | none (204) | `none` | no |
| `logout` | `POST /v1/auth/logout` | none (204) | `signed-in` | no |
| `getSession` | `GET /v1/session` | `Session`: `user`, and `company` once one is chosen | `signed-in` | no |
| `getMe` | `GET /v1/me` | `Me`: `user`, `personalIdentityNumber`, `mobile`, `twoStep`, `permissions` (empty in no company), and in a company `company` and `membership` | `signed-in` | no |
| `createCompany` | `POST /v1/companies` | `Company` (201) | `signed-in` | no |
| `listCompanies` | `GET /v1/companies` | a page of `CompanyChoice`: `company` and `adminLevel` | `signed-in` | no |
| `listRecentCompanies` | `GET /v1/me/companies/recent` | `RecentCompanies`: `companies` | `signed-in` | no |
| `selectCompany` | `POST /v1/session/company` | `Session` | `signed-in` | no |
| `updateMyMembership` | `PATCH /v1/me/companies/{companyId}` | `Membership` | `signed-in` | no |

`User` is a person: `id`, `name`, `email` and `language` (`sv` or `en`).

`Membership` is the person in one company, Användare there: `companyId`, `userId`, `status` (`invited`, `active`, `inactive`, `removed` or `left`), `adminLevel` (`owner` or `admin`, the system administrator's level, `SysAdmin`, absent for none), `idleTimeout` ("Utloggning efter inaktivitet": 15, 30, 60, 120 or 480 minutes, 120 by default) and the work contacts `workEmail` and `workPhone`.

Field names are camelCase. An answer is the object itself, with no wrapper around it.

## Who acts

Every operation with a permission acts as one actor in one company. The company comes from the request's credential, never from the path or the body. A path inside the company holds no company id. A `signed-in` operation acts as the signed-in person, in no company, in the credential's company (`current`), in the company it makes (`new`), or in the company its input names, where the person must be an active member: a path about the person's own memberships names the company. A `none` operation runs before there is an actor.

A browser signs in with a password and a TOTP code, and then sends its session in a cookie (Signing in, below). `openapi.json` names that cookie as the security scheme `sessionCookie`, an API key in the cookie `__Host-nortfox-session`, on every operation that needs an actor. The browser sends it by itself, and no script reads it, so the generated client takes no option for it. The server looks the session up on every request. A session acts as its person, with the actor kind `user`. It works in no company until it chooses one with `selectCompany` (The companies, below). On `/v1`, a request with a bearer token ignores the cookie; API tokens come in a later part of slice 2c, so until then a bearer token names no actor. `/mcp` never reads the cookie: an MCP client signs in through OAuth, which comes in a later part of slice 2c, so until then every tool that needs an actor answers 401. An operation that needs an actor answers 401 without one, by REST with a challenge in `WWW-Authenticate` that names the credential the operation takes, and by MCP in a tool result marked `isError`. In this part of slice 2c that credential is the session cookie, whose challenge is `Cookie realm="NortFox", cookie-name="__Host-nortfox-session"`. HTTP has no registered scheme for a cookie, so that scheme is NortFox's own, and a client that does not know it ignores it. `openapi.json` names the challenge on each 401. `GET /v1/health` and `/openapi.json` need no actor.

The server checks the actor and the permission before it reads the rest of the request: on REST before the path parameters, the query and the body, on MCP before the tool's arguments. So a request with no actor gets 401, a credential that names no company gets 403 `company-required` for an operation in the credential's company, and an actor without the permission gets 403 `permission-missing`, even when the rest of the request is wrong. No transaction of the operation runs for them, and nothing of the input is read. Only the session's own lookup runs first: the server finds the session by its cookie's hash, ends it when it has passed its end, and notes the request.

Each request runs in one database transaction, with the company, the actor, the actor's kind (`user`, `system` or `integration`) and the channel (`rest` or `mcp`) set for that transaction only. A `signed-in` operation's transaction works in the company that its company source names (the credential's, the one it makes, or the one its input names), or in none. A `none` operation opens its own transactions. A read sees one snapshot, so a page and its total agree. The behandlingshistorik records the actor, its kind and the channel of every change ([db/README.md](../db/README.md)).

## Requests on `/v1`

- Paths and names are case-sensitive. A path has no trailing slash. An unknown path gets 404 `not-found`. A known path with another method gets 405 `method-not-allowed`, with the methods it takes in `Allow`.
- A path parameter is one segment of the path, such as the id in `/v1/users/{userId}`. Its value is checked like any field: a bad one is a field problem at `/userId`.
- A query parameter that the operation does not declare is refused, and so is a parameter given twice.
- A body is JSON in UTF-8, sent as `application/json`. Another media type gets 415 `unsupported-media-type`. A body that does not parse gets 400 `malformed-json`. A body over 1 MiB gets 413 `payload-too-large`.
- A body field that the operation does not declare is refused, at any depth.

## Cross-site requests

A browser's session comes in the cookie `__Host-nortfox-session`, which is `SameSite=Strict`, so a browser never sends it with a request that another site starts. `/v1` also checks the `Origin` header, from the request's headers alone and before it reads the cookie:

- A request whose method is not `GET` or `HEAD`, that carries the session cookie and no bearer token, must carry the install's own origin in `Origin`. A browser sends `Origin` with every such request. Without it, or with another, the request gets 403 `origin-not-allowed`.
- An operation that runs before sign-in (`permission: none`) refuses an `Origin` that is not the install's, so another site cannot sign a browser in. A request with no `Origin` and no session cookie, from a program that is not a browser, runs. With the session cookie, the first rule holds: a sign-in from a program that still sends an old session cookie gets 403 `origin-not-allowed`.
- A request with a bearer token is a program's. It ignores the cookie, so the first rule does not touch it.

The install's own origin is the one it is set up with, `NORTFOX_PUBLIC_ORIGIN` ([deploy/README.md](../deploy/README.md)). `/mcp` allows the same one. A `public` operation reads nothing of anyone's, so neither rule touches it. A body is `application/json` only, which a form on another site cannot send without a preflight, and `/v1` answers no preflight.

## Signing in

A browser signs in in two steps. Each serves the browser's session, so its MCP tool refuses every call.

1. `loginWithPassword` takes an identifier and the password. The identifier is the e-mail address, in any letter case, or the personnummer: in 12 digits, with or without the hyphen, or in 10, `YYMMDD-NNNN`, with `+` in place of `-` from the year the person turns 100. A right password gives `{ "outcome": "totp-required", "challenge": "..." }`. The challenge works for 20 minutes and for five codes.
2. `verifyTotp` takes the challenge and the six digits of the person's authenticator app (RFC 6238). A right code answers 204, sets the session cookie, and makes the browser a known device. A code works once, also when it is sent twice at once. The browser keeps its device cookie only when it names a device that the person knows already. Otherwise the answer sets a new one: a device token that the server did not give the person, such as one that someone else put in the browser, never becomes the person's known device. So one browser is a known device of one person at a time.

The person's two-step choice, `twoStep` in `getMe`, says how often the TOTP step comes. With `new_device_90_days`, which a new identity starts with, it comes on a new device, and on a known device 90 days after the device's last TOTP step. Inside those 90 days, on a known device, `loginWithPassword` answers `{ "outcome": "signed-in" }` and sets the session cookie itself. With `every_login` it comes at every sign-in.

| Cookie | Holds | Attributes |
| --- | --- | --- |
| `__Host-nortfox-session` | the session | `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, and no `Max-Age`, so it ends with the browser |
| `__Host-nortfox-device` | the known device | `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, and `Max-Age` 400 days |

No answer body holds a session's token, and the server keeps every token only as its hash. `getSession` gives the session's person, and `getMe` the person's own login data. A session ends at `logout`, 12 hours after it began, and after its idle time without a request: the membership's "Utloggning efter inaktivitet" while it works in a company, and 120 minutes while it works in none. The server notes a request at most once a minute, so that end can come up to a minute early. It notes a request at once when the idle time in force is not the one the session was last seen under. The session keeps the idle time of the request it last noted. A lower idle time holds at once for every session that works with the membership, also one that makes no request, and stays with it when the idle time is raised again. A higher one holds for a session from its next request. So a session that went past its idle time does not come back when the idle time is raised. A session's own change of the idle time of the membership it works with holds for it from its next request; a session that chose another company meanwhile keeps that company's idle time. From the next request on, its cookie gets 401, and so does every request of the session sent at once with that one: the session ends once. `logout` ends the session at once and clears its cookie. The browser stays a known device.

**One answer for every failure.** Every failed password step gets 422 `sign-in-failed`: an unknown identifier, a deleted identity, an identity without a password and a wrong password. With no identity or no password, the server checks the password against a dummy hash, so the time tells nothing either. Every failed TOTP step gets 422 `sign-in-failed` too: a wrong code, a code used before, and a challenge that is used, past its 20 minutes or out of codes. A stored TOTP secret that does not open with the install secret is the server's fault, not a wrong code: the step answers 500 `internal-error`, counts nothing against the person, and the server logs which secret it was.

**The limits.**

- The failures of the password step count per account, for an hour from the first: the identity's, or, for an identifier that names none, the identifier's, so both are limited the same way. An e-mail address counts in the form that finds its identity: folded as the database folds it, so every spelling that would find one identity counts as one. After the nth failure from the fifth on, the next attempt waits 2^(n-5) seconds, at most 60, and never past the hour's end. At 100 failures the step is locked until the hour has passed. An attempt that comes too soon gets 429 `too-many-attempts` with `Retry-After`, and its password is not checked. A right password clears the count.
- A challenge takes five codes in all, also from parallel calls. Ten wrong codes of one identity in 15 minutes lock its TOTP step for 15 minutes from the tenth, with 429 `too-many-attempts` and `Retry-After`, also across its challenges, and also when the 15 minutes from the first wrong code end before the lock does.
- Each attempt is counted before it is checked, so attempts sent at once come one after another: a burst gets no more checked than one attempt after another would. An attempt that the server could not check, such as one that gets 503, counts nothing.
- The server checks at most as many passwords at once as it has cores, with a queue of as many. When both are full, a request gets 503 `server-busy` with `Retry-After: 1`.

**Kontoaktivitet** holds the person's own events: each sign-in and each failed one, with the method, the second step, the application and the IP address; the lock of a step; each logout; and each company the person made. The entries of a failure are written after the answer.

**The behandlingshistorik.** A sign-in is written in the company it signs in to, each time `selectCompany` chooses one, also when switching: Program "Användare", Rubrik "Inloggning", with the method (`password-email` or `password-personnummer`), the second step (`totp` or `known-device`), when the person identified (the session's start, once the sign-in's last step passed; a switch of company keeps it), the personnummer for a sign-in with the personnummer, the application (`web`, "Webb") and the IP address of the choice. An IPv4 address is written as IPv4, `a.b.c.d`, also when the server listens on IPv6 and sees it as `::ffff:a.b.c.d`; Kontoaktivitet writes it the same way. A failed sign-in, a wrong password for an identifier that names an identity or a wrong TOTP code, is written after the answer in each company where the identity is an active member, with the identity as the person, at most once a minute per company, with the count of the identity's failed sign-ins in the last hour. A failure for an identifier that names no identity is written nowhere. No operation of this slice reads the behandlingshistorik.

**The first identity.** An empty install gets its first identity from a setup link that the install's setup command prints ([deploy/README.md](../deploy/README.md)). `completeSetup` takes the link's token in its path, with a name, an e-mail address and a password. The link works once, for 28 days, and a newer link stops it. Any other link gets 422 `setup-link-invalid`, and an install that has an identity 422 `install-not-empty`. The answer gives the new TOTP secret as an `otpauth` URI, and sets no session: the person signs in next, and the first right code confirms the secret.

**Passwords.** A new password is 12 to 1024 characters, counted in code points after NFC normalisation. One that is too short or too long is a field problem at `/password`, `too-short` or `too-long`. One that holds a lone surrogate (half of a character, which JSON can send as an escape such as `\ud800`), or more than 30 combining marks in a row, is a field problem too, `invalid-value`, and such a password is never right at the sign-in. The server keeps a password only as an Argon2id hash.

## The companies

A signed-in person makes a company with `createCompany`: its name and organisation number. The person is its owner, a system administrator, from the same transaction, and the company gets its tenant id, `databaseNumber`, a whole number from 1 to 2147483647 that is never given out again, also when the transaction that took it fails. The organisation number never changes. A company always has an active system administrator. The session does not move to the new company: `selectCompany` chooses it.

`listCompanies` lists the companies where the person is an active member, by name, with the person's system administrator's level in each; `query` keeps those whose name, in any letter case, or organisation number holds it. `listRecentCompanies` gives the three the person chose last, of those where the person is still an active member.

`selectCompany` ("Byt företag") makes the session work in a company where the person is an active member, without a new sign-in. Any other company, also one that does not exist, gets 422 `company-not-available` at `/companyId`. The session keeps the membership it chose the company with, and the person's permissions there as they were then. The session ends at once when that membership is deactivated, disconnected, removed or left, and stays ended when the membership is active again. On every request the server also asks whether that membership is still the person's active one there: when it is not, or the person holds another one there now, the request gets 401 and the session ends. A session that ends while `selectCompany` runs, such as by a `logout` at the same time, chooses nothing and gets 401, as a request with no actor. A membership that is deactivated, disconnected, removed or left while `selectCompany` runs never stays with the session: a change that commits first makes the choice get 422 `company-not-available`, and one that comes later waits for the choice, and then ends the session. Once the session has chosen a company, `getSession` and `getMe` give the company, and `getMe` the membership and the permissions; `getCompany` and every other operation with a permission work in it. Until the session chooses a company, `getCompany` and every other operation with a permission answer 403 `company-required`, `getSession` and `getMe` give no company, and `getMe` gives an empty list of permissions.

The permissions in a company: every active member holds `company:read`, so every member reads the company with `getCompany`. A system administrator holds nothing more yet. The permissions to run the company's users and their programs come with the user administration, in a later part of slice 2c.

`updateMyMembership` changes the person's own work e-mail address and phone number in a company, and its idle logout, one of 15, 30, 60, 120 and 480 minutes: on the screen, Användaruppgifter. Any other value is a field problem at `/idleTimeout`. A field left out stays as it is, and `null` takes a work contact away. The company is the one in the path, where the person must be an active member, as for `selectCompany`: any other company gets 422 `company-not-available` at `/companyId`, and so does a change that waited for a removal or a deactivation of the membership. Two changes of one membership at once take turns, so each keeps the field that the other gave. The work contacts belong to the person's membership in that company alone, and are not in the behandlingshistorik.

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
- `errors` lists every field problem of a 400 `invalid-request`. Each has its own `code`, a `detail`, a `pointer` and, when there are any, its facts in `data`: `expected` (the JSON type the field takes), `minimum`, `maximum`, `allowed` (the values it takes) and `format` (the format a text lacks).
- `permission` names the permission a 403 `permission-missing` lacks.
- A rule's refusal, 422, has the rule's `code`, its facts in `data`, and a `pointer` when it is about one field, so a screen can show it on that field.
- A 429 and a 503 carry `Retry-After`, in whole seconds.
- A 500 `internal-error` holds nothing of the error. The server logs it, but only the error's class, its code, the constraint, schema, table and column it names, its message and its stack, with every token, personnummer and e-mail address taken out. The log never holds a database error's detail, which can hold a row, nor the parameters of a statement.
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
| 403 | `company-required` | The operation works in the credential's company, and the credential names none. |
| 403 | `permission-missing` | The actor lacks the operation's permission. |
| 403 | `origin-not-allowed` | A request from a site that may not send it: to `/mcp` from a browser origin that the install does not allow, or to `/v1` as Cross-site requests says. |
| 403 | `browser-only` | An MCP call of an operation that serves the browser's session. |
| 404 | `not-found` | No operation has the path. |
| 405 | `method-not-allowed` | The path takes another method. |
| 409 | `idempotency-key-in-use` | Another request with the same idempotency key is still running. |
| 413 | `payload-too-large` | The body is over 1 MiB. |
| 415 | `unsupported-media-type` | The body is not `application/json`. |
| 422 | `idempotency-key-reused` | The idempotency key belongs to another request. |
| 422 | `sign-in-failed` | A sign-in step failed. The answer is the same for every cause (Signing in). |
| 422 | `setup-link-invalid` | The setup link is unknown, used, stopped by a newer link, or past its end. |
| 422 | `company-not-available` | The person is no active member of the company that the input names, or it does not exist: the same answer for both. `pointer` names the field. |
| 422 | a rule's code | A rule refuses the request, such as `period-locked-manual`, or `install-not-empty` for a setup link on an install that has an identity. |
| 429 | `too-many-attempts` | An attempt came too soon after failed ones, or while its step is locked. `Retry-After` gives the seconds to wait. |
| 500 | `internal-error` | The server failed. |
| 503 | `server-busy` | The server checks as many passwords as it can at once. `Retry-After` gives the seconds to wait. |

The field problems:

| Code | When |
| --- | --- |
| `unknown-parameter` | A query parameter that the operation does not declare (REST). |
| `repeated-parameter` | A query parameter given more than once (REST). |
| `unknown-field` | A body field or a tool argument that the operation does not declare. |
| `missing-field` | A field that the operation needs is missing. |
| `invalid-type` | A field has the wrong JSON type. `data.expected` names the right one. |
| `invalid-value` | A field holds a value it does not take. `data.allowed` lists the values when there is a list. No text that the server stores or looks up takes U+0000, which PostgreSQL's text cannot hold, or a lone surrogate (half of a character, which JSON can send as an escape such as `\ud800`). |
| `too-short`, `too-long` | A text or a list is shorter or longer than it may be. |
| `not-an-integer` | A number that must be whole is not. |
| `out-of-range` | A number or an amount is outside its bounds. |
| `bad-format` | A text does not have its format, such as an e-mail address, a token, a six-digit code or a UUID. `data.format` names the format: `email`, `uuid`, or `regex` for a pattern. An amount that is not a decimal string gets it too, with no `data.format` (above). |
| `fraction-of-ore`, `unknown-currency` | An amount is wrong (above). |
| `cursor-invalid` | A cursor that this server did not make for this list and this company. |
| `idempotency-key-missing`, `idempotency-key-invalid` | A write's key is missing, or is not a key (below). |

The rules of the ledger live in the database. When one refuses a request, the answer is 422 with the rule's reason in kebab-case as its code, such as `unbalanced`, `period-locked-manual` or `date-outside-fiscal-year`, and the rule's facts in `data` with camelCase keys. An amount among the facts is Money. [db/README.md](../db/README.md) lists every reason.

## Writes and idempotency keys

A write takes an idempotency key: the `Idempotency-Key` header on REST, and the `idempotencyKey` argument on MCP. A key is 1 to 255 characters of visible ASCII without `"` and `\`, such as a random UUID. The header takes the key bare or in double quotes, as the IETF draft writes it. A write that runs before sign-in takes no key, since there is no actor to keep it for.

- The same key with the same request gives the first answer again, and nothing is written twice. An answer without a body is given again with no body.
- The same key with another request gets 422 `idempotency-key-reused`. Another operation, another path parameter, another body or another query is another request, and so is `"1.5"` beside `"1.50"`.
- A request whose key a running request holds gets 409 `idempotency-key-in-use`, and writes nothing. Send it again once the first has ended.
- A write with no key gets 400, with the field problem `idempotency-key-missing` at `/idempotencyKey`. A key that is not a key gets `idempotency-key-invalid` there.
- Keys belong to one company and one actor. The same key in another company, or from another actor, is another key. A signed-in person's write that works in no company keeps its keys for the person alone, and so does `createCompany`, whose company is new on each try. A write in a company whose answer holds a person's contact data (`personalOutput`), such as `updateMyMembership` and `selectCompany`, keeps its key for the person and the company outside every company table, so that data never reaches the behandlingshistorik.
- The key and the first answer are stored in the write's own transaction. A write that is refused or fails stores no key, so a retry with the key runs again.
- The server keeps a request's fingerprint, never the request: an HMAC-SHA256 of it, under a key from the install secret. A body can hold a password, and without the install secret a stored fingerprint tells nothing of it.
- REST and MCP share the keys: the same input by either gives the same answer.
- The keys that are kept outside the company tables are purged 24 hours after they were stored. The keys of a write in a company's own table do not expire yet.

## Lists

A list takes `limit` and `cursor`, and answers its items, `nextCursor` while more follow, and `total`, the number of items in the whole list:

```json
{ "items": [], "nextCursor": "eyJ2IjoxLC...", "total": 250 }
```

- `limit` is 1 to 500, and 100 by default. Any other whole number gives 100 too. A limit that is not a whole number gets 400 at `/limit`.
- Pass the page's `nextCursor` as `cursor` to get the next page. The last page has no `nextCursor`.
- A cursor is opaque. It works only for the list and the company it came from, or for the person whose own list it came from, and only until the server restarts. Any other cursor gets 400 `cursor-invalid`; start the list again without it.
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

`/mcp` checks the `Origin` header before anything else, as the MCP specification asks against DNS rebinding. A request whose `Origin` the install does not allow gets 403 `origin-not-allowed`, and nothing runs for it. A request with no `Origin`, as a program that is not a browser sends, is not refused for that. The install allows one browser origin, its own, `NORTFOX_PUBLIC_ORIGIN`.

## The assistant

The registry is also the list of what the AI assistant may do ([decision 3](decisions/0003-contract-first-rest-and-mcp.md)). Today `getCompany` is the one operation open to it. The assistant itself comes in slice 4i.
