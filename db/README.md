# The database

The ledger law lives here, in PostgreSQL itself ([decision 2](../docs/decisions/0002-ledger-law-in-postgresql.md)). The server's role cannot break it: the rules are constraints, triggers and row level security, and the app role cannot change them ([decision 9](../docs/decisions/0009-company-isolation-and-database-roles.md)).

It holds the foundation (the roles, the companies, row level security, the refusals and the behandlingshistorik), the fiscal years, their periods and the period lock, the accounts, the voucher series, their counters and the void ranges, and the vouchers with their rows, the reversing link and the record of deleted vouchers. [deploy/README.md](../deploy/README.md) says how an install runs it and backs it up.

## Files

| File | What it is |
| --- | --- |
| `roles.sql` | The cluster roles. A superuser runs it once per cluster, before the first migration. It is safe to run again: it makes what is missing and sets every attribute again. |
| `database.sql` | What a superuser sets in the ledger database, once, after making it and before the first migration: it closes the functions that make a large object. A migration cannot, because those functions are the bootstrap superuser's. It is safe to run again. |
| `migrations/NNNN_name.sql` | Plain SQL, applied in name order by the runner, never edited once applied. |

The runner is `apps/server/src/db/migrate.ts`. The one-shot step that runs it is `apps/server/src/db/migrate-main.ts`.

## In an install

The compose file (`deploy/compose.yaml`) sets the database up in two steps:

1. On the first start, PostgreSQL's image runs `deploy/postgres/initdb/10-roles.sh` as the superuser. It runs `roles.sql`, sets the passwords of `nortfox_owner` and `nortfox_app` from the compose secrets, makes the database `nortfox`, owned by `nortfox_owner`, and runs `database.sql` in it. Then `20-stanza.sh` sets up the backups, and as its last step writes the file `nortfox-first-start-done` in the data folder. The service is healthy only once that file is there, so the migrate step never runs after a first start that failed ([deploy/README.md](../deploy/README.md)).
2. The migrate step runs the runner as `nortfox_owner`, once PostgreSQL is healthy, and stops. It reads the address from `NORTFOX_DATABASE_URL`, which holds no password, and the password from the file that `NORTFOX_DATABASE_PASSWORD_FILE` names. The server's image carries the migrations of its own commit, so a deploy applies exactly those.

The restore test (`pnpm backup:test`) checks both on a running stack: every migration applied by `nortfox_owner`, every schema, table, index and sequence in `ledger`, `audit` and `meta` owned by it, and no role of ours able to make a large object.

## Roles

| Role | What it may do |
| --- | --- |
| `nortfox_owner` | Owns the database, the schemas, the tables and the functions. Runs the migrations. Alone records a void range. The server never uses it. |
| `nortfox_app` | The server's role. Reads and writes rows, and only the writes each table needs. It cannot change the schema, disable a trigger, bypass row level security, make a temporary table or a large object, or become another role. |
| `nortfox_reader` | A group, never a login. Each reader role is a login role that is a member of it, bound to one company in `ledger.reader_roles`. A reader only reads. |

No role here is a superuser, or may make databases or roles, replicate, or bypass row level security. Passwords are not in `roles.sql`: an install's first start sets them from its secret files.

A superuser makes a reader role, and the owner binds it to one company:

```sql
CREATE ROLE example_reader LOGIN;
GRANT nortfox_reader TO example_reader WITH INHERIT TRUE, SET FALSE;
-- then, as nortfox_owner, with the company and an actor set:
INSERT INTO ledger.reader_roles (company_id, role_oid) VALUES ('<company id>', 'example_reader'::regrole);
```

A binding holds the role's oid, not its name, and `ledger.current_role_oid()` gives the oid of the role that reads. So a role that is dropped and made again with the same name, or another role renamed to it, is not the role that was bound: it reads nothing until the owner binds it. A role keeps its oid in a restore from pgBackRest and through `pg_upgrade`. A dump restored into another cluster gives each role a new oid, so the owner binds the readers again there.

