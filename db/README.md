# The database

The ledger law lives here, in PostgreSQL itself ([decision 2](../docs/decisions/0002-ledger-law-in-postgresql.md)). The server's role cannot break it: the rules are constraints, triggers and row level security, and the app role cannot change them ([decision 9](../docs/decisions/0009-company-isolation-and-database-roles.md)).

This version covers the foundation (the roles, the companies, row level security, the refusals and the behandlingshistorik) and the fiscal years, their periods and the period lock. The accounts, the voucher series and the vouchers come in the next migrations.

## Files

| File | What it is |
| --- | --- |
| `roles.sql` | The cluster roles. A superuser runs it once per cluster, before the first migration. It is safe to run again: it makes what is missing and sets every attribute again. |
| `migrations/NNNN_name.sql` | Plain SQL, applied in name order by the runner, never edited once applied. |

The runner is `apps/server/src/db/migrate.ts`. The one-shot step that runs it is `apps/server/src/db/migrate-main.ts`.

## Roles

| Role | What it may do |
| --- | --- |
| `nortfox_owner` | Owns the database, the schemas, the tables and the functions. Runs the migrations. Alone records a void range. The server never uses it. |
| `nortfox_app` | The server's role. Reads and writes rows, and only the writes each table needs. It cannot change the schema, disable a trigger, bypass row level security, make a temporary table, or become another role. |
| `nortfox_reader` | A group, never a login. Each reader role is a login role that is a member of it, bound to one company in `ledger.reader_roles`. A reader only reads. |

No role here is a superuser, or may make databases or roles, replicate, or bypass row level security. Passwords are not in `roles.sql`.

A superuser makes a reader role, and the owner binds it to one company:

```sql
CREATE ROLE example_reader LOGIN;
GRANT nortfox_reader TO example_reader WITH INHERIT TRUE, SET FALSE;
-- then, as nortfox_owner, with the company and an actor set:
INSERT INTO ledger.reader_roles (company_id, role_name) VALUES ('<company id>', 'example_reader');
```

## Schemas

| Schema | What it holds |
| --- | --- |
| `ledger` | The companies and the ledger's tables, the helpers the policies call, and the refusals. |
| `audit` | The behandlingshistorik, `audit.history`. |
| `meta` | `meta.schema_migrations`, which the runner makes and writes, and `meta.protect_company_table()`, which the migrations call. |

The database itself: only the app and the reader roles may connect, besides the owner, and no one but the owner may make anything in it, temporary tables included.

## The settings the server sets

The server sets these at the start of each transaction, with `SET LOCAL` or `set_config(name, value, true)`, so a pooled connection never carries them over. An empty setting counts as unset.

| Setting | Value |
| --- | --- |
| `nortfox.company_id` | The company, a uuid. With no company set, every company table returns no rows. |
| `nortfox.actor_id` | The actor, a uuid. |
| `nortfox.actor_kind` | `user`, `system` (the internal system user) or `integration`. |

A write with no actor, or with another kind, is refused. A reader's settings are never read: a reader sees the company its role is bound to.

## Every company table

Each table with company data has:

- a `company_id` column, and a primary key of one uuid column (`companies` uses `company_id`);
- row level security, enabled and forced, so the owner is held to it too;
- three policies: the app and the owner see and write the rows of the transaction's company, and a reader sees the rows of its own company;
- the `audit_history` trigger, which writes the behandlingshistorik;
- the `refuse_truncate` trigger, because `TRUNCATE` skips the row triggers;
- `company_id` in every foreign key to another company table, because a foreign key check skips row level security;
- `SELECT` for the app and the readers, and for the app only the writes the table needs.

`meta.protect_company_table(table, key_column)` sets up all but the foreign keys and the writes. The table guard (`apps/server/src/db/table-guard.ts`) checks all of it from the catalog. The runner runs the guard inside each migration's transaction and rolls the migration back on any problem. Three tables are held to other rules, and a test pins the list:

- `meta.schema_migrations` holds no company data;
- `audit.history` has no history trigger of its own;
- `ledger.reader_roles` lets a reader see only its own binding, by its role name.

## Companies

