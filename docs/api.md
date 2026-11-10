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
- the scope a token needs to call it (`scope`);
- the text of its MCP tool;
- whether it writes;
- whether it is a list;
- whether the AI assistant may call it. An operation is closed to the assistant unless it says otherwise;
- whether it serves or needs the browser's session (`session`);
- where its company comes from (`company`);
- which fields of its answer are a person's contact data (`personalOutput`);
- which fields of its answer are secrets (`secretOutput`).

`openapi.json` shows these facts on each operation, under `x-nortfox`, and names the credential of each operation that needs an actor under OpenAPI's own `security` (Who acts, below). So the diff of `openapi.json` in a pull request shows a reviewer every change, a changed permission too.

### The marks

| Mark | Value | Meaning |
| --- | --- | --- |
| `permission` | `public` | Reads and writes no data. Anyone may call it, and it never asks for an actor. |
| | `none` | Runs before there is an actor, such as a sign-in. Anyone may call it. It serves the browser's session, and it takes no idempotency key. |
| | `signed-in` | Needs a signed-in person, and no permission in a company. |
| | a permission, such as `company:read` | Needs that permission in the credential's company. |
| `scope` | a scope, such as `companyinformation` | The scope a token needs to call it (Scopes, below). |
| | `null` | No token calls it by a scope: a `public` operation, and one that serves or needs a browser session. |
| `session` | `flow` | Serves the browser's session, such as a sign-in or a logout. Its MCP tool refuses every call, and `/v1` refuses a token's call with 403 `session-required`. |
| | `only` | Needs a browser session, though it does not serve it, such as `listRecentCompanies`. A token's call is refused with 403 `session-required`, on `/v1` and through its MCP tool. |
| | `null` | Any other operation. |
| `company` | `none` | Works in no company: every `public` and `none` operation, and a `signed-in` one by default. |
| | `credential` | Works in the company that the request's credential names: every operation with a permission. |
| | `current` | A `signed-in` operation that works in the credential's company when it names one, and in none otherwise, such as `getMe`. |
| | `new` | A `signed-in` operation that works in the company it makes: `createCompany`. The server picks the company's id. |
| | `{"input": "companyId"}` | A `signed-in` operation that works in the company that a field of its input names, where the person must be an active member, such as `selectCompany`. Any other company, also one that does not exist, gets 422 `company-not-available` at the field's pointer. |
| `personalOutput` | a list of JSON Pointers | The fields of the answer that hold a person's contact data: a person's name, an e-mail address, a phone or mobile number, a personnummer. The registry derives the list from the answer's schema, and `*` stands for each item of a list or a tuple and each value of a record. A write keeps the answer of its key outside every company table when the list is not empty (Writes and idempotency keys). |
| `secretOutput` | a list of JSON Pointers | The fields of the answer that work as a credential: a token, a code, an `otpauth` URI, a URL that carries a code or a `state`. The registry derives the list from the answer's schema, as for `personalOutput`. A write keeps the answer of its key without them (Writes and idempotency keys). |

The registry guard holds these together. An operation that runs before sign-in serves the browser's session. Only a `none` or a `signed-in` operation may serve it. Only a `signed-in` operation or one with a permission may need it. An operation names a scope exactly when it is not `public` and neither serves nor needs a browser session, and the scope is one of `SCOPES`. An operation that a token may call has no secret in its answer, so no token and no MCP client ever gets a credential in an answer. An operation with a permission takes its company from the credential, and no other operation does. Only a `signed-in` operation takes its company from `current`, `new` or its input, and the input's field is a required string. A write takes an idempotency key, unless it runs before sign-in. A `GET` writes only when it runs before sign-in and answers 303. Two operations of one method never answer the same path, so `/v1/users/{memberId}` and `/v1/users/me` cannot both be `GET`. Two operations whose paths differ only in a parameter's name are one path, so they give the parameter one name: `GET /v1/users/{memberId}` and `PATCH /v1/users/{id}` cannot both be in the registry. An operation that needs an actor, `signed-in` or with a permission, names its credentials in `security`: the session cookie, and beside it a bearer token when it names a scope. A `public` or `none` operation names none.

The server serves only what the registry holds. It refuses to start when a route under `/v1` is not in the registry.