To remove a reader, the owner deletes its binding, and then a superuser drops the role:

```sql
-- as nortfox_owner, with the company and an actor set:
DELETE FROM ledger.reader_roles WHERE role_oid = 'example_reader'::regrole;
-- then, as a superuser:
DROP ROLE example_reader;
```

## Schemas

| Schema | What it holds |
| --- | --- |
| `ledger` | The companies and the ledger's tables, the helpers the policies call, and the refusals. |
| `audit` | The behandlingshistorik, `audit.history`. |
| `meta` | `meta.schema_migrations`, which the runner makes and writes, and `meta.protect_company_table()`, which the migrations call. |

The database itself: only the app and the reader roles may connect, besides the owner, and no one but the owner may make anything in it, temporary tables included. No role of ours may make a large object, the owner neither: a large object holds bytes outside every table, its row level security and the behandlingshistorik, and its maker can grant it to any role. `database.sql` closes the three functions that make one (`lo_creat`, `lo_create` and `lo_from_bytea`). The other large object functions only read or write one that already exists.

## The settings the server sets

The server sets these at the start of each transaction, with `SET LOCAL` or `set_config(name, value, true)`, so a pooled connection never carries them over. An empty setting counts as unset.

| Setting | Value |
| --- | --- |
| `nortfox.company_id` | The company, a uuid. With no company set, every company table returns no rows. |
| `nortfox.actor_id` | The actor, a uuid. |
| `nortfox.actor_kind` | `user`, `system` (the internal system user) or `integration`. |

A write with no actor, or with another kind, is refused. A reader's settings are never read: a reader sees the company its role is bound to.

**One actor per transaction.** Any role can change a setting at any time, also in the middle of a statement. A rule that depends on the actor, such as the period lock, is checked for the actor that is set when its trigger runs, and the stamps and the behandlingshistorik record the actor that is set when theirs run. So the first time a transaction's write reads its actor, `ledger.current_actor()` keeps that actor and its kind in `ledger.transaction_actors`, and refuses a write under any other actor or kind for the rest of the transaction (`42501`), in a later statement or later in the same statement. The writes of a savepoint that rolled back keep no actor. The table holds one row per backend, for the transaction that last wrote in it, and is not ledger data: each writing transaction writes over its backend's row, and it is unlogged, so a crash, which ends every transaction, empties it. Only the owner reads and writes it. It costs each writing transaction one write to that row, and each read of the actor one lookup by its key.

## Every company table

Each table with company data has:

- a `company_id` column, and a primary key of one uuid column (`companies` uses `company_id`);
- row level security, enabled and forced, so the owner is held to it too;
- three policies: the app and the owner see and write the rows of the transaction's company, and a reader sees the rows of its own company;
- the `audit_history` trigger, which writes the behandlingshistorik;
- the `refuse_truncate` trigger, because `TRUNCATE` skips the row triggers;
- `company_id` in every foreign key to another company table, because a foreign key check skips row level security;
- `company_id` as a key column of every unique index, and compared with `=` in every exclusion constraint, because their checks skip row level security too: otherwise one company could learn from the error whether another holds a value. The primary key of one uuid column is the one key that leaves it out;
- `SELECT` for the app and the readers, and for the app only the writes the table needs.

A row never moves to another company: the history trigger refuses an update that changes `company_id` (`immutable_field`), on every company table. A statement can change the transaction's company after row level security has let the old row through, so the policies alone do not stop it.

`meta.protect_company_table(table, key_column)` sets up all but the foreign keys, the keys and the writes. The table guard (`apps/server/src/db/table-guard.ts`) checks all of it from the catalog. The runner runs the guard inside each migration's transaction and rolls the migration back on any problem. Four tables are held to other rules, and a test pins the list:

- `meta.schema_migrations` holds no company data;
- `ledger.transaction_actors` holds no company data: it keeps each writing transaction's actor (above);
- `audit.history` has no history trigger of its own;
- `ledger.reader_roles` lets a reader see only its own binding, by its role's oid.

Three unique keys leave `company_id` out, and a test pins the list too: the history's own id (an identity column that only the trigger writes), the companies' tenant id (from one sequence, never given or changed by a caller), and a reader role's oid (bound to one company, written only by the owner).

## Companies

`ledger.companies` holds the name, the organisation number and the tenant id, `database_number`. The app picks the company's uuid, sets it as the transaction's company, and inserts. The tenant id comes from one sequence for the install, from 1. A tenant id given on insert is refused, and neither the tenant id nor the company's uuid ever changes. A new company gets its row in `ledger.automatic_locks`, with the automatic lock off.

## Fiscal years and periods

`ledger.fiscal_years` holds each year's `from_date` and `to_date`, its `accounting_method` (`ACCRUAL` or `CASH`), its chart name `account_chart_type`, and `is_default`. A year has no open or closed state: a whole year is locked with the period lock.

- `year_number` is the year's integer for the compatible API: the company's highest plus one, in the order the years are made. The trigger takes it under a lock on the company's row, so two years made at once get the next two numbers. A number given on insert is refused, it never changes, and a unique key holds it per company.
- A company's years never overlap, not even by one day (an exclusion constraint).
- A company has at most one default year (a partial unique index). The default moves when the old one gives it up first.
- New dates that would leave one of the year's periods or vouchers outside it are refused, with the table and the count (`fiscal_year_strands_rows`). A booking, a change and a deletion of one of the year's vouchers lock the year's row `FOR SHARE`, so a change of the year's dates waits for them, and the other way round. The year's end is also where the automatic lock's `year_end_60` interval counts from (below).
- The app may insert and change years, never delete one.

`ledger.periods` holds a year's periods, each with a `from_date` and a `to_date`. A period lies inside its year (`period_outside_fiscal_year`), and two periods of one year never overlap (an exclusion constraint on the company, the year and the dates). The trigger locks the year's row `FOR SHARE`, so a change of the year's dates waits for a new period, and the other way round. The app may insert and change periods, never delete one.

## The period lock

A lock is a locked-through date: every date up to and including it is locked. `ledger.period_locks` holds one row per scope: one for each user (`scope = 'user'` with its `user_id`), one for the internal system user (`system`), one for integrations (`integration`) and one for all users (`all`). A NULL `end_date` is a cleared lock. The trigger writes `set_by`, `set_by_kind` and `set_at` from the transaction's actor, refuses them when they are given, and never lets a row's scope, user or id change. Each date is set and cleared on its own. The app may insert and change rows, never delete one.

`ledger.automatic_locks` holds each company's automatic lock: `enabled`, the `interval` (`month_end_50`, `quarter_end_50` or `year_end_60`, required when it is on) and `notice_days`, with who changed it and when, as above. The row comes with the company. The app may only change it.

The functions:

| Function | What it gives |
| --- | --- |
| `ledger.day_in_sweden(instant)` | The date in Europe/Stockholm at an instant, in winter time and in summer time. No setting moves it, and the session's time zone plays no part. |
| `ledger.today_in_sweden()` | The day in Sweden when the current statement began, not the transaction: `day_in_sweden(statement_timestamp())`. A transaction kept open past midnight checks its next statement against the new day's automatic lock. |
| `ledger.automatic_lock_end_date(company, today)` | The date the automatic lock reaches on `today`, or NULL when it is off. A period that ends on day E is locked from day E + 50 on (E + 60 for the fiscal year). Quarters are calendar quarters. No job has to run. |
| `ledger.applicable_locks(company, kind, actor, today)` | Every date that applies to the actor: its own row, the all-users row and the automatic lock. |
| `ledger.lock_covering(company, kind, actor, day, today)` | The lock that makes `day` locked for the actor, or no row. Of the dates that apply and reach `day`, the latest wins; on a tie, the actor's own row, then all users, then the automatic lock. |
| `ledger.locked_through(company, kind, actor, today)` | The one locked-through date for the actor, or NULL. |
| `ledger.assert_open(company, day, is_closing_series)` | Refuses the transaction's actor a date that is locked for it today, with `period_locked_manual` or `period_locked_automatic`. The closing series passes every lock. Only the triggers call it. |
| `ledger.lock_voucher_period(company, fiscal_year, series_code)` | Locks the rows that the period lock on a voucher reads, `FOR SHARE` until the transaction ends: the voucher's fiscal year, its series and the company's automatic lock row, in that order. Gives the series' closing mark, read from the locked row. Only the voucher triggers call it. |
| `ledger.assert_voucher_open(company, fiscal_year, series_code, day)` | The same as `ledger.assert_open` for a voucher: it takes those locks first (`ledger.lock_voucher_period`), and calls `ledger.assert_open` with the series' closing mark. Only the voucher triggers call it. |

The app may call the first six. Row level security keeps each one to the transaction's company. The actor's kind is `user`, `system` or `integration`, and a user needs its id; anything else is an error (`22023`), not a refusal.

A change of what a lock depends on and a change of a voucher never overlap. The lock on a voucher's date depends on the lock dates, the automatic lock's settings, the end of the voucher's fiscal year (the `year_end_60` interval counts from it) and the closing mark of its series. A booking, a change and a deletion of a voucher, and a new row, each lock, `FOR SHARE` until the transaction ends, the voucher's fiscal year, then its series, then the company's row in `ledger.automatic_locks` (`ledger.lock_voucher_period`), and only then read them. A change of the year's dates or of the closing mark locks that row for update, and every change of a lock date locks the automatic lock row for update, as a change of the automatic lock does. So such a change waits for an open change of a voucher, and a change of a voucher waits for such a change and then reads it. Of the years' ends, only the voucher's own year's matters: the automatic lock reaches a date of that year only once a year that ends on or after the date ended 60 days ago, and no such year ends before the voucher's own. With writes at READ COMMITTED only (below), no change goes in under a lock that it did not see. The day itself is the one exception: a transaction kept open past midnight checks only its next statement against the new day's automatic lock.

## Accounts

`ledger.accounts` holds each fiscal year's accounts: the `number`, the name `description`, and `active` (true unless told otherwise). A number is unique in its year (a unique key), and an account's number, year and id never change (`immutable_field`). `modified_at` moves with every accepted change. Only the trigger writes it: one given on insert is refused (`immutable_field`), and one written by an update too (`internal_only`). A refused change moves nothing. The app may insert, change and remove accounts. An unused account can be removed, and the behandlingshistorik keeps its last state. An account that holds rows cannot be removed (`account_has_rows`, with the number of vouchers that hold a row on it, struck rows included); `ledger.account_voucher_count` counts them. A deleted voucher holds no rows: its rows are in the record of deleted vouchers, with the account's name. A new row reads its account's `active` flag from the account's row locked `FOR SHARE` until the transaction ends. So a change of the account waits for an open new row on it, and a new row waits for an open change of the account and then reads it.

## Voucher series

`ledger.voucher_series` holds each fiscal year's series: the `code`, the name `description`, `manual` and `is_closing`. `manual` has no default, so whoever makes a series states it. `is_closing` is false unless told otherwise.

