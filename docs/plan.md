# The NortFox plan

Status: roadmap, 2026-11-01, updated 2026-11-02. The plan changes as the work teaches us. Choices that are hard to undo are written down as [decision records](decisions/).

## 1. What NortFox is

NortFox is an open-source accounting system for Swedish companies. It keeps the books (Bokföring) the way Swedish law asks: BAS accounts, vouchers, VAT, SIE files, and the reports a company and its accountant need.

It runs on one small server that the company, or its accountant, controls. Every feature works through the API and through MCP, so a program or an AI agent can do what a person can do on a screen.

## 2. Principles

- **Everything through the API.** Every feature is an API operation first. MCP offers the same operations. The web app is one client of the API. A screen is never the only way in.
- **The law lives in the database.** PostgreSQL itself refuses a change to a voucher in a locked period, a gap in a voucher series that is not a recorded void range, and a voucher where debit and credit differ. Triggers write the behandlingshistorik. Each company sees only its own rows.
- **Money is exact.** Inside, an amount is whole öre in a `bigint`. On the native API, it is a decimal string with a currency code. The compatible API takes amounts as the established API does, as JSON numbers or as strings, and reads each one from its own text, never through a float. Never a JavaScript number.
- **Contract first.** Each operation is defined once, with its data shapes. The REST paths, the committed `openapi.json`, the generated client, the MCP tools and the compatible API ([decision 12](decisions/0012-compatible-api.md)) all come from that one list.
- **Self-hosted.** One Docker Compose file. Point-in-time backups from day one. A restore skips voucher numbers, as a recorded void range, rather than give one out twice.
- **Swedish first.** Bokföringslagen, BAS, SIE and the VAT report are built in. The screens are in Swedish and English.
- **Strict from the first commit.** Strict types, zero lint warnings, real coverage floors, property tests for the rules, tests against real PostgreSQL. Every guard is proven to fail.
- **Free software.** AGPL-3.0 for NortFox. MIT for the API client and the API description, so any program can use them.

### How behaviour is decided

Many people who will use NortFox already keep books in the established Swedish accounting system. NortFox should feel familiar to them.

- **The law first, then the established system, then NortFox's own rules.** The law decides where it speaks. The established system decides what the law leaves open. NortFox's own rules come last, where neither says anything.
- **The SIE format and the BAS chart are standards, not law.** This order does not rank them against the established system. Where the established system departs from one, the slice's issue writes the departure down and the owner decides.
- **Behaviour copies the established system:** what happens, the steps and their order, the rules, the names, the messages, the fields and their order, and the keyboard flow. NortFox adds no steps of its own to a familiar flow: no extra warnings, required fields, checklists or helpers.
- **Where the established way looks unlawful,** NortFox first finds out how the established system stays within the law: its help pages, the reading of the law it relies on, and what it expects the company to do. Where that reading holds, NortFox copies the established way, also when it is lawful only if the company does its part, such as locking its periods in time. NortFox differs only where the law clearly forbids the established way.
- **The look and the controls are NortFox's own, and modern:** shadcn components on Base UI, the themes, the layout from the [design rules](design/README.md), and controls such as comboboxes, date pickers and a command menu. Where a design file describes behaviour or words that differ from this section, this section wins until the file is updated.
- **NortFox adds features only where the established system has none.** Every feature has an API operation and an MCP tool, also where the established system has no API for it. The other additions are the ones this plan lists, such as the theme switcher, the style builder, the import from another system's API, the PWA and the AI assistant. An improvement to a familiar flow is the owner's call. It is never built in by default.

### Names