| Operation | Method and path | Output | Permission | Open to the assistant |
| --- | --- | --- | --- | --- |
| `getHealth` | `GET /v1/health` | `Health`: `status` and `version` | `public` | no |
| `getCompany` | `GET /v1/company` | `Company`: `id`, `name`, `organizationNumber`, `databaseNumber`, and the addresses and the contact details when they are set | `company:read` | yes |
| `completeSetup` | `POST /v1/setup/{token}` | `SetupResult`: `user` and `totpEnrolment` | `none` | no |
| `loginWithPassword` | `POST /v1/auth/password` | `PasswordSignIn`: `outcome` and, for the TOTP step, `challenge` | `none` | no |
| `verifyTotp` | `POST /v1/auth/totp` | none (204) | `none` | no |
| `logout` | `POST /v1/auth/logout` | none (204) | `signed-in` | no |
| `getSession` | `GET /v1/session` | `Session`: `user`, and `company` once one is chosen | `signed-in` | no |
| `getMe` | `GET /v1/me` | `Me`: `user`, `personalIdentityNumber`, `mobile`, `twoStep`, `permissions` (empty in no company), and in a company `company` and `membership`, with its roles and programs | `signed-in` | no |
| `createCompany` | `POST /v1/companies` | `Company` (201) | `signed-in` | no |
| `listCompanies` | `GET /v1/companies` | a page of `CompanyChoice`: `company`, a `CompanySummary`, and `adminLevel` | `signed-in` | no |
| `listRecentCompanies` | `GET /v1/me/companies/recent` | `RecentCompanies`: `companies` | `signed-in` | no |
| `selectCompany` | `POST /v1/session/company` | `Session` | `signed-in` | no |
| `updateMyMembership` | `PATCH /v1/me/companies/{companyId}` | `Membership` | `signed-in` | no |
| `updateCompany` | `PATCH /v1/company` | `Company` | `company:update` | no |
| `listPermissions` | `GET /v1/permissions` | `PermissionCatalogue`: `roles`, `programs`, `groups` and `permissions` | `signed-in` | no |
| `listUsers` | `GET /v1/users` | a page of `Member` | `users:read` | no |
| `getUser` | `GET /v1/users/{memberId}` | `Member` | `users:read` | no |
| `updateUser` | `PATCH /v1/users/{memberId}` | `Member` | `users:admin` | no |
| `removeUser` | `DELETE /v1/users/{memberId}` | none (204) | `users:admin` | no |
| `assignProgram` | `PUT /v1/users/{memberId}/programs/{program}` | `ProgramGrant` | `programs:grant` | no |
| `removeProgram` | `DELETE /v1/users/{memberId}/programs/{program}` | none (204) | `programs:grant` | no |
| `moveProgram` | `POST /v1/users/{memberId}/programs/{program}/move` | `ProgramGrant` | `programs:grant` | no |
| `updateUserRights` | `PUT /v1/users/{memberId}/rights` | `UserRights`: `permissions` and `programs` | `programs:grant` | no |
| `inviteUser` | `POST /v1/users` | `Member` (201), with the status `invited` | `users:admin` | no |
| `resendInvitation` | `POST /v1/users/{memberId}/invitation` | none (204) | `users:admin` | no |
| `disconnectUserIdentity` | `POST /v1/users/{memberId}/disconnect` | `Member`, with the status `invited` | `users:admin` | no |
| `getInvitation` | `GET /v1/invitations/{token}` | `Invitation`: `name`, `email`, `expiresAt`, `companyName` and `inviterName` | `none` | no |
| `acceptInvitation` | `POST /v1/invitations/{token}/accept` | `InvitationAcceptance`: `user`, `membership` and, for a new identity, `totpEnrolment` | `none` | no |
| `leaveCompany` | `POST /v1/me/companies/{companyId}/leave` | none (204) | `signed-in` | no |
| `createApiToken` | `POST /v1/api-tokens` | `NewApiToken` (201): an `ApiToken` and `token`, shown once | `tokens:own` | no |
| `listApiTokens` | `GET /v1/api-tokens` | a page of `ApiToken`: `id`, `name`, `scopes`, `userId` and `createdAt` | `tokens:own` | no |
| `revokeApiToken` | `DELETE /v1/api-tokens/{tokenId}` | none (204) | `tokens:own` | no |

`User` is a person: `id`, `name`, `email` and `language` (`sv` or `en`).

`Membership` is the person in one company, Användare there: `id`, the member's id in the company, which the paths of `/v1/users` take as `memberId`; `companyId`; `userId`, the person's id, absent while the membership has no person; `status` (`invited`, `active`, `inactive`, `removed` or `left`), `adminLevel` (`owner` or `admin`, the system administrator's level, `SysAdmin`, absent for none), `idleTimeout` ("Utloggning efter inaktivitet": 15, 30, 60, 120 or 480 minutes, 120 by default), the work contacts `workEmail` and `workPhone` (an invited member has a work e-mail address only when `updateUser` gave it one, and the acceptance sets it to the invitation's address; a removed, a left or a disconnected member has none), and, as they are now, `roles` (The roles and the programs, below), `programs`, the member's program grants, each a `ProgramGrant`, and `programsAdministered`, each a `ProgramAdmin` with its `program`. `Member` is a membership as the user administration gives it, with the person's `name`, or for an invited member the name of their latest invitation (The users, below).

`Company` is the company: `id`, `name`, `organizationNumber`, `databaseNumber`, and when they are set its postal address (`address`, `zipCode`, `city`, `countryCode`), its visiting address (`visitAddress`, `visitZipCode`, `visitCity`, `visitCountryCode`) and its contact details (`phone`, `email`). A country is its code in ISO 3166-1 alpha-2, two capital letters such as `SE`. The company lists give a `CompanySummary` in `CompanyChoice.company`: the `id`, `name`, `organizationNumber` and `databaseNumber` alone, and no detail; `getCompany` gives the details.

Field names are camelCase. An answer is the object itself, with no wrapper around it.

## Who acts

Every operation with a permission acts as one actor in one company. The company comes from the request's credential, never from the path or the body. A path inside the company holds no company id. A `signed-in` operation acts as the signed-in person, in no company, in the credential's company (`current`), in the company it makes (`new`), or in the company its input names, where the person must be an active member: a path about the person's own memberships names the company. A `none` operation runs before there is an actor.

A browser signs in with a password and a TOTP code, and then sends its session in a cookie (Signing in, below). `openapi.json` names that cookie as the security scheme `sessionCookie`, an API key in the cookie `__Host-nortfox-session`, on every operation that needs an actor. The browser sends it by itself, and no script reads it, so the generated client takes no option for it. The server looks the session up on every request. A session acts as its person, with the actor kind `user`. It works in no company until it chooses one with `selectCompany` (The companies, below). A program sends an API token instead, as `Authorization: Bearer <token>` (The API tokens, below). `openapi.json` names it as the security scheme `bearer`, an HTTP bearer token, beside `sessionCookie`, on every operation that names a scope, which a token may call. The generated client sends it with every call when its option `token` holds it. On `/v1`, a request with a bearer token ignores the cookie, and a bearer token that is not a live API token names no actor. `/mcp` never reads the cookie or an API token: an MCP client signs in through OAuth, which comes in a later part of slice 2c, so until then every tool that needs an actor answers 401. An operation that needs an actor answers 401 without one, by REST with a challenge in `WWW-Authenticate` for each credential the operation takes, and by MCP in a tool result marked `isError`. The session cookie's challenge is `Cookie realm="NortFox", cookie-name="__Host-nortfox-session"`. HTTP has no registered scheme for a cookie, so that scheme is NortFox's own, and a client that does not know it ignores it. The bearer token's is `Bearer realm="NortFox"` (RFC 6750). `openapi.json` names the challenge on each 401. `GET /v1/health` and `/openapi.json` need no actor.