- The code is 1 to 10 of `0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZÅÄÖ`, written out rather than as a range, so no collation can widen the set (`series_code_invalid`). It may start with a digit.
- The code is unique in its year (`series_code_duplicate`). The trigger locks the year's row while it checks, so two series made at once in one year are checked one after the other. It never changes (`series_code_changed`), and neither do the series' year and id (`immutable_field`).
- The name is at most 200 characters, counted as characters, and may be empty (`value_too_long`).
- At most one series of a year is the closing series (a partial unique index). The mark moves when the old closing series gives it up first. The period lock does not apply to the closing series. A booking, a change or a deletion of a voucher locks its series' row `FOR SHARE` before it reads the mark, so a change of the mark waits for it, and the other way round. So does a change of the series' name or manual flag. A booking reads the manual flag from that locked row too, so a booking that waited for a change of the flag reads the new flag.
- `modified_at` moves with every accepted change, as for accounts. The next number is the series' too, as the compatible API shows it, and every move of it, by a booking, by the deletion of the last voucher or by a void range, moves the counter's own `modified_at` (below). The series' modified time, as `lastmodified` reads it, is the later of the two: `greatest(voucher_series.modified_at, voucher_counters.modified_at)`.
- Check constraints and the unique key hold the code's form, the name's length and the code's uniqueness also when the trigger is off.
- The app may insert, change and remove series. An unused series can be removed, and its counter goes with it. A series that a voucher, an entry in the record of deleted vouchers or a void range names cannot (`ON DELETE RESTRICT`, `23001`).

## Counters

`ledger.voucher_counters` holds each series' `next_number`, one row per series, and `modified_at`, when it was made or last moved. A trigger makes it at 1 with its series, so every series starts at 1 in every fiscal year. Only the database's own triggers write it (the internal-write rule below): a statement that a caller sends is refused (`internal_only`). The app and the readers only read it. A trigger may change the next number only with proof in the same transaction: a void range recorded in it that starts at the old next number and ends just before the new one; up by one, a voucher booked in it with the old next number; back by one, the voucher with the new next number while it is being deleted (it is in the record from this transaction and not yet out of the vouchers). Anything else is refused (`counter_move`). Each accepted move sets `modified_at`, and a refused or rolled-back one moves nothing. A counter is removed only by the cascade when its series goes.

## Void ranges

`ledger.void_ranges` holds a recorded skip in a series: `fiscal_year_id` and `series_code`, `first_number` and `last_number`, and the `reason`, which may not be empty. Only the owner records one, as the restore tool will ([decision 7](../docs/decisions/0007-self-hosting-and-backups.md)); the app and the readers only read them. A range starts at the series' counter (`void_range_not_at_counter`), so it never leaves a gap and never covers a number that was given out. The trigger locks the counter while it checks, so a booking or another range waits and then sees the counter this one left. The counter then moves to `last_number + 1`. The trigger writes `created_at`, `created_by`, `created_by_kind` and `created_xact` from the transaction's actor, and refuses them when they are given. No role changes or deletes a void range, the owner neither (`append_only`). Its history row is written like any other.

## Vouchers

`ledger.vouchers` holds each voucher: its `fiscal_year_id` and `series_code`, its `number`, the `description`, the `comments`, the `transaction_date`, the `reference_type` (`INVOICE`, `SUPPLIERINVOICE`, `INVOICEPAYMENT`, `SUPPLIERPAYMENT`, `MANUAL`, `CASHINVOICE` or `ACCRUAL`), the `reference_number`, and `reverses_voucher_id`. The key is the year, the series and the number. `ledger.voucher_rows` holds its rows: the `account_number` of the voucher's year, a `debit` and a `credit` in öre, each a `bigint` of zero or more (a check, `23514`), 0 when none is given, and kept as they were sent, so one row can hold both ([decision 5](../docs/decisions/0005-money.md)), the `transaction_information`, the `quantity` (a `numeric` of any scale, 0 when none is given), the `position`, and `removed` with who struck the row and when. A row's year is its voucher's: the key to the voucher carries it.

**Bokför.** An insert into `ledger.vouchers` books the voucher: it gets its number at once, in the same transaction. There is no draft. The trigger checks, in this order, and the first that fails is the refusal:

1. no column that the database writes is given: the number, the created stamps (`created_at`, `created_by`, `created_by_kind`, `created_xact`), `modified_at` and the altered stamps (`immutable_field`, create);
2. the description is there (`description_missing`; an empty or NULL one is missing, spaces are not) and at most 200 characters (`value_too_long`);
3. the comments are at most 1000 characters (`value_too_long`);
4. the series is in the voucher's year (`series_missing`), and a `MANUAL` voucher's series is manual (`series_not_manual`);
5. the date is in some fiscal year of the company (`no_fiscal_year`), and in the voucher's own (`date_outside_fiscal_year`, with the year), the closing series too;
6. the date is not locked for the actor (`ledger.assert_open`), except in the closing series;
7. the voucher it reverses, if any, is locked first; it is an earlier voucher of the company (`23503`, below); it has the same reference type (`reversing_other_module`); and no other voucher reverses it (`reversing_voucher_exists`);
8. the series' counter row is locked `FOR UPDATE` until the transaction ends, and gives the number.

A reference type outside the seven is refused by a check (`23514`). The series and its manual flag are read from the series' row, locked `FOR SHARE` after the year's row. The rows are inserted next, each one a statement. A row's trigger locks its voucher, refuses a given year, position, created stamp or strike (`immutable_field`, create), and checks that the account is in the voucher's year (`account_missing`) and active (`account_inactive`), read from the account's row locked `FOR SHARE`, and that the text is at most 100 characters (`value_too_long`). It sets the next position and the created stamps. After the voucher is in, the counter moves past its number. A statement that books several vouchers of one series gives them the next numbers in turn.