- The screens use the words that users know from the established system. In Swedish, these are its Swedish screen words, such as Verifikationer, Bokför and Leverantörsfakturor. In English, they are its English screen words or, where it has none, the English names of the established API.
- The API and the code use the English names of the established API, such as Voucher, VoucherSeries, FinancialYear and CostCenter, so that there is one vocabulary. This is a default that the owner may change. The module names in [section 4](#4-server-modules) are working names until each slice's issue fixes them by this rule.
- The brand names and trademarks of the established system are never used. Generic accounting words are.
- A word can mean one thing on the screen and another in the law. The screen's Bokför gives a voucher its number, but in the law's sense an entry is bokförd only once its period is locked for everyone. So each slice's issue starts with its terms ([section 6](#6-how-a-slice-is-built)).

## 3. Structure

```
apps/
  server/          Hono on Node, one process: the API under /v1, the compatible API, MCP under /mcp, background jobs
  web/             the React web app, which is also the PWA
packages/
  engine/          pure accounting logic: checks, VAT, SIE, accruals, bank rules. No I/O.
  contract/        the operation list and the data shapes
  client/          the generated API client and the committed openapi.json (MIT)
  ui/              components on Base UI and shadcn, the theme switcher, the style builder
  i18n/            Swedish and English texts; date, number and money formats
db/
  migrations/      plain SQL, applied in order, never edited after merge
reference-data/    BAS chart, VAT codes and boxes, SRU codes, holidays. One version per year.
scripts/           the repository's own checks: the names check, the fixture guard and the other guards
deploy/            Docker Compose, a PostgreSQL image with pgBackRest, Caddy
docs/              this plan, the decision records, the system documentation
AGENTS.md          the rules for every change, by a person or an AI agent
```

`openapi.json` sits in `packages/client`, so that one MIT licence file covers the client and the API description.

Who may import whom (checked in CI):

- `engine` imports nothing from the repository. It does no I/O; the time and the reference data are passed in.
- `i18n` imports nothing from the repository. It formats plain values: an amount as a `bigint` with its currency code, a date, a number. Until `i18n` exists (slice 2d), the Swedish form of an amount sits in `engine`. The slice that adds `i18n` moves it there.
- `contract` may import `engine`.
- `server` may import `engine`, `contract` and `i18n`. It needs `i18n` for what it writes in Swedish or English: PDF reports, the archive, invitations and the texts in problem details. Only `server` talks to the database. Its tests may also import `client`, to call the API as a program does.
- `ui` may import `i18n` and `engine`. It never calls the server; `web` passes the data in.
- `web` may import `client`, `ui`, `i18n` and `engine`. Never `server` or `contract`.
- `client` is generated from `openapi.json` and imports nothing from the repository.
- `scripts` may import `engine` and `contract`. Nothing imports `scripts`.

## 4. Server modules

Each module lives in `apps/server/src/modules/<name>`. A module owns its tables, its operations in the contract, its tests, and its screens in `apps/web`. Pure logic goes to `packages/engine`.

### Platform

| Module | What it does |
| --- | --- |
| companies | A company: organisation number, name, fiscal year layout, VAT period, accounting method (invoice method or cash method). |
| users | The people who log in. |
| memberships | Which user works in which company, and in which role. |
| auth | Login: BankID through pluggable providers, generic OIDC, password plus TOTP. Opaque session tokens in HttpOnly cookies. |
| tokens | API tokens for programs: bound to one company, with scopes, stored hashed, shown once. |
| oauth | An OAuth 2.1 server, so MCP clients can log in as a user. |
| appearance | Runtime themes: 8 shadcn styles, 7 base colours, 24 theme colours, chart colours, light and dark, radius, menu colour, menu accent, 26 self-hosted fonts. A style builder for company admins. Values only, never raw CSS. Contrast is checked. |
| audit | The behandlingshistorik: who changed what, when, and through which client. Written by database triggers. |
| jobs | Background jobs, the outbox, and webhooks. |
| start-page | The Startsida: the Att göra card with its count, the key figures and the onboarding card, as in the established system. One operation lists what needs the user, and the card is one client of it. |
| messages | Notices under the bell, and messages between colleagues, on their own or on a voucher or a supplier invoice, as in the established system. |
| files | Attachments (underlag), stored with a hash in NortFox's own storage, with optional copies on the company's own cloud drive. A removed file goes to a trash for 30 days, as in the established system. |
| status | Health checks and `nortfox doctor`, which checks that an install is sound. |
| import | Bring a company's books in: from a SIE4 file, or from another system's API through an import adapter. Each adapter lives in its own folder, under a neutral id ([decision 11](decisions/0011-names-policy.md)). |
| compatible-api | A second API surface that follows the established API, its login flow included, so that an integration keeps its own code. It changes its addresses and its client credentials, and logs in once with the new client. A service account uses its company's tenant id in NortFox. Its adapter lives in one folder, under a neutral id ([decision 12](decisions/0012-compatible-api.md)). |
| assistant | An AI assistant that works only through the API, with the user's own rights, and only through the operations that are open to it. |

### Bokföring

| Module | What it does |
| --- | --- |
| accounts | The kontoplan, from the BAS chart. |
| fiscal-years | Räkenskapsår and their periods. The period lock: a locked-through date per user, for the internal system user, for integrations and for all users, and the automatic lock. Opening balances. |
| voucher-series | Verifikationsserier, with gap-free numbers per fiscal year, and each year's closing series, which the period lock does not apply to. A series skips numbers only through a void range that a restore records. |
| vouchers | Book, change, correct, copy and delete vouchers, as the established system does. A voucher whose period is locked for everyone is final. |
| dimensions | Cost centres (kostnadsställen) and projects. |
| currencies | Currencies and exchange rates. |
| budget | Budgets per account and period. |
| accruals | Periodisering: spread an amount over several periods. |
| cash-register | Dagskassa: book a day's sales from a cash register report. |
| vat | The VAT report (momsdeklaration) and the EU sales list (periodisk sammanställning). |
| tax-agency | Skatteverket by API: the VAT report sent as a draft that the user signs at Skatteverket, and the tax account (skattekonto) read each day, as in the established system. Each install makes its own agreement with Skatteverket. |
| reports | Grundbok, huvudbok, saldobalans, balansrapport, resultatrapport and more. |
| sie | SIE 4 import and export. |
| bank | Bank statement files, booking rules, reconciliation. |
| supplier-invoices | Leverantörsfakturor, with approval flows (attest). |
| payments | Payment files. |

Not in this plan: customer invoices, payroll, the annual report. They come after the books work.

Nor is the fixed-asset register (anläggningsregister). The law needs one for most companies (BFL 5 kap. 4 §, BFNAR 2013:2 kapitel 4). Until NortFox has one, the company keeps its register outside NortFox and names it in its system documentation.

## 5. Build order

Each slice is one PR. "Done when" says what must be true before the slice is finished. Every slice also meets the rules in [section 6](#6-how-a-slice-is-built).

### Step 1: the frame

This is the repository setup. It lands before every other PR: until it does, nothing can report the required checks, so no PR can merge.

- **What:**
  - a pnpm workspace with Turborepo; TypeScript 7 in strict mode; ESLint with zero warnings; the import rules from section 3; Vitest with v8 coverage floors and fast-check; Changesets; a hello server that answers `GET /v1/status`, and a hello web page;
  - the CI workflow and its aggregator job "CI OK";
  - the approval workflow that gives "Names", "Owner OK" and "Outside approval", the owner path list, the names check and the fixture guard, all as [section 6](#6-how-a-slice-is-built) describes.
- **Done when:**
  - A PR runs every check, and each guard has a test that shows it fails on a bad input.
  - zizmor and actionlint run in CI and find nothing. Every workflow starts with `permissions: {}` and grants a write scope only to the job that needs it. Every action is pinned to a full commit SHA. No `${{ github.event.* }}` or `github.head_ref` appears inside `run:`; such values pass through `env`. Checkout uses `persist-credentials: false`. No `pull_request` job needs a secret, so a PR from a fork runs every CI job. No required workflow has a paths filter.
  - "CI OK" runs with `if: always()` and fails when a job it needs failed, was cancelled or was skipped. A test feeds it each case.
  - CI installs with `pnpm install --frozen-lockfile`. Only the dependencies on an allowlist may run install scripts, and a new version of a dependency is installed only after a minimum age. `TURBO_TELEMETRY_DISABLED=1` is set. No remote cache exists that a PR run can write.
  - The names check fails on the fake words that its tests inject, in each form it folds, and in a file name, a commit message and a PR title. A `.protected-name-ok` marker outside the marker allowlist fails it too. A missing secret fails it. On a PR from the owner's account it prints only where a match is. A PR from any other account it reads only in a run that the owner's account starts, after the owner's account has approved its head commit, and then it prints only how many matches it found.
  - The fixture guard refuses a real-looking personal identity number, e-mail address or organisation number that is not on its short list of test values.
  - `AGENTS.md` carries the merge rule from [section 6](#where-the-checks-come-from): a PR from an outside contributor is merged only by the owner, by hand, after reading its whole diff. Agents merge only PRs from the owner's account and PRs that Dependabot opened from a branch in this repository, and the owner's own local setup stops them from merging any other.
  - The approval tests show, with a sample owner path list, that a push after the owner-ok label removes the label, and that Owner OK then fails until the owner sets the label again.
- **Owner steps** (agents cannot do these). There is no GitHub App and no bot account: the approval workflow uses its own `GITHUB_TOKEN`.
  - Put the list of protected names in a repository secret. The owner may keep it instead in an environment that only `main` can use.
  - Require every action to be pinned to a full commit SHA.
  - Set "Names", "Owner OK" and "Outside approval" by hand, once, on the frame PR's head commit. This is the bootstrap. GitHub runs a `pull_request_target` workflow from the file on `main` at each event, and every head commit of the frame PR was pushed while `main` had no approval workflow, so nothing can run those checks on the PR that adds them. The plan PR needs no such step. After the frame merges, the plan PR's branch is updated from `main`, which branch protection asks for anyway, and that push runs the approval checks from `main` on its new head. A check set by hand belongs to one commit, so one set on the plan PR's current head would be lost at that push.
  - After the frame PR merges, add "Names" to the required checks.
  - After the bootstrap, the owner may pin "CI OK", "Names", "Owner OK" and "Outside approval" to GitHub Actions. "Review OK" stays open to any source, because it is a commit status. A pin to GitHub Actions does not stop a PR from adding its own job with a required check's name, since that job runs in GitHub Actions too. The merge rule is the gate against that.

### Step 2: the foundation

**2a. Ledger core in PostgreSQL**

- **What:** the first SQL migrations: the database roles (owner, app, and reader roles that are each bound to one company); companies; fiscal years and their periods; the period lock, with its locked-through dates per user, for the internal system user, for integrations and for all users, and the automatic lock's setting; accounts; voucher series, their void ranges and each year's closing series; vouchers and their rows; the record of deleted vouchers; the behandlingshistorik. The triggers for the ledger law, with the voucher rules of [decision 2](decisions/0002-ledger-law-in-postgresql.md). FORCE RLS on every company table. The compose file with PostgreSQL and pgBackRest. The tests set the actor's kind directly: a user, the internal system user or an integration. Decision 2 sets which requests count as which kind. The server applies it from 2c on, where logins and tokens come.
- **Done when:**
  - Tests against real PostgreSQL, run as the app role, show that the database refuses: changing or deleting a voucher in a period that is locked for the actor, or dating a voucher there, except in that year's closing series; deleting a voucher that is not the last of its series; changing a row's account or amount, or removing a row; changing a voucher's series, number or fiscal year; taking the mark off a struck row, or changing who struck it or when; any other change to a voucher or its rows that decision 2 does not allow; changing or deleting anything in the record of deleted vouchers; booking a voucher whose rows that are not struck differ in debit and credit; a voucher date outside every existing fiscal year; a voucher date outside the fiscal year that the voucher is booked in, at booking or by a change, also in the closing series; reading or writing another company's rows.
  - Each lock date applies only to the actors it is set for. With a date set only for one user, for the internal system user, for integrations or for all users, a voucher dated on or before it is refused for those actors and accepted for the others. The automatic lock applies to everyone.
  - A voucher in the closing series of its fiscal year is accepted inside a locked period, under the manual and the automatic lock.
  - After any change to a voucher, the behandlingshistorik holds each earlier value, with the actor and the time. This is NortFox's own working default ([decision 2](decisions/0002-ledger-law-in-postgresql.md)). A struck row stays, marked struck, with the actor and the time.
  - Deleting the last voucher of a series moves it to the record of deleted vouchers, with the actor and the time. The next voucher booked in that series gets its number. When that voucher is deleted too, the record holds both deletions of the number, each as its own entry with its count.
  - A property test with parallel bookings, changes of date, tries to change a voucher's series, number or fiscal year, deletions and rollbacks finds no gap in any series, no number held by two vouchers that are not deleted, no voucher with a number inside a void range, and no voucher dated outside its own fiscal year. A series can only skip numbers through a recorded void range.
  - As the app role, recording a void range is refused, and so is any change to one. Only the owner role can record one, and the trigger writes its behandlingshistorik row like any other.
  - After a void range is recorded, deleting the voucher just below it is refused, because a void range counts as used numbers ([decision 2](decisions/0002-ledger-law-in-postgresql.md)). The next voucher booked in that series still gets a number above the range.
  - Every insert, update and delete leaves a behandlingshistorik row with the actor and the time. The app role cannot change or delete those rows.
  - The app role cannot change the schema, disable a trigger or bypass RLS.
  - As a reader role, setting another company's id for the transaction returns none of that company's rows.
  - A guard lists every table and fails if one lacks FORCE RLS, its company policy or its audit trigger, and a test shows the guard fails.
  - The compose file starts PostgreSQL with WAL archiving to pgBackRest and a short `archive_timeout` ([decision 7](decisions/0007-self-hosting-and-backups.md)), and a point-in-time restore of a test database works.

**2b. API and MCP spine**

- **What:** the Hono server with `@hono/zod-openapi`. `packages/contract` holds the `createRoute` objects, which are the operation registry. Each operation declares its id, its path under `/v1`, its input and output shapes, its permission, its MCP tool text, and whether the AI assistant may call it (closed unless it says so). `openapi.json` is generated and committed; `packages/client` is generated from it. `/mcp` serves every operation as an MCP tool, from the same registry. On `/v1`, errors are problem details (RFC 9457), writes take an idempotency key, and lists use cursor paging. The compatible API comes in 2e, so 2b ships no compatible endpoint.
- **Done when:**
  - One real operation (read a company, on the 2a tables) works by REST, by the generated client and as an MCP tool, with the same result.
  - CI fails when `openapi.json` or the client is out of date.
  - A guard fails when an operation has no permission or no MCP tool, and a test proves it.
  - On `/v1`, money always travels as a decimal string with a currency code; a test shows a JSON number is refused.
  - Each request runs in one transaction that sets the company and the actor with `SET LOCAL`, so a pooled connection never carries them to the next request.

**2c. Login, roles, tokens, MCP OAuth**

- **What:** the companies, users and memberships modules; the first roles (owner, admin, bookkeeper, approver, viewer, auditor); auth with password plus TOTP, generic OIDC and a pluggable BankID provider interface; opaque session tokens in HttpOnly cookies; API tokens; an OAuth 2.1 server for MCP clients; Caddy in the compose file, in front of the server. The real BankID provider comes in 2f. The fake provider exists only in the tests, and the BankID operations refuse when no provider is configured.
- **Done when:**
  - Through the API and MCP, a person can create a company, log in with password plus TOTP, and invite a second user with a role.
  - Session tokens, API tokens and OAuth tokens are random and opaque, are stored only as hashes, and can be revoked. Cookies are HttpOnly, Secure and SameSite.
  - A login through a fake BankID provider works end to end. A generic OIDC login works against a test identity provider.
  - With no BankID provider configured, the BankID operations refuse with 422 `bankid-not-configured`, and the fake provider cannot be configured in an install. A test checks both.
  - An MCP client finds the login from `/mcp` through the protected resource metadata (RFC 9728) and the authorization server metadata (RFC 8414), logs in with authorization code and PKCE, and calls a tool with the user's rights only. Its tokens work for `/mcp` and nothing else.
  - The same MCP discovery and login work through the compose stack, with Caddy in front ([decision 8](decisions/0008-authentication.md)).
  - For every operation and every role, a test generated from the registry shows that a role without the permission is refused.
  - Logins, failed logins, and created and revoked tokens are in the behandlingshistorik.
  - Each request runs as the kind of actor that [decision 2](decisions/0002-ledger-law-in-postgresql.md) sets, and a test checks each kind of request: a session runs as its user, and a request with an API token or from an MCP client runs as an integration.

**2d. Web frame with the theme switcher**

- **What:** `apps/web` with React 19, Vite and Tailwind v4; `packages/ui` with the first shadcn components on Base UI; `packages/i18n` with Swedish and English, and the Swedish amount form moved there from `packages/engine`; login, company picker and an empty app frame with the menu; the theme switcher over the appearance values. The frame lands on the Startsida and leaves room in the top bar for the messages and the bell, as in the established system, and 3r fills all three.
- **Design:** every screen follows the [design rules](design/README.md).
- **Done when:**
  - Login, company choice and logout work in the browser through the generated client only. A guard refuses any other way of calling the server.
  - The theme changes at once, without a reload, and is saved per user through the API.
  - The API refuses a theme that fails WCAG 2.2 AA contrast, not just the screen.
  - All text comes from `packages/i18n` in Swedish and English. A guard fails on a missing key.
  - The frame works at phone width and with the keyboard alone.
  - Fonts and icons are served by the install itself. The app makes no request to another site.

**2e. The compatible API spine**

- **What:** the shared parts of the compatible API ([decision 12](decisions/0012-compatible-api.md)):
  - its adapter folder, named by a neutral id, with its marker and its one docs page. The folder's line on the marker allowlist lands before it, in a PR of its own (see the three PRs below);
  - the routing for the established API's paths, its paging, and its error format and codes;
  - the query parameters that the established API shares across its endpoints: the choice of fiscal year (`financialyear` and `financialyeardate`), `lastmodified`, the filters and the sorting. A booking with neither year parameter goes into the company's default year, which comes in 3b, as the established API uses its preselected year. Which year a read with neither uses is open, for 3b's issue;
  - a query parameter that an endpoint does not take, which each endpoint refuses or ignores as its established endpoint does ([decision 12](decisions/0012-compatible-api.md)). On every established endpoint where an unknown or wrongly cased name was tried, it was refused, with the established API's error. The read of the locked period ignores `financialyear` (3b). How that read treats an unknown or wrongly cased name is open, for 3b's issue;
  - the money reader, which takes each amount and each exchange rate from its own text in the request, as a JSON number or as a string, in each form that the established endpoint takes ([decision 5](decisions/0005-money.md)). How an endpoint rounds an amount with more decimals than it keeps is its own, and each slice's issue records it;
  - the established API's login flow, as [decision 8](decisions/0008-authentication.md) describes it: the authorization code flow, with its `state`, its redirect URI rule and PKCE; refresh tokens; service accounts with their activation and client credentials; the revoke endpoint; the established API's scopes and its token lifetimes. Caddy passes the compatible API's paths and its login paths to the server;
  - the registration of clients, as [decision 8](decisions/0008-authentication.md) describes it: a member of the company with the owner or the admin role (2c) registers a client in that company, changes it, gives it a new secret and deletes it. Each of these is an operation in the registry, with its MCP tool. Any company on the install can then activate the client;
  - listing and revoking a company's consents, service accounts included, as [decision 8](decisions/0008-authentication.md) describes it: a member with the owner or the admin role lists and revokes any of them, and any member lists and revokes the consents that the member gave. Each of these is an operation in the registry, with its MCP tool;
  - the compatible endpoints for the operations of 2b to 2d that the established API also has, such as reading the company.
  - 2e is the first slice that ships a compatible endpoint. From 2e on, each slice adds its own ([section 6](#6-how-a-slice-is-built)). The PR title, body, branch name, commits and changeset use neutral words.
- **Three PRs, in this order,** because the names check reads the marker allowlist from `main`:
  1. A PR that teaches the names check that a marker exempts only the established system's name ([section 6](#the-names-check)). After it merges, the owner marks that name in the list, in the secret and in the local file.
  2. A PR that adds only the folder's line to `.github/protected-name-allowlist.txt`, with the file's header brought up to date. It has no marker and no text that names the established system.
  3. After it merges, the slice's PR, which adds the folder, its marker and its content.
- **Done when:**
  - Reading the company through the compatible API calls the same operation as `/v1` and answers in the established API's shape. A test pins the shape.
  - The paging and the error format, with its codes, follow the established API. Tests with hand-written fixtures pin both.
  - The query parameters follow the established API: the choice of fiscal year, `lastmodified` in the established API's date forms and time zone, and the sorting. Tests with hand-written fixtures pin each.
  - Each compatible endpoint refuses or ignores a query parameter that it does not take, as its established endpoint does. A refusal gives the established API's error. Its tests pin only what was seen on the established endpoint.
  - Money and exchange rates in a request are read from the raw text of each number and never become a float. A test with amounts and rates that a float cannot hold exactly shows it.
  - The money reader also takes an amount sent as a string, such as `"200.50"`, exactly, and refuses a string that is not a number. A test shows both.
  - A program logs in with the established API's login flow: the authorization code flow, whose code works once and for 10 minutes; refresh tokens that each work once; a service account, activated once by a member of the company with the owner or the admin role and then served by client credentials with the company's tenant id; and the revoke endpoint. The scopes and the token lifetimes are the established API's, and a call outside a token's scopes gets the established API's error.
  - The authorization code flow keeps the established rules, and a test pins each: `state` is required and comes back unchanged; a redirect URI that differs from the client's registered one is refused, the registered one is used when none is sent, and the token step refuses one that differs from the request for the code; PKCE takes only `S256`; a client that requires PKCE is refused without a challenge; when a challenge was sent, the token step refuses a missing or wrong `code_verifier`; a request for a scope that is not registered for the client is refused; and an activation with `account_type=service` for a client that does not allow service accounts is refused. Each refusal gives the established API's error.
  - The access token has the established token's shape, a JWT with the company's tenant id as a claim ([decision 8](decisions/0008-authentication.md)). A test reads the tenant id from it, as an integration does. Every token of the flow is stored only as a hash, looked up on every request, bound to one company, and refused outside the compatible API.
  - The revoke endpoint revokes a refresh token, as the established one does. Revoking a consent, or the client, stops every token it gave on the next request, access tokens included ([decision 8](decisions/0008-authentication.md)).
  - Through the API and MCP, a member of the company with the owner or the admin role registers a client, changes it, gives it a new secret and deletes it. Each other role of 2c is refused, for these acts and for the activation of a service account. The secret is shown once and stored only as a hash. After a new secret, the old one is refused. Deleting the client stops every token it gave on the next request.
  - Through the API and MCP, a member of the company with the owner or the admin role lists the company's consents, service accounts included, and revokes one. Its tokens stop on the next request. Any member lists and revokes the consents that the member gave. Each other role is refused for any other consent.
  - The login and a compatible call work through the compose stack, with Caddy in front.
  - A request from a compatible client runs as an integration, and so does one from a service account ([decision 2](decisions/0002-ledger-law-in-postgresql.md)). A test checks both.
  - The folder is on the marker allowlist and holds its marker. The names check passes on everything outside it, including `openapi.json`, the client, `packages/i18n` and the changesets. Inside it, the check still refuses every protected name but the established system's.

**2f. BankID: the real provider**

- **What:**
  - a BankID provider behind the provider interface of 2c ([decision 8](decisions/0008-authentication.md)). It speaks BankID's relying party API: it starts an order, collects it and cancels it, over mutual TLS with the install's relying party certificate. Each install gets its certificate through its own agreement, with a bank or a reseller that sells BankID. NortFox is not tied to one of them. The configuration names the certificate file, the file that holds its passphrase, and the environment: test or production;
  - the QR code, which the person scans with the BankID app on another device, and which BankID asks to change every second. The server computes it from the order's QR start secret and the seconds since BankID answered the start. The start secret never leaves the server ([BankID](https://developers.bankid.com/how-to-guides/qr-code)). So the pending answer of 2c's collect operations carries the current QR data and BankID's hint code. A client asks for it once a second. The server asks BankID's collect at most once every two seconds, as BankID asks;
  - the two kinds of order, for another device or for this device, which 2c's start operations take. BankID answers every start with both the QR start data and the autoStartToken. An order for another device is the QR code above. Its answers carry the QR data and never the autoStartToken, so its start cannot be passed on as a link that opens the BankID app. It needs no nonce and no IP match: BankID calls no return URL for it, and the phone's IP address may differ from the computer's. An order for this device opens the BankID app on the same phone or computer. Its start answer carries the autoStartToken, and the order carries a return URL to the web app, with a nonce bound to the browser that started the order, as BankID strongly recommends ([BankID](https://developers.bankid.com/how-to-guides/return-url)). It completes only when that nonce comes back from that browser, and when the IP address that BankID saw on the device equals the one the order was started from. This adds the kind to the input of 2c's start operations, and the nonce to the input of 2c's collect operations;
  - BankID's rule against ID switching. BankID's agreement forbids using BankID to give out another login method, to confirm the person behind a login made with another method, or to reset another method's password. It also forbids keeping a person logged in by a lasting cookie after more than two hours without activity ([BankID](https://www.bankid.com/foretag/anslut-foretag)). 2c's issue lets a BankID verification approve a new TOTP secret, an OIDC link and a new personal e-mail, which receives the reset links, and lets an idle logout run up to 8 hours. Before 2f is built, the owner decides, one point at a time: how long a session from a BankID login may stay idle; whether a BankID verification may approve another login method or the e-mail that receives the reset links; and what an MCP or API token made after a BankID login may do. 2f's issue turns each choice into a done-when line with its test;
  - the decisions that change: decision 8's consequence becomes "The required tests use a fake provider or a local stand-in", and [decision 10](decisions/0010-quality-gates.md) says where a test that reaches an outside service runs, as below.
- **Done when:**
  - One contract test suite for the provider interface runs against the fake provider of 2c and against the real one. The real one runs against a local stand-in for the relying party API that asks for a client certificate.
  - With the real provider in the code, the BankID operations still refuse with 422 `bankid-not-configured` when no provider is configured, and the fake provider still cannot be configured in an install. A test checks both.
  - The order carries the person's own IP address, as BankID asks, also with Caddy in front.
  - A test pins the QR data against the example in BankID's documentation. Through the API, the QR data changes every second, and no answer holds the QR start secret.
  - Against the stand-in, no answer for an order for another device holds the autoStartToken, and such an order completes without a nonce. An order for this device is refused when its nonce is wrong, when the right nonce comes from another browser, and when BankID saw another IP address on the device.
  - Against BankID's test environment, with its public test certificate, an order starts, is collected as pending, and is cancelled. This test reaches an outside service. So it runs in a workflow of its own, on a schedule and on demand, and neither CI OK nor any other required check needs it. Its job fetches BankID's public test certificate at run time, so the certificate is not stored in the repository. `pnpm test` leaves the test out by its configuration, not by a skip. Without its certificate path, the test fails. It never skips.
  - BankID's test environment issues a test BankID for any personnummer ([BankID](https://developers.bankid.com/test-portal/test-information)). So the server starts with the test environment only when its configuration also marks the install as a test install. A test shows the refusal. This is a working default that the owner may change.
  - A login and a verification with a test BankID on the test environment work by hand, with a personnummer from the fixture guard's list. `deploy/README.md` lists the steps. It says how an install gets its agreement and its certificate, and that an install with real people uses production.
  - The passphrase, the certificate's private key and the order's QR start secret never appear in a log, in an answer or in clear in a table. A provider's error reaches a log or an answer only as its error code and its HTTP status, never with the provider's own text.

### Step 3: Bokföring

The ledger comes first, then what a voucher carries, then the reports and SIE so the books can be checked and moved, then the VAT report, then the modules that bring money in and out. Two platform modules come in where the first Bokföring module needs them. Last come the Startsida, the bell and messages, which show what the earlier slices leave for the user, and Skatteverket by API.

**3a. accounts: the kontoplan**

- **What:** a new company gets the BAS chart for its year from `reference-data`. Users add, rename and deactivate accounts. Each account carries its VAT code and SRU code where the chart gives one.
- **Done when:** the chart can be listed, changed and exported through the API and MCP; the database refuses to delete an account that has booked rows; the source and terms of the BAS data are written next to it in `reference-data`.

**3b. fiscal-years: räkenskapsår and the period lock**

- **What:** create fiscal years and their monthly periods. The engine checks the year's length (normally 12 months; a first or changed year may be shorter, or at most 18 months). A fiscal year has no open or closed state, as in the established system. The period lock, set through the year's last date, locks a whole year.
  - The default year (förvalt), as the established system has it. A company has one default year at a time. It is set when a year is created or changed. It is the year the screen opens in at login. The compatible API uses it when a request gives no year: a voucher booked with neither `financialyear` nor `financialyeardate` goes into it (3d). The established API calls this the preselected year. That it is the year marked as the default is likely but not confirmed. 3b's issue confirms it, and settles which year the compatible reads use when no year is sent.
  - Opening balances, as the established system has them. Only a balance account has one; a result account opens at zero. When a year is created after another, the closing balances of the year before can be copied into it as its opening balances. That copy is made once: a later change in the old year does not reach it by itself. A transfer copies the old year's closing balances again, and the user runs it after such a change. An opening balance can also be set by hand, on a balance account only. A transfer overwrites the opening balances set by hand, as in the established system.
  - The period lock, as the established system has it ([decision 2](decisions/0002-ledger-law-in-postgresql.md)):
    - The manual lock: a locked-through date for each user, for the internal system user, for integrations and for all users. Each date can be set, changed and cleared. What setting or clearing the all-users date does to the other dates is open (below).
    - The automatic lock, on or off, for everyone, with one of the established system's intervals: 50 days after the end of the month, 50 days after the end of the quarter, or 60 days after the end of the fiscal year. The case for sole traders, at the date of the income tax return, comes once its rule is confirmed.
    - The automatic lock needs no job: the database works out its date from the day's date and the interval. The screen shows, as the established one does, the date locked now, the next date, the next lock run, and how many days before a lock run a reminder comes. The reminder itself needs the job queue, so it comes in 3j.
    - The year's closing series (3c) is exempt from both locks, on every date.
  - Open, for 3b's issue to settle ([decision 2](decisions/0002-ledger-law-in-postgresql.md)), from the help pages or from a lock test that the owner allows. Where neither answers, the default after each point stands:
    - Which bookings count as the internal system user's. Default: a booking that a module makes by itself, with no user or integration asking for it, such as an accrual run. Every other booking counts as the actor whose request made it.
    - Whether the latest date that applies to an actor is what locks, as the help pages suggest. Default: it is.
    - Which date the compatible API's read of the locked period returns, since the established API returns one date and does not say which row it reflects. Default: the date that is locked for the caller, which counts as an integration.
    - What setting and clearing the all-users date does to the dates of the users, the internal system user and integrations. On the established screen, the all-users row's clear button reads as removing every locked period. Default: each date is set and cleared on its own, and the other dates stay as they were.
  - Open too: how the established read of the locked period treats an unknown or wrongly cased query parameter name, such as `foo=bar` or `FinancialYear`. Only `financialyear` was tried there, and it was ignored. 3b's issue checks it with a live read, which changes nothing. Until then, 3b's tests pin only `financialyear`.
- **Done when:**
  - The database refuses a voucher dated in a period that is locked for the actor, except in that year's closing series, and a voucher dated outside every existing fiscal year.
  - With a date set only for one user, for the internal system user, for integrations or for all users, a voucher dated on or before it is refused for the actors that the date applies to and accepted for the others.
  - A voucher in the year's closing series is accepted inside the manual and the automatic lock.
  - Once a period is locked for an actor, that actor's change or deletion of one of its vouchers is refused. After the date is cleared, both are allowed again.
  - Setting and clearing the all-users date does to the other dates what 3b's issue settles, and a test pins it.
  - For each interval of the automatic lock, a test at its boundary shows the last day the period is open and the first day it is locked. 3b's issue settles which day the established system locks on.
  - Every change to a lock date, to the automatic lock's setting and to the year's closing series is in the behandlingshistorik, with who and when.
  - When a year is created after another with its balances copied, each balance account's opening balance equals its closing balance of the year before, and each result account opens at zero. After a late booking in the old year, the new year's opening balances stay as they were. After a new transfer, they match again. A transfer overwrites an opening balance set by hand. The transfer works through the API, MCP and the screen.
  - A property test shows that right after a transfer, each balance account's opening balance always equals its closing balance of the year before.
  - An opening balance on a result account is refused, as in the established system.
  - The compatible read of the locked period ignores `financialyear`, as the established one does: also with a year that does not exist, it gives the same answer as no parameter. A test pins it ([decision 12](decisions/0012-compatible-api.md)). Once 3b's issue has checked how the established read treats an unknown or wrongly cased name, a test pins that too.
  - A company has one default year at a time, set when a year is created or changed, through the API, MCP and the screen. Marking another year as the default moves the mark. The screen opens in the default year at login.

**3c. voucher-series**

- **What:** series per company, a number range per series and fiscal year, a default series per kind of voucher (manual, supplier invoice, payment, bank, cash register). One series per fiscal year can be marked as the closing series, which the period lock does not apply to ([decision 2](decisions/0002-ledger-law-in-postgresql.md)). A voucher gets its number when it is booked. Deleting the last voucher of a series gives its number out again.
- **Done when:** numbering starts again in each fiscal year; a used series cannot be deleted; a second closing series in one fiscal year is refused; after the last voucher of a series is deleted, the next voucher booked in it gets that number; a property test with parallel bookings and deletions in several series finds no gap, and no number held by two vouchers that are not deleted.

**3d. vouchers: book and correct**

- **What:** book, change, correct, delete, list and read vouchers, as the established system does ([decision 2](decisions/0002-ledger-law-in-postgresql.md)).
  - A voucher is booked at once and gets its number. Nothing is saved before that: an unfinished form stays in the browser.
  - Until its period is locked for the actor, a voucher can be changed: its description, its date and its row texts can change, and rows can be added. A row's account or amount is never changed; the row is struck and a new row takes its place. The struck row stays on the voucher, struck through, with who and when. The established system's help pages also let Ändra change the voucher's cost centre and project. 3f settles that, since the dimensions come there.
  - Until its period is locked for the actor, it can also be deleted, when it is the last voucher of its series. Its number is given out again, and the deleted voucher goes to the record of deleted vouchers, with who and when.
  - Until its period is locked for the actor, it can also be corrected with a reversing voucher. Ändringsverifikation opens a new, unbooked form, filled as the established system fills it: the description names the old voucher, and the old voucher's rows that are not struck come with debit and credit swapped. Nothing is booked until Bokför, as with Kopiera. The booked voucher has its own number, in an open period, and is linked to the old one both ways. A voucher has at most one reversing voucher at a time. Ändringsverifikation refuses a voucher that another module made, such as a supplier invoice, as the established screen does, by REST and MCP too. The module that made a voucher can still reverse it itself, as the VAT module does when a report is booked again (3i). Deleting the reversing voucher, which is allowed while it is last in its series, removes the link both ways, and the old voucher can then get a new one.
  - Open: whether the established system offers Ändringsverifikation after the lock too. 3d's issue settles it, with the help centre or a lock test that the owner allows. Either way, a voucher in a locked period can be corrected by a new voucher dated in an open period.
  - Kopiera opens a new, unbooked form with the voucher's description and its rows that are not struck, as in the established system. Nothing is saved until Bokför. Kopiera is disabled on a voucher that another module made.
  - Kopiera and Ändringsverifikation are each an operation with its MCP tool, and the screen calls the same operations. Each returns the input for a new voucher, filled as above, and books nothing. Booking that input is an ordinary booking. For Ändringsverifikation, the booking names the old voucher, so the two are linked. The established API has neither, so neither has a compatible endpoint.
  - A booking that names an old voucher as the one it reverses is refused when another module made the old voucher, unless the booking comes from that module, as the VAT module's does (3i). So a client that books directly by REST or MCP, without Ändringsverifikation, cannot link a reversing voucher to a module's voucher either. The established system never allows that link.
  - An imported voucher counts as manual or as another module's, for Ändringsverifikation, Kopiera and the link above, by where it comes from. In the established system, only a manual voucher gets an Ändringsverifikation, and a voucher booked through the established API counts as manual.
    - From another system's API (4f), it keeps the kind it had there. The established API gives that kind as the voucher's reference type. So a voucher that was manual there is manual here, and one that a module made there counts as another module's voucher here. Where the source gives no kind, the voucher counts as manual.
    - From a SIE file (3h): open. Whether the established system counts a voucher imported from a SIE file as manual was not tested. 3h's issue settles it, from the help pages or from a test that the owner allows. Until then, such a voucher counts as manual, since a SIE file does not say which module made a voucher. This is NortFox's own working default.
  - A change keeps the voucher's date inside the fiscal year it is booked in, also in the closing series ([decision 2](decisions/0002-ledger-law-in-postgresql.md)). Open: whether the established screen lets Ändra move the date into another year. 3d's issue checks it. Until then, such a change is refused.
  - A booking goes into the year that the request names, or into the company's default year (3b) when it names none, as in the established system. Open: whether the established API refuses a booking dated in another existing year than the chosen one, or books it in the year its date lies in. 3d's issue checks it, and the compatible API then does what the established API does. Until then, such a booking is refused, as NortFox's own working default ([decision 2](decisions/0002-ledger-law-in-postgresql.md)).
  - A voucher in a period that is locked for the actor is only corrected by that actor, by a new voucher in an open period, never changed or deleted, except in the year's closing series.
  - Booking through `/v1` or MCP takes an idempotency key. A voucher's behandlingshistorik and the record of deleted vouchers are readable through the API and MCP.
- **Design:** the screens follow [the vouchers screen spec](design/screens/vouchers.md), which describes the voucher rules above. Where the spec and this slice ever differ, this slice wins until the spec is updated.
- **Done when:**
  - Booking, reading, changing, correcting, copying and deleting work by REST, by MCP and on the screen.
  - The answer to a booking carries the voucher's number.
  - Tests as the app role show the database refuses a change or a deletion in a period that is locked for the actor, except in the year's closing series, the deletion of a voucher that is not last in its series, a change to a row's account or amount, a change to a voucher's series, number or fiscal year, taking the mark off a struck row or changing who struck it or when, any other change that decision 2 does not allow, and a change that moves a voucher's date into another fiscal year, also in the closing series.
  - After a change, the voucher shows its struck rows with who and when, and the behandlingshistorik, read through the API, holds each earlier value.
  - A voucher shows who created it and when, and, once changed, who changed it last and when, as the established screen does.
  - Ändringsverifikation opens an unbooked form with the old voucher's rows that are not struck, debit and credit swapped, and a description that names the old voucher. Nothing is booked until Bokför. Once it is booked, each voucher points to the other. A second reversing voucher while the first exists is refused. Ändringsverifikation on a voucher that another module made is refused, by REST, by MCP and on the screen. So is a booking by REST or MCP that names such a voucher as the one it reverses, unless it comes from that module, and no link is made.
  - After the reversing voucher is deleted, the old voucher points to none, and a new reversing voucher for it is accepted.
  - After a deletion, the next voucher in the series gets the freed number, and the deleted voucher can be read, with who and when, in the record of deleted vouchers. When that number is deleted again, the record holds both, each with its count.
  - Kopiera on a booked voucher, by REST, by MCP or on the screen, gives the input for a new voucher, with the old voucher's description and its rows that are not struck. Nothing is booked or saved until Bokför. On a voucher that another module made, Kopiera is disabled on the screen and refused by REST and MCP.
  - Every booking, change, strike, correction and deletion is in the behandlingshistorik, with who and when.
  - Inside a lock set only for integrations, a booking with an API token, from an MCP client or through the compatible API is refused, and the same booking from a session is accepted.
  - A booking through the compatible API with neither `financialyear` nor `financialyeardate` goes into the company's default year, unless 3b's issue finds that the established API's preselected year is another one. A test pins it, with two years, so the default year and the year of today differ.
  - Booking the same request twice through `/v1` or MCP, with the same idempotency key, gives one voucher. Through the compatible API, as through the established API, each request books its own voucher.

**3e. files (platform): attachments**

- **What:** upload files (PDF, images, XML) and link them to vouchers. The original file lives in NortFox's own storage, on disk or in S3-compatible object storage, with a SHA-256 hash. A pluggable storage layer can also copy each file to a cloud drive that the company connects itself.
  - Removing a file works as in the established system. Ta bort moves it to a trash, where it can be restored for 30 days. After that, a job deletes it for good. That job needs the job queue, so it comes in 3j; until then, a file stays in the trash. The trash can also be emptied at once, which deletes its files for good. Removing a link through the compatible API gives the established API's answer.
  - The established system's paid archive also caps the size of the trash. That cap is out of scope for 3e.
  - Open: whether a locked period stops the removal of a file. 3e's issue settles it from the help pages, or from a lock test that the owner allows. Until one of them answers, removing a file has no lock check, as far as the established system is known: its help pages name none.
  - By default, the original stays in NortFox's own storage and a cloud drive holds only copies. This is a default that the owner may change. The docs recommend it, because a drive's users can delete its files, a drive account can be closed, and the law sets where räkenskapsinformation may be kept (BFL 7 kap. 2 § and 3 a §).
- **Done when:**
  - Ta bort on a linked file moves it to the trash, where it can be restored for 30 days. Emptying the trash deletes its files at once. Removing a link through the compatible API gives the established API's answer. Unless 3e's issue finds a lock check, Ta bort and the removal of a link work the same on a voucher in a locked period.
  - The hash is checked on every read. The size and type limits are enforced by the server.
  - With a test cloud drive connected, a new file is stored in NortFox's own storage and copied to the drive. Disconnecting the drive, or deleting the copy there, loses no file and changes no voucher.

**3f. dimensions: cost centres and projects**

- **What:** dimensions and their objects, as in SIE. A voucher row can carry one object per dimension.
  - The voucher itself can also carry a cost centre and a project, beside those on its rows, as in the established system.
  - Ändra can change the voucher's cost centre and project, and those of a row, while the voucher's date is not locked for the actor, as the established system's help pages say ([decision 2](decisions/0002-ledger-law-in-postgresql.md), 3d).
  - Open: whether Ändra makes such a change in place, or by striking the row and adding a new one. 3f's issue settles it, from the help pages or from a test in the established system.
- **Done when:**
  - A row can carry a cost centre and a project, and so can the voucher itself, through the API, MCP and the screen.
  - Ändra changes the cost centre and the project of a voucher and of a row, the way 3f's issue settles, while the voucher's date is not locked for the actor. The behandlingshistorik holds each earlier value, with who and when. Once the date is locked for the actor, the change is refused.
  - A property test shows that a report per project always equals the sum of its rows that are not struck.

**3g. reports**

- **What:** grundbok (vouchers in date order), huvudbok (rows per account), saldobalans, balansrapport and resultatrapport, for any date range and per dimension. JSON through the API, plus CSV and PDF downloads.
- **Done when:** a property test shows the balansrapport always balances, with the year's result included; the reports for a fixed set of reference books, with a struck row among them, match numbers worked out by hand from the rows that are not struck.

**3h. sie: import and export**

- **What:** the SIE 4 format both ways, in `packages/engine`: export a fiscal year; import vouchers into an existing company; start a new company from one SIE4 file (kontoplan, opening balances, vouchers, dimensions). This is the first part of the import module. 3h's issue settles whether a voucher imported from a SIE file counts as manual, for Ändringsverifikation and Kopiera. Until then, it does (3d).
- **Done when:** a property test shows that export followed by import gives the same books; synthetic files that cover every record type of the published SIE 4 format import, in the format's CP437 encoding; a file with an error is refused as a whole, with the line number.

**3i. vat: VAT report and EU sales list**

- **What:** VAT codes and report boxes per year from `reference-data`; the VAT report for a month, quarter or year; the file for the tax agency; the VAT settlement voucher; the EU sales list (periodisk sammanställning). As far as is known, the established system does not lock a period when its VAT report is booked. 3i's issue confirms this, and until then 3i adds no lock.
  - Sending the report to Skatteverket by API, as a draft that the user signs there, comes in 3s.
  - A booked report is corrected as in the established system. Either its VAT voucher is deleted, while it is the last of its series, and a new report is booked. Or the period's bookings are fixed and the report is booked again. The VAT module then books a reversing voucher of its earlier VAT voucher, linked both ways, and a new VAT voucher. Booking the report again with no change in the period books nothing.
  - A booked report keeps the box values it was booked with, stored with its VAT voucher. So it can be read again with those numbers, also after a later change in its period. Whether the established system keeps them, or works a booked report out again from the books, was not checked. 3i's issue checks it. Until then, the values are stored, as NortFox's own working default.
  - Each VAT period has a state, as in the established system's Moms view. A period waits from the day after it ends until the user marks it Klar or Redan hanterad. Booking its report does not end the wait by itself. Klar is the last step, after the report is booked and the return filed: by API (3s), or by hand and then marked as filed (Markera momsdeklarationen som inlämnad). Redan hanterad is for a period handled elsewhere. Each mark is an operation with its MCP tool. The Startsida shows the periods that wait (3r).
  - Open: which periods wait in a company whose books started before NortFox. 3i's issue checks it with a live look. Until then, every period that ends inside a fiscal year in NortFox waits until it is marked, and the user marks the old ones Redan hanterad.
- **Done when:**
  - The box values for the reference books match numbers worked out by hand.
  - Through the API, MCP and the screen, a VAT period waits from the day after it ends until it is marked Klar or Redan hanterad. Booking its report alone leaves it waiting. A return marked as filed by hand keeps that mark.
  - A booked report can be read again later with the numbers it was booked with, also after a later change in its period.
  - Booking a report again after a change in its period books a reversing voucher of the earlier VAT voucher, linked both ways, and a new VAT voucher with the new numbers. Booking it again with no change books nothing.

**3j. jobs (platform): background jobs and the outbox**

- **What:** a job queue in PostgreSQL, run by the server process; an outbox written in the same transaction as the change it reports; retries with backoff; jobs readable through the API. The first jobs are the reminder before each automatic lock run (3b), which the API serves and 3r shows in the app as the established system does, and the job that deletes a file once it has been in the trash for 30 days (3e).
- **Done when:** a job survives a server restart and runs exactly once; a test shows an outbox event exists if and only if its transaction committed; the reminder appears the chosen number of days before an automatic lock run; a file in the trash is deleted once it has been there for 30 days, and not before.

**3k. currencies**

- **What:** currencies (ISO 4217); daily exchange rates, fetched by a job from a public source or entered by hand; voucher rows with a foreign amount and its rate.
- **Done when:** a row in a foreign currency books an exact amount in öre, with the rate stored next to it; a property test shows the engine and the database round the same way.

**3l. accruals: periodisering**

- **What:** an accrual plan spreads an amount over months and books one voucher per period; year-end accruals that reverse on the first day of the next year.
- **Done when:** a property test shows the booked parts always add up to the total, to the öre; stopping a plan stops only the vouchers that are not yet booked.

**3m. budget**

- **What:** budgets per account and month, optionally per dimension; budget against actual in the resultatrapport; budgets in SIE.
- **Done when:** the resultatrapport shows actual, budget and difference; a budget survives a SIE export and import unchanged.

**3n. cash-register: dagskassa**

- **What:** book a day's cash register report: sales per VAT rate, payment methods, cash differences; one template per register.
- **Done when:** a day's report books one balanced voucher from the company's template; the cash balance per day can be read back through the API.

**3o. bank: statements, booking rules, reconciliation**

- **What:** import statement files (ISO 20022 camt.053, and CSV through a column mapping); booking rules that match a line on text, amount or counterparty and propose a voucher; reconciliation of each bank account against the statement.
- **Done when:** importing the same file twice changes nothing; a rule can be tried as a dry run first; the reconciliation of the reference books shows no difference.

**3p. supplier-invoices: leverantörsfakturor with approval**

- **What:** a supplier register; register an invoice with its file; book it on receipt (invoice method) or on payment (cash method), per the company's setting; approval flows with one or more approvers by amount or cost centre; OCR reference check; due dates.
- **Done when:** an invoice cannot be paid before its approval flow is complete; both accounting methods give the right vouchers for the reference cases; the supplier ledger always equals the balance of its account.

**3q. payments: payment files**

- **What:** a payment proposal from approved invoices that are due; a payment file in ISO 20022 pain.001; bank days from the holidays in `reference-data`; the payment is booked when the bank statement shows it.
- **Done when:** every payment file validates against the pain.001 schema; a test shows one invoice is never in two files; matching the statement books the payment and closes the invoice.

**3r. start-page and messages (platform): the Startsida, the bell and messages**

- **What:** the Startsida with its cards, the bell with its notices, and the messages panel, as in the established system. They show what the earlier slices leave for the user.
  - One operation, with its MCP tool, lists what needs the user in the current company, with the user's own rights. It gives one row per kind of task, as the established Att göra card does: a short label, a title with the number of records and their total where they have amounts, a one-line explanation, and a link to the list that holds them, filtered. The operation also returns the records under each row. The Startsida's Att göra card is one client of it, and its count is the number of rows.
  - The rows come from the earlier slices:
    - supplier invoices that wait for the user's approval (3p), which open the supplier-invoice list on the Under attest tab;
    - bank lines that wait to be booked or linked (3o), which open the bank's waiting lines;
    - approved supplier invoices that are due and in no payment file (3q), which open the payment proposal;
    - each VAT period that waits (3i), as a row of its own, which opens the period's VAT report.
  - A record leaves its row once it is handled, and a row leaves once none of its records waits.
  - Open: which kinds of task the established card shows, and how it groups each. Its help page names payments that need action and invoices to approve. Other help pages say that waiting bank lines and VAT periods show as cards on the start page. Only one row was seen, for overdue customer invoices, which are outside this plan. 3r's issue settles the list with a live look, which changes nothing. Until then, the list holds the four kinds above, grouped as above. Reading the payments that need action as invoices that are due to be paid is NortFox's own working default.
  - Beside the Att göra card, the key figures, as in the established system:
    - Hur det går: graphs of Omsättning (accounts 3000 to 3799), Kostnader (4000 to 7999 and 8000 to 8799) and Resultat (3000 to 3999, 4000 to 7999 and 8000 to 8799), from the ledger, with the year before beside them when the user asks. Ändra nyckeltal picks which cards show and in what order, and the choice is kept per user. It also offers Likviditet, Betalförmåga and Moms.
    - Företaget: the unpaid supplier invoices (3p, 3q), as the total of those overdue and those not yet due, with the overdue part split into more than 30 days, 11 to 30 days and the last 10 days. The established card also shows customer invoices and financing, which are not in this plan.
    - Konton: the balance of each bank account. The established card takes it from a live bank link. NortFox reads statement files (3o), so it shows each account's balance from its latest statement, with the statement's date. This is NortFox's own working default. The tax account's balance comes in 3s.
    - The established page also has Insikter, its own comments on changes such as a falling margin, and Tips, news from its maker. Neither is in this plan.
  - Open: what Likviditet, Betalförmåga and Moms show, and which months the graphs cover. The help page names them without saying. 3r's issue finds out with a live look. Until then, the graphs show the current fiscal year month by month, Likviditet shows the balance of the cash and bank accounts (BAS group 19), Moms shows the result of the VAT report for the current period (3i), and Betalförmåga is left out. These are NortFox's own working defaults.
  - Open: who sees which card. In the established system, the graphs need a right of their own, the supplier-invoice figures need the right to read the bookkeeping reports, and Konton needs the right to reconcile an account. A firmatecknare logged in with e-legitimation also sees the last two. A user who logged in without e-legitimation sees none of the key figures. 3r's issue maps these rights to the roles of 2c, and the owner decides whether NortFox copies the rule on e-legitimation. Until then, Hur det går and Företaget show to the roles that may read the reports (3g), Konton to the roles that may reconcile a bank account (3o), and the way the user logged in does not matter, since an install without a BankID agreement (2f) would otherwise never show them.
  - Beside them, the onboarding card (Kom igång), as in the established system: its tasks, its progress, Starta, Hoppa över, Ångra, Visa fler and Minimera. A skipped task stays on the card for 7 days and then leaves. Ångra within those days keeps it until it is done. A done task stays for 7 days and then leaves. Which tasks a user sees depends on the user's rights.
  - Open: which tasks the onboarding card holds. The established card shows a task when the company orders a product. It was seen with four tasks, none done. One showed, for a company card that no slice offers. The other three sat behind Visa fler and were not read. 3r's issue lists them with a live look. Until then, the card holds the set-up tasks that have a screen by 3r: the fiscal year (3b) and the kontoplan (3a). This is NortFox's own working default.
  - The bell lists the user's notices. They come from events in the outbox (3j), so a change that is rolled back gives no notice:
    - the supplier-invoice approval notices, each with its established setting (3p): a notice to an approver when an invoice reaches the approver's step, and notices to the administrator after a set number of days without approval and a set number of days before the due date;
    - the reminder before an automatic lock run (3j).
  - Open: the order of the notices, and when an approver's notice comes under the bell. The bell was seen only empty, and the help page says only that the notices in the app are always sent. 3r's issue settles both with a live look. Until then, the newest notice comes first, and an approver's notice comes at once.
  - Open: where the reminder before an automatic lock run shows. The established help page places it under the letter icon at the top, and the established top bar now has a speech bubble for messages and a bell. 3r's issue settles it with a live look. Until then, it shows under the bell, to the members whose role may set the period lock.
  - E-mail, as in the established system. The notices always show in the app. The approval notices also go by e-mail to a user whose e-mail notices are on. That is a setting per user, off until the owner or an admin turns it on, as the established system sets it under the user's rights. For the approvers, the established settings apply to these mails: Skicka notiser, Omgående or Vid angiven tid, which gathers the invoices in one mail at a set time; and Påminnelsenotis, with its interval. A mail goes out only when the install's configuration names a mail server. The setting is an operation with its MCP tool. SMS, which the established system sells as an extra, and push notices to a phone are out of scope.
  - Open: whether the reminder before an automatic lock run also goes by e-mail. The evidence shows it only in the app. Until 3r's issue settles it, it stays in the app.
  - The messages panel, as in the established system. It opens from the speech bubble in the top bar. A user writes to chosen users of the same company. A thread can be attached to a voucher (3d) or a supplier invoice (3p), and Gå till post opens the thread there. A message changes nothing on the voucher or the invoice. The panel searches the messages.
    - Any user of the company can be addressed. The list of users marks as Behörig those who may see the voucher or the invoice. For an invoice, these are the users with the supplier-invoice right, and the approvers who have approved it or are next in line (3p).
    - Everyone who may see the voucher or the invoice may read its thread. A user joins the thread with the eye, which also watches it, and leaves it with the crossed-out eye. Any participant adds others with Lägg till deltagare. The participants are told of each join, leave and addition, and the thread shows it, with who added whom.
    - A thread attached to nothing is private: only its participants read it, and any participant can add others. The established system's open threads, which an accounting firm's staff can read, are out of scope, since this plan gives a firm no access of its own.
    - Each participant is told of a new message by an unread notice on the speech bubble and in the browser tab, not under the bell. Messages send no mail, except one: as in the established system, a user gets a mail the first time the user sends or gets a message, when the install names a mail server.
  - Open: what the help pages do not say: whether an addressed user who is not Behörig reads the thread, whether a message can be changed or deleted, and whether a message can carry a file, as the panel's empty state suggests for underlag sent from the phone. 3r's issue settles each with a live look. Until then, an addressed user who is not Behörig reads the messages in the panel but cannot open the voucher or the invoice, a message stays as it was written, and it carries no file.
  - The list of what needs the user, the key figures and the choice of them, the onboarding tasks, the notices, the e-mail setting and each act on a message thread are operations in the registry, each with its MCP tool. The screens call the same operations. The established API has none of them, so none has a compatible endpoint.
- **Done when:**
  - Through REST, MCP and the Startsida, the list of what needs the user gives the same rows, and the Att göra card's count equals the number of rows.
  - Three invoices that wait for one user's approval give that user one row, with 3 and their total, which opens the supplier-invoice list on the Under attest tab. The number drops as each one is approved, and the row leaves once none waits. No other user gets a row for them.
  - A bank line counts in its row until it is booked or linked, or until it leaves 3o's waiting lines in another way that 3o has. An approved invoice that is due counts until it is in a payment file. A VAT period that waits is a row of its own, until the period is marked Klar or Redan hanterad (3i). Each kind of row that 3r's issue settles has such a test.
  - Omsättning, Kostnader and Resultat for the reference books equal the sums of their account ranges in the resultatrapport of 3g, for the current year and the year before. The choice and order of the cards from Ändra nyckeltal are kept per user through the API.
  - With a fixed clock, the supplier-invoice figure equals the open total of the supplier ledger of 3p, and its overdue part is split into more than 30 days, 11 to 30 days and the last 10 days. Konton shows each bank account's balance from its latest statement, with its date. Each card shows only to the roles that the open point above gives it.
  - Each onboarding task opens its screen. Hoppa över, Ångra and Minimera are kept through the API. With a fixed clock, a skipped task leaves after 7 days, Ångra within them keeps it until it is done, and a done task leaves 7 days after it was done.
  - With a fixed clock, an approver gets a notice under the bell when an invoice reaches the approver's step, and the administrator gets one after the set days without approval and the set days before the due date.
  - With a test mail server, a user whose e-mail notices are on gets the approval mails: an approver at once or gathered at the set time, as the setting says, and the reminders at the interval. A user whose e-mail notices are off gets no mail, and with no mail server named no mail goes out.
  - An approval whose transaction rolls back gives no notice.
  - The reminder before an automatic lock run shows where 3r's issue settles, the chosen number of days before the run.
  - Through REST, MCP and the screen, a user starts a thread on a voucher and one on a supplier invoice with a chosen colleague, and the colleague answers. Every user who may see the voucher or the invoice reads its thread, and the list of users marks those users Behörig. A member of another company sees nothing.
  - Joining with the eye, leaving and Lägg till deltagare work. The participants are told of each, and the thread shows it, with who added whom. Each participant gets an unread notice of each new message on the speech bubble. Only a user's first message, sent or received, gives that user a mail.
  - A thread attached to nothing is read only by its participants.
  - After a thread and its messages, the voucher and the invoice read the same as before.

**3s. tax-agency: Skatteverket by API**

- **What:** Skatteverket's APIs, as the established system uses them: the VAT report sent as a draft, and the company's tax account (skattekonto) read each day.
  - Each install makes its own agreement with Skatteverket, as it makes its own BankID agreement in 2f ([decision 8](decisions/0008-authentication.md)). Skatteverket gives an organisation its API keys after a request and, for production, a signed agreement. The calls also need an organisation certificate (organisationslegitimation) that Skatteverket accepts. NortFox is not tied to one organisation. The configuration names the client id, the file that holds the client secret, the certificate file, the file that holds its passphrase, and the environment: test or production.
  - Skatteverket's terms for the VAT return API (Allmänna villkor för Skatteverkets API Momsdeklaration, version 1.0) bind the install that signs the agreement. Section 5 asks the software to tell the user that the return is filed only once a person with the right to sign has signed it; the outcome of each call, with the meaning of each error that the API returns; that a draft can be changed in Skatteverket's e-service Lämna momsdeklaration, through Mina sidor; what the link to Skatteverket is for; and that Skatteverket keeps an audit log of the calls. So the screen and the API's answers for sending a draft carry these facts. Section 4.2 asks that personal data from Skatteverket is received in a technical environment inside the EU or the EEA.
  - With no agreement configured, the operations of 3s refuse with 422 `tax-agency-not-configured`. The VAT report and its file of 3i still work, and the company uploads the file at Skatteverket, as before.
  - Sending the VAT report, as in the established system. A booked VAT report (3i) is sent to Skatteverket's API for the VAT return as a draft (utkast). The user then signs it at Skatteverket: the answer carries the link to Skatteverket's site, where the user logs in and signs. A user who may not sign for the company passes the link on to someone who may. NortFox never signs.
  - Skatteverket checks the draft at once, and the answer carries its checks, as in the established system. Åtgärda is an error: nothing is filed, and the report is fixed and sent again. Granska accepts the draft but flags values that look unusual, and the user can sign after Godkänn avvikelser. After Åtgärda, or when the user picks Granska och justera, the draft is reset, so it can be changed and sent again.
  - Until the draft is signed, a job (3j) asks Skatteverket for its state. Once it is signed, the period counts as filed (3i), and the receipt (kvittens) is saved as a PDF file on the VAT voucher (3e). It holds what the established receipt holds: the company's name and organisation number, the VAT period, the receipt number, the date and time, who signed, the amount and the VAT voucher. Only a report sent by API gets a receipt, as in the established system.
  - Open: what happens when the user changes the draft at Skatteverket before signing, so that the signed return differs from the booked report. 3s's issue finds out what the established system does. Until then, the receipt is saved as it comes, with the amount that was signed, the VAT voucher stays as it was booked, and the user corrects the books as in 3i.
  - Reading the tax account, as in the established system. The tax account is a transaction account of the bank module (3o), on the ledger account that the user picks. The established help says it is usually 1630, and NortFox proposes 1630 as its own working default. Switching the read on starts it the next day, and the user who switched it on gets a notice under the bell once it is active (3r). A job (3j) reads the new lines from Skatteverket each day. They wait with the bank lines and are booked as 3o books those, by hand or with booking rules. The established system's ready rules for the tax account's kinds of event come with it, and the user picks which of them to switch on, and from which date. The read stops when the company withdraws its authorisation at Skatteverket.
  - The read takes only the lines that are on the account, which Skatteverket's tax account API gives as its earlier transactions. Decided taxes and fees that are not yet on the account, which it gives as its coming transactions, are not lines. A line carries no id, only its date, its interest date, its text and its amounts in whole kronor. So the read matches the lines of each date as a multiset, and two equal lines on one day are two lines.
  - The tax account's balance shows on the Startsida's Konton card (3r), as in the established system.
  - Proposing tax payments from the tax account, as the established system does, is out of scope for 3s.
  - Each of these is an operation in the registry, with its MCP tool. The established API has no operation for the VAT report or the tax account, so 3s has no compatible endpoint.
  - Open, for 3s's issue: whether Skatteverket gives a production agreement to an install's operator that does not sell software, such as a company that runs NortFox for itself or an accounting firm that runs it for its clients. Skatteverket's page names software companies, authorities and organisations. Its terms call the party that connects the software company (programvaruföretaget), and section 4.1 asks it to be in a company register, or to be a sole trader, to be registered for VAT, approved for F-skatt, and free of debts for Swedish taxes at Kronofogden. Until the issue knows, each install applies for its own agreement, and without one the operations refuse.
  - Open: which authorisations the company gives at Skatteverket, and to whom. In the established system, the company gives two ombud authorisations to the company behind the established system: "Momsdeklaration, ombud", which the firmatecknare approves and signs, and "Skattekonto, bara läsbehörighet", which is free and works from the next day. Skatteverket's APIs also take a login with e-legitimation, or an organisation certificate alone. 3s's issue finds out what an install needs. Until then, the company gives the same two authorisations to the organisation that holds the install's agreement, and the screen links to Skatteverket's page where they are given.
  - Open: how the test against Skatteverket's test service gets its keys. Skatteverket sends test keys after a request, so they cannot be fetched at run time, as 2f fetches BankID's test certificate. Until 3s's issue settles it, the owner requests them and keeps them in a secret of an environment that only that test's workflow can use.
- **Done when:**
  - One contract test suite for the Skatteverket client runs against a local stand-in for Skatteverket's VAT return and tax account APIs. The stand-in asks for the API keys and a client certificate.
  - With no agreement configured, every operation of 3s refuses with 422 `tax-agency-not-configured`, and the VAT report and its file of 3i work as before. A test checks both.
  - Against the stand-in, sending a booked report gives a draft and the link to sign it, and no operation signs. Sending it twice with the same idempotency key gives one draft. An Åtgärda answer files nothing, and the fixed report can be sent again. A Granska answer allows signing only after Godkänn avvikelser. Granska och justera resets the draft.
  - The screen and the API's answers for sending a draft carry the facts that section 5 of Skatteverket's terms asks for, and a test checks each.
  - Once the stand-in marks the draft signed, the period counts as filed, and the receipt is a file on the VAT voucher, with each field above.
  - Against the stand-in, the daily read brings each line that is on the tax account in once, and no coming transaction. A second read on the same day adds nothing, and two equal lines on one day come in as two. The lines are booked as the bank lines of 3o are. When the stand-in answers with code 6, Auktorisation saknas, and HTTP 403, the read stops and says why.
  - Once the stand-in has the read active, the user who switched it on gets a notice under the bell, and the tax account's balance shows on the Konton card.
  - Against Skatteverket's test service, with its test keys and a test organisation certificate, a draft is sent and its state read, and a tax account is read. This test reaches an outside service. So, as in 2f, it runs in a workflow of its own, on a schedule and on demand, and neither CI OK nor any other required check needs it. `pnpm test` leaves the test out by its configuration, not by a skip. Without its keys, the test fails. It never skips.
  - The server starts with Skatteverket's test service only when its configuration also marks the install as a test install, as in 2f, so an install with real books never sends its return to the test service. A test shows the refusal. This is a working default that the owner may change.
  - `deploy/README.md` says how an install gets its agreement, its keys and its certificate, and which authorisations the company gives at Skatteverket. It names what section 4.1 of Skatteverket's terms asks of the party that signs, and that section 4.2 asks for personal data from Skatteverket to be received inside the EU or the EEA.
  - The client secret, the certificate's private key, its passphrase and Skatteverket's tokens never appear in a log, in an answer or in clear in a table. Skatteverket's checks of a draft reach the user in full, as in the established system. Every other error from Skatteverket reaches the user, on the screen and in the API's answer, with its meaning as Skatteverket's service description gives it for its code, as section 5 of the VAT return terms asks. A log holds only its code and its HTTP status. A test covers each error code of the stand-in.

### Step 4: the rest of the platform

4a to 4d must be finished before NortFox keeps real books.

**4a. nortfox doctor**

- **What:** a command, and an admin API operation, that checks an install: migrations up to date; FORCE RLS, policies and triggers on every table; no extra rights for the app role; every series gap-free or with recorded void ranges, and no voucher numbered inside a void range; every voucher balanced in its rows that are not struck; file hashes; the age of the last backup and the last restore drill; the archive lag, which fails when WAL older than twice `archive_timeout` has not reached both backup repositories; free disk space.
- **Done when:** each check has a test that breaks it on purpose and sees the doctor report it; the command exits non-zero when any check fails.

**4b. Restore drill**

- **What:** the restore tool and a scheduled drill. PostgreSQL archives the WAL in whole segments, so the archive can lag the last commit; `archive_timeout` is 60 seconds to keep that lag short. Before a restore, the tool finds the highest number issued in each series. With the live database still there, it reads that number there. Without it, it replays the archive to its end and adds a margin (1000 by default, and the operator can raise it), because numbers issued after the last archived segment are gone with the disk. After the restore, each series continues above that number. The tool, as the owner role, records the skipped numbers as a void range, with the reason. The drill restores the latest backup into a scratch database, runs the doctor on it, and records the time and the result.
- **Done when:**
  - A test restores to an earlier point, with the live database there, and shows the next voucher gets a number above every number issued before.
  - A test restores without the live database, after bookings that never reached the archive, and shows each series continues above the archive's highest number plus the margin, with a void range for the skipped numbers.
  - After a restore that records a void range, deleting the highest restored voucher of that series is refused, because the void range above it counts as used numbers ([decision 2](decisions/0002-ledger-law-in-postgresql.md)). The next voucher booked in that series still gets a number above the void range.
  - The drill's last result shows in the doctor.

**4c. Archive**

- **What:** export a company's full räkenskapsinformation for a range of years: SIE4, vouchers with their files, the record of deleted vouchers, the behandlingshistorik, the reports, and the version of the system documentation. Open formats, with a checksum list. A background job (3j) makes the archive. When it is done, the user who started it gets a notice under the bell with its link (3r), as the established system gives for its file export.
- **Done when:** the archive can be read without NortFox; the database refuses to delete a company's books before the seven years have passed; the user who started an archive gets a notice with its link when it is done.

**4d. System documentation**

- **What:** the systemdokumentation in `docs/system`: what the system is made of, how data flows, the controls in the database, how the behandlingshistorik and the backups work, and a template for the company's own routines. The lists of operations, tables, triggers and checks are generated from the code.
- **Done when:** CI fails when a generated list is out of date; each release carries its version of the documentation.

**4e. Webhooks**

- **What:** subscribe to events per company, on top of the outbox. Signed deliveries, retries with backoff, a delivery log, replay through the API.
- **Done when:** a receiver can verify each signature; a failed delivery is retried and logged; a webhook address that points into the server's own network is refused.

**4f. Import adapters**

- **What:** the second part of the import module: an adapter reads another system's API, maps the data to NortFox shapes, shows a dry-run report, then imports. Each adapter lives in its own folder, named by a neutral id, with its own tests and sample data. The import operations are generic: they take an adapter id. The server reads an adapter's display name and texts from its folder at runtime and serves them through the API. An imported voucher keeps the kind it had in the system it came from, manual or made by a module, for Ändringsverifikation and Kopiera (3d). The sample data is hand-written from the other system's public API documentation, with made-up companies, people and numbers; it is never recorded from a real account. The first adapter's folder is one of the two folders on the marker allowlist ([decision 11](decisions/0011-names-policy.md)). As in 2e, it comes in two PRs: first a PR that adds only the folder's line to the allowlist, with the file's header brought up to date, then, after it merges, 4f's PR with the folder and its marker. The PR title, body, branch name, commits and changeset of both use neutral words.
- **Done when:** a dry run changes nothing; running an import twice imports nothing twice; the first adapter passes on its sample data; an imported voucher that a module made in the source gets neither Ändringsverifikation nor Kopiera, and an imported manual one gets both; after the adapter lands, the names check passes on everything outside the adapter's folder, including `openapi.json`, the client, `packages/i18n`, `docs/system` and the changesets.

**4g. Style builder**

- **What:** company admins build their own theme from values: start from a preset, change colours, radius, fonts and the menu; live preview; export and import as JSON.
- **Done when:** no field accepts raw CSS, and a test that sends CSS is refused; the API refuses a theme that fails contrast; a theme made in the builder can also be set through the API and MCP.

**4h. PWA**

- **What:** the web app can be installed on phone and desktop. The app frame works offline. Receipts can be photographed offline and are uploaded when the device is back online.
- **Done when:** the app installs and opens offline; an offline upload arrives once, not twice; booking always needs the server, because the database gives the numbers.

**4i. AI assistant**

- **What:** an assistant that reads and acts only through the API operations, with the user's own rights, and only through the operations whose registry entry opens them to it. An operation is closed to it unless it says otherwise. Approvals, payments, supplier payment details, tokens, memberships, webhooks and settings stay closed. It proposes vouchers; a person books them. The admin chooses the model provider; the assistant is off until turned on.
- **Done when:**
  - The assistant cannot do anything the user cannot, and cannot call a closed operation.
  - An uploaded invoice that carries instructions for the assistant cannot make it call a closed operation, and a test proves it.
  - Every action it takes is marked as the assistant's in the behandlingshistorik.
  - With the assistant off, no data leaves the install.

## 6. How a slice is built

- **One issue per slice.** Each slice gets one GitHub issue, shortly before it is built. The issues of the next plan step may be written while the current step is built, but never more than one step ahead, and never the whole plan at once. That timing is a default that the owner may change. The issue starts with the slice's terms: for each, what the law means by it, the word on the screen, and its name in the API and the code ([section 2](#names)). Then come the behaviour, the API, what the law requires, the done-when lines and what is out of scope.
- **One slice, one PR.** Each PR has its own branch. Merges are squash only, and the history stays linear. The PR title and body become the commit on `main`.
- **Everything in the same PR:** the migration, the engine logic, the contract operations, the server module, the compatible endpoint where the established API has one, from slice 2e on ([decision 12](decisions/0012-compatible-api.md)), the screens, the docs that change, and a changeset for what users will notice.
- **Tests first.** Each done-when line becomes a test before the code it tests is written, and each test is seen to fail for the right reason. Then the code is built until the tests pass.
- **Tests in the same PR:** unit tests for the engine (100% coverage), property tests for every invariant, server tests against real PostgreSQL as the app role, a test that drives the new operations through MCP, and tests that pin each compatible endpoint's shape.
- **Review until a round finds no major problem.** The owner's review agent reviews each PR from the owner's account in rounds. The PR fixes the major problems that a round finds, and a new round checks again. The PR may merge once a round finds no major problem. A minor problem found after that becomes an issue, fixed in its own small PR.
- **Made-up test data.** Fixtures use fictional companies and people, and the test identity and organisation numbers on the fixture guard's list. Nothing is recorded from a real account. A file made by another program has its program record and its metadata rewritten. A file from a third party, such as the BAS data, carries a note with its source and its terms.
- **No quiet loosening.** A PR does not lower a coverage floor or switch off a lint rule. Workflows keep the rules from step 1.
- **The MIT client is published** only through npm trusted publishing, from an environment that only `main` can use. No long-lived publish token exists.

### The required checks

- **CI OK:** the aggregator job of the CI workflow. It passes only when every CI job passed. A failed, cancelled or skipped job fails it.
- **Names:** from the approval workflow. It fails when the names check finds a protected name in the PR. On a PR from another account, it also fails until the owner's account has approved the head commit and started a run ([the names check](#the-names-check)).
- **Owner OK:** from the approval workflow. It fails when Names fails. Otherwise it passes when the PR changes no owner path, or when the owner has set the owner-ok label on the PR's current head commit. The list of owner paths is empty, so no PR needs the label. It still fails a PR whose changed files GitHub cannot list in full, which it can for at most 3000 files ([owner paths](#owner-paths)).
- **Outside approval:** from the approval workflow. It passes when the PR comes from the owner's account: the owner opened it, from a branch in this repository or in the owner's own fork. A PR that the owner opens from a branch in another account's fork counts as from that account, because that account can push to the branch. For any other PR, it passes only after the owner's account approves the PR's current head commit: the owner on a PR from an outside contributor, and the review agent on a PR that Dependabot opened from a branch in this repository. A review starts no run, so after the review the PR's approval checks run again ([where the checks come from](#where-the-checks-come-from)).
- **Review OK:** a commit status that the owner's review agent posts when it has reviewed the PR's head commit and passes it. The agents that build slices never post it.

### Where the checks come from

NortFox uses no GitHub App and no bot account. Agents work as the owner's own GitHub account.

- "CI OK" is a job of the CI workflow.
- "Names", "Owner OK" and "Outside approval" are jobs of the approval workflow. It runs on `pull_request_target` only, so GitHub runs the workflow file from `main`, never the PR's copy. The workflow never checks out, installs or runs the PR's code. Names fetches the PR's head commit by its SHA into a checkout of `main`, and reads the PR's files, paths and commits from it with git, as data. The title, body, labels and reviews, and the account that opened the PR, come through the API, as data, with the run's own `GITHUB_TOKEN`.
- "Review OK" is a commit status that the owner's review agent posts. The review agent approves the PRs that agents open from the owner's account, which GitHub does not let the same account approve. On a PR that Dependabot opened from a branch in this repository, it also approves the head commit from the owner's account, for Outside approval.

Each approval check judges one head commit: the one named by the event that started its run. It fails when the PR's head is another commit, so a verdict lands only on the commit it judged. Names and Owner OK read the PR again at the end, and give no result when it changed while they read it. The run for that change judges the PR again.

A review starts no run, so the owner starts one after reviewing a PR from an outside contributor. After approving it, the owner re-runs the failed jobs of the PR's latest approval run. After asking for changes or dismissing a review, the owner re-runs all of that run's jobs, so that a pass that no longer holds turns red. Only then do Outside approval and Names see the review. The run must be the latest one, because a re-run judges the head commit of the event that started it.

A PR that Dependabot opened is from another account too, but a re-run does not work there. A re-run keeps the rights of the account that started the first run, and GitHub gives a run that Dependabot started no secrets. So Names has no list, fails, and says why. On such a PR, when Dependabot opened it from a branch in this repository, an agent starts a new run from the owner's account instead, after the review agent has approved its head commit: it adds a label other than owner-ok and removes it again. On any other PR that Dependabot opened, the owner does this, as for an outside contributor.

Branch protection accepts a required check with the right name from any source, until the check is pinned to one. After the bootstrap (step 1), the owner may pin "CI OK", "Names", "Owner OK" and "Outside approval" to GitHub Actions. "Review OK" stays open to any source.

A pin to GitHub Actions shuts out commit statuses and checks from any other source. It does not stop a PR from adding its own workflow job with a required check's name, or from changing `ci.yml`: those jobs run in GitHub Actions too. So a passing check alone proves nothing about a PR that someone else wrote. The real gate is the merge rule:

- A PR from an outside contributor is merged only by the owner, by hand, after reading its whole diff. An outside contributor is any account other than the owner's and Dependabot's. A PR that the owner opened from a branch in another account's fork counts as that account's, and so does a PR that Dependabot opened from anywhere but a branch in this repository. Just before the merge, the owner runs the PR's approval checks again, because the author can change the name on their account at any time, and that starts no run. That is all the jobs of the PR's latest approval run, or, on a PR that Dependabot opened, a new run from the owner's account.
- Agents never merge such a PR, never approve it and never start its approval runs. The owner's own local setup stops them from merging it.
- A PR that Dependabot opened from a branch in this repository is merged by an agent. The owner's review agent reads its whole diff, workflows included. When it passes the PR, it approves the head commit and posts "Review OK". An agent then starts a new approval run by adding a label other than owner-ok and removing it again, and squash-merges the PR when all five checks pass on that head commit. The agent writes the squash commit's message itself, in the merge: Dependabot's title and the PR number as the subject, and an empty body. Dependabot's body holds release notes from other projects, with their issue numbers and their authors' accounts, and a squash merge would copy it into `main`. The `names-main` job in `ci.yml` checks that message after the merge. When the review does not pass the PR, nobody merges it. Branch protection merges a PR only when it is up to date with `main`, and Dependabot brings its PR up to date by itself only when it has a conflict. So when the PR is behind `main`, the agent comments `@dependabot rebase` on it, and does nothing else to it. A comment starts no approval run and no CI run. Dependabot then pushes a new commit, and the review starts again. The agent never pushes to the PR's branch, and never uses Update branch, which is a push too.
- A PR from the owner's account, which is how agents open theirs, is approved by the owner's review agent. It reads the whole diff, workflows included, before it posts "Review OK".

### Owner paths

Only the files a PR changes decide whether it needs the owner-ok label. When it does, the owner-ok label on the PR, set on its head commit, is the only label that counts: other labels, and labels on a linked issue, play no part. The list of owner paths is `.github/owner-paths.txt`. The workflow reads it from `main`, so a PR cannot change it for itself.

The list is empty: the file holds only comments. Of all PRs, only those from outside contributors need the owner, and each of them needs the owner's approving review anyway (Outside approval). Everything else is read by the owner's review agent: the licences, the exceptions to the names rule, which are the markers and the marker allowlist, and the database migrations, where the ledger law lives. The tests guard the ledger rules. With no owner path, no PR needs the owner-ok label. Owner OK still reads the files a PR changes, and fails when GitHub cannot list them all (at most 3000), so that it holds again once a path is back on the list.

The owner-ok label and its check stay, so the owner can put paths on the list again. A list that is not empty also names itself, so that a PR that shortens it for later PRs needs the owner too. CODEOWNERS mirrors the list, so it gives no path to anyone now. A test pins the list, and a test checks that CODEOWNERS matches it.

The owner-ok label counts only for the head commit it was set on. A push after the label removes it. A PR that changes an owner path then fails Owner OK until the owner sets the label again.

Agents work as the owner's GitHub account, so GitHub cannot tell a label that an agent sets from one the owner sets. A local hook stops agents from setting owner-ok, and that hook is part of this gate.

### The names check

The repository never contains a name on the owner's list of protected names ([decision 11](decisions/0011-names-policy.md)). The names check enforces it.

- The list is a repository secret, or a secret of an environment that only `main` can use. It is never in the repository, not even as hashes, because the hash of a short name is reversed in moments. Locally, the same check reads the list from a file outside the repository.
- The check runs in the approval workflow as "Names", over the PR's files, file and folder names, commits (each message, author and committer), branch name, title and body, the commit message that the squash merge will write, and the author it will give that commit. That author is the account that opened the PR: its profile name, or its login, and its noreply or public e-mail address. A private address is not in the API, so the check cannot read it. A second job checks issue titles, bodies and comments when they change, and tells the owner.
- A missing secret fails the check. It never skips.
- On a PR from the owner's account, it prints only where a match is (the file and line, or the field), never the match itself, because the logs are public.
- A PR from any other account is read with the list only in a run that the owner's account starts, while the PR is open, and after the owner's account has approved its head commit. The check then prints only how many matches it found, never where. A place would let anyone open a PR with one guess per line and read from the public log which guesses are on the list. A run that the author's own push or edit starts fails Names, which then waits for a run from the owner's account. Agents work as the owner's account, so GitHub counts every run they start as the owner's. So on a PR from an outside contributor they start none. Each of these starts one: a push to its branch, an edit of its title, body or base, marking it ready for review, adding or removing a label of any kind, reopening it, and a re-run ([AGENTS.md](../AGENTS.md)). On a PR that Dependabot opened from a branch in this repository, an agent starts one only after the review agent has approved its head commit ([where the checks come from](#where-the-checks-come-from)).
- The second job treats an issue or a comment from any other account the same way: it reads the text with the list only in a run that the owner starts, and prints only a count.
- The run that an agent starts on a Dependabot PR is an accepted risk. The PR's title, body and commit messages hold release notes, changelog lines and commit titles from other projects, and anyone who got a change merged in one of NortFox's dependencies may have written some of that text. No one who knows the list reads it first: the review agent does not know the list, so its reading would not help. So the count in the public log can answer a guess hidden in that text. The risk is accepted because such a guess costs a change merged in a dependency, Dependabot opens such a PR about once a week per ecosystem, and none of that text but the title reaches `main`.
- Before it compares, it folds each text: Unicode NFKC; it strips combining marks (`\p{M}`) and format characters (`\p{Cf}`); it maps Unicode confusables, letters and symbols alike, to the letters they look like; it reads the digits 0, 1, 3, 4, 5 and 7, and `$`, as letters; it drops separators; and it decodes base64, percent-encoding and the character references of the HTML standard. A look-alike symbol is read both as its letters and as a separator. An encoding wrapped across lines is put back together before it is decoded.
- It reads each file by its type: text as UTF-8, and also as CP437 and Latin-1; PDF files with their streams inflated, and their Info and XMP metadata; EXIF data and PNG text chunks; the members of a zip file. A file type it cannot read is refused until the check learns to read it.
- It reads each path from the bytes git stores for it, which need not be UTF-8: in the same three ways, and as the name Git for Windows writes to disk. When any of these readings holds a match, the report names the file by its position, never by its path.
- Dropping separators makes ordinary words match across a space. Such a text is reworded. The check keeps no allowlist of false positives: the only exceptions to the names rule are the markers and the marker allowlist.
- A digest is data, so the check reads it the way it reads base64: it decodes it and searches what it decodes to. In `pnpm-lock.yaml`, the value of pnpm's own integrity key at the start of a line, at the exact length of its algorithm, is read only that way, because so many random letters spell a short word by chance. Anywhere else, also on a comment line or later on the same line, a run shaped like a digest is read as letters too.
- A `.protected-name-ok` marker counts only in a folder on the marker allowlist, `.github/protected-name-allowlist.txt`. The allowlist holds at most two folders: the import adapter's (slice 4f) and the compatible API adapter's (slice 2e, [decision 12](decisions/0012-compatible-api.md)). It is empty until the first folder's line is added. A marker anywhere else fails the check.
- A marker exempts only the established system's name. The list itself marks which of its names a marker exempts, so the repository still holds no name. Inside a folder with a marker, the check still refuses every other name on the list, in file contents and in the names of files and folders. The check learns this in a PR of its own, before the first folder's line is added to the allowlist ([slice 2e](#step-2-the-foundation)).
- The check reads the allowlist from `main`, so each folder comes in two PRs, in this order. First, a PR adds only the folder's line to the allowlist, with the file's header brought up to date, and with no marker and no text that names the established system. After it merges, the PR that adds the folder, its marker and its content follows. In one PR, the new marker would fail the check.
- Its tests inject fake words. The real names never appear in a test.

## 7. The legal frame

NortFox is built to meet Bokföringslagen (1999:1078) and Bokföringsnämndens general advice BFNAR 2013:2 on bokföring. In short:

- Every business event is booked from a voucher (verifikation).
- Bookings are kept in date order (grundbok) and by account (huvudbok).
- An entry may stay preliminary, and be changed or deleted, until the company locks its period for everyone. The company must lock it within the booking deadlines (BFL 5 kap. 2 §, BFNAR 2013:2 kapitel 2 and 3). Once locked, the entry is bokförd and final: it is never removed or changed, only corrected by a new entry that shows when the correction was made and by whom.
- The system keeps a behandlingshistorik of how the data was processed, and a systemdokumentation that describes how the system works.
- All räkenskapsinformation is kept, readable, until the end of the seventh year after the calendar year in which the fiscal year ended.

NortFox gives a company the tools for this. The company stays responsible for its own books.

## 8. Decision records

1. [TypeScript 7 on Node 24, with pnpm and Turborepo](decisions/0001-typescript-7-node-24-pnpm-turborepo.md)
2. [The ledger law lives in PostgreSQL](decisions/0002-ledger-law-in-postgresql.md)
3. [Contract-first REST and MCP from one registry](decisions/0003-contract-first-rest-and-mcp.md)
4. [Licences](decisions/0004-licences.md)
5. [Money](decisions/0005-money.md)
6. [One web app that is also the PWA](decisions/0006-web-app-pwa-and-theming.md)
7. [Self-hosting and backups](decisions/0007-self-hosting-and-backups.md)
8. [Authentication](decisions/0008-authentication.md)
9. [Company isolation and database roles](decisions/0009-company-isolation-and-database-roles.md)
10. [Quality gates](decisions/0010-quality-gates.md)
11. [Names policy](decisions/0011-names-policy.md)
12. [The compatible API](decisions/0012-compatible-api.md)
