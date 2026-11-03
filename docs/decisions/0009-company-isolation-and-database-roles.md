# 9. Company isolation and database roles

Status: accepted, 2026-11-01. Amended 2026-11-03, in slice 2a: no company table keeps planner statistics or has a partial index, a key of one column holds only random ids or ids that order the changes, no role of ours reads the locks that other backends hold, and a reader can still set its own role settings, its password and its default privileges.

## Context

One NortFox install holds many companies, for example all the clients of an accounting firm. A bug in a query must never show one company's books to another. The server should have no more rights than it needs.

## Decision

- Every table with company data has a `company_id` column, row level security that is enabled and FORCED, and a policy that matches `company_id` to the company for the transaction.
- For the app role, the company for the transaction is a setting. The server sets the company and the actor with `SET LOCAL` at the start of each transaction, so a pooled connection never carries them over.
- Tables that do not belong to one company, such as users and memberships, have their own policies, by user.
- The database roles:
  - **owner** owns the schema and runs the migrations. The server never uses it. Only the owner role records a void range in a voucher series ([decision 2](0002-ledger-law-in-postgresql.md)).
  - **app** is the server's role. It reads and writes rows, nothing more. It cannot change the schema, disable a trigger or bypass row level security.
  - **reader** roles can only read. Each reader role is bound to one company in a table that only the owner role writes, and its policies compare `company_id` with that table for `current_user`. A reader's policies never trust a setting, because any role can change a setting.
- Outside tools use the API, with a token bound to one company. A reader role is only for a tool that must read the database directly.
- No role used at runtime is a superuser or has `BYPASSRLS`.

## Consequences

- A query without a company set returns nothing. It never returns everything.
- A reader role that sets another company's id still sees only its own company.
- No company table keeps planner statistics of its values. Otherwise a reader's `EXPLAIN` would show from its row estimates the values of another company's rows. The planner then uses its default estimates, which can give a worse plan for a large report. PostgreSQL cannot hide the totals: every role sees how many rows each table holds over all the companies of the install ([db/README.md](../../db/README.md)). No company table has a partial index, whose row count every role would see too, counting the rows of every company that meet its condition.
- A reader's `EXPLAIN ANALYZE` shows real counts, of rows and of pages. So a reader's policy reads its company once for the whole query, before any row: otherwise the planner would check the reader's own conditions first, and the count would show how many of another company's rows meet them. A key of one column, such as a primary key, leaves `company_id` out. After a lookup by it, `EXPLAIN ANALYZE` counts the rows that the policy removes, so a reader learns whether another company's row holds an id, and how many such rows fall in a range of ids. So each such id is random, or only orders the changes, as the history's does, and never carries a time or a value ([db/README.md](../../db/README.md)).
- No role of ours reads `pg_locks`, the owner neither. Each company's transactions take the company's turn, an advisory lock on the hash of its id, and `pg_locks` would show that lock to every role: when each other company books or changes its locks, and, by the transaction's id, whether each change committed. PostgreSQL cannot hide the rest: every role sees in `pg_stat_activity` when the install's transactions run, with their ids, and `pg_xact_status()` tells whether each committed, over all the companies ([db/README.md](../../db/README.md)).
- A reader, like any role, can still set its own role settings and its password, which the cluster's catalog keeps, and its own default privileges, which the database's catalog keeps. PostgreSQL has no privilege to stop it. A superuser sees them and clears them, and runs `DROP OWNED BY` before it drops a reader ([db/README.md](../../db/README.md)).
- Work that spans companies, such as the doctor's checks, runs company by company.
- Tests run as the app role and as a reader role against real PostgreSQL. A guard fails if a table lacks FORCE RLS or its policy.