The server checks the actor and the permission before it reads the rest of the request: on REST before the path parameters, the query and the body, on MCP before the tool's arguments. So a request with no actor gets 401, a credential that names no company gets 403 `company-required` for an operation in the credential's company, and an actor without the permission gets 403 `permission-missing`, even when the rest of the request is wrong. No transaction of the operation runs for them, and nothing of the input is read. A test generated from the registry checks this for every operation with a permission, by REST and by MCP: for each of the plan's six roles, and for a member who holds each smallest set of the catalogue (The roles and the programs, below), each made through the operations. Only the session's own lookup runs first: the server finds the session by its cookie's hash, ends it when it has passed its end, and notes the request.

Each request runs in one database transaction, with the company, the actor, the actor's kind (`user`, `system` or `integration`), the channel (`rest` or `mcp`) and, for an integration, its via (the API token or the MCP client it acts through) set for that transaction only. A `signed-in` operation's transaction works in the company that its company source names (the credential's, the one it makes, or the one its input names), or in none. A `none` operation opens its own transactions. A read sees one snapshot, so a page and its total agree. The behandlingshistorik records the actor, its kind, its via and the channel of every change ([db/README.md](../db/README.md)).

A token, an API token or an MCP client's, acts as its person with the actor kind `integration`, in its one company. The server refuses a token before it reads anything of the input: an operation that serves or needs a browser session with 403 `session-required`, and an operation whose scope the token lacks with 403 `scope-missing`, which names the scope in `scope`, also when the token's person holds the permission. Both come before `company-required` and `permission-missing`. So what a token may do is its scopes and its person's permissions in its company together. A session is not limited by scopes. An operation whose input names its company, such as `updateMyMembership`, refuses a token's call that names another company than the token's with 422 `company-not-available`, the same answer as for a company that does not exist, before the database is asked. An operation that runs before sign-in takes a token's call as a call with no actor, so a token links nothing to an invitation. The server takes API tokens on `/v1` (The API tokens, below); the MCP clients' tokens come later in slice 2c.

### Scopes

Each operation that a token may call names one scope. The established API's scope names are kept where it has one, case-sensitive, also those that no operation names yet, and NortFox has its own scope for each module that the established API has none for: `companies`, `users` and `tokens`. Each scope reads and writes. `SCOPES` in `packages/contract` is the list.

| Scope | Operations |
| --- | --- |
| `companyinformation` | `getCompany` |
| `profile` | `getMe` |
| `companies` | `createCompany`, `listCompanies`, `updateMyMembership`, `updateCompany`, `leaveCompany` |
| `users` | `listPermissions`, `listUsers`, `getUser`, `updateUser`, `removeUser`, `assignProgram`, `removeProgram`, `moveProgram`, `updateUserRights`, `inviteUser`, `resendInvitation`, `disconnectUserIdentity` |
| `tokens` | `listApiTokens`, `revokeApiToken` |
| `bookkeeping`, `settings`, `costcenter`, `project`, `currency`, `supplier`, `supplierinvoice`, `payment`, `connectfile`, `inbox`, `archive`, `deletevoucher` | none yet: later slices name them |

No scope covers a `public` operation, an operation that serves the browser's session (the `none` operations, `getSession`, `selectCompany` and `logout`), or one that needs a browser session (`listRecentCompanies` and `createApiToken`).

## Requests on `/v1`

- Paths and names are case-sensitive. A path has no trailing slash. An unknown path gets 404 `not-found`. A known path with another method gets 405 `method-not-allowed`, with the methods it takes in `Allow`. A fixed path comes before a path with a parameter in its place, as in OpenAPI: `PATCH /v1/me/companies/recent` gets 405 with `Allow: GET, HEAD`, and never reaches `updateMyMembership`.
- A path parameter is one segment of the path, such as the id in `/v1/users/{memberId}`. Its value is checked like any field: a bad one is a field problem at `/memberId`.
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

**The first identity.** An empty install gets its first identity from a setup link that the install's setup command prints ([deploy/README.md](../deploy/README.md)). `completeSetup` takes the link's token in its path, with a name, an e-mail address and a password. The address keeps the owner's fold rule (The invitations, below), and its local part may be outside ASCII, though a disconnect refuses such a work e-mail, as `createCompany` copies it (below). The link works once, for 28 days, and a newer link stops it. Any other link gets 422 `setup-link-invalid`, and an install that has an identity 422 `install-not-empty`. The answer gives the new TOTP secret as an `otpauth` URI, and sets no session: the person signs in next, and the first right code confirms the secret. The answer is the only copy of the secret: no answer gives it again.

**A lost answer.** While the install's only identity, which a setup link made, has never confirmed its TOTP secret, the setup command makes a new link. Using it replaces that identity: it is deleted, so it keeps no e-mail address and its address is free; its password, its pending TOTP secret and its open login challenges are gone; and `completeSetup` makes a new identity from its input, with a new TOTP secret in a new 201. The new identity may use the same address. The old identity's password and challenges work no more, also with a code of the old secret. Once the identity has confirmed its secret, the command makes no link, and a link made before gets 422 `install-not-empty`. The same holds while the install has any other identity, but for the identities that earlier setup links replaced: they do not count, so the way out works again when a later answer is lost too. A TOTP step of the old identity and the new link's use at the same time never both succeed: one waits for the other. A password step of the old identity and the use at the same time take turns too: the use deletes the step's challenge with the others, or the step opens none and gets 422 `sign-in-failed`.

**Passwords.** A new password is 12 to 1024 characters, counted in code points after NFC normalisation. One that is too short or too long is a field problem at `/password`, `too-short` or `too-long`. One that holds a lone surrogate (half of a character, which JSON can send as an escape such as `\ud800`), or more than 30 combining marks in a row, is a field problem too, `invalid-value`, and such a password is never right at the sign-in. The server keeps a password only as an Argon2id hash.

## The companies

A signed-in person makes a company with `createCompany`: its name and organisation number. The person is its owner, a system administrator, from the same transaction, and the company gets its tenant id, `databaseNumber`, a whole number from 1 to 2147483647 that is never given out again, also when the transaction that took it fails. The organisation number never changes. A company always has an active system administrator. The session does not move to the new company: `selectCompany` chooses it.

`listCompanies` lists the companies where the person is an active member, by name, with the person's system administrator's level in each; `query` keeps those whose name holds it, in any letter case, or whose organisation number holds it, with or without the hyphen: `5560000167`, `556000-0167` and `0000167` find 556000-0167, and hyphens alone find no number. `listRecentCompanies` gives the three the person chose last, of those where the person is still an active member.

`selectCompany` ("Byt företag") makes the session work in a company where the person is an active member, without a new sign-in. Any other company, also one that does not exist, gets 422 `company-not-available` at `/companyId`. The session keeps the membership it chose the company with, and the person's permissions there as they were then, less a right whose grant has ended since (The roles and the programs, below). The session ends at once when that membership is deactivated, disconnected, removed or left, and stays ended when the membership is active again. On every request the server also asks whether that membership is still the person's active one there: when it is not, or the person holds another one there now, the request gets 401 and the session ends. A session that ends while `selectCompany` runs, such as by a `logout` at the same time, chooses nothing and gets 401, as a request with no actor. A membership that is deactivated, disconnected, removed or left while `selectCompany` runs never stays with the session: a change that commits first makes the choice get 422 `company-not-available`, and one that comes later waits for the choice, and then ends the session. Once the session has chosen a company, `getSession` and `getMe` give the company, and `getMe` the membership and the permissions; `getCompany` and every other operation with a permission work in it. Until the session chooses a company, `getCompany` and every other operation with a permission answer 403 `company-required`, `getSession` and `getMe` give no company, and `getMe` gives an empty list of permissions.

The permissions in a company: every active member holds `company:read`, so every member reads the company with `getCompany`. A system administrator, the owner or an admin, also holds `company:update`, `users:read`, `users:admin` and `programs:grant`: the company's details, its users and their programs. A program administrator holds `users:read` and `programs:grant`, for the programs they administer (The users, below). None of these is a work right: the work rights come from the member's programs (The roles and the programs, below).

`updateMyMembership` changes the person's own work e-mail address and phone number in a company, and its idle logout, one of 15, 30, 60, 120 and 480 minutes: on the screen, Användaruppgifter. Any other value is a field problem at `/idleTimeout`. A field left out stays as it is. Every active and inactive member has a work e-mail address, as the established screen requires it: `createCompany` gives the owner the person's own e-mail address as the work e-mail, and a change sets another one but never takes it away, so `null` for `workEmail` is a field problem, `invalid-type`. A disconnect sends the member's new invitation to the work e-mail, so a new one keeps both of the owner's rules for an address (The invitations, below): one that breaks either gets 400 `bad-format` at `/workEmail`. `null` takes the phone number away. The company is the one in the path, where the person must be an active member, as for `selectCompany`: any other company gets 422 `company-not-available` at `/companyId`, and so does a change that waited for a removal or a deactivation of the membership, or that found the membership while it was the person's when a disconnect and another person's acceptance came before its change. Two changes of one membership at once take turns, so each keeps the field that the other gave. The work contacts belong to the person's membership in that company alone, and are not in the behandlingshistorik.

`updateCompany` changes the request's company: its name, its addresses and its contact details. A field left out stays as it is, and `null` takes an address field or a contact detail away. Each is a text of at least one character and at most its length: 200 for a street, 20 for a postal code, 100 for a town, 50 for the phone and 254 for the e-mail address, which must be an address; a country is two capital letters. The database checks the same. The organisation number never changes: `updateCompany` does not take it, so a request that sends it gets 400 with `unknown-field` at `/organizationNumber`, and the database refuses its change from every role. A change of the company is in the behandlingshistorik, and a change that changes nothing writes none. `getCompany` and `getMe` give the details.

## The users

A system administrator runs the company's users; a program administrator reads them and grants the programs they administer. A user here is a member of the request's company, `Member`, named by the membership's id, `memberId` in the paths, which is `Membership.id`: an invited member has an id before any person accepts it. `userId` is the person's id. The operations reach the company's invited, active and inactive members. A removed or a left member's membership stays, so the person stays the actor on every entry, but no operation here finds it: any id that names no invited, active or inactive member of the company, also one of another company, gets 422 `user-not-found` at its pointer.

- `listUsers` lists the members in the order they were added, and `getUser` gives one. Each has the person's `name`, from the people of the company, which never give the personnummer or the mobile number; the status; the admin level; the idle logout; the work contacts; and the programs. A program administrator sees only the grants and the administration of the programs they administer, and the roles that those give. The admin level stays in view.
- `updateUser` changes a member. `active` is Aktiv användare: `false` stops the member's work in the company, and their sessions there end at once, while their rights are kept; `true` restores them. An invited member has not accepted yet, so `active` gets 422 `user-invited` at `/active`. `adminLevel` `admin` makes the member a system administrator, and `null` makes them no longer one; only creating a company gives the owner's level, which `admin` keeps, and `owner` is a field problem. `programsAdministered` is the whole list of the programs the member administers. `idleTimeout` takes the five values, and a lower one holds at once for the member's sessions. The work contacts follow the rules of `updateMyMembership`. A system administrator's own raise of their idle logout holds for the session that made it from its next request.
- `removeUser`, Ta bort användaren, removes a member: the membership stays with the status `removed`, which is final, its sessions end at once, and its work contacts are erased. Nobody removes themselves: that gets 422 `cannot-remove-yourself`. A removed person who is invited again gets a new membership.
- A company always has an active system administrator. Removing, deactivating, demoting or disconnecting the last one, and the last one leaving, get 422 `last-system-administrator`, with the company's id in `data`. The server refuses it first, and the database refuses at the commit what a race got past that check, with the same answer: of two system administrators who remove each other at once, or who leave at once, exactly one succeeds. A disconnect sends its mail before its commit, so it takes the company's turn of its administrators alone before its check, and each of the other changes takes it with the others: a disconnect and such a change take turns, the one that comes second gets `last-system-administrator`, and a disconnect that loses sends no mail. A change waits for the turn before it takes a connection of the server's pool, so changes of a company that wait for a disconnect's mail never keep another company's requests waiting. An update that neither demotes nor deactivates takes no turn.

The programs:

- `assignProgram`, Tilldela program, grants a program with `full: true`, Full behörighet, or with `permissions`, a list of its rights, the program's own and its Rapporter and Register/Övrigt rights: one of the two. A member who holds the program gets the new list, and the grant keeps its time and its end. A grant that has ended, a Revisor grant after its 30 days, is granted again, with a new time and a new end. It answers 200 with the grant in both cases, also when it makes one: an operation has one success status, and `grantedAt` tells a new grant from a changed one. RFC 9110 asks a `PUT` that makes its target for 201, so this is a known difference. A right that the program's set does not hold gets 422 `not-in-program`, and an action right without its group's view right 422 `view-permission-missing`, each with the right's pointer, such as `/permissions/1`, and its facts. The database holds the same rules.
- `removeProgram`, Ta bort program, takes a grant away, also one that has ended. A program the member does not hold gets 422 `program-not-granted`.
- `moveProgram`, Flytta program, gives a member's grant to the member that `targetMemberId` names, and takes it from the first. The grant keeps its time and its end. With `permissions`, it is narrowed first: a right that the grant does not hold gets 422 `not-in-grant`. A target that holds the program already gets 422 `program-already-granted`. A grant that has ended gives nothing, so it counts as none: it is no grant to move (422 `program-not-granted`), and the target's grant that has ended is taken away and replaced by the one that moves.
- `updateUserRights`, Anpassa Rapporter and Anpassa Register/Övrigt, sets the member's Rapporter and Register/Övrigt rights, the whole list: each grant holds those that its program covers, and keeps its program's own rights. A right that no grant of the member covers gets 422 `right-not-covered`. The field takes the Rapporter and Register/Övrigt rights alone (`RightKey`), so a right of a program's own is the field problem `invalid-value`, whose `data.allowed` lists the rights it takes. A grant that has ended covers nothing and is not changed, and the answer's `permissions` are the rights of the grants that hold.
- A program administrator does each of these only for the programs they administer: any other program gets 422 `program-not-administered`. They never change a member with `updateUser`, so they appoint no admin. Which programs they reach follows the session's rule, as their permissions do: a session keeps the programs it chose the company with, also one taken from them since, and reaches one appointed since when it chooses the company again.

`listPermissions` gives any signed-in person the catalogue as the install holds it, `PermissionCatalogue`: the plan's six `roles`, each with the admin level or the program that makes it; the `programs`, each with its screen words, the days after which its grant ends (30 for Revisor) and its set, each right marked with whether Full behörighet holds it; the `groups`; and every permission, `Permission`, with its group, its screen words, `view` and `manualOnly`, each in the catalogue's order.

The answers of `updateUser`, `inviteUser` and `disconnectUserIdentity` hold a person's name and work contacts, so their keys are kept outside every company table (Writes and idempotency keys, below).

## The invitations

A system administrator invites a person by e-mail, and the invitation's mail holds a link with a token, "Acceptera inbjudan". The link works once, for 14 days, and a newer invitation of the same member stops it, as does the member's removal. The database stamps who sent an invitation, when, to the millisecond, and its end, and keeps the hash of the link's token only; the token is in the mail alone. Every invitation, its acceptance and its stop are in the behandlingshistorik, with the name and the address it was sent to.

- `inviteUser`, Lägg till användare, takes a name and an e-mail address, makes an invited member with that name, and sends the invitation to the address. The address keeps both of the owner's rules for an address (below): one that breaks either gets 400 `bad-format` at `/email`, and no mail goes. An address that a member of the company has, as their identity's or their work e-mail address, or that an open invitation of the company goes to, in any letter case, gets 422 `already-member` at `/email`, also the second of two invitations to one address at once: a company's invitations take turns, on a turn of their own, so no other change of the company waits while an invitation's mail is sent. An invitation waits for the turn before it takes a connection of the server's pool, so however many of a company's invitations wait for one that sends its mail, no other company's request waits for them. Then `assignProgram` and `updateUser` can give the invited member programs and an admin level before anyone accepts.
- `resendInvitation`, Skicka en ny inbjudan, sends an invited member a new invitation, to the name and the address of their latest one, for 14 days from now, and stops the old link. A member who is not invited gets 422 `user-not-invited`.
- `disconnectUserIdentity` takes the identity from an active or inactive member, so it no longer reaches the company: the membership is invited again, with no person, its sessions end at once, and the old person's work contacts are erased. The member keeps the admin level, the idle logout and the programs, and a new invitation goes to the person's name and the member's work e-mail address. A new or an existing identity may accept it, and gets those rights. An invited member gets 422 `user-invited`. A member whose work e-mail address has its local part outside ASCII gets 422 `work-email-not-mailable` at `/memberId`, and nothing changes: an administrator sets another work e-mail with `updateUser` first (the owner's rules, below). It is the way back for a person who lost their way in.
- With no mail set up for the install ([deploy/README.md](../deploy/README.md)), each of the three gets 422 `mail-not-configured` before it reads or changes anything. A mail goes inside the request, before it commits: a mail that the mail server refuses makes the request answer 500 `internal-error`, and nothing changes.

