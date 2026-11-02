-- SPDX-License-Identifier: AGPL-3.0-only
--
-- What a superuser sets in each database of the cluster other than the
-- ledger database, once, at an install's first start
-- (deploy/postgres/initdb/10-roles.sh): postgres and template1. template0
-- takes no connection at all. It is safe to run again.
--
-- A role of NortFox works in the ledger database only. PostgreSQL lets every
-- role connect to postgres and template1, and make temporary tables in
-- postgres. There a role could make a large object or a temporary table:
-- bytes that stay in the cluster and its backups, outside the ledger's
-- tables, its row level security and the behandlingshistorik. A large object
-- in template1 would also be copied into every database made from it later.
-- So PUBLIC loses CONNECT and TEMPORARY here, and only a superuser connects.
-- The init step runs db/database.sql here first, so the functions that make
-- such bytes are closed here too.

DO $close$
BEGIN
  EXECUTE pg_catalog.format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', pg_catalog.current_database());
END
$close$;
