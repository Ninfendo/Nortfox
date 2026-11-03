# The database

The ledger law lives here, in PostgreSQL itself ([decision 2](../docs/decisions/0002-ledger-law-in-postgresql.md)). The server's role cannot break it: the rules are constraints, triggers and row level security, and the app role cannot change them ([decision 9](../docs/decisions/0009-company-isolation-and-database-roles.md)).

It holds the foundation (the roles, the companies, row level security, the refusals and the behandlingshistorik), the fiscal years, their periods and the period lock, the accounts, the voucher series, their counters and the void ranges, the vouchers with their rows, the reversing link and the record of deleted vouchers, and the idempotency keys that the API stores with its writes. [deploy/README.md](../deploy/README.md) says how an install runs it and backs it up.

## Files

| File | What it is |
| --- | --- |
| `roles.sql` | The cluster roles. A superuser runs it once per cluster, before the first migration. It is safe to run again: it makes what is missing and sets every attribute again. |
| `database.sql` | What a superuser sets in the ledger database, once, after making it and before the first migration: it closes the functions that keep bytes outside the ledger, a large object or a message in the WAL, the advisory locks, and the view of every backend's locks, `pg_locks`. A migration cannot, because those functions and that view are the bootstrap superuser's. An install runs it in the cluster's other databases too. It is safe to run again. |
| `other-databases.sql` | What a superuser sets in each other database of the cluster, `postgres` and `template1`, at an install's first start: no role of ours may connect there. It is safe to run again. |
| `migrations/NNNN_name.sql` | Plain SQL, applied in name order by the runner, never edited once applied. |

The runner is `apps/server/src/db/migrate.ts`. The one-shot step that runs it is `apps/server/src/db/migrate-main.ts`.

## In an install

The compose file (`deploy/compose.yaml`) sets the database up in two steps:

1. On the first start, PostgreSQL's image runs `deploy/postgres/initdb/10-roles.sh` as the superuser. It runs `roles.sql`, and runs `database.sql` and `other-databases.sql` in `template1` and `postgres`. It sets the passwords of `nortfox_owner` and `nortfox_app` from the compose secrets, makes the database `nortfox`, owned by `nortfox_owner`, and runs `database.sql` in it. Then `20-stanza.sh` sets up the backups, writes the file `nortfox-first-backups-pending` on the data volume, outside the data folder, and the file `nortfox-first-start-done` in the data folder, and takes the first full backup to each repository, which holds the second file. When a backup fails, it removes the second file again. Once both backups are taken, it removes the first. The service is healthy only once the second file is there and the first is not, so the migrate step never runs after a first start that failed or stopped during its first backups ([deploy/README.md](../deploy/README.md)).
2. The migrate step runs the runner as `nortfox_owner`, once PostgreSQL is healthy, and stops. It reads the address from `NORTFOX_DATABASE_URL`, which holds no password, and the password from the file that `NORTFOX_DATABASE_PASSWORD_FILE` names. The server's image carries the migrations of its own commit, so a deploy applies exactly those.

The restore test (`pnpm backup:test`) checks both on a running stack: every migration applied by `nortfox_owner`, every schema, table, index and sequence in `ledger`, `audit` and `meta` owned by it, our roles, a reader among them, able to connect to the database `nortfox` only, and none of them able to make a large object, write a message in the WAL or read `pg_locks` in any database of the cluster.

## Roles

| Role | What it may do |
| --- | --- |
| `nortfox_owner` | Owns the database, the schemas, the tables and the functions. Runs the migrations. Alone records a void range. The server never uses it. |
| `nortfox_app` | The server's role. Reads and writes rows, and only the writes each table needs. It cannot change the schema, disable a trigger, bypass row level security, make a temporary table or a large object, write a message in the WAL, take an advisory lock, read the locks that other backends hold, connect to another database of the cluster, or become another role. |
| `nortfox_reader` | A group, never a login. Each reader role is a login role that is a member of it, bound to one company in `ledger.reader_roles`. A reader reads its company's rows and writes nothing in the ledger. Like any role, it can still set its own role settings and its own default privileges (below). |

No role here is a superuser, or may make databases or roles, replicate, or bypass row level security. Passwords are not in `roles.sql`: an install's first start sets them from its secret files.

The owner owns every table, so it could switch a table's trigger or its forced row level security off, and then change or delete what the rules keep: the behandlingshistorik, the record of deleted vouchers, the void ranges and each company's automatic lock row. So the rules hold the app and the readers always, and the owner's own statements while its triggers are on. The owner's password is for the migrate step and the restore tool alone ([deploy/README.md](../deploy/README.md)).

A superuser makes a reader role, and the owner binds it to one company:

```sql
CREATE ROLE example_reader LOGIN;
GRANT nortfox_reader TO example_reader WITH INHERIT TRUE, SET FALSE;
-- then, as nortfox_owner, with the company and an actor set:
INSERT INTO ledger.reader_roles (company_id, role_oid) VALUES ('<company id>', 'example_reader'::regrole);
```

A binding holds the role's oid and, next to it, its name, `role_name`, which the trigger writes from the oid: a name that is given is refused (`immutable_field`), and an oid that names no role is refused by the `NOT NULL`. A binding never changes its role (`immutable_field`): the owner deletes it and binds again. A reader's binding is the one with both the oid of the role that reads, `ledger.current_role_oid()`, and its name. So a role that is dropped and made again with the same name, another role renamed to it, or the bound role renamed, is not the role that was bound: it reads nothing until the owner binds it. A role keeps its oid and its name in a restore from pgBackRest and through `pg_upgrade`.

