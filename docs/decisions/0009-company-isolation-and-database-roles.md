# 9. Company isolation and database roles

Status: accepted, 2026-11-01

## Context

One NortFox install holds many companies, for example all the clients of an accounting firm. A bug in a query must never show one company's books to another. The server should have no more rights than it needs.

## Decision

- Every table with company data has a `company_id` column, row level security that is enabled and FORCED, and a policy that matches `company_id` to the company set for the transaction.
- The server sets the company and the actor with `SET LOCAL` at the start of each transaction, so a pooled connection never carries them over.
- Tables that do not belong to one company, such as users and memberships, have their own policies, by user.
- Three database roles:
  - **owner** owns the schema and runs the migrations. The server never uses it.
  - **app** is the server's role. It reads and writes rows, nothing more. It cannot change the schema, disable a trigger or bypass row level security.
  - **readonly** can only read, under the same policies. It is for reports, checks and outside tools.
- No role used at runtime is a superuser or has `BYPASSRLS`.

## Consequences

- A query without a company set returns nothing. It never returns everything.
- Work that spans companies, such as the doctor's checks, runs company by company.
- Tests run as the app role against real PostgreSQL. A guard fails if a table lacks FORCE RLS or its policy.