`ledger.companies` holds the name, the organisation number and the tenant id, `database_number`. The app picks the company's uuid, sets it as the transaction's company, and inserts. The tenant id comes from one sequence for the install, from 1. A tenant id given on insert is refused, and neither the tenant id nor the company's uuid ever changes. A new company gets its row in `ledger.automatic_locks`, with the automatic lock off.

## Fiscal years and periods

`ledger.fiscal_years` holds each year's `from_date` and `to_date`, its `accounting_method` (`ACCRUAL` or `CASH`), its chart name `account_chart_type`, and `is_default`. A year has no open or closed state: a whole year is locked with the period lock.

- `year_number` is the year's integer for the compatible API: the company's highest plus one, in the order the years are made. The trigger takes it under a lock on the company's row, so two years made at once get the next two numbers. A number given on insert is refused, it never changes, and a unique key holds it per company.
- A company's years never overlap, not even by one day (an exclusion constraint).
- A company has at most one default year (a partial unique index). The default moves when the old one gives it up first.
- New dates that would leave one of the year's periods outside it are refused, with the count (`fiscal_year_strands_rows`).
- The app may insert and change years, never delete one.

`ledger.periods` holds a year's periods, each with a `from_date` and a `to_date`. A period lies inside its year (`period_outside_fiscal_year`), and two periods of one year never overlap (an exclusion constraint). The trigger locks the year's row `FOR SHARE`, so a change of the year's dates waits for a new period, and the other way round. The app may insert and change periods, never delete one.

## The period lock

A lock is a locked-through date: every date up to and including it is locked. `ledger.period_locks` holds one row per scope: one for each user (`scope = 'user'` with its `user_id`), one for the internal system user (`system`), one for integrations (`integration`) and one for all users (`all`). A NULL `end_date` is a cleared lock. The trigger writes `set_by`, `set_by_kind` and `set_at` from the transaction's actor, refuses them when they are given, and never lets a row's scope, user or id change. Each date is set and cleared on its own. The app may insert and change rows, never delete one.

`ledger.automatic_locks` holds each company's automatic lock: `enabled`, the `interval` (`month_end_50`, `quarter_end_50` or `year_end_60`, required when it is on) and `notice_days`, with who changed it and when, as above. The row comes with the company. The app may only change it.

The functions:

| Function | What it gives |
| --- | --- |
| `ledger.today_in_sweden()` | The date in Europe/Stockholm when the transaction began. No setting moves it, and the session's time zone plays no part. |
| `ledger.automatic_lock_end_date(company, today)` | The date the automatic lock reaches on `today`, or NULL when it is off. A period that ends on day E is locked from day E + 50 on (E + 60 for the fiscal year). Quarters are calendar quarters. No job has to run. |
| `ledger.applicable_locks(company, kind, actor, today)` | Every date that applies to the actor: its own row, the all-users row and the automatic lock. |
| `ledger.lock_covering(company, kind, actor, day, today)` | The lock that makes `day` locked for the actor, or no row. Of the dates that apply and reach `day`, the latest wins; on a tie, the actor's own row, then all users, then the automatic lock. |
| `ledger.locked_through(company, kind, actor, today)` | The one locked-through date for the actor, or NULL. |
| `ledger.assert_open(company, day, is_closing_series)` | Refuses the transaction's actor a date that is locked for it today, with `period_locked_manual` or `period_locked_automatic`. The closing series passes every lock. Only the triggers call it. |

The app may call the first five. Row level security keeps each one to the transaction's company. The actor's kind is `user`, `system` or `integration`, and a user needs its id; anything else is an error (`22023`), not a refusal.

## The behandlingshistorik

`audit.history` gets one row per inserted, updated or deleted row of every company table, in the same transaction: the table, the row's id, the operation (`INSERT`, `UPDATE` or `DELETE`), the whole old and new row as JSON, the actor and its kind, the transaction id and the time to the microsecond. No role changes or deletes a history row, the owner neither, and only the trigger writes one.

## The internal-write rule

Some rows may only be written by the database's own triggers, such as the history. A trigger refuses such a write when `pg_trigger_depth()` is 1, the depth of a statement that a caller sent. The app cannot reach depth 2 on its own: it can make no trigger and no function.

## Refusals

Each refusal has its own SQLSTATE in the class `NF`. The error's message is the reason, and its detail is the facts, as JSON. Amounts in the facts are strings of öre. `apps/server/src/db/refusals.ts` holds the same list and reads an error into its reason and facts, and a test fails when the two lists differ. Later slices answer each reason with the established system's message.