A dump restored into another cluster brings every binding with the old oids, and the new cluster gives its roles new ones, which may be old oids of other roles. Such a role has the oid but not the name, so it reads nothing, but the old binding keeps that oid from being bound (a unique key). So after such a restore, and before any reader role is made there, the owner deletes every binding, company by company, with the company and an actor set: `DELETE FROM ledger.reader_roles`. Then it binds each reader again. The restore also brings the ids of the transactions that booked the vouchers, and of those whose actor each backend keeps (one actor per transaction, below), which the new cluster gives out again. The rules ask for a time as well as the transaction's id: the time of the booking, or the time the transaction that kept the actor began. So such an id is never taken for the current transaction's (the booking's own transaction, below).

To remove a reader, the owner deletes its binding, and then a superuser, in the database `nortfox`, clears the role's default privileges (below) and drops the role:

```sql
-- as nortfox_owner, with the company and an actor set:
DELETE FROM ledger.reader_roles WHERE role_oid = 'example_reader'::regrole;
-- then, as a superuser, in the database nortfox:
DROP OWNED BY example_reader;
DROP ROLE example_reader;
```

A reader owns nothing, so `DROP OWNED BY` drops no object. It deletes the role's own default privileges, takes the role out of the entries of other roles that name it, and revokes what was granted to it. Without it, `DROP ROLE` refuses a role that such an entry holds (`2BP01`). A test runs these steps as they stand here.

## Schemas

| Schema | What it holds |
| --- | --- |
| `ledger` | The companies and the ledger's tables, the helpers the policies call, and the refusals. |
| `audit` | The behandlingshistorik, `audit.history`. |
| `meta` | `meta.schema_migrations`, which the runner makes and writes, and `meta.protect_company_table()` and `meta.hide_statistics()`, which the migrations call. |

The database itself: only the app and the reader roles may connect, besides the owner, and no one but the owner may make anything in it, temporary tables included. No role of ours may make a large object or write a message in the WAL, the owner neither. A large object holds bytes outside every table, its row level security and the behandlingshistorik, and its maker can grant it to any role. A message in the WAL, up to 1 GB, goes with the archive to both repositories and stays with the backups. `database.sql` closes the three functions that make a large object (`lo_creat`, `lo_create` and `lo_from_bytea`) and the two that write a message in the WAL (`pg_logical_emit_message`). The other large object functions only read or write one that already exists. It also closes every advisory lock function to every role but the owner, which may run only the four it uses: its triggers take each company's turn with one (the lock order, below), and a role that held a company's key could stop that company's bookings, or its lock changes, for as long as it liked. The migration runner takes its own. Last, it closes the view `pg_locks`, and the function `pg_lock_status()` under it, to every role of ours, the owner too, since none of them reads it. It shows the locks that every backend holds, so each company's turn while a transaction holds it: the key, which is the same for the company each time, whether the turn is shared, for a change of a voucher, or alone, for a change of a lock, a year, a series or an account, and the transaction's id. A reader would see when each other company books and changes its locks, and, from `pg_xact_status()`, whether each change committed.

Role settings are a way out that PostgreSQL cannot close. Every role may set its own defaults with `ALTER ROLE ... SET`, for the cluster or `IN DATABASE`, and no privilege takes that away. So a reader, like any role of ours, can keep some text of its own choosing there, in a setting that any role may set, such as `search_path`, which takes any number of names. A setting of ours, such as `nortfox.company_id`, is refused (`42501`), and so is a change to another role's settings. The text stays in the cluster's catalog, `pg_db_role_setting`, so in the WAL and the backups, outside every table, its row level security and the behandlingshistorik, and every role can read it there. Every function of ours pins its `search_path`, so such a setting changes no rule. A role can set its own password too. A superuser sees the settings in `pg_db_role_setting` and clears a reader's with `ALTER ROLE <reader> RESET ALL` and `ALTER ROLE <reader> IN DATABASE nortfox RESET ALL`.

Default privileges are a second way out of the same kind. Every role may run `ALTER DEFAULT PRIVILEGES` for itself, for the objects it would make, in any schema or in all, with any roles as grantees, and no privilege takes that away. Another role's defaults are refused (`42501`). So the app and a reader can keep entries of their own choosing, one for each schema and kind of object, in the database's own catalog, `pg_default_acl`, so in the WAL, the backups and a dump, and every role can read them there. Neither the app nor a reader can make an object, so such an entry changes no rule. But an entry holds the roles it names: `DROP ROLE` refuses a role with entries of its own, and a role that another role's entry names (`2BP01`). So a reader could keep another company's reader from being dropped. A superuser sees the entries in `pg_default_acl`, and the steps to remove a reader (above) clear them with `DROP OWNED BY`.

The cluster's other databases: PostgreSQL lets every role connect to `postgres` and `template1`, and make temporary tables in `postgres`, and there the functions above are open. An install's first start runs `database.sql` and `other-databases.sql` in both, so no role of ours connects to them, and a database made from `template1` later starts with those functions closed. `template0` takes no connection at all.

## The settings the server sets

The server sets these at the start of each transaction, with `SET LOCAL` or `set_config(name, value, true)`, so a pooled connection never carries them over. An empty setting counts as unset.

| Setting | Value |
| --- | --- |
| `nortfox.company_id` | The company, a uuid. With no company set, every company table returns no rows. |
| `nortfox.actor_id` | The actor, a uuid. |
| `nortfox.actor_kind` | `user`, `system` (the internal system user) or `integration`. |
| `nortfox.channel` | The client the request came through: `rest` or `mcp`. Later slices add others. A write outside a request, such as one of the owner's tools, sets none. |

A write with no actor, or with another kind, is refused. A write under a channel the database does not know is refused by the history's check (`23514`); with none, the history records NULL. A reader's settings are never read: a reader sees the company its role is bound to.

The server's database layer, `apps/server/src/db/database.ts`, runs each request in one transaction, as `nortfox_app`, from a pool of connections. Before the request's first query, one statement sets all four with `set_config(name, value, true)`. A read runs at REPEATABLE READ READ ONLY, so a page and its total come from one snapshot, and a write at READ COMMITTED (the isolation level, below). Both levels are named in `BEGIN`, so a default of the connection's never changes them. After the transaction, PostgreSQL gives `''` for each setting, which counts as unset. A query on the transaction after it ended is refused, so it never runs in the next request's transaction on the same connection. A connection that breaks, or whose rollback fails, leaves the pool.

**One actor per transaction.** Any role can change a setting at any time, also in the middle of a statement. A rule that depends on the actor, such as the period lock, is checked for the actor that is set when its trigger runs, and the stamps and the behandlingshistorik record the actor that is set when theirs run. So the first time a transaction's write reads its actor, `ledger.current_actor()` keeps that actor, its kind and the channel in `ledger.transaction_actors`, and refuses a write under any other actor, kind or channel for the rest of the transaction (`42501`), in a later statement or later in the same statement. No channel counts as a channel of its own: a write with none after a write with one is refused, and the other way round. The writes of a savepoint that rolled back keep no actor and no channel. The table holds one row per backend, for the transaction that last wrote in it, and is not ledger data: each writing transaction writes over its backend's row, and it is unlogged, so a crash, which ends every transaction, empties it. A row names its transaction by the transaction's id and the time it began (`ledger.in_this_transaction`), so a row that a dump brought from another cluster is no transaction's, and the next write on its backend writes over it. The time a transaction began does not move while it runs, so a clock set back never makes the transaction's own row look like an earlier one. Only the owner reads and writes it. It costs each writing transaction one write to that row, and each read of the actor one lookup by its key.

## Every company table

Each table with company data has:

- a `company_id` column, and a primary key of one uuid column (`companies` uses `company_id`);
- row level security, enabled and forced, so the owner's statements are held to it too;
- three policies: the app and the owner see and write the rows of the transaction's company, and a reader sees the rows of its own company, which its policy reads once for the whole query, before any row (below);
- the `audit_history` trigger, which writes the behandlingshistorik;
- the `refuse_truncate` trigger, because `TRUNCATE` skips the row triggers;
- `company_id` in every foreign key to another company table, because a foreign key check skips row level security;
- `company_id` as a key column of every unique index, and compared with `=` in every exclusion constraint, because their checks skip row level security too: otherwise one company could learn from the error whether another holds a value. The primary key of one uuid column, and the three keys named below, leave it out;
- no planner statistics of its values: a statistics target of 0 on every column and on every expression column of its indexes, and no extended statistics (below);
- no partial index: every index holds every row of its table, so its row count is the table's (below). A unique index keeps a rule for some rows only by a NULL in the others, since NULLs are distinct in it;
- `SELECT` for the app and the readers, and for the app only the writes the table needs.

A row never moves to another company: the history trigger refuses an update that changes `company_id` (`immutable_field`), on every company table. A statement can change the transaction's company after row level security has let the old row through, so the policies alone do not stop it.

`meta.protect_company_table(table, key_column)` sets up all but the foreign keys, the keys and the writes. It calls `meta.hide_statistics(table)`, which sets the statistics targets of the columns and indexes the table has then. The table guard (`apps/server/src/db/table-guard.ts`) checks from the catalog all of it but the grants that must be there: it flags a missing or wrong row level security, policy, trigger, key or owner, planner statistics that a table keeps, a partial index, a `TRUNCATE`, `REFERENCES` or `TRIGGER` for the app, anything but `SELECT` for a reader, and anything for another role. It does not check that the app and the readers have `SELECT`, nor which writes the app has: `apps/server/src/modules/companies/roles.db.test.ts` pins each role's privileges on each table. The runner runs the guard inside each migration's transaction and rolls the migration back on any problem. Four tables are held to other rules, and a test pins the list:

- `meta.schema_migrations` holds no company data;
- `ledger.transaction_actors` holds no company data: it keeps each writing transaction's actor and channel (above);
- `audit.history` has no history trigger of its own;
- `ledger.reader_roles` lets a reader see only its own binding, by its role's oid and name.

Three unique keys leave `company_id` out, and a test pins the list too: the history's own id (an identity column that only the trigger writes), the companies' tenant id (from one sequence, never given or changed by a caller), and a reader role's oid (bound to one company, written only by the owner).

**The planner's statistics.** `ANALYZE`, which autovacuum runs by itself, keeps the most common values and a histogram of each column in `pg_statistic`, of every company's rows together. Under row level security the planner still reads them for an operator that is leakproof, such as `=` and `<` on text and on integers, and `EXPLAIN` shows its row estimates to every role that may read the table. So a reader could learn another company's values from the estimates, also by a binary search over range bounds, with no guess. So no company table keeps statistics of its values, `audit.history` and `ledger.reader_roles` neither: each column, and each expression column of an index, such as the date ranges of the exclusion constraints, has a statistics target of 0, and no table has extended statistics. `ANALYZE` then keeps none, and the planner uses its default estimates for those columns. That can give a worse plan for a large query, such as a report over many rows. A migration that adds a column, or an index with an expression, to a company table calls `meta.hide_statistics` on it again, or the guard refuses the migration.

PostgreSQL cannot hide the totals. Every role sees each table's row and page counts in `pg_class` and its counters in `pg_stat_user_tables`, over all the companies of the install. So a reader sees how many rows the install holds, and in an install with two companies it learns the other's count. `ANALYZE` keeps each index's row count in `pg_class` too. A partial index would count only the rows of every company that meet its condition, such as the reversing vouchers, so no company table has one: each index counts every row of its table, the same as the table's own count. An index's page count still grows with the values it holds, so it shows roughly how many rows hold a value in a column that is mostly NULL, such as `reverses_voucher_id`. Every role also sees in `pg_stat_activity` each backend's role and the id of its open transaction, and `pg_xact_status()` tells whether that transaction committed. So a reader sees when the install's transactions run and how they end, over all the companies. `pg_locks` would also show which company each one changes, by its turn, and it is closed (above).

**What `EXPLAIN ANALYZE` counts.** A reader's `EXPLAIN ANALYZE` runs the query and shows real counts: the rows each step read and removed, and the pages it read. Under row level security the planner checks a cheap leakproof condition of the reader's own, such as `number < 5150`, before a costly policy. A policy that read the reader's company for each row would read it only for the rows that pass the reader's condition, other companies' rows among them, and the page count would show how many there are. A policy that read it once, when the first row passes, would show whether one does. Either way a binary search would read another company's values. So a reader's policy compares `company_id` twice with a subquery that reads the reader's company, `(SELECT ledger.reader_company_id())`. The planner then checks the two subqueries against each other once, before the scan, so it reads both before any row, and compares each row with the value it read. `ledger.reader_roles` reads the role's oid the same way. The table guard checks the policies' text, and `statistics.db.test.ts` checks that a reader's counts are the same for another company's values as for values that no company has, on every company table. It compares each step's own pages, and leaves out the pages that the policy's subqueries read: they read the reader's binding and the catalog, never a row of the table, and their count changes when any role of the cluster changes, which resets every backend's caches of roles.

A key of one column leaves `company_id` out: each table's primary key, the companies' tenant id and a reader role's oid. After a lookup by it, `EXPLAIN ANALYZE` counts the rows that the policy removes. So a reader learns whether another company's row holds an id, and how many such rows fall in a range of ids. The uuid keys are random, from `gen_random_uuid()`, and the uuid that the app gives a company must be random too. The history's id comes from one sequence for the install, so it shows how many changes the other companies made between two of the reader's own, which the counters in `pg_stat_user_tables` show too. No id may carry more: a time-ordered id, such as `uuidv7()`, would tell a reader when each of another company's rows was made. A test pins both.

## Companies

`ledger.companies` holds the name, the organisation number and the tenant id, `database_number`. The app picks the company's uuid, sets it as the transaction's company, and inserts. The tenant id comes from one sequence for the install, from 1. A tenant id given on insert is refused, and neither the tenant id nor the company's uuid ever changes. A new company gets its row in `ledger.automatic_locks`, with the automatic lock off.

## Fiscal years and periods

`ledger.fiscal_years` holds each year's `from_date` and `to_date`, its `accounting_method` (`ACCRUAL` or `CASH`), its chart name `account_chart_type`, and `is_default`. A year has no open or closed state: a whole year is locked with the period lock.

- `year_number` is the year's integer for the compatible API: the company's highest plus one, in the order the years are made. The trigger takes it under a lock on the company's row, so two years made at once get the next two numbers. A number given on insert is refused, it never changes, and a unique key holds it per company.
- A company's years never overlap, not even by one day (an exclusion constraint).
- A company has at most one default year (a unique index on the company and `NULLIF(is_default, false)`, in which only the default year holds a value). The default moves when the old one gives it up first.
- New dates that would leave one of the year's periods or vouchers outside it are refused, with the table and the count (`fiscal_year_strands_rows`). A booking, a change and a deletion of one of the year's vouchers lock the year's row `FOR SHARE`, so a change of the year's dates waits for them, and the other way round. The year's end is also where the automatic lock's `year_end_60` interval counts from (below).
- The app may insert and change years, never delete one.

`ledger.periods` holds a year's periods, each with a `from_date` and a `to_date`. A period lies inside its year (`period_outside_fiscal_year`), and two periods of one year never overlap (an exclusion constraint on the company, the year and the dates). The trigger locks the year's row `FOR SHARE`, so a change of the year's dates waits for a new period, and the other way round. The app may insert and change periods, never delete one.

## The period lock

A lock is a locked-through date: every date up to and including it is locked. `ledger.period_locks` holds one row per scope: one for each user (`scope = 'user'` with its `user_id`), one for the internal system user (`system`), one for integrations (`integration`) and one for all users (`all`). A NULL `end_date` is a cleared lock. The trigger writes `set_by`, `set_by_kind` and `set_at` from the transaction's actor, refuses them when they are given, and never lets a row's scope, user or id change. Each date is set and cleared on its own. The app may insert and change rows, never delete one.

`ledger.automatic_locks` holds each company's automatic lock: `enabled`, the `interval` (`month_end_50`, `quarter_end_50` or `year_end_60`, required when it is on) and `notice_days`, with who changed it and when, as above. The row comes with the company. The app may only change it. No role may delete it, the owner's statements neither (`append_only`): every change of a lock date and every change of a voucher locks it (below), and without the row they would lock nothing.

The functions:

| Function | What it gives |
| --- | --- |
| `ledger.day_in_sweden(instant)` | The date in Europe/Stockholm at an instant, in winter time and in summer time. No setting moves it, and the session's time zone plays no part. |
| `ledger.today_in_sweden()` | The day in Sweden on the clock when it is called, not when its statement or its transaction began: `day_in_sweden(clock_timestamp())`. A DO block keeps the moment its statement began through every `COMMIT` in it, and so does a long statement. So a check after midnight reads the new day's automatic lock, also in a transaction, a statement or a DO block that began the day before. |
| `ledger.automatic_lock_end_date(company, today)` | The date the automatic lock reaches on `today`, or NULL when it is off. A period that ends on day E is locked from day E + 50 on (E + 60 for the fiscal year). Quarters are calendar quarters. No job has to run. |
| `ledger.applicable_locks(company, kind, actor, today)` | Every date that applies to the actor: its own row, the all-users row and the automatic lock. |
| `ledger.lock_covering(company, kind, actor, day, today)` | The lock that makes `day` locked for the actor, or no row. Of the dates that apply and reach `day`, the latest wins; on a tie, the actor's own row, then all users, then the automatic lock. |
| `ledger.locked_through(company, kind, actor, today)` | The one locked-through date for the actor, or NULL. |
| `ledger.assert_open(company, day, is_closing_series)` | Refuses the transaction's actor a date that is locked for it today, with `period_locked_manual` or `period_locked_automatic`. The closing series passes every lock. Only the triggers call it. |
| `ledger.take_turn(company, alone)` | Takes the company's turn until the transaction ends: with the other changes of vouchers, or alone (the lock order, below). Only the triggers call it. |
| `ledger.lock_voucher_period(company, fiscal_year, series_code)` | Takes the company's turn with the others, then locks the rows that the period lock on a voucher reads, `FOR SHARE` until the transaction ends: the voucher's fiscal year, its series and the company's automatic lock row, in that order. Gives the series' closing mark, read from the locked row. Only the voucher triggers call it. |
| `ledger.assert_voucher_open(company, fiscal_year, series_code, day)` | The same as `ledger.assert_open` for a voucher: it takes those locks first (`ledger.lock_voucher_period`), and calls `ledger.assert_open` with the series' closing mark. Only the voucher triggers call it. |

The app may call the first six. Row level security keeps each one to the transaction's company. The actor's kind is `user`, `system` or `integration`, and a user needs its id; anything else is an error (`22023`), not a refusal.

A change of what a lock depends on and a change of a voucher never overlap. The lock on a voucher's date depends on the lock dates, the automatic lock's settings, the end of the voucher's fiscal year (the `year_end_60` interval counts from it) and the closing mark of its series. A booking, a change and a deletion of a voucher, and a new row, each lock, `FOR SHARE` until the transaction ends, the voucher's fiscal year, then its series, then the company's row in `ledger.automatic_locks` (`ledger.lock_voucher_period`), and only then read them. A change of the year's dates or of the closing mark locks that row for update, and every change of a lock date locks the automatic lock row for update, as a change of the automatic lock does. So such a change waits for an open change of a voucher, and a change of a voucher waits for such a change and then reads it. Both first take the company's turn (the lock order, below), so such a change waits only for the changes of vouchers that were open when it came, also while the company's bookings overlap without a pause, and the changes of vouchers that come after it wait for it. Of the years' ends, only the voucher's own year's matters: the automatic lock reaches a date of that year only once a year that ends on or after the date ended 60 days ago, and no such year ends before the voucher's own. With writes at READ COMMITTED only (below), no change goes in under a lock that it did not see. The day itself is the one exception. Each check reads the day from the clock when it runs, so a check after midnight reads the new day. But the automatic lock moves at midnight with no change of a row, so a change that was checked before midnight can still commit after it. Its stamps show when it was made.

## Accounts

`ledger.accounts` holds each fiscal year's accounts: the `number`, the name `description`, and `active` (true unless told otherwise). A number is unique in its year (a unique key), and an account's number, year and id never change (`immutable_field`). `modified_at` moves with every accepted change. Only the trigger writes it: one given on insert is refused (`immutable_field`), and one written by an update too (`internal_only`). A refused change moves nothing. The app may insert, change and remove accounts. An unused account can be removed, and the behandlingshistorik keeps its last state. An account that holds rows cannot be removed (`account_has_rows`, with the number of vouchers that hold a row on it, struck rows included); `ledger.account_voucher_count` counts them. A deleted voucher holds no rows: its rows are in the record of deleted vouchers, with the account's name. A new row reads its account's `active` flag from the account's row locked `FOR SHARE` until the transaction ends. So a change of the account waits for an open new row on it, and a new row waits for an open change of the account and then reads it.

## Voucher series

`ledger.voucher_series` holds each fiscal year's series: the `code`, the name `description`, `manual` and `is_closing`. `manual` has no default, so whoever makes a series states it. `is_closing` is false unless told otherwise.

- The code is 1 to 10 of `0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZÅÄÖ`, written out rather than as a range, so no collation can widen the set (`series_code_invalid`). It may start with a digit.
- The code is unique in its year (`series_code_duplicate`). The trigger locks the year's row while it checks, so two series made at once in one year are checked one after the other. It never changes (`series_code_changed`), and neither do the series' year and id (`immutable_field`).
- The name is at most 200 characters, counted as characters, and may be empty (`value_too_long`).
- At most one series of a year is the closing series (a unique index on the company, the year and `NULLIF(is_closing, false)`, in which only the closing series holds a value). The mark moves when the old closing series gives it up first. The period lock does not apply to the closing series. A booking, a change or a deletion of a voucher locks its series' row `FOR SHARE` before it reads the mark, so a change of the mark waits for it, and the other way round. So does a change of the series' name or manual flag. A booking reads the manual flag from that locked row too, so a booking that waited for a change of the flag reads the new flag.
- `modified_at` moves with every accepted change, as for accounts. The next number is the series' too, as the compatible API shows it, and every move of it, by a booking, by the deletion of the last voucher or by a void range, moves the counter's own `modified_at` (below). The series' modified time, as `lastmodified` reads it, is the later of the two: `greatest(voucher_series.modified_at, voucher_counters.modified_at)`.
- Check constraints and the unique key hold the code's form, the name's length and the code's uniqueness also when the trigger is off.
- The app may insert, change and remove series. An unused series can be removed, and its counter goes with it. A series that a voucher, an entry in the record of deleted vouchers or a void range names cannot (`23001`). A trigger looks for such a row first, by a plain read, which waits for no lock, and refuses the removal with the foreign key's own error, so that the removal never waits for a voucher that a deletion holds (the lock order, below). The foreign keys (`ON DELETE RESTRICT`) hold the rule when the trigger is off.

## Counters

`ledger.voucher_counters` holds each series' `next_number`, one row per series, and `modified_at`, when it was made or last moved. A trigger makes it at 1 with its series, so every series starts at 1 in every fiscal year. Only the database's own triggers write it (the internal-write rule below): a statement that a caller sends is refused (`internal_only`). The app and the readers only read it. A trigger may change the next number only with proof in the same transaction: a void range recorded in it that starts at the old next number and ends just before the new one; up by one, a voucher booked in it with the old next number; back by one, the voucher with the new next number while it is being deleted (it is in the record from this transaction and not yet out of the vouchers). Each proof carries the transaction's id and a time after the transaction began (the booking's own transaction, below). Anything else is refused (`counter_move`). Each accepted move sets `modified_at`, and a refused or rolled-back one moves nothing. A counter is removed only by the cascade when its series goes.

