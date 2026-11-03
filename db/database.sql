-- SPDX-License-Identifier: AGPL-3.0-only
--
-- What a superuser sets in the ledger database once, after making it and
-- before the first migration: the compose file's init step
-- (deploy/postgres/initdb/10-roles.sh) and the test setup. It is safe to run
-- again. A migration cannot do this, because it runs as nortfox_owner, and
-- these functions and views belong to the bootstrap superuser. The init step runs it in
-- the cluster's other databases too, postgres and template1, so a database
-- made from template1 later starts with these functions closed
-- (db/other-databases.sql).
--
-- Bytes outside the ledger. Any role that may connect can run these functions
-- by default, and each keeps bytes of its caller's choosing outside every
-- table, its row level security and the behandlingshistorik, in the backups:
--
-- - lo_creat, lo_create and lo_from_bytea make a large object. It stays in
--   the database, and its maker can grant it to any other role. The other
--   large object functions read or write only a large object that already
--   exists, with the privileges its maker gave.
-- - pg_logical_emit_message writes a message of up to 1 GB into the WAL,
--   which the archive sends to both repositories and keeps with the backups.
--
-- So no role of NortFox may run them: not the app, which reads and writes
-- rows, not a reader, which writes nothing in the ledger, and not the owner.
-- No privilege closes two more ways out: every role may set its own role
-- settings, which the cluster's catalog keeps, and its own default
-- privileges, which this database's catalog keeps (db/README.md).

REVOKE EXECUTE ON FUNCTION
  pg_catalog.lo_creat(integer),
  pg_catalog.lo_create(oid),
  pg_catalog.lo_from_bytea(oid, bytea),
  pg_catalog.pg_logical_emit_message(boolean, text, text, boolean),
  pg_catalog.pg_logical_emit_message(boolean, text, bytea, boolean)
FROM PUBLIC;

-- Advisory locks. Any role that may connect can take any advisory lock by
-- default, by its key, and hold it as long as its session lasts. The ledger's
-- own triggers take one for each company, the company's turn
-- (ledger.take_turn, db/migrations/0002_fiscal_years.sql): a role that held
-- a company's key could stop that company's bookings, or its lock changes,
-- for as long as it liked. So only the owner may take one in the ledger
-- database: its triggers take the turn, and the migration runner its own
-- lock (apps/server/src/db/migrate.ts).

REVOKE EXECUTE ON FUNCTION
  pg_catalog.pg_advisory_lock(bigint),
  pg_catalog.pg_advisory_lock(integer, integer),
  pg_catalog.pg_advisory_lock_shared(bigint),
  pg_catalog.pg_advisory_lock_shared(integer, integer),
  pg_catalog.pg_advisory_unlock(bigint),
  pg_catalog.pg_advisory_unlock(integer, integer),
  pg_catalog.pg_advisory_unlock_shared(bigint),
  pg_catalog.pg_advisory_unlock_shared(integer, integer),
  pg_catalog.pg_advisory_unlock_all(),
  pg_catalog.pg_advisory_xact_lock(bigint),
  pg_catalog.pg_advisory_xact_lock(integer, integer),
  pg_catalog.pg_advisory_xact_lock_shared(bigint),
  pg_catalog.pg_advisory_xact_lock_shared(integer, integer),
  pg_catalog.pg_try_advisory_lock(bigint),
  pg_catalog.pg_try_advisory_lock(integer, integer),
  pg_catalog.pg_try_advisory_lock_shared(bigint),
  pg_catalog.pg_try_advisory_lock_shared(integer, integer),
  pg_catalog.pg_try_advisory_xact_lock(bigint),
  pg_catalog.pg_try_advisory_xact_lock(integer, integer),
  pg_catalog.pg_try_advisory_xact_lock_shared(bigint),
  pg_catalog.pg_try_advisory_xact_lock_shared(integer, integer)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  pg_catalog.pg_advisory_lock(bigint),
  pg_catalog.pg_advisory_unlock(bigint),
  pg_catalog.pg_advisory_xact_lock(integer, integer),
  pg_catalog.pg_advisory_xact_lock_shared(integer, integer)
TO nortfox_owner;

-- The locks that every backend holds. Any role may read them by default, in
-- the view pg_locks or the function pg_lock_status() under it. While a
-- company's transaction holds its turn, they show it to every role: the key,
-- which is the same for the company each time, whether the turn is shared,
-- for a change of a voucher, or alone, for a change of a lock, a year, a
-- series or an account, and the id of the transaction, whose end
-- pg_xact_status() then tells. So a reader would see when each other company
-- books and changes its locks, and whether each change committed. No role of
-- NortFox reads them, the owner neither, so none may.

REVOKE SELECT ON pg_catalog.pg_locks FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.pg_lock_status() FROM PUBLIC;