The invited person's side serves the browser's sign-in, so the MCP tools of both operations refuse every call:

- `getInvitation` gives what the link's page shows: the name and the address the invitation was sent to, when the link stops working, and the company's and the sender's names as they were when it was sent.
- `acceptInvitation` accepts the invitation once. With `newIdentity`, Skapa ett nytt NortFox ID, a new identity with that name and a password of 12 to 1024 characters takes the invitation's e-mail address; the answer gives its TOTP secret, as `completeSetup` does, and sets no session, so the person signs in next with the password and a code, which confirms the secret. Without `newIdentity`, Koppla ihop med befintligt NortFox ID, the identity of the browser's session accepts, and with no session the call gets 422 `sign-in-required`. Either way the member's work e-mail address becomes the invitation's, and the answer gives the person and the membership.
- A link that is unknown, used, stopped or past its end gets one answer, 422 `invitation-link-invalid`, from both. Of two acceptances of one link at once, one succeeds. An address that another identity has gets 422 `email-taken`, also when two invitations to one address are accepted at once as new identities, and a person who is a member of the company already gets 422 `already-member`, also for two invitations of one company accepted at once. A refusal changes nothing, and the link works on.

**The owner's two rules for an address** (2026-11-09), where the issue says nothing:

- **The fold.** An address that can become an identity's, or a work e-mail that a disconnect invites, holds no character whose case fold is not its lower case, each character read alone, in NFC: ß, ẞ, ς, ſ, µ, the ligatures, the Cherokee letters and every other such character that Unicode's data gives. The database folds an address with `casefold()`, to keep one identity per address and to find it at the sign-in, and that fold makes `straße.example` into `strasse.example`, which IDNA2008 and a mail program keep apart. So whoever holds a mailbox at such a twin could take another address's identity, or learn from `email-taken` that it has one. `completeSetup`, `inviteUser`, and the `workEmail` of `updateUser` and `updateMyMembership` refuse such an address with 400 `bad-format`; `acceptInvitation` takes no address. The database refuses it too ([db/README.md](../db/README.md), the fold of an address). The sign-in keeps the fold: a known identity signs in with its address in any letter case, `ß` for `ss` too.
- **ASCII before the @.** An address that NortFox sends mail to has its local part, the part before the `@`, in ASCII, since a mail server that does not offer SMTPUTF8 must not take another (RFC 6531): `inviteUser`'s address and a new work e-mail refuse one with 400 `bad-format`. The pattern of these fields in the description and the tools' schemas says so. The domain may be internationalised: the mail goes to its A-label. `completeSetup` and the sign-in still take a local part outside ASCII, as the owner decided, since no mail goes to the person's own address in this part. `createCompany` gives the owner that address as the work e-mail, as it is, and migration 0009 filled the work e-mail of an existing install the same way. So `disconnectUserIdentity` checks the member's work e-mail before it changes anything: one with its local part outside ASCII gets 422 `work-email-not-mailable` at `/memberId`, and no mail goes. An administrator sets another work e-mail with `updateUser` first. So no invitation holds such an address, and `resendInvitation` never sends one.