## Void ranges

`ledger.void_ranges` holds a recorded skip in a series: `fiscal_year_id` and `series_code`, `first_number` and `last_number`, and the `reason`, which may not be empty. Only the owner records one, as the restore tool will ([decision 7](../docs/decisions/0007-self-hosting-and-backups.md)); the app and the readers only read them. A range starts at the series' counter (`void_range_not_at_counter`), so it never leaves a gap and never covers a number that was given out. The trigger locks the counter while it checks, so a booking or another range waits and then sees the counter this one left. The counter then moves to `last_number + 1`. The trigger writes `created_at`, `created_by`, `created_by_kind` and `created_xact` from the transaction's actor, and refuses them when they are given. The trigger refuses a change or a deletion of a void range from every role, the owner's statements too (`append_only`). Its history row is written like any other.

## Vouchers

`ledger.vouchers` holds each voucher: its `fiscal_year_id` and `series_code`, its `number`, the `description`, the `comments`, the `transaction_date`, the `reference_type` (`INVOICE`, `SUPPLIERINVOICE`, `INVOICEPAYMENT`, `SUPPLIERPAYMENT`, `MANUAL`, `CASHINVOICE` or `ACCRUAL`), the `reference_number`, and `reverses_voucher_id`. The key is the year, the series and the number. `ledger.voucher_rows` holds its rows: the `account_number` of the voucher's year, a `debit` and a `credit` in öre, each a `bigint` of zero or more (a check, `23514`), 0 when none is given, and kept as they were sent, so one row can hold both ([decision 5](../docs/decisions/0005-money.md)), the `transaction_information`, the `quantity` (a `numeric` of any scale that may be negative, 0 when none is given, and never `NaN`, `Infinity` or `-Infinity`, which a check refuses, `23514`), the `position`, and `removed` with who struck the row and when. A row's year is its voucher's: the key to the voucher carries it.

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

