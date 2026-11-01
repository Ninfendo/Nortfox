# The NortFox plan

Status: roadmap, 2026-11-01. The plan changes as the work teaches us. Choices that are hard to undo are written down as [decision records](decisions/).

## 1. What NortFox is

NortFox is an open-source accounting system for Swedish companies. It keeps the books (Bokföring) the way Swedish law asks: BAS accounts, vouchers, VAT, SIE files, and the reports a company and its accountant need.

It runs on one small server that the company, or its accountant, controls. Every feature works through the API and through MCP, so a program or an AI agent can do what a person can do on a screen.

## 2. Principles

- **Everything through the API.** Every feature is an API operation first. MCP offers the same operations. The web app is one client of the API. A screen is never the only way in.
- **The law lives in the database.** PostgreSQL itself refuses a change to a booked voucher, a gap in a voucher series that is not a recorded void range, and a voucher where debit and credit differ. Triggers write the behandlingshistorik. Each company sees only its own rows.
- **Money is exact.** Inside, an amount is whole öre in a `bigint`. On the wire, it is a decimal string with a currency code. Never a JavaScript number.
- **Contract first.** Each operation is defined once, with its data shapes. The REST paths, the committed `openapi.json`, the generated client and the MCP tools all come from that one list.
- **Self-hosted.** One Docker Compose file. Point-in-time backups from day one. A restore skips voucher numbers, as a recorded void range, rather than give one out twice.
- **Swedish first.** Bokföringslagen, BAS, SIE and the VAT report are built in. The screens are in Swedish and English.
- **Strict from the first commit.** Strict types, zero lint warnings, real coverage floors, property tests for the rules, tests against real PostgreSQL. Every guard is proven to fail.
- **Free software.** AGPL-3.0 for NortFox. MIT for the API client and the API description, so any program can use them.

## 3. Structure

```
apps/
  server/          Hono on Node, one process: the API under /v1, MCP under /mcp, background jobs
  web/             the React web app, which is also the PWA
packages/
  engine/          pure accounting logic: checks, VAT, SIE, accruals, bank rules. No I/O.
  contract/        the operation list and the data shapes
  client/          the generated API client (MIT)
  ui/              components on Base UI and shadcn, the theme switcher, the style builder
  i18n/            Swedish and English texts; date, number and money formats
openapi/           the committed openapi.json (MIT)
db/
  migrations/      plain SQL, applied in order, never edited after merge
reference-data/    BAS chart, VAT codes and boxes, SRU codes, holidays. One version per year.
tools/             the repository's own checks: the names check, the fixture guard and the other guards
deploy/            Docker Compose, a PostgreSQL image with pgBackRest, Caddy
docs/              this plan, the decision records, the system documentation
AGENTS.md          the rules for every change, by a person or an AI agent
```

`openapi/` is its own folder so that the MIT licence file sits next to the one file it covers.

Who may import whom (checked in CI):

- `engine` imports nothing from the repository. It does no I/O; the time and the reference data are passed in.
- `i18n` imports nothing from the repository. It formats plain values: an amount as a `bigint` with its currency code, a date, a number.
- `contract` may import `engine`.
- `server` may import `engine`, `contract` and `i18n`. It needs `i18n` for what it writes in Swedish or English: PDF reports, the archive, invitations and the texts in problem details. Only `server` talks to the database.
- `ui` may import `i18n` and `engine`. It never calls the server; `web` passes the data in.
- `web` may import `client`, `ui`, `i18n` and `engine`. Never `server` or `contract`.
- `client` is generated from `openapi.json` and imports nothing from the repository.
- `tools` may import `engine` and `contract`. Nothing imports `tools`.

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
| files | Attachments (underlag), stored with a hash. A file on a booked voucher cannot be removed. |
| status | Health checks and `nortfox doctor`, which checks that an install is sound. |
| import | Bring a company's books in: from a SIE4 file, or from another system's API through an import adapter. Each adapter lives in its own folder, under a neutral id ([decision 11](decisions/0011-names-policy.md)). |
| assistant | An AI assistant that works only through the API, with the user's own rights, and only through the operations that are open to it. |

### Bokföring