The company's own address (`updateCompany`) keeps neither rule: it is no identity's, and NortFox sends it no mail.

`leaveCompany`, Koppla bort användaren, is the person's own: they leave a company where they are an active member, the one in the path. The membership stays with the status `left`, which is final, its sessions end at once, and its work contacts are erased. Only a new invitation lets the person back, with a new membership. Any other company gets 422 `company-not-available` at `/companyId`. A repeat of the leave with its key gives its first answer again, 204, also from another session: its key is kept with the person, outside every company table, and is read before the company is, since the leave's own success makes the person no member there.

## The roles and the programs

A member's work rights come from their program grants, Program: `bookkeeping` (Bokföring), `approval-read` (Bokföring - Attest & Läs), `read` (Läs) and `auditor` (Revisor). A member holds a program once, and may hold several. A grant, `ProgramGrant`, lists the rights it holds as the catalogue's permission keys, such as `vouchers.view` and `vouchers.book`, in the catalogue's order. `full` says whether it holds every right of its program's Full behörighet, the default when a program is granted; `grantedAt` says when it was granted, and `expiresAt` when it ends by itself. A Revisor grant ends 30 days after it was granted, with no action by anyone, and gives nothing from then on. The other programs have no end. A member holds the rights of each grant that has not ended, so a right that two programs give stays while either does. The database holds each grant to its program's set, and each action right to its group's view right. So the smallest set of rights a member can hold is a view right, a Rapporter right or a Register/Övrigt right alone, or an action right with its group's view right.