**The booking's own transaction.** A voucher was booked in the current transaction when it carries that transaction's id in `created_xact` and its `created_at` comes after the transaction began (`ledger.in_this_transaction`). The counters' proofs ask the same of a void range and of a deletion. The id alone is not enough: a transaction's id is unique only in the history of one cluster, and a dump restored into another cluster brings the old ids, which that cluster gives out again. The time of a row from before such a restore never comes after a transaction that began after it. If the clock is set back during a transaction, its own booking then looks like an earlier one, and the booking is refused (`counter_move`); the next try books it.

**Ändringsverifikation.** A booking that sets `reverses_voucher_id` reverses that earlier voucher, which stays as it was. It must be there before the booking, in the transaction's company: the trigger refuses any other id, the voucher's own id and that of a voucher booked later in the same statement among them, with PostgreSQL's foreign key error (`23503`, `vouchers_reverses`). The link reads both ways, and a voucher whose date is locked can be named. A unique index on the company and `reverses_voucher_id` keeps one reversing voucher at a time; a voucher that reverses none holds NULL there. Deleting the reversing voucher removes the link, and the old voucher can then get a new one.

**Radera.** A delete moves the voucher to the record of deleted vouchers. The trigger checks, in this order: the date is not locked for the actor (the closing series passes); the voucher is the last of its series, directly below the counter (`not_last_in_series`), so the voucher just below a void range never is; no voucher reverses it (`reversing_voucher_exists`); and, as it stands now, it has two rows (`too_few_rows`) and they balance (`unbalanced`). The checks at commit never see a voucher that is gone, so a deletion in the transaction that booked the voucher, or that changed its rows, makes those two checks here: the record holds no voucher that could not have been booked. Then it copies the voucher and its rows, each row with its account's name, into the record, and moves the counter back by one, so the number is given out again. The rows then go by the cascade. A row is never removed from a voucher that stays (`row_removal`); the app has no `DELETE` on rows at all.

