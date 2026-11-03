-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0001 foundation: the database's own privileges, the schemas, the helpers
-- that every rule uses, the refusals, the companies, the reader roles'
-- bindings and the behandlingshistorik. See db/README.md, and decisions 0002
-- and 0009 in docs/decisions/.
--
-- The runner (apps/server/src/db/migrate.ts) applies each file as
-- nortfox_owner, in one transaction, with search_path = pg_catalog, pg_temp.
-- Before it commits, it runs the table guard (apps/server/src/db/table-guard.ts).
-- So every name of our own here is schema-qualified, and a table that lacks
-- forced row level security, its policies or its triggers never commits.

-- The database. Only the app and the reader roles may connect, besides the
-- owner. No one but the owner may create anything here, temporary tables
-- included: a temporary table could shadow a name. No role of ours may make
-- a large object either. Its functions belong to the bootstrap superuser, so
-- this migration cannot close them: db/database.sql does, run by a superuser
-- in the database before the first migration.
DO $database$
BEGIN
  EXECUTE pg_catalog.format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', pg_catalog.current_database());
  EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO nortfox_app, nortfox_reader', pg_catalog.current_database());
END
$database$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- The extension that lets an exclusion constraint compare a uuid with = and a
-- date range with &&, so that fiscal years and periods never overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

-- No function of ours is open to PUBLIC. Each is granted to the roles that
-- call it.
ALTER DEFAULT PRIVILEGES FOR ROLE nortfox_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE SCHEMA ledger;
CREATE SCHEMA audit;
GRANT USAGE ON SCHEMA ledger, audit TO nortfox_app, nortfox_reader;

-- Refusals --------------------------------------------------------------------
--
-- Each refusal is its own reason with its own SQLSTATE in the class NF. The
-- error's message is the reason, and its detail is the facts as JSON. Amounts
-- in the facts are strings of öre. apps/server/src/db/refusals.ts holds the
-- same list, and a test fails when the two differ.

CREATE FUNCTION ledger.refusal_reasons() RETURNS TABLE (reason text, code text)
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT v.column1, v.column2
  FROM (VALUES
    ('unbalanced', 'NF001'),
    ('too_few_rows', 'NF002'),
    ('account_missing', 'NF003'),
    ('account_inactive', 'NF004'),
    ('series_missing', 'NF005'),
    ('series_not_manual', 'NF006'),
    ('no_fiscal_year', 'NF007'),
    ('date_outside_fiscal_year', 'NF008'),
    ('description_missing', 'NF009'),
    ('value_too_long', 'NF010'),
    ('period_locked_manual', 'NF011'),
    ('period_locked_automatic', 'NF012'),
    ('not_last_in_series', 'NF013'),
    ('reversing_voucher_exists', 'NF014'),
    ('reversing_other_module', 'NF015'),
    ('account_has_rows', 'NF016'),
    ('series_code_invalid', 'NF017'),
    ('series_code_duplicate', 'NF018'),
    ('series_code_changed', 'NF019'),
    ('immutable_field', 'NF020'),
    ('actor_missing', 'NF050'),
    ('append_only', 'NF051'),
    ('internal_only', 'NF052'),
    ('row_removal', 'NF053'),
    ('counter_move', 'NF054'),
    ('void_range_not_at_counter', 'NF055'),
    ('period_outside_fiscal_year', 'NF056'),
    ('fiscal_year_strands_rows', 'NF057'),
    ('read_committed_only', 'NF058')
  ) AS v
  ORDER BY v.column2;
END;

-- Raises the refusal: its SQLSTATE, the reason as the message, the facts as
-- the detail. A reason that is not on the list is a fault, not a refusal.
CREATE FUNCTION ledger.refuse(reason text, facts jsonb DEFAULT '{}') RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $refuse$
DECLARE
  state text;
BEGIN
  SELECT r.code INTO state FROM ledger.refusal_reasons() AS r WHERE r.reason = refuse.reason;
  IF state IS NULL THEN
    RAISE EXCEPTION 'ledger.refuse was given an unknown reason: %', refuse.reason;
  END IF;
  RAISE EXCEPTION USING ERRCODE = state, MESSAGE = refuse.reason, DETAIL = refuse.facts::text;
END
$refuse$;

-- Companies -------------------------------------------------------------------
--
-- A company has a name, an organisation number and a tenant id, the
-- database_number, which the compatible API uses for the company. The app
-- picks the company_id, sets it as the transaction's company, then inserts.
-- The tenant id comes from one sequence for the install, and never changes.

CREATE SEQUENCE ledger.database_number_seq AS integer START WITH 1 NO CYCLE;

