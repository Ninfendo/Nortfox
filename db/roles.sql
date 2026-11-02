-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The cluster roles of a NortFox install (docs/decisions/0009). A superuser
-- runs this file once per cluster, before the first migration: the compose
-- file's init step, and the test setup. It is safe to run again. It makes each
-- role that is missing, then sets every attribute of every role, so a role
-- that exists with a wrong attribute is put right.
--
-- No password is set here. The compose file's init step sets the passwords
-- from its secret files. The tests use trust authentication.
--
-- nortfox_owner   owns the database, the schemas, the tables and the
--                 functions. It runs the migrations, and it alone records a
--                 void range. The server never uses it.
-- nortfox_app     the server's role. It reads and writes rows, nothing more.
--                 NOINHERIT: it gets no privilege through a role granted to it.
-- nortfox_reader  a group, never a login. Each reader role is a login role
--                 that is a member of it, bound to one company in
--                 ledger.reader_roles. A superuser makes each reader role with
--                 GRANT nortfox_reader TO <role> WITH INHERIT TRUE, SET FALSE.
--
-- No role here is a superuser, or may create databases or roles, replicate,
-- or bypass row level security.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'nortfox_owner') THEN
    CREATE ROLE nortfox_owner;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'nortfox_app') THEN
    CREATE ROLE nortfox_app;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'nortfox_reader') THEN
    CREATE ROLE nortfox_reader;
  END IF;
END
$roles$;

ALTER ROLE nortfox_owner WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE nortfox_app WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE nortfox_reader WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- None of the three is a member of another role, so none can take another
-- role's privileges or SET ROLE to it.
DO $memberships$
DECLARE
  membership record;
BEGIN
  FOR membership IN
    SELECT granted.rolname AS granted, member.rolname AS member, grantor.rolname AS grantor
    FROM pg_catalog.pg_auth_members AS m
    JOIN pg_catalog.pg_roles AS granted ON granted.oid = m.roleid
    JOIN pg_catalog.pg_roles AS member ON member.oid = m.member
    JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = m.grantor
    WHERE member.rolname IN ('nortfox_owner', 'nortfox_app', 'nortfox_reader')
  LOOP
    EXECUTE pg_catalog.format('REVOKE %I FROM %I GRANTED BY %I', membership.granted, membership.member, membership.grantor);
  END LOOP;
END
$memberships$;
