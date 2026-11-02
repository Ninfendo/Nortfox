-- SPDX-License-Identifier: AGPL-3.0-only
--
-- What a superuser sets in the ledger database once, after making it and
-- before the first migration: the compose file's init step
-- (deploy/postgres/initdb/10-roles.sh) and the test setup. It is safe to run
-- again. A migration cannot do this, because it runs as nortfox_owner, and
-- these functions belong to the bootstrap superuser.
--
-- Large objects. Any role that may connect can make a large object with these
-- three functions. A large object holds bytes that stay in the database and
-- in its backups, outside every table, its row level security and the
-- behandlingshistorik, and its maker can grant it to any other role. So no
-- role of NortFox may make one: not the app, which reads and writes rows, not
-- a reader, which only reads, and not the owner. The other large object
-- functions read or write only a large object that already exists, with the
-- privileges its maker gave.

REVOKE EXECUTE ON FUNCTION
  pg_catalog.lo_creat(integer),
  pg_catalog.lo_create(oid),
  pg_catalog.lo_from_bytea(oid, bytea)
FROM PUBLIC;