**The lock order.** A booking, a change and a deletion of a voucher first take the company's turn with the others (below), and then lock, `FOR SHARE`, its fiscal year, its series and the company's automatic lock row, in that order (the period lock, above). A booking then locks the voucher it reverses and the series' counter. A new row locks its voucher, then those three rows (a row of the booking's own transaction holds them from the booking), and then its account, `FOR SHARE`. A deletion locks its voucher first, as its statement's target, then those rows, then the counter, and then its rows by the cascade. A change of a row locks the row first, as its statement's target, and only then its voucher. So a change of a row and a deletion of the same voucher take the two in opposite orders, and can deadlock (`40P01`). Every caller that changes a row therefore locks its voucher first, in the same transaction: `SELECT 1 FROM ledger.vouchers WHERE id = $1 FOR NO KEY UPDATE`. Then the change waits for the deletion and finds no row, or the deletion waits for the change. The test helpers do this, and every server handler that changes a row must too, in its request's transaction (`apps/server/src/db/database.ts` says so).

**The company's turn.** PostgreSQL gives a new `FOR SHARE` lock at once to a row that only share locks hold, ahead of a change that waits for the row. So while a company's bookings overlap, a change of a row that they lock `FOR SHARE` would wait until they pause: with three connections booking back to back, a lock date waited for as long as they ran. So each change takes the company's turn first, an advisory lock on the hash of the company's id that PostgreSQL queues in order (`ledger.take_turn`). A booking, a change and a deletion of a voucher, and a new or changed period, take it with the others. A change of a fiscal year, a lock date or the automatic lock, a new, changed or deleted series, and a changed or deleted account take it alone, from a trigger for each statement, before the statement locks any row. Such a change then waits only for the changes of vouchers that were open when it came, and the ones that come after it wait for it, at the turn, before they lock any of those rows. The row locks still keep the rules; the turn only orders them. The statement's trigger takes the turn of the company that is set when the statement starts. A statement that sets another company between its rows can change that company's rows without its turn, and the row locks keep the rules then too: `row-locks.db.test.ts` runs each race of such a change against a change of a voucher with no turn taken alone. Two companies whose ids hash alike share a turn, which costs only a wait. No role of ours sees a turn: `database.sql` closes `pg_locks` (the schemas, above). One cost: while a change waits for a long transaction, such as an import that books many vouchers at once, the company's later bookings wait too, until the change commits.

