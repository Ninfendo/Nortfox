# The NortFox plan

Status: roadmap, 2026-11-01. The plan changes as the work teaches us. Choices that are hard to undo are written down as [decision records](decisions/).

## 1. What NortFox is

NortFox is an open-source accounting system for Swedish companies. It keeps the books (Bokföring) the way Swedish law asks: BAS accounts, vouchers, VAT, SIE files, and the reports a company and its accountant need.

It runs on one small server that the company, or its accountant, controls. Every feature works through the API and through MCP, so a program or an AI agent can do what a person can do on a screen.

## 2. Principles

- **Everything through the API.** Every feature is an API operation first. MCP offers the same operations. The web app is one client of the API. A screen is never the only way in.
- **The law lives in the database.** PostgreSQL itself refuses a change to a booked voucher, a gap in a voucher series, and a voucher where debit and credit differ. Triggers write the behandlingshistorik. Each company sees only its own rows.
- **Money is exact.** Inside, an amount is whole öre in a `bigint`. On the wire, it is a decimal string with a currency code. Never a JavaScript number.
- **Contract first.** Each operation is defined once, with its data shapes. The REST paths, the committed `openapi.json`, the generated client and the MCP tools all come from that one list.
- **Self-hosted.** One Docker Compose file. Point-in-time backups from day one. A restore never gives out a voucher number twice.
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
deploy/            Docker Compose, a PostgreSQL image with pgBackRest, Caddy
docs/              this plan, the decision records, the system documentation
```

`openapi/` is its own folder so that the MIT licence file sits next to the one file it covers.

Who may import whom (checked in CI):

- `engine` imports nothing from the repository. It does no I/O; the time and the reference data are passed in.
- `contract` may import `engine`.
- `server` may import `engine` and `contract`. Only `server` talks to the database.
- `web` may import `client`, `ui`, `i18n` and `engine`. Never `server` or `contract`.
- `client` is generated from `openapi.json` and imports nothing from the repository.

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
| import | Bring a company's books in: from a SIE4 file, or from another system's API through an import adapter. Each adapter lives in its own folder. |
| assistant | An AI assistant that works only through the API, with the user's own rights. |

### Bokföring

| Module | What it does |
| --- | --- |
| accounts | The kontoplan, from the BAS chart. |
| fiscal-years | Räkenskapsår, their periods, and locked periods. Opening balances. |
| voucher-series | Verifikationsserier, with gap-free numbers per fiscal year. |
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

This is the repository setup.

- **What:** a pnpm workspace with Turborepo; TypeScript 7 in strict mode; ESLint with zero warnings; the import rules from section 3; Vitest with v8 coverage floors and fast-check; the CI workflow and its aggregator job "CI OK"; the approval workflow that gives "Outside approval" and "Owner OK"; Changesets; a check for the names policy; a hello server that answers `GET /v1/status`, and a hello web page.
- **Done when:** a PR runs every check, and each guard has a test that shows it fails on a bad input.

### Step 2: the foundation

**2a. Ledger core in PostgreSQL**

- **What:** the first SQL migrations: the three database roles (owner, app, readonly); companies; fiscal years and periods; accounts; voucher series; vouchers and their rows; the behandlingshistorik. The triggers for the ledger law. FORCE RLS on every company table. The compose file with PostgreSQL and pgBackRest.
- **Done when:**
  - Tests against real PostgreSQL, run as the app role, show that the database refuses: changing or deleting a booked voucher or its rows; booking a voucher where debit and credit differ; a voucher date outside an open fiscal year or inside a locked period; reading or writing another company's rows.
  - A property test with parallel bookings and rollbacks finds no gap and no duplicate number in any series. A series can only skip numbers through a recorded void range.
  - Every insert, update and delete leaves a behandlingshistorik row with the actor and the time. The app role cannot change or delete those rows.
  - The app role cannot change the schema, disable a trigger or bypass RLS.
  - A guard lists every table and fails if one lacks FORCE RLS, its company policy or its audit trigger, and a test shows the guard fails.
  - The compose file starts PostgreSQL with WAL archiving to pgBackRest, and a point-in-time restore of a test database works.

**2b. API and MCP spine**

- **What:** the Hono server with `@hono/zod-openapi`. `packages/contract` holds the `createRoute` objects, which are the operation registry. Each operation declares its id, its path under `/v1`, its input and output shapes, its permission and its MCP tool text. `openapi.json` is generated and committed; `packages/client` is generated from it. `/mcp` serves every operation as an MCP tool, from the same registry. Errors are problem details (RFC 9457). Writes take an idempotency key. Lists use cursor paging.
- **Done when:**
  - One real operation (read a company, on the 2a tables) works by REST, by the generated client and as an MCP tool, with the same result.
  - CI fails when `openapi.json` or the client is out of date.
  - A guard fails when an operation has no permission or no MCP tool, and a test proves it.
  - Money always travels as a decimal string with a currency code; a test shows a JSON number is refused.
  - Each request runs in one transaction that sets the company and the actor with `SET LOCAL`, so a pooled connection never carries them to the next request.

**2c. Login, roles, tokens, MCP OAuth**

- **What:** the companies, users and memberships modules; the first roles (owner, admin, bookkeeper, approver, viewer, auditor); auth with password plus TOTP, generic OIDC and a pluggable BankID provider interface; opaque session tokens in HttpOnly cookies; API tokens; an OAuth 2.1 server for MCP clients.
- **Done when:**
  - Through the API and MCP, a person can create a company, log in with password plus TOTP, and invite a second user with a role.
  - Session tokens, API tokens and OAuth tokens are random and opaque, are stored only as hashes, and can be revoked. Cookies are HttpOnly, Secure and SameSite.
  - A login through a fake BankID provider works end to end. A generic OIDC login works against a test identity provider.
  - An MCP client finds the login from `/mcp` (protected resource metadata), logs in with authorization code and PKCE, and calls a tool with the user's rights only. Its tokens work for `/mcp` and nothing else.
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
- **Done when:** a property test shows that export followed by import gives the same books; the format's published example files import; a file with an error is refused as a whole, with the line number.

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

- **What:** a command, and an admin API operation, that checks an install: migrations up to date; FORCE RLS, policies and triggers on every table; no extra rights for the app role; every series gap-free or with recorded void ranges; every booked voucher balanced; file hashes; the age of the last backup and the last restore drill; free disk space.
- **Done when:** each check has a test that breaks it on purpose and sees the doctor report it; the command exits non-zero when any check fails.

**4b. Restore drill**

- **What:** the restore tool and a scheduled drill. Before a restore, the tool reads the highest number issued in each series, from the live database or by replaying the archive to its end. After the restore, each series continues above that number, and the skipped numbers are recorded as a void range in the behandlingshistorik. The drill restores the latest backup into a scratch database, runs the doctor on it, and records the time and the result.
- **Done when:** a test restores to an earlier point and shows the next voucher gets a number above every number issued before; the drill's last result shows in the doctor.

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

- **What:** the second part of the import module: an adapter reads another system's API, maps the data to NortFox shapes, shows a dry-run report, then imports. Each adapter lives in its own folder with its own tests and recorded sample data.
- **Done when:** a dry run changes nothing; running an import twice imports nothing twice; the first adapter passes on its recorded data.

**4g. Style builder**

- **What:** company admins build their own theme from values: start from a preset, change colours, radius, fonts and the menu; live preview; export and import as JSON.
- **Done when:** no field accepts raw CSS, and a test that sends CSS is refused; the API refuses a theme that fails contrast; a theme made in the builder can also be set through the API and MCP.

**4h. PWA**

- **What:** the web app can be installed on phone and desktop. The app frame works offline. Receipts can be photographed offline and are uploaded when the device is back online.
- **Done when:** the app installs and opens offline; an offline upload arrives once, not twice; booking always needs the server, because the database gives the numbers.

**4i. AI assistant**

- **What:** an assistant that reads and acts only through the API operations, with the user's own rights. It proposes drafts; a person books them. The admin chooses the model provider; the assistant is off until turned on.
- **Done when:** the assistant cannot do anything the user cannot; every action it takes is marked as the assistant's in the behandlingshistorik; with the assistant off, no data leaves the install.

## 6. How a slice is built

- **One slice, one PR.** Each PR has its own branch. Merges are squash only, and the history stays linear.
- **Everything in the same PR:** the migration, the engine logic, the contract operations, the server module, the screens, the docs that change, and a changeset for what users will notice.
- **Tests in the same PR:** unit tests for the engine (100% coverage), property tests for every invariant, server tests against real PostgreSQL as the app role, and a test that drives the new operations through MCP.
- **The four required checks:**
  - **CI OK:** the aggregator job; it passes only when every CI job passed.
  - **Outside approval** and **Owner OK:** from the approval workflow. A change to a ledger rule needs the owner-ok label, and only the owner sets it.
  - **Review OK:** a commit status posted by the owner's code review.
- **No quiet loosening.** A PR does not lower a coverage floor or switch off a lint rule.

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