No permission gets past the ledger's rules in the database ([decision 2](decisions/0002-ledger-law-in-postgresql.md)): they hold for every actor, whatever it holds. A member who holds every permission, the system administrator's and the rights switched on by hand only among them, gets the same refusals as anyone else, such as 422 `period-locked-manual` for a voucher dated in a locked period and 422 `not-last-in-series` for a deletion of a voucher that is not the last of its series. The server's database role cannot change or delete the behandlingshistorik or the record of deleted vouchers, whatever the request's permissions, Radera behandlingshistorik among them. A system administrator holds no work right by being one. No operation of slice 2c needs a right of the catalogue yet: later slices attach their operations to them.

The plan's six roles, `Role`, are sets in this model: `owner` and `admin` are the system administrator's two levels, which hold the same permissions and no work right; `bookkeeper` is Bokföring with Full behörighet; `approver` is Bokföring - Attest & Läs; `viewer` is Läs; and `auditor` is Revisor. A member holds a program's role while a grant of the program has not ended, and `bookkeeper` only while the Bokföring grant is full. A member may hold several roles. A program administrator, `ProgramAdmin`, is set per program, and holds no role by being one.

In a company, `getMe` gives the membership with its `roles`, `programs` and `programsAdministered` as they are now, and the request's `permissions`: a member's own, the admin level's, a program administrator's while the member administers a program, and the rights of the member's grants, in alphabetical order. A session takes its permissions when it chooses the company with `selectCompany`, each with the end of the grant that gives it, and keeps them until it chooses a company again: a right taken from the member still works in it, and a right given since does not, until then. The member's next session takes them as they are then. A right whose grant ends, such as a Revisor grant's, holds no more from its end, also in a session that chose the company before. So `programs` can show a grant whose rights the session's `permissions` do not hold yet, or no longer hold. A right of a grant is read to the millisecond, so it ends at most a millisecond before the database's end, never after it.

## The API tokens