So a transaction that makes only these changes never waits in a circle with a change of a voucher, whatever the order of its changes, several accounts included, as long as it locks such a row only by changing it. A removal of an account or a series that rows still name is refused by a plain read, before a foreign key would lock those rows, so it never waits for a voucher that a deletion locked before it took the turn. A `SELECT` that locks one of these rows `FOR UPDATE` or `FOR NO KEY UPDATE` runs no trigger, so it locks the row before the transaction has the turn. A booking that comes next takes the turn with the others and waits for that row, and the transaction's later change of the row waits for the booking at the turn: the two deadlock (`40P01`). So a caller changes such a row with `UPDATE ... RETURNING`, and never locks it for update with a `SELECT` first. A test pins that deadlock. A transaction that makes these changes and also writes a voucher can deadlock with another change of a voucher (`40P01`), in either order. When it has changed a voucher first, it holds the turn with the others, so its change of such a row waits for every other open change of a voucher of the company, and can deadlock with one that waits for it, such as a booking in the same series, which waits for its counter. When it makes such a change first, it holds the turn alone. A change of a voucher that is there locks the voucher's row before it takes the turn: an `UPDATE` or a `DELETE` as its statement's target, a new or changed row through its trigger, and the caller's lock of the voucher (above). So another change of that voucher can hold the voucher and wait at the turn, while the transaction's own change of the voucher waits for it. PostgreSQL rolls one of the two back. So a caller makes such changes in a transaction of their own, or tries again on `40P01`. Tests pin both deadlocks.