Migration 0001 raises `immutable_field`, `actor_missing`, `append_only` and `internal_only`. Migration 0002 raises `period_locked_manual`, `period_locked_automatic`, `period_outside_fiscal_year` and `fiscal_year_strands_rows`, and `immutable_field` for the year number, the lock rows' stamps, scope and user, and the ids. The others are listed now, so that their codes stay fixed. The migrations for accounts, series and vouchers raise them.

| Code | Reason | Facts |
| --- | --- | --- |
| NF001 | `unbalanced` | `debit`, `credit` |
| NF002 | `too_few_rows` | `count` |
| NF003 | `account_missing` | `number` |
| NF004 | `account_inactive` | `number` |
| NF005 | `series_missing` | `code` |
| NF006 | `series_not_manual` | `code` |
| NF007 | `no_fiscal_year` | `date` |
| NF008 | `date_outside_fiscal_year` | `date`, `year` |
| NF009 | `description_missing` | none |
| NF010 | `value_too_long` | `field`, `value` |
| NF011 | `period_locked_manual` | `end_date`, `source`, `user_id`, `set_by`, `set_by_kind`, `set_at` |
| NF012 | `period_locked_automatic` | `end_date`, `interval` |
| NF013 | `not_last_in_series` | `series`, `number` |
| NF014 | `reversing_voucher_exists` | `series`, `number` |
| NF015 | `reversing_other_module` | `reversed_type`, `reversing_type` |
| NF016 | `account_has_rows` | `number`, `count` |
| NF017 | `series_code_invalid` | `code` |
| NF018 | `series_code_duplicate` | `code` |
| NF019 | `series_code_changed` | `code` |
| NF020 | `immutable_field` | `field`, `operation` (`create` or `update`) |
| NF050 | `actor_missing` | `setting` |
| NF051 | `append_only` | `table`, `operation` |
| NF052 | `internal_only` | `table`, `field` |
| NF053 | `row_removal` | `voucher` |
| NF054 | `counter_move` | `series`, `from`, `to` |
| NF055 | `void_range_not_at_counter` | `first_number`, `next_number` |
| NF056 | `period_outside_fiscal_year` | `from_date`, `to_date` |
| NF057 | `fiscal_year_strands_rows` | `table`, `count` |

Where no reason is named, PostgreSQL's own error stands: a unique key, a check, a foreign key, a missing privilege (`42501`), or a row that a policy refuses (`42501`).

## Adding a migration

1. Add `migrations/NNNN_name.sql`: the next number, four digits, then lower-case words joined by underscores. Its first line is `-- SPDX-License-Identifier: AGPL-3.0-only`.
2. Write no `BEGIN`, `COMMIT` or `ROLLBACK`: the runner wraps the file in one transaction. It runs with `search_path` set to `pg_catalog, pg_temp`, so write every name of ours in full, such as `ledger.companies`.
3. Give every new company table what the list above says: call `meta.protect_company_table`, then grant the app only the writes it needs.
4. Give every function `SET search_path = pg_catalog, pg_temp`. Make a trigger function `SECURITY DEFINER`. No function is open to `PUBLIC`: grant `EXECUTE` only to the roles that call it.
5. Never edit a migration once it is on `main`. The runner refuses a database whose applied migration has changed.
6. Write the tests first, against real PostgreSQL, as the app role (below). Add each new company table to `apps/server/test/every-table.ts`, so the isolation and history tests cover it.

A migration is an owner path while `.github/owner-paths.txt` lists `db/migrations/**`.

## The tests

The database tests are `apps/server/src/**/*.db.test.ts`. They run against real PostgreSQL, as the app role unless they test another role, each test file in a copy of a migrated template database.

```sh
pnpm db:test        # starts a test cluster: PostgreSQL in Docker, on 127.0.0.1:55433, data in memory
pnpm test           # every suite, the database tests too
pnpm db:test:stop   # stops it
```

`NORTFOX_TEST_DATABASE_URL` points the tests at another cluster: a superuser on a cluster of its own, with trust authentication. Roles belong to the whole cluster, so the tests refuse a cluster that holds any database they did not make. Without a cluster, the tests fail with a line that says how to start one. They never skip.