**At commit**, two deferred constraint triggers check each voucher that is still there: at least two rows, struck rows included (`too_few_rows`, with the count; no row of a voucher can be struck in its booking's own transaction, below, so at booking every row counts), and debit equal to credit over the rows that are not struck (`unbalanced`, with both sums): the sum of every row's `debit` against the sum of every row's `credit`. Between two statements a voucher may be out of balance. A refused or rolled-back voucher uses no number.

**Ändra.** While the voucher's date is not locked for the actor, an update may change its `description` and its `transaction_date` inside its own year, a row's `transaction_information`, and a row's `removed` from false to true. A row may be added. Everything else is refused: the voucher's id, series, number, year, reference type and number, comments, `reverses_voucher_id` and created stamps, and a row's id, account, debit, credit, position, quantity, voucher, year and created stamps (`immutable_field`, update); taking the mark off a struck row, or changing who struck it and when (`immutable_field`); and writing `modified_at` or the altered stamps (`internal_only`). The period lock applies by the old date and by the new date. A strike gets `removed_at`, `removed_by` and `removed_by_kind` from the transaction. A strike in the booking's own transaction is refused (`immutable_field`, `removed`, create), as a row inserted struck is: the established system's new voucher takes a row away before it is booked, and striking is a change by Ändra. A row's text may still change there. Each accepted change after the booking's own transaction sets `altered_at`, `altered_by` and `altered_by_kind` and moves `modified_at`; a change to a row does it on its voucher. A refused change moves nothing. The behandlingshistorik keeps each earlier value.

**Ändringsverifikation.** A booking that sets `reverses_voucher_id` reverses that earlier voucher, which stays as it was. It must be there before the booking, in the transaction's company: the trigger refuses any other id, the voucher's own id and that of a voucher booked later in the same statement among them, with PostgreSQL's foreign key error (`23503`, `vouchers_reverses`). The link reads both ways, and a voucher whose date is locked can be named. A partial unique index keeps one reversing voucher at a time. Deleting the reversing voucher removes the link, and the old voucher can then get a new one.

**Radera.** A delete moves the voucher to the record of deleted vouchers. The trigger checks, in this order: the date is not locked for the actor (the closing series passes); the voucher is the last of its series, directly below the counter (`not_last_in_series`), so the voucher just below a void range never is; no voucher reverses it (`reversing_voucher_exists`); and, as it stands now, it has two rows (`too_few_rows`) and they balance (`unbalanced`). The checks at commit never see a voucher that is gone, so a deletion in the transaction that booked the voucher, or that changed its rows, makes those two checks here: the record holds no voucher that could not have been booked. Then it copies the voucher and its rows, each row with its account's name, into the record, and moves the counter back by one, so the number is given out again. The rows then go by the cascade. A row is never removed from a voucher that stays (`row_removal`); the app has no `DELETE` on rows at all.

**The lock order.** A booking, a change and a deletion of a voucher lock, `FOR SHARE`, its fiscal year, its series and the company's automatic lock row, in that order (the period lock, above). A booking then locks the voucher it reverses and the series' counter. A new row locks its voucher, then those three rows (a row of the booking's own transaction holds them from the booking), and then its account, `FOR SHARE`. A deletion locks its voucher first, as its statement's target, then those rows, then the counter, and then its rows by the cascade. A change of a row locks the row first, as its statement's target, and only then its voucher. So a change of a row and a deletion of the same voucher take the two in opposite orders, and can deadlock (`40P01`). Every caller that changes a row therefore locks its voucher first, in the same transaction: `SELECT 1 FROM ledger.vouchers WHERE id = $1 FOR NO KEY UPDATE`. Then the change waits for the deletion and finds no row, or the deletion waits for the change. The test helpers do this, and the server's repository must too.

A change of a fiscal year's dates, of a series or of an account locks only that row, and a change of a lock date locks its own row and then the automatic lock row, so none of them waits in a circle with a single change of a voucher. A transaction that makes more than one of these changes makes them in the order a voucher locks those rows: the fiscal year, then the series, then the lock dates, then the accounts. In another order it can deadlock with a change of a voucher (`40P01`), and PostgreSQL rolls one of the two back.

**The record of deleted vouchers.** `ledger.deleted_vouchers` holds each deletion as its own entry: every column the voucher had, the voucher's id in `voucher_id`, its `deletion_count` (the number's first deletion in its series and year is 1, the next 2), and `deleted_at`, `deleted_by`, `deleted_by_kind` and `deleted_xact`. An entry has an id of its own, so a voucher whose id an earlier deleted voucher had, in this company or another, is deleted as an entry of its own too. `ledger.deleted_voucher_rows` holds the entry's rows (`deleted_voucher_id` is the entry's id), each with an id of its own, the row's id in `row_id`, every column and `account_description`, the account's name at the deletion. Only a deletion writes them (`internal_only`), and no role changes or deletes them, the owner neither (`append_only`). The app and the readers only read them.

**The company at each check.** The triggers that run after a voucher or a row is written, and the checks at commit, read the voucher's rows through row level security, as the company that is set when they run. So each of them is refused (`42501`) when that company is not the voucher's: in a statement that changes `nortfox.company_id` between its rows, and in a transaction that has written a voucher and has another company, or none, set at its commit. The database does not keep one company for the whole transaction, as it keeps one actor: a transaction that writes in one company, switches to another and back, and then commits, is not refused, and each of its rows is the company's that was set when it was written. The server sets the company once, at the start of each transaction ([decision 9](../docs/decisions/0009-company-isolation-and-database-roles.md)). A transaction keeps one actor (the settings, above): a row added to a voucher in its booking's own transaction is part of the booking, so it is checked against the lock only with the booking.

The app may insert, change and delete vouchers, and insert and change rows.

## The behandlingshistorik

`audit.history` gets one row per inserted, updated or deleted row of every company table, in the same transaction: the table, the row's id, the operation (`INSERT`, `UPDATE` or `DELETE`), the whole old and new row as JSON, the actor and its kind, the transaction id and the time to the microsecond. No role changes or deletes a history row, the owner neither, and only the trigger writes one. The trigger refuses an update that would move a row to another company (`immutable_field`, `company_id`), so a company's history always holds every change to its rows. The actor of every history row of a transaction is the one actor that the transaction keeps.