**The record of deleted vouchers.** `ledger.deleted_vouchers` holds each deletion as its own entry: every column the voucher had, the voucher's id in `voucher_id`, its `deletion_count` (the number's first deletion in its series and year is 1, the next 2), and `deleted_at`, `deleted_by`, `deleted_by_kind` and `deleted_xact`. An entry has an id of its own, so a voucher whose id an earlier deleted voucher had, in this company or another, is deleted as an entry of its own too. `ledger.deleted_voucher_rows` holds the entry's rows (`deleted_voucher_id` is the entry's id), each with an id of its own, the row's id in `row_id`, every column and `account_description`, the account's name at the deletion. Only a deletion writes them (`internal_only`), and the triggers refuse a change or a deletion of them from every role, the owner's statements too (`append_only`). The app and the readers only read them.

**The company at each check.** The triggers that run after a voucher or a row is written, and the checks at commit, read the voucher's rows through row level security, as the company that is set when they run. So each of them is refused (`42501`) when that company is not the voucher's: in a statement that changes `nortfox.company_id` between its rows, and in a transaction that has written a voucher and has another company, or none, set at its commit. The database does not keep one company for the whole transaction, as it keeps one actor: a transaction that writes in one company, switches to another and back, and then commits, is not refused, and each of its rows is the company's that was set when it was written. The server sets the company once, at the start of each transaction ([decision 9](../docs/decisions/0009-company-isolation-and-database-roles.md)). A transaction keeps one actor (the settings, above): a row added to a voucher in its booking's own transaction is part of the booking, so it is checked against the lock only with the booking.

The app may insert, change and delete vouchers, and insert and change rows.

## Idempotency keys

`ledger.idempotency_keys` holds the key of each write through `/v1` or MCP, with its first answer: the `idempotency_key`, the `operation_id`, the `request_hash` (the SHA-256 of the request, 64 lower-case hexadecimal digits), the `response_status` and the `response_body`. The server stores it in the same transaction as the write, so the same key and request give the first answer again and nothing is written twice.

- A key belongs to the company and the actor of the transaction that stored it. The trigger writes `actor_id`, `actor_kind` and `created_at` from the transaction's actor and the clock, and refuses each when it is given (`immutable_field`, create). The unique key holds the company, the actor and the key, so a company and an actor have a key once, and another actor or another company may use the same key. A write that meets a stored key with `INSERT ... ON CONFLICT (company_id, actor_id, idempotency_key) DO NOTHING` stores nothing and writes no history row.
- The key is 1 to 255 characters of visible ASCII but the double quote and the backslash (a check, `23514`), the same alphabet as the server's own check in `packages/contract`, so the key's quoted form in a header needs no escape. The check's ranges run by code point, so no collation widens them.
- The status is a success, 200 to 299 (a check): a refused write stores no key.
- The app may insert keys and read its company's, and never changes or deletes one. A reader reads its company's keys.
- Keys never expire yet. The stored answer is in the behandlingshistorik too, like every company row.

## The behandlingshistorik

`audit.history` gets one row per inserted, updated or deleted row of every company table, in the same transaction: the table, the row's id, the operation (`INSERT`, `UPDATE` or `DELETE`), the whole old and new row as JSON, the actor and its kind, the channel (NULL when the transaction set none), the transaction id and the time to the microsecond. Its trigger refuses a change or a deletion of a history row from every role, the owner's statements too, and only the history trigger writes one. The trigger refuses an update that would move a row to another company (`immutable_field`, `company_id`), so a company's history always holds every change to its rows. The actor and the channel of every history row of a transaction are the ones that the transaction keeps.