CREATE TABLE ledger.companies (
  company_id uuid PRIMARY KEY,
  name text NOT NULL,
  organization_number text NOT NULL,
  database_number integer NOT NULL UNIQUE
);

-- Reader roles ------------------------------------------------------------------
--
-- Binds each reader role to one company. Only the owner writes it. A reader
-- sees only its own row, which ledger.reader_company_id() reads, so a
-- reader's policies never trust a setting. A binding holds the role's oid
-- and, next to it, the role's name, which its trigger writes from the oid. A
-- reader's binding is the one with both its oid and its name. So a role that
-- is dropped and made again with the same name, another role renamed to it,
-- or the bound role renamed, is not the role that was bound, and reads
-- nothing until the owner binds it. A dump restored into another cluster
-- brings the bindings with the old oids, which the new cluster may give to
-- other roles: such a role has the oid but not the name, and reads nothing.

CREATE TABLE ledger.reader_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES ledger.companies (company_id),
  role_oid oid NOT NULL UNIQUE,
  role_name name NOT NULL,
  UNIQUE (company_id, id)
);

-- Behandlingshistorik -----------------------------------------------------------
--
-- One row per inserted, updated or deleted row of every company table,
-- written by the audit_history trigger in the same transaction: the table,
-- the row, the operation, the whole old and new row, the actor and its kind,
-- the transaction and the time to the microsecond. Its trigger refuses a
-- change or a deletion of a history row from every role, the owner's
-- statements too. The owner owns the table and could switch the trigger
-- off; no runtime role can.

CREATE TABLE audit.history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id uuid NOT NULL,
  table_name text NOT NULL,
  row_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  old_values jsonb,
  new_values jsonb,
  actor_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'system', 'integration')),
  transaction_id xid8 NOT NULL,
  at timestamptz NOT NULL,
  CHECK ((old_values IS NULL) = (operation = 'INSERT')),
  CHECK ((new_values IS NULL) = (operation = 'DELETE'))
);
CREATE INDEX history_row ON audit.history (company_id, table_name, row_id);

-- Settings ----------------------------------------------------------------------
--
-- The server sets these for each transaction with set_config(name, value,
-- true), which SET LOCAL does too: nortfox.company_id (a uuid),
-- nortfox.actor_id (a uuid) and nortfox.actor_kind (user, system or
-- integration). An empty setting counts as unset.

-- The transaction's company, or NULL. The app's and the owner's policies
-- compare company_id with it, so with no company set a query returns nothing.
CREATE FUNCTION ledger.current_company_id() RETURNS uuid
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
RETURN NULLIF(current_setting('nortfox.company_id', true), '')::uuid;

-- The oid of the current role, which a reader's binding holds. It reads no
-- setting.
CREATE FUNCTION ledger.current_role_oid() RETURNS oid
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = CURRENT_USER;
END;

-- The company that the current reader role is bound to, or NULL. It reads no
-- setting.
CREATE FUNCTION ledger.reader_company_id() RETURNS uuid
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT r.company_id FROM ledger.reader_roles AS r WHERE r.role_oid = ledger.current_role_oid() AND r.role_name = CURRENT_USER;
END;

-- The actor that each backend's writing transaction keeps. A rule that
-- depends on the actor, such as the period lock, is checked for the actor
-- that is set when its trigger runs, and the stamps and the history record
-- the actor that is set when theirs run. Any role can change a setting at any
-- time, also in the middle of a statement. So the first time a transaction's
-- write reads its actor, ledger.current_actor() keeps that actor and its kind
-- here, and refuses any other for the rest of the transaction. The table
-- holds one row per backend, for the transaction that last wrote in it: each
-- such transaction writes over it. It is not ledger data, and is unlogged, so
-- a crash, which ends every transaction, empties it. Only the owner writes it,
-- through ledger.current_actor(), and no other role may read it.
CREATE UNLOGGED TABLE ledger.transaction_actors (
  backend_pid integer PRIMARY KEY,
  transaction_id xid8 NOT NULL,
  actor_id uuid NOT NULL,
  actor_kind text NOT NULL
);

-- The transaction's actor and its kind. A write with no actor is refused,
-- and so is a write under another actor or kind than the transaction's
-- first write had (insufficient privilege, 42501). The writes of a savepoint
-- that rolled back keep no actor.
CREATE FUNCTION ledger.current_actor(OUT actor_id uuid, OUT actor_kind text)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $actor$
DECLARE
  id_setting text := NULLIF(current_setting('nortfox.actor_id', true), '');
  kind_setting text := NULLIF(current_setting('nortfox.actor_kind', true), '');
  kept_transaction xid8;
  kept_id uuid;
  kept_kind text;