## The isolation level

The ledger is written at READ COMMITTED only, by every role (`read_committed_only`, with the level). The rules check other rows under row locks: a booking locks its fiscal year's row `FOR SHARE` against a change of the year's dates, a booking locks its series' counter, a booking, a change and a deletion of a voucher lock its year, its series and the company's lock settings, and a new row locks its account. At READ COMMITTED each statement of a trigger then reads what is committed. At REPEATABLE READ and SERIALIZABLE every statement reads the transaction's first snapshot, and a lock that another transaction held and gave back at its commit raises no serialization failure. Such a transaction could shorten a fiscal year past a voucher booked just before, or change a voucher in a period locked just before. `audit.write_history`, the trigger that every company table has, refuses every write at those levels. READ UNCOMMITTED is READ COMMITTED in PostgreSQL, and is accepted. A read may run at any level.

## The internal-write rule

Some rows may only be written by the database's own triggers: the history, the counters, the record of deleted vouchers, and the stamp columns. A trigger refuses such a write when `pg_trigger_depth()` is 1, the depth of a statement that a caller sent. The app cannot reach depth 2 on its own: it can make no trigger and no function.

## Refusals

Each refusal has its own SQLSTATE in the class `NF`. The error's message is the reason, and its detail is the facts, as JSON. Amounts in the facts are strings of öre. `apps/server/src/db/refusals.ts` holds the same list and reads an error into its reason and facts, and a test fails when the two lists differ. Later slices answer each reason with the established system's message.

Migration 0001 raises `immutable_field` (a company's keys, and any row's `company_id`), `actor_missing`, `append_only`, `internal_only` and `read_committed_only`. Migration 0002 raises `period_locked_manual`, `period_locked_automatic`, `period_outside_fiscal_year` and `fiscal_year_strands_rows`, and `immutable_field` for the year number, the lock rows' stamps, scope and user, and the ids. Migration 0003 raises `series_code_invalid`, `series_code_duplicate`, `series_code_changed`, `value_too_long` (a series' name), `counter_move` and `void_range_not_at_counter`; `immutable_field`, `internal_only` and `append_only` for the accounts, the series, the counters and the void ranges; and `account_has_rows`, once the vouchers are there. Migration 0004 raises the rest: `unbalanced`, `too_few_rows`, `account_missing`, `account_inactive`, `series_missing`, `series_not_manual`, `no_fiscal_year`, `date_outside_fiscal_year`, `description_missing`, `not_last_in_series`, `reversing_voucher_exists`, `reversing_other_module` and `row_removal`; `value_too_long` for the vouchers and their rows; the period lock's two reasons for the vouchers; `fiscal_year_strands_rows` for the vouchers; `immutable_field` and `internal_only` for the vouchers and their rows; and `append_only` and `internal_only` for the record of deleted vouchers.

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
| NF058 | `read_committed_only` | `isolation` |

Where no reason is named, PostgreSQL's own error stands: a unique key, a check, a foreign key, a missing privilege (`42501`), a row that a policy refuses (`42501`), a check of a voucher that runs while another company than the voucher's is set (`42501`), or a write under another actor than the transaction's first write had (`42501`). These last two are faults of the server, not refusals of a request.

## Adding a migration

1. Add `migrations/NNNN_name.sql`: the next number, four digits, then lower-case words joined by underscores. Its first line is `-- SPDX-License-Identifier: AGPL-3.0-only`.
2. Write no `BEGIN`, `COMMIT` or `ROLLBACK`: the runner wraps the file in one transaction. It runs with `search_path` set to `pg_catalog, pg_temp`, so write every name of ours in full, such as `ledger.companies`.
3. Give every new company table what the list above says: call `meta.protect_company_table`, put `company_id` in its foreign keys, unique keys and exclusion constraints, then grant the app only the writes it needs.
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