| Module | What it does |
| --- | --- |
| accounts | The kontoplan, from the BAS chart. |
| fiscal-years | Räkenskapsår, their periods, and locked periods. Opening balances. |
| voucher-series | Verifikationsserier, with gap-free numbers per fiscal year. A series skips numbers only through a void range that a restore records. |
| vouchers | Book and correct vouchers. A booked voucher is never edited. |
| dimensions | Cost centres (kostnadsställen) and projects. |
| currencies | Currencies and exchange rates. |
| budget | Budgets per account and period. |
| accruals | Periodisering: spread an amount over several periods. |
| cash-register | Dagskassa: book a day's sales from a cash register report. |
| vat | The VAT report (momsdeklaration) and the EU sales list (periodisk sammanställning). |
| reports | Grundbok, huvudbok, saldobalans, balansrapport, resultatrapport and more. |
| sie | SIE 4 import and export. |
| bank | Bank statement files, booking rules, reconciliation. |
| supplier-invoices | Leverantörsfakturor, with approval flows (attest). |
| payments | Payment files. |

Not in this plan: customer invoices, payroll, the annual report. They come after the books work.

## 5. Build order

Each slice is one PR. "Done when" says what must be true before the slice is finished. Every slice also meets the rules in [section 6](#6-how-a-slice-is-built).

### Step 1: the frame

This is the repository setup. It lands before every other PR: until it does, nothing can report the four required checks, so no PR can merge.

- **What:**
  - a pnpm workspace with Turborepo; TypeScript 7 in strict mode; ESLint with zero warnings; the import rules from section 3; Vitest with v8 coverage floors and fast-check; Changesets; a hello server that answers `GET /v1/status`, and a hello web page;
  - the CI workflow and its aggregator job "CI OK";
  - the approval workflow that gives "Outside approval" and "Owner OK", the owner path list, the names check and the fixture guard, all as [section 6](#6-how-a-slice-is-built) describes.
- **Done when:**
  - A PR runs every check, and each guard has a test that shows it fails on a bad input.
  - zizmor and actionlint run in CI and find nothing. Every workflow starts with `permissions: {}` and grants a write scope only to the job that needs it. Every action is pinned to a full commit SHA. No `${{ github.event.* }}` or `github.head_ref` appears inside `run:`; such values pass through `env`. Checkout uses `persist-credentials: false`. No `pull_request` job needs a secret, so a PR from a fork runs every CI job. No required workflow has a paths filter.
  - "CI OK" runs with `if: always()` and fails when a job it needs failed, was cancelled or was skipped. A test feeds it each case.
  - CI installs with `pnpm install --frozen-lockfile`. Only the dependencies on an allowlist may run install scripts, and a new version of a dependency is installed only after a minimum age. `TURBO_TELEMETRY_DISABLED=1` is set. No remote cache exists that a PR run can write.
  - The names check fails on the fake words that its tests inject, in each form it folds, and in a file name, a commit message and a PR title. A `.protected-name-ok` marker outside the marker allowlist fails it too. A missing secret fails it. It prints only where a match is.
  - The fixture guard refuses a real-looking personal identity number, e-mail address or organisation number that is not on its short list of test values.
  - After the owner steps below, a test PR shows two things: a job or commit status that the PR adds with the name of a required check does not satisfy that check; and a push after the owner-ok label turns Owner OK back to pending.
- **Owner steps** (agents cannot do these):
  - Create two GitHub Apps that the owner owns: one for the approval workflow, one for the owner's code review.
  - Put the approval App's key and the list of protected names in an environment that only `main` can use.
  - Pin each required check to its source: "CI OK" to GitHub Actions, "Outside approval" and "Owner OK" to the approval App, "Review OK" to the review App.
  - Require every action to be pinned to a full commit SHA.
  - Clear "Outside approval" and "Owner OK" by hand on the frame PR itself, because the approval workflow is not on `main` yet while that PR runs.

### Step 2: the foundation

**2a. Ledger core in PostgreSQL**

- **What:** the first SQL migrations: the database roles (owner, app, and reader roles that are each bound to one company); companies; fiscal years and periods; accounts; voucher series and their void ranges; vouchers and their rows; the behandlingshistorik. The triggers for the ledger law. FORCE RLS on every company table. The compose file with PostgreSQL and pgBackRest.
- **Done when:**
  - Tests against real PostgreSQL, run as the app role, show that the database refuses: changing or deleting a booked voucher or its rows; booking a voucher where debit and credit differ; a voucher date outside an open fiscal year or inside a locked period; reading or writing another company's rows.
  - A property test with parallel bookings and rollbacks finds no gap and no duplicate number in any series. A series can only skip numbers through a recorded void range.
  - As the app role, recording a void range is refused, and so is any change to one. Only the owner role can record one, and the trigger writes its behandlingshistorik row like any other.
  - Every insert, update and delete leaves a behandlingshistorik row with the actor and the time. The app role cannot change or delete those rows.
  - The app role cannot change the schema, disable a trigger or bypass RLS.
  - As a reader role, setting another company's id for the transaction returns none of that company's rows.
  - A guard lists every table and fails if one lacks FORCE RLS, its company policy or its audit trigger, and a test shows the guard fails.
  - The compose file starts PostgreSQL with WAL archiving to pgBackRest and a short `archive_timeout` ([decision 7](decisions/0007-self-hosting-and-backups.md)), and a point-in-time restore of a test database works.

**2b. API and MCP spine**

- **What:** the Hono server with `@hono/zod-openapi`. `packages/contract` holds the `createRoute` objects, which are the operation registry. Each operation declares its id, its path under `/v1`, its input and output shapes, its permission, its MCP tool text, and whether the AI assistant may call it (closed unless it says so). `openapi.json` is generated and committed; `packages/client` is generated from it. `/mcp` serves every operation as an MCP tool, from the same registry. Errors are problem details (RFC 9457). Writes take an idempotency key. Lists use cursor paging.
- **Done when:**
  - One real operation (read a company, on the 2a tables) works by REST, by the generated client and as an MCP tool, with the same result.
  - CI fails when `openapi.json` or the client is out of date.
  - A guard fails when an operation has no permission or no MCP tool, and a test proves it.
  - Money always travels as a decimal string with a currency code; a test shows a JSON number is refused.
  - Each request runs in one transaction that sets the company and the actor with `SET LOCAL`, so a pooled connection never carries them to the next request.

**2c. Login, roles, tokens, MCP OAuth**

- **What:** the companies, users and memberships modules; the first roles (owner, admin, bookkeeper, approver, viewer, auditor); auth with password plus TOTP, generic OIDC and a pluggable BankID provider interface; opaque session tokens in HttpOnly cookies; API tokens; an OAuth 2.1 server for MCP clients; Caddy in the compose file, in front of the server.
- **Done when:**
  - Through the API and MCP, a person can create a company, log in with password plus TOTP, and invite a second user with a role.
  - Session tokens, API tokens and OAuth tokens are random and opaque, are stored only as hashes, and can be revoked. Cookies are HttpOnly, Secure and SameSite.
  - A login through a fake BankID provider works end to end. A generic OIDC login works against a test identity provider.
  - An MCP client finds the login from `/mcp` through the protected resource metadata (RFC 9728) and the authorization server metadata (RFC 8414), logs in with authorization code and PKCE, and calls a tool with the user's rights only. Its tokens work for `/mcp` and nothing else.
  - The same MCP discovery and login work through the compose stack, with Caddy in front ([decision 8](decisions/0008-authentication.md)).
  - For every operation and every role, a test generated from the registry shows that a role without the permission is refused.
  - Logins, failed logins, and created and revoked tokens are in the behandlingshistorik.

**2d. Web frame with the theme switcher**

- **What:** `apps/web` with React 19, Vite and Tailwind v4; `packages/ui` with the first shadcn components on Base UI; `packages/i18n` with Swedish and English; login, company picker and an empty app frame with the menu; the theme switcher over the appearance values.
- **Done when:**
  - Login, company choice and logout work in the browser through the generated client only. A guard refuses any other way of calling the server.
  - The theme changes at once, without a reload, and is saved per user through the API.
  - The API refuses a theme that fails WCAG 2.2 AA contrast, not just the screen.
  - All text comes from `packages/i18n` in Swedish and English. A guard fails on a missing key.
  - The frame works at phone width and with the keyboard alone.
  - Fonts and icons are served by the install itself. The app makes no request to another site.

### Step 3: Bokföring

The ledger comes first, then what a voucher carries, then the reports and SIE so the books can be checked and moved, then the VAT report, then the modules that bring money in and out. Two platform modules come in where the first Bokföring module needs them.

**3a. accounts: the kontoplan**

- **What:** a new company gets the BAS chart for its year from `reference-data`. Users add, rename and deactivate accounts. Each account carries its VAT code and SRU code where the chart gives one.
- **Done when:** the chart can be listed, changed and exported through the API and MCP; the database refuses to delete an account that has booked rows; the source and terms of the BAS data are written next to it in `reference-data`.

**3b. fiscal-years: räkenskapsår and locked periods**

- **What:** create fiscal years and their monthly periods; lock and unlock periods; opening balances. The engine checks the year's length (normally 12 months; a first or changed year may be shorter, or at most 18 months).
- **Done when:** the database refuses a voucher dated in a locked period or outside every open year; a property test shows that a year's opening balances always equal the closing balances of the year before, also after a late booking in the old year.

**3c. voucher-series**

- **What:** series per company, a number range per series and fiscal year, a default series per kind of voucher (manual, supplier invoice, payment, bank, cash register).
- **Done when:** numbering starts again in each fiscal year; a used series cannot be deleted; a property test with parallel bookings in several series finds no gap and no duplicate.

**3d. vouchers: book and correct**

- **What:** draft, book, list and read vouchers. A draft can change; a booked voucher never. A correction is a new voucher that reverses or adjusts the old one and points to it. Booking through the API takes an idempotency key. The behandlingshistorik of a voucher is readable through the API.
- **Done when:** booking, reading and correcting work by REST, by MCP and on the screen; tests as the app role show the database refuses every change to a booked voucher; every correction shows who made it, when, and which voucher it corrects; booking the same request twice gives one voucher.

**3e. files (platform): attachments**

- **What:** upload files (PDF, images, XML), store them on disk or in object storage with a SHA-256 hash, and link them to vouchers.
- **Done when:** the database refuses to unlink or delete a file on a booked voucher; the hash is checked on every read; the size and type limits are enforced by the server.

**3f. dimensions: cost centres and projects**

- **What:** dimensions and their objects, as in SIE. A voucher row can carry one object per dimension.
- **Done when:** a row can carry a cost centre and a project; a property test shows that a report per project always equals the sum of its rows.

**3g. reports**

- **What:** grundbok (vouchers in date order), huvudbok (rows per account), saldobalans, balansrapport and resultatrapport, for any date range and per dimension. JSON through the API, plus CSV and PDF downloads.
- **Done when:** a property test shows the balansrapport always balances, with the year's result included; the reports for a fixed set of reference books match numbers worked out by hand.

**3h. sie: import and export**

- **What:** the SIE 4 format both ways, in `packages/engine`: export a fiscal year; import vouchers into an existing company; start a new company from one SIE4 file (kontoplan, opening balances, vouchers, dimensions). This is the first part of the import module.
- **Done when:** a property test shows that export followed by import gives the same books; synthetic files that cover every record type of the published SIE 4 format import, in the format's CP437 encoding; a file with an error is refused as a whole, with the line number.

**3i. vat: VAT report and EU sales list**

- **What:** VAT codes and report boxes per year from `reference-data`; the VAT report for a month, quarter or year; the file for the tax agency; the VAT settlement voucher; the EU sales list (periodisk sammanställning).
- **Done when:** the box values for the reference books match numbers worked out by hand; a period locks when its report is marked as filed; a filed report can be produced again later with the same numbers.

**3j. jobs (platform): background jobs and the outbox**

- **What:** a job queue in PostgreSQL, run by the server process; an outbox written in the same transaction as the change it reports; retries with backoff; jobs readable through the API.
- **Done when:** a job survives a server restart and runs exactly once; a test shows an outbox event exists if and only if its transaction committed.

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

### Step 4: the rest of the platform

4a to 4d must be finished before NortFox keeps real books.

**4a. nortfox doctor**

- **What:** a command, and an admin API operation, that checks an install: migrations up to date; FORCE RLS, policies and triggers on every table; no extra rights for the app role; every series gap-free or with recorded void ranges; every booked voucher balanced; file hashes; the age of the last backup and the last restore drill; the archive lag, which fails when WAL older than twice `archive_timeout` has not reached both backup repositories; free disk space.
- **Done when:** each check has a test that breaks it on purpose and sees the doctor report it; the command exits non-zero when any check fails.

**4b. Restore drill**

- **What:** the restore tool and a scheduled drill. PostgreSQL archives the WAL in whole segments, so the archive can lag the last commit; `archive_timeout` is 60 seconds to keep that lag short. Before a restore, the tool finds the highest number issued in each series. With the live database still there, it reads that number there. Without it, it replays the archive to its end and adds a margin (1000 by default, and the operator can raise it), because numbers issued after the last archived segment are gone with the disk. After the restore, each series continues above that number. The tool, as the owner role, records the skipped numbers as a void range, with the reason. The drill restores the latest backup into a scratch database, runs the doctor on it, and records the time and the result.
- **Done when:**
  - A test restores to an earlier point, with the live database there, and shows the next voucher gets a number above every number issued before.
  - A test restores without the live database, after bookings that never reached the archive, and shows each series continues above the archive's highest number plus the margin, with a void range for the skipped numbers.
  - The drill's last result shows in the doctor.

**4c. Archive**

- **What:** export a company's full räkenskapsinformation for a range of years: SIE4, vouchers with their files, the behandlingshistorik, the reports, and the version of the system documentation. Open formats, with a checksum list.
- **Done when:** the archive can be read without NortFox; the database refuses to delete a company's books before the seven years have passed.

**4d. System documentation**

- **What:** the systemdokumentation in `docs/system`: what the system is made of, how data flows, the controls in the database, how the behandlingshistorik and the backups work, and a template for the company's own routines. The lists of operations, tables, triggers and checks are generated from the code.
- **Done when:** CI fails when a generated list is out of date; each release carries its version of the documentation.

**4e. Webhooks**

- **What:** subscribe to events per company, on top of the outbox. Signed deliveries, retries with backoff, a delivery log, replay through the API.
- **Done when:** a receiver can verify each signature; a failed delivery is retried and logged; a webhook address that points into the server's own network is refused.

**4f. Import adapters**

- **What:** the second part of the import module: an adapter reads another system's API, maps the data to NortFox shapes, shows a dry-run report, then imports. Each adapter lives in its own folder, named by a neutral id, with its own tests and sample data. The import operations are generic: they take an adapter id. The server reads an adapter's display name and texts from its folder at runtime and serves them through the API. The sample data is hand-written from the other system's public API documentation, with made-up companies, people and numbers; it is never recorded from a real account. The first adapter's folder is the one on the marker allowlist ([decision 11](decisions/0011-names-policy.md)). Its PR title, body, branch name, commits and changeset use neutral words.
- **Done when:** a dry run changes nothing; running an import twice imports nothing twice; the first adapter passes on its sample data; after the adapter lands, the names check passes on everything outside the adapter's folder, including `openapi.json`, the client, `packages/i18n`, `docs/system` and the changesets.

**4g. Style builder**

- **What:** company admins build their own theme from values: start from a preset, change colours, radius, fonts and the menu; live preview; export and import as JSON.
- **Done when:** no field accepts raw CSS, and a test that sends CSS is refused; the API refuses a theme that fails contrast; a theme made in the builder can also be set through the API and MCP.

**4h. PWA**

- **What:** the web app can be installed on phone and desktop. The app frame works offline. Receipts can be photographed offline and are uploaded when the device is back online.
- **Done when:** the app installs and opens offline; an offline upload arrives once, not twice; booking always needs the server, because the database gives the numbers.

**4i. AI assistant**

- **What:** an assistant that reads and acts only through the API operations, with the user's own rights, and only through the operations whose registry entry opens them to it. An operation is closed to it unless it says otherwise. Approvals, payments, supplier payment details, tokens, memberships, webhooks and settings stay closed. It proposes drafts; a person books them. The admin chooses the model provider; the assistant is off until turned on.
- **Done when:**
  - The assistant cannot do anything the user cannot, and cannot call a closed operation.
  - An uploaded invoice that carries instructions for the assistant cannot make it call a closed operation, and a test proves it.
  - Every action it takes is marked as the assistant's in the behandlingshistorik.
  - With the assistant off, no data leaves the install.

## 6. How a slice is built

- **One slice, one PR.** Each PR has its own branch. Merges are squash only, and the history stays linear. The PR title and body become the commit on `main`.
- **Everything in the same PR:** the migration, the engine logic, the contract operations, the server module, the screens, the docs that change, and a changeset for what users will notice.
- **Tests in the same PR:** unit tests for the engine (100% coverage), property tests for every invariant, server tests against real PostgreSQL as the app role, and a test that drives the new operations through MCP.
- **Made-up test data.** Fixtures use fictional companies and people, and the test identity and organisation numbers on the fixture guard's list. Nothing is recorded from a real account. A file made by another program has its program record and its metadata rewritten. A file from a third party, such as the BAS data, carries a note with its source and its terms.
- **No quiet loosening.** A PR does not lower a coverage floor or switch off a lint rule. Workflows keep the rules from step 1.
- **The MIT client is published** only through npm trusted publishing, from an environment that only `main` can use. No long-lived publish token exists.

### The four required checks

- **CI OK:** the aggregator job of the CI workflow. It passes only when every CI job passed. A failed, cancelled or skipped job fails it.
- **Owner OK:** from the approval workflow. It fails when the names check finds a protected name. Otherwise it passes when the PR changes no owner path, or when the owner has set the owner-ok label on the PR's current head commit.
- **Outside approval:** from the approval workflow. It passes when the PR's author is the owner's account. For any other author, it passes only after the owner approves the PR's current head commit.
- **Review OK:** a commit status posted by the owner's code review. Agents never post it.

### Where the checks come from

Branch protection accepts a check with the right name from any source, until the check is pinned to one. Without a pin, a PR could add a job named like a required check and pass it. So:

- The approval workflow runs on `pull_request_target`, so GitHub runs the workflow file from `main`, never the PR's copy. The workflow never checks out or runs the PR's code. It reads the PR's files, paths, commits, title and body through the API, as data. It posts its checks on the PR's head commit with a token from the approval App, whose key sits in an environment that only `main` can use.
- The owner's code review posts "Review OK" with a token from the review App. The agents that build slices cannot read its key.
- The owner pins each check to its source (step 1). A check from any other source does not count.
- Pinning "CI OK" only shuts out other sources. A PR can still change `ci.yml`, so `.github/**` is an owner path, and the review reads the diff.

### Owner paths

Owner OK decides from the files a PR changes. Labels on the PR or on its issue play no part. The list of owner paths is a file that the workflow reads from `main`, so a PR cannot shorten it for itself. It covers at least:

- `db/migrations/**`, and the ledger checks in `packages/engine`;
- `.github/**` and `tools/**`;
- every `LICENSE` file and every `.protected-name-ok` marker;
- `AGENTS.md` and `docs/decisions/**`;
- the names check's allowlist, the marker allowlist and the fixture guard's list of test values;
- the list of owner paths itself.

The owner-ok label counts only for the head commit it was set on. A push after the label removes it, and Owner OK goes back to pending.

Agents work as the owner's GitHub account, so GitHub cannot tell a label that an agent sets from one the owner sets. A local hook stops agents from setting owner-ok, and that hook is part of this gate.

### The names check

The repository never contains a name on the owner's list of protected names ([decision 11](decisions/0011-names-policy.md)). The names check enforces it.

- The list is a secret in the environment that only `main` can use. It is never in the repository, not even as hashes, because the hash of a short name is reversed in moments. Locally, the same check reads the list from a file outside the repository.
- The check runs in the approval workflow, over the PR's files, file and folder names, commit messages, branch name, title and body. A second job checks issue titles, bodies and comments when they change, and tells the owner.
- A missing secret fails the check. It never skips.
- It prints only where a match is (the file and line, or the field), never the match itself, because the logs are public.
- Before it compares, it folds each text: Unicode NFKC; it strips combining marks (`\p{M}`) and format characters (`\p{Cf}`); it maps Unicode confusables to the letters they look like; it reads the digits 0, 1, 3, 4, 5 and 7, and `$`, as letters; it drops separators; and it decodes base64, percent-encoding and HTML entities.
- It reads each file by its type: text as UTF-8, and also as CP437 and Latin-1; PDF files with their streams inflated, and their Info and XMP metadata; EXIF data and PNG text chunks; the members of a zip file. A file type it cannot read is refused until the check learns to read it.
- Dropping separators makes ordinary words match across a space. Known false positives go on the check's allowlist, which is an owner path.
- A `.protected-name-ok` marker counts only in a folder on the marker allowlist, which holds one import adapter's folder. A marker anywhere else fails the check.
- Its tests inject fake words. The real names never appear in a test.

## 7. The legal frame

NortFox is built to meet Bokföringslagen (1999:1078) and Bokföringsnämndens general advice BFNAR 2013:2 on bokföring. In short: every business event is booked from a voucher (verifikation); bookings are kept in date order (grundbok) and by account (huvudbok); a booked entry is never removed or changed, only corrected by a new entry that shows when the correction was made and by whom; the system keeps a behandlingshistorik of how the data was processed, and a systemdokumentation that describes how the system works; and all räkenskapsinformation is kept, readable, until the end of the seventh year after the calendar year in which the fiscal year ended. NortFox gives a company the tools for this. The company stays responsible for its own books.

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