BEGIN
  IF id_setting IS NULL THEN
    PERFORM ledger.refuse('actor_missing', jsonb_build_object('setting', 'nortfox.actor_id'));
  END IF;
  IF kind_setting IS NULL OR kind_setting NOT IN ('user', 'system', 'integration') THEN
    PERFORM ledger.refuse('actor_missing', jsonb_build_object('setting', 'nortfox.actor_kind'));
  END IF;
  actor_id := id_setting::uuid;
  actor_kind := kind_setting;
  SELECT t.transaction_id, t.actor_id, t.actor_kind INTO kept_transaction, kept_id, kept_kind
  FROM ledger.transaction_actors AS t
  WHERE t.backend_pid = pg_backend_pid();
  IF kept_transaction = pg_current_xact_id() THEN
    IF kept_id IS DISTINCT FROM current_actor.actor_id OR kept_kind IS DISTINCT FROM current_actor.actor_kind THEN
      RAISE EXCEPTION USING
        ERRCODE = 'insufficient_privilege',
        MESSAGE = 'The transaction''s actor changed after its first write. A transaction keeps one actor.';
    END IF;
    RETURN;
  END IF;
  INSERT INTO ledger.transaction_actors AS t (backend_pid, transaction_id, actor_id, actor_kind)
  VALUES (pg_backend_pid(), pg_current_xact_id(), current_actor.actor_id, current_actor.actor_kind)
  ON CONFLICT (backend_pid) DO UPDATE
  SET transaction_id = excluded.transaction_id, actor_id = excluded.actor_id, actor_kind = excluded.actor_kind;
END
$actor$;

-- The current transaction --------------------------------------------------------
--
-- Whether a row was written in the current transaction, by the id of the
-- transaction that wrote it (xact) and the time on the clock when it did
-- (at), both of which the triggers write. A transaction's id is unique only
-- in the history of one cluster: a dump restored into another cluster brings
-- the old ids, and that cluster gives the same ids out again. So the row's
-- time must also come after the current transaction began, which the time
-- of a row from before the restore never does. A clock set back during a
-- transaction makes its own rows count as earlier ones, so its booking is
-- refused (counter_move), and the next try books.
CREATE FUNCTION ledger.in_this_transaction(xact xid8, at timestamptz) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
RETURN in_this_transaction.xact = pg_current_xact_id() AND in_this_transaction.at >= transaction_timestamp();

-- The isolation level ------------------------------------------------------------
--
-- The ledger is written at READ COMMITTED only, by every role. Its rules
-- check other rows under row locks: a booking locks its fiscal year's row
-- FOR SHARE, a change of the year's dates locks it for update, and the
-- period lock serialises the same way. At READ COMMITTED, each statement of a
-- trigger reads what is committed once it holds its lock. At REPEATABLE READ
-- and SERIALIZABLE, every statement reads the transaction's first snapshot,
-- and a lock that another transaction only held, and gave back at its
-- commit, raises no serialization failure. So such a transaction could miss
-- a voucher booked into the year it shortens, or a lock date set while it
-- changes a voucher. A write at either level is refused (read_committed_only),
-- with the level. READ UNCOMMITTED is READ COMMITTED in PostgreSQL. Reads may
-- run at any level.
CREATE FUNCTION ledger.assert_read_committed() RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $isolation$
DECLARE
  found_level text := current_setting('transaction_isolation');
BEGIN
  IF found_level NOT IN ('read committed', 'read uncommitted') THEN
    PERFORM ledger.refuse('read_committed_only', jsonb_build_object('isolation', found_level));
  END IF;
END
$isolation$;

-- Triggers ----------------------------------------------------------------------
--
-- Every trigger function is SECURITY DEFINER and owned by the owner. Its
-- EXECUTE is not granted to anyone: a trigger fires without it.
--
-- The internal-write rule. Some rows may only be written by the database's
-- own triggers, such as the history. A trigger refuses such a write when
-- pg_trigger_depth() is 1, the depth of a statement that a caller sent. The
-- app cannot reach depth 2 on its own: it can make no trigger and no function.

-- Writes the history row of one row change. Its argument is the table's key
-- column. Every company table has this trigger (the table guard checks it),
-- so it is also where a write at another level than READ COMMITTED is
-- refused, whichever table it is on, and where a row that would move to
-- another company is: a statement can change the transaction's company after
-- row level security has let the old row through, and the new row is then
-- checked against the new company. The history row of an insert or a delete
-- must be the transaction's company's, by the owner's policy on the history.
CREATE FUNCTION audit.write_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $history$
DECLARE
  actor record;
  old_row jsonb;
  new_row jsonb;