A member makes an API token for a program with `createApiToken`, in a browser session, for the company the session works in. It takes a `name` (1 to 100 characters on one line) and `scopes`, one or more of `SCOPES` by their exact names (Scopes, above); each is kept once, in the list's order, and any other name, also one that differs only in letter case, gets 400. The answer, `NewApiToken`, gives the token in `token` once: `nft_` and 43 characters. The server keeps only its SHA-256, so a lost token cannot be shown again; a repeat with the write's idempotency key gets 409 `answer-shown-once`, with the token's id in `answer`. Only a browser session makes a token: a token is refused `createApiToken` with 403 `session-required`, so a token never makes a token.

A program sends the token as `Authorization: Bearer <token>`, on `/v1` only: `/mcp` never takes it. The token acts as the person who made it, with the actor kind `integration`, in its one company, and the behandlingshistorik names the token beside the person. It may do what its scopes and its person's permissions in its company both allow, read on every request: a permission that the person loses is refused from the token's next request, and one given since holds at once. Through a token, `getMe` gives the token's company and no personnummer and no mobile number, `listCompanies` gives the token's company alone, and an operation that names another company in its input gets 422 `company-not-available`. `createCompany` is the one operation that reaches outside the token's company: it makes the person a new company, and the token stays bound to its own.

A token works until it is revoked. It is bound to its person's membership: while the member is deactivated it names no actor, and it works again once the member is active again. A removal, a leave and a disconnect revoke the member's tokens, so a new invitation lets none of them back. `listApiTokens` gives the company's live tokens, `ApiToken`, in the order they were made, never the token itself: a member's own, or every one of the company for a system administrator, who holds `tokens:all`. `revokeApiToken` revokes one, the actor's own or, with `tokens:all`, any of the company's; it is refused from the next request on. Any other id gets 422 `api-token-not-found`. The behandlingshistorik of the company gets an entry for each token made and each token revoked, Program "Användare", with the token's id, name and scopes.

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
- `permission` names the permission a 403 `permission-missing` lacks, and `scope` the scope a 403 `scope-missing` lacks.
- `answer` holds, for a 409 `answer-shown-once`, the first answer to the key without its secret.
- A rule's refusal, 422, has the rule's `code`, its facts in `data`, and a `pointer` when it is about one field, so a screen can show it on that field.
- A 429 and a 503 carry `Retry-After`, in whole seconds.
- A 500 `internal-error` holds nothing of the error. The server logs it, but only the error's class, its code, the constraint, schema, table and column it names, its message and its stack, with every token, personnummer and e-mail address taken out. The log never holds a database error's detail, which can hold a row, nor the parameters of a statement.
- An answer never repeats the values the request sent.

### Pointers

A pointer is a JSON Pointer (RFC 6901), in its string form, into the operation's flat input. The flat input is one object with the path parameters, the query parameters, the body's fields and, for a write, `idempotencyKey`. It is the same object that the operation's MCP tool takes. So:

- `/memberId` is the path parameter `memberId`;
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
| 403 | `session-required` | A token's call of an operation that serves or needs a browser session. |
| 403 | `scope-missing` | A token lacks the operation's scope. `scope` names it. |
| 404 | `not-found` | No operation has the path. |
| 405 | `method-not-allowed` | The path takes another method. |
| 409 | `idempotency-key-in-use` | Another request with the same idempotency key is still running. |
| 409 | `answer-shown-once` | The same request came again with its idempotency key, and its first answer held a secret, which is shown only once. `answer` gives the rest of that answer (Writes and idempotency keys). |
| 413 | `payload-too-large` | The body is over 1 MiB. |
| 415 | `unsupported-media-type` | The body is not `application/json`. |
| 422 | `idempotency-key-reused` | The idempotency key belongs to another request. |
| 422 | `sign-in-failed` | A sign-in step failed. The answer is the same for every cause (Signing in). |
| 422 | `setup-link-invalid` | The setup link is unknown, used, stopped by a newer link, or past its end. |
| 422 | `company-not-available` | The person is no active member of the company that the input names, or it does not exist: the same answer for both. `pointer` names the field. |
| 422 | `user-not-found` | The company has no invited, active or inactive member with the id that the input names: the same answer for a removed or a left member, one of another company and an id that is not there. `pointer` names the field. |
| 422 | `user-invited` | `updateUser` set `active`, or `disconnectUserIdentity` named a member, who has not accepted the invitation yet. |
| 422 | `user-not-invited` | `resendInvitation` named a member who is not invited. |
| 422 | `already-member` | `inviteUser`'s address is a member's of the company, or an open invitation's, or `acceptInvitation`'s person is a member of the company already. |
| 422 | `mail-not-configured` | The install has no mail set up, so `inviteUser`, `resendInvitation` and `disconnectUserIdentity` send no invitation. |
| 422 | `work-email-not-mailable` | `disconnectUserIdentity` named a member whose work e-mail address has its local part outside ASCII, so NortFox sends no invitation to it (the owner's rule of 2026-11-09). |
| 422 | `invitation-link-invalid` | The invitation's link is unknown, used, stopped by a newer invitation or the member's removal, or past its end. |
| 422 | `sign-in-required` | `acceptInvitation` without `newIdentity` has no session to link. |
| 422 | `email-taken` | Another identity has the e-mail address, in any letter case. `pointer` names the field when the input has it. |
| 422 | `personal-identity-number-taken` | Another identity has the personnummer. `pointer` names the field when the input has it. The operations that set a personnummer come in a later part of slice 2c. |
| 422 | `api-token-not-found` | `revokeApiToken` named no live API token of the company that the actor may revoke: the same answer for a revoked token, another member's for a member, one of another company and an id that is not there. `pointer` names the field. |
| 422 | `cannot-remove-yourself` | `removeUser` named the actor's own membership. |
| 422 | `program-not-administered` | A program administrator asked for a program they do not administer. `data` names it. |
| 422 | `program-not-granted` | The member holds no grant of the program. |
| 422 | `program-already-granted` | `moveProgram`'s target holds the program already. |
| 422 | `not-in-grant` | `moveProgram`'s list holds a right that the grant does not, so a move cannot give it. `pointer` names it. |
| 422 | `right-not-covered` | `updateUserRights`'s list holds a right that no grant of the member, in the actor's reach, covers. `pointer` names it. |
| 422 | a rule's code | A rule refuses the request, such as `period-locked-manual`, `install-not-empty` for a setup link on an install that has an identity it may not replace, `last-system-administrator`, or `not-in-program` and `view-permission-missing` for a grant's rights, where the server points at the right too. |
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
| `invalid-value` | A field holds a value it does not take. `data.allowed` lists the values when there is a list. No text that the server stores or looks up takes U+0000, which PostgreSQL's text cannot hold, or a lone surrogate (half of a character, which JSON can send as an escape such as `\ud800`). A person's or a company's name stands on one line: it takes no control character, such as a line feed, a carriage return or a tab, no line or paragraph separator, and no control of the text's direction. |
| `too-short`, `too-long` | A text or a list is shorter or longer than it may be. An e-mail address holds at most 254 characters, also in NFC, the form the server stores, which can be longer than the text sent. |
| `not-an-integer` | A number that must be whole is not. |
| `out-of-range` | A number or an amount is outside its bounds. |
| `bad-format` | A text does not have its format, such as an e-mail address, a token, a six-digit code or a UUID. `data.format` names the format: `email`, `uuid`, or `regex` for a pattern. An e-mail address is one mailbox, with UTF-8 as RFC 6531 takes it: a local part of atoms with one dot between two, its one `@`, and a domain of labels. A display name, a comment, a list, a group, a quoted local part, an address literal, a space, a control character and a slash at the local part's end are not taken. The local part holds at most 64 characters, and the address is one mailbox also in NFC, the form the server stores (U+037E is a semicolon there). The domain is written as a mail is sent to it: IDNA's mapping (UTS 46), which a mail program makes before it sends, must give back its own labels, in lower case, so a domain with a character that the mapping drops or folds, such as a soft hyphen, a zero-width space, a fullwidth letter or U+3002 as a dot, is not taken, nor an A-label (`xn--`), nor a domain that ends in a number. So a mail goes to the address that the server keeps and shows. The owner's two rules come on top where they hold (The invitations, above): no character whose case fold is not its lower case, and a local part in ASCII where NortFox sends mail. The description and the tools' schemas give such an address the format `idn-email`, RFC 6531's, with its pattern, which is the server's own check of the form and holds only the tokens that every regex dialect reads (JSON Schema 2020-12, section 6.4): no lookahead, no `\u` escape and no property class. The lengths are the checks' own, `maxLength` and the local part's 64. An amount that is not a decimal string gets it too, with no `data.format` (above). |
| `fraction-of-ore`, `unknown-currency` | An amount is wrong (above). |
| `cursor-invalid` | A cursor that this server did not make for this list and this company. |
| `idempotency-key-missing`, `idempotency-key-invalid` | A write's key is missing, or is not a key (below). |

The rules of the ledger live in the database. When one refuses a request, the answer is 422 with the rule's reason in kebab-case as its code, such as `unbalanced`, `period-locked-manual` or `date-outside-fiscal-year`, and the rule's facts in `data` with camelCase keys. An amount among the facts is Money. [db/README.md](../db/README.md) lists every reason.

## Writes and idempotency keys

A write takes an idempotency key: the `Idempotency-Key` header on REST, and the `idempotencyKey` argument on MCP. A key is 1 to 255 characters of visible ASCII without `"` and `\`, such as a random UUID. The header takes the key bare or in double quotes, as the IETF draft writes it. A write that runs before sign-in takes no key, since there is no actor to keep it for.

- The same key with the same request gives the first answer again, and nothing is written twice. An answer without a body is given again with no body.
- A secret is shown once. A write whose answer holds one (`secretOutput`) keeps its key with the answer less each secret field, and never the secret. The same key with the same request gets 409 `answer-shown-once` instead of the first answer, and nothing is written twice. Its `answer` is the answer it kept, such as the id of what the first call made, so a client that lost the secret can end what it made and send the request again with a new key.
- The same key with another request gets 422 `idempotency-key-reused`. Another operation, another path parameter, another body or another query is another request, and so is `"1.5"` beside `"1.50"`.
- A request whose key a running request holds gets 409 `idempotency-key-in-use`, and writes nothing. Send it again once the first has ended.
- A write with no key gets 400, with the field problem `idempotency-key-missing` at `/idempotencyKey`. A key that is not a key gets `idempotency-key-invalid` there.
- Keys belong to one company and one actor. The same key in another company, or from another actor, is another key. In a company a key serves one write, whichever table keeps it (below): a key that one write of the company used gets `idempotency-key-reused` for another. A signed-in person's write that works in no company keeps its keys for the person alone, and so does `createCompany`, whose company is new on each try. A write in a company whose answer holds a person's contact data (`personalOutput`), such as `updateMyMembership`, `selectCompany` and `updateUser`, keeps its key for the person and the company outside every company table, so that data never reaches the behandlingshistorik. So does `leaveCompany`, whose answer has no body, so that its repeat reads the key where the person no longer reaches the company.
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

The tool of an operation that serves the browser's session, such as a sign-in, is listed like any other, and refuses every call with 403 `browser-only` before it reads an argument. An MCP client signs in through OAuth instead. The tool of an operation that needs a browser session, such as `listRecentCompanies`, refuses a token's call with 403 `session-required`, and every tool refuses a token that lacks its scope with 403 `scope-missing`, as on `/v1`.

The arguments take JSON's own types: on MCP, `limit` is a JSON number, and the key is the argument as it is, without the header's quotes.

`/mcp` checks the `Origin` header before anything else, as the MCP specification asks against DNS rebinding. A request whose `Origin` the install does not allow gets 403 `origin-not-allowed`, and nothing runs for it. A request with no `Origin`, as a program that is not a browser sends, is not refused for that. The install allows one browser origin, its own, `NORTFOX_PUBLIC_ORIGIN`.

## The assistant

The registry is also the list of what the AI assistant may do ([decision 3](decisions/0003-contract-first-rest-and-mcp.md)). Today `getCompany` is the one operation open to it. The assistant itself comes in slice 4i.