## The isolation level

The ledger is written at READ COMMITTED only, by every role (`read_committed_only`, with the level). The rules check other rows under row locks: a booking locks its fiscal year's row `FOR SHARE` against a change of the year's dates, a booking locks its series' counter, a booking, a change and a deletion of a voucher lock its year, its series and the company's lock settings, and a new row locks its account. At READ COMMITTED each statement of a trigger then reads what is committed. At REPEATABLE READ and SERIALIZABLE every statement reads the transaction's first snapshot, and a lock that another transaction held and gave back at its commit raises no serialization failure. Such a transaction could shorten a fiscal year past a voucher booked just before, or change a voucher in a period locked just before. `audit.write_history`, the trigger that every company table has, refuses every write at those levels. READ UNCOMMITTED is READ COMMITTED in PostgreSQL, and is accepted. A read may run at any level.

## The internal-write rule

Some rows may only be written by the database's own triggers: the history, the counters, the record of deleted vouchers, and the stamp columns. A trigger refuses such a write when `pg_trigger_depth()` is 1, the depth of a statement that a caller sent. The app cannot reach depth 2 on its own: it can make no trigger and no function.

## Refusals

Each refusal has its own SQLSTATE in the class `NF`. The error's message is the reason, and its detail is the facts, as JSON. Amounts in the facts are strings of öre. `apps/server/src/db/refusals.ts` holds the same list and reads an error into its reason and facts, and a test fails when the two lists differ. Later slices answer the reasons NF001 to NF020 with the established system's message where it has one (rule 44 of the slice). The reasons from NF050 on guard the database's own rules and have no such answer.

Migration 0001 raises `immutable_field` (a company's keys, a binding's role, and any row's `company_id`), `actor_missing`, `append_only`, `internal_only` and `read_committed_only`. Migration 0002 raises `period_locked_manual`, `period_locked_automatic`, `period_outside_fiscal_year` and `fiscal_year_strands_rows`; `immutable_field` for the year number, the lock rows' stamps, scope and user, and the ids; and `append_only` for a deletion of an automatic lock row. Migration 0003 raises `series_code_invalid`, `series_code_duplicate`, `series_code_changed`, `value_too_long` (a series' name), `counter_move` and `void_range_not_at_counter`; `immutable_field`, `internal_only` and `append_only` for the accounts, the series, the counters and the void ranges; and `account_has_rows`, once the vouchers are there. Migration 0004 raises the rest: `unbalanced`, `too_few_rows`, `account_missing`, `account_inactive`, `series_missing`, `series_not_manual`, `no_fiscal_year`, `date_outside_fiscal_year`, `description_missing`, `not_last_in_series`, `reversing_voucher_exists`, `reversing_other_module` and `row_removal`; `value_too_long` for the vouchers and their rows; the period lock's two reasons for the vouchers; `fiscal_year_strands_rows` for the vouchers; `immutable_field` and `internal_only` for the vouchers and their rows; and `append_only` and `internal_only` for the record of deleted vouchers. Migration 0005 adds no reason: it raises `immutable_field` for an idempotency key's actor, kind and time.

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

Where no reason is named, PostgreSQL's own error stands: a unique key, a check, a foreign key, a missing privilege (`42501`), a row that a policy refuses (`42501`), a check of a voucher that runs while another company than the voucher's is set (`42501`), a write under another actor or channel than the transaction's first write had (`42501`), or a channel that the history's check does not know (`23514`). These last three are faults of the server, not refusals of a request.

## Adding a migration

1. Add `migrations/NNNN_name.sql`: the next number, four digits, then lower-case words joined by underscores. Its first line is `-- SPDX-License-Identifier: AGPL-3.0-only`.
2. Write no `BEGIN`, `COMMIT` or `ROLLBACK`: the runner wraps the file in one transaction. It runs with `search_path` set to `pg_catalog, pg_temp`, so write every name of ours in full, such as `ledger.companies`.
3. Give every new company table what the list above says: call `meta.protect_company_table` once its indexes are there, put `company_id` in its foreign keys, unique keys and exclusion constraints, then grant the app only the writes it needs. A new column, or a new index with an expression, on a company table needs `meta.hide_statistics` on that table.
4. Give every function `SET search_path = pg_catalog, pg_temp`. Make a trigger function `SECURITY DEFINER`. No function is open to `PUBLIC`: grant `EXECUTE` only to the roles that call it.
5. Never edit a migration once it is on `main`. The runner refuses a database whose applied migration has changed.
6. Write the tests first, against real PostgreSQL, as the app role (below). Add each new company table to `apps/server/test/every-table.ts`, so the isolation and history tests cover it.

Migrations are not an owner path ([decision 2](../docs/decisions/0002-ledger-law-in-postgresql.md)). The owner's review agent reads a migration like any other change, and the tests guard the rules.

## The tests

The database tests are `apps/server/src/**/*.db.test.ts`. They run against real PostgreSQL, as the app role unless they test another role, each test file in a copy of a migrated template database.

```sh
pnpm db:test        # starts a test cluster: PostgreSQL in Docker, on 127.0.0.1:55433, data in memory
pnpm test           # every suite, the database tests too
pnpm db:test:stop   # stops it
```

`NORTFOX_TEST_DATABASE_URL` points the tests at another cluster: a superuser on a cluster of its own, with trust authentication. Roles belong to the whole cluster, so the tests refuse a cluster that holds any database they did not make. The roles and the cluster's limit of connections serve one run at a time, so a run holds the cluster from its setup to its teardown, with an advisory lock in the database `postgres`. A second run on the same cluster, from another worktree for example, says that it waits, and starts when the first ends. Without a cluster, the tests fail with a line that says how to start one. They never skip.