BEGIN
  PERFORM ledger.assert_read_committed();
  IF TG_OP <> 'INSERT' THEN
    old_row := to_jsonb(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_row := to_jsonb(NEW);
  END IF;
  IF TG_OP = 'UPDATE' AND (old_row ->> 'company_id') IS DISTINCT FROM (new_row ->> 'company_id') THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'company_id', 'operation', 'update'));
  END IF;
  SELECT a.actor_id, a.actor_kind INTO actor FROM ledger.current_actor() AS a;
  INSERT INTO audit.history
    (company_id, table_name, row_id, operation, old_values, new_values, actor_id, actor_kind, transaction_id, at)
  VALUES (
    (COALESCE(new_row, old_row) ->> 'company_id')::uuid,
    TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
    (COALESCE(new_row, old_row) ->> TG_ARGV[0])::uuid,
    TG_OP,
    old_row,
    new_row,
    actor.actor_id,
    actor.actor_kind,
    pg_current_xact_id(),
    clock_timestamp()
  );
  RETURN NULL;
END
$history$;

-- History rows come only from audit.write_history, and stay as written.
CREATE FUNCTION audit.history_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $append$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF pg_trigger_depth() < 2 THEN
      PERFORM ledger.refuse('internal_only', jsonb_build_object('table', 'audit.history', 'field', NULL));
    END IF;
    RETURN NEW;
  END IF;
  PERFORM ledger.refuse('append_only', jsonb_build_object('table', 'audit.history', 'operation', TG_OP));
  RETURN NULL;
END
$append$;

-- TRUNCATE skips the row triggers, so no row of a company table may go that
-- way, by any role.
CREATE FUNCTION ledger.refuse_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $truncate$
BEGIN
  PERFORM ledger.refuse('append_only', jsonb_build_object('table', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, 'operation', 'TRUNCATE'));
  RETURN NULL;
END
$truncate$;

-- A binding's role name comes from the role that its oid names, never from
-- the caller: a given name is refused. An oid that names no role gives no
-- name, and the NOT NULL refuses the binding. A binding never changes its
-- role: the owner deletes it and binds again.
CREATE FUNCTION ledger.reader_roles_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.role_name IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'role_name', 'operation', 'create'));
    END IF;
    NEW.role_name := (SELECT r.rolname FROM pg_catalog.pg_roles AS r WHERE r.oid = NEW.role_oid);
    RETURN NEW;
  END IF;
  IF NEW.role_oid IS DISTINCT FROM OLD.role_oid THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'role_oid', 'operation', 'update'));
  END IF;
  IF NEW.role_name IS DISTINCT FROM OLD.role_name THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'role_name', 'operation', 'update'));
  END IF;
  RETURN NEW;
END
$rules$;

-- A company's tenant id comes from the sequence, and neither it nor the
-- company_id ever changes.
CREATE FUNCTION ledger.companies_keys() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $keys$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.database_number IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'database_number', 'operation', 'create'));
    END IF;
    NEW.database_number := nextval('ledger.database_number_seq');
    RETURN NEW;
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'company_id', 'operation', 'update'));
  END IF;
  IF NEW.database_number IS DISTINCT FROM OLD.database_number THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'database_number', 'operation', 'update'));
  END IF;
  RETURN NEW;
END
$keys$;

-- Company tables ----------------------------------------------------------------
--
-- The planner keeps no statistics of a table's values. ANALYZE, which
-- autovacuum runs by itself, would keep the most common values and a
-- histogram of each column in pg_statistic, of every company's rows together.
-- Under row level security the planner still reads them for an operator that
-- is leakproof, such as = and < on text and on integers, and EXPLAIN shows its
-- row estimates to every role that may read the table. So a reader could
-- learn another company's values from its own EXPLAIN. With a statistics
-- target of 0 on every column, and on every expression column of the table's
-- indexes, ANALYZE keeps none. The planner then uses its default estimates
-- for them. A migration that adds a column or an index with an expression to
-- a company table calls this again. The table guard checks it.
CREATE FUNCTION meta.hide_statistics(target regclass) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $hide$
DECLARE
  found record;
BEGIN
  FOR found IN
    SELECT a.attname FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = target AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  LOOP
    EXECUTE format('ALTER TABLE %s ALTER COLUMN %I SET STATISTICS 0', target, found.attname);
  END LOOP;
  FOR found IN
    SELECT x.indexrelid::regclass AS index, a.attnum
    FROM pg_catalog.pg_index AS x
    JOIN pg_catalog.pg_attribute AS a ON a.attrelid = x.indexrelid AND a.attnum > 0
    WHERE x.indrelid = target AND x.indkey[a.attnum - 1] = 0
    ORDER BY 1, 2
  LOOP
    EXECUTE format('ALTER INDEX %s ALTER COLUMN %s SET STATISTICS 0', found.index, found.attnum);
  END LOOP;
END
$hide$;

-- What every company table gets, and what the table guard checks: row level
-- security, enabled and forced; the three policies; the history trigger with
-- the table's key column; the truncate trigger; no planner statistics of its
-- values; SELECT for the app and the readers. Each table then grants the app
-- only the writes it needs.
CREATE FUNCTION meta.protect_company_table(target regclass, key_column name) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $protect$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format(
    'CREATE POLICY company_app ON %s TO nortfox_app'
    ' USING (company_id = ledger.current_company_id()) WITH CHECK (company_id = ledger.current_company_id())',
    target);
  EXECUTE format(
    'CREATE POLICY company_owner ON %s TO nortfox_owner'
    ' USING (company_id = ledger.current_company_id()) WITH CHECK (company_id = ledger.current_company_id())',
    target);
  EXECUTE format(
    'CREATE POLICY company_reader ON %s FOR SELECT TO nortfox_reader USING (company_id = ledger.reader_company_id())',
    target);
  EXECUTE format(
    'CREATE TRIGGER audit_history AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION audit.write_history(%L)',
    target, key_column);
  EXECUTE format('CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION ledger.refuse_truncate()', target);
  PERFORM meta.hide_statistics(target);
  EXECUTE format('GRANT SELECT ON %s TO nortfox_app, nortfox_reader', target);
END
$protect$;

CREATE TRIGGER companies_keys BEFORE INSERT OR UPDATE ON ledger.companies
  FOR EACH ROW EXECUTE FUNCTION ledger.companies_keys();
SELECT meta.protect_company_table('ledger.companies', 'company_id');
GRANT INSERT, UPDATE ON ledger.companies TO nortfox_app;

-- The reader roles' bindings: the owner's company policy, and a reader's own
-- row by its role's oid and name. The app has no access at all.
ALTER TABLE ledger.reader_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.reader_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY company_owner ON ledger.reader_roles TO nortfox_owner
  USING (company_id = ledger.current_company_id()) WITH CHECK (company_id = ledger.current_company_id());
CREATE POLICY own_binding ON ledger.reader_roles FOR SELECT TO nortfox_reader
  USING (role_oid = ledger.current_role_oid() AND role_name = CURRENT_USER);
CREATE TRIGGER reader_roles_rules BEFORE INSERT OR UPDATE ON ledger.reader_roles
  FOR EACH ROW EXECUTE FUNCTION ledger.reader_roles_rules();
CREATE TRIGGER audit_history AFTER INSERT OR UPDATE OR DELETE ON ledger.reader_roles
  FOR EACH ROW EXECUTE FUNCTION audit.write_history('id');
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON ledger.reader_roles
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.refuse_truncate();
SELECT meta.hide_statistics('ledger.reader_roles');
GRANT SELECT ON ledger.reader_roles TO nortfox_reader;

-- The history: the three company policies and the truncate trigger, but no
-- history trigger of its own. The app and the readers only read it.
ALTER TABLE audit.history ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.history FORCE ROW LEVEL SECURITY;
CREATE POLICY company_app ON audit.history TO nortfox_app
  USING (company_id = ledger.current_company_id()) WITH CHECK (company_id = ledger.current_company_id());
CREATE POLICY company_owner ON audit.history TO nortfox_owner
  USING (company_id = ledger.current_company_id()) WITH CHECK (company_id = ledger.current_company_id());
CREATE POLICY company_reader ON audit.history FOR SELECT TO nortfox_reader
  USING (company_id = ledger.reader_company_id());
CREATE TRIGGER history_append_only BEFORE INSERT OR UPDATE OR DELETE ON audit.history
  FOR EACH ROW EXECUTE FUNCTION audit.history_append_only();
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON audit.history
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.refuse_truncate();
SELECT meta.hide_statistics('audit.history');
GRANT SELECT ON audit.history TO nortfox_app, nortfox_reader;

-- The helpers that the policies call.
GRANT EXECUTE ON FUNCTION ledger.current_company_id() TO nortfox_app, nortfox_reader;
GRANT EXECUTE ON FUNCTION ledger.current_role_oid(), ledger.reader_company_id() TO nortfox_reader;
