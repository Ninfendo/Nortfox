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
-- included: a temporary table could shadow a name.
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
    ('fiscal_year_strands_rows', 'NF057')
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
-- reader's policies never trust a setting.

CREATE TABLE ledger.reader_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES ledger.companies (company_id),
  role_name name NOT NULL UNIQUE,
  UNIQUE (company_id, id)
);

-- Behandlingshistorik -----------------------------------------------------------
--
-- One row per inserted, updated or deleted row of every company table,
-- written by the audit_history trigger in the same transaction: the table,
-- the row, the operation, the whole old and new row, the actor and its kind,
-- the transaction and the time to the microsecond. No role changes or deletes
-- a history row, the owner neither.

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

-- The company that the current reader role is bound to, or NULL. It reads no
-- setting.
CREATE FUNCTION ledger.reader_company_id() RETURNS uuid
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT r.company_id FROM ledger.reader_roles AS r WHERE r.role_name = CURRENT_USER;
END;

-- The transaction's actor and its kind. A write with no actor is refused.
CREATE FUNCTION ledger.current_actor(OUT actor_id uuid, OUT actor_kind text)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $actor$
DECLARE
  id_setting text := NULLIF(current_setting('nortfox.actor_id', true), '');
  kind_setting text := NULLIF(current_setting('nortfox.actor_kind', true), '');
BEGIN
  IF id_setting IS NULL THEN
    PERFORM ledger.refuse('actor_missing', jsonb_build_object('setting', 'nortfox.actor_id'));
  END IF;
  IF kind_setting IS NULL OR kind_setting NOT IN ('user', 'system', 'integration') THEN
    PERFORM ledger.refuse('actor_missing', jsonb_build_object('setting', 'nortfox.actor_kind'));
  END IF;
  actor_id := id_setting::uuid;
  actor_kind := kind_setting;
END
$actor$;

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
-- column.
CREATE FUNCTION audit.write_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $history$
DECLARE
  actor record;
  old_row jsonb;
  new_row jsonb;
BEGIN
  SELECT a.actor_id, a.actor_kind INTO actor FROM ledger.current_actor() AS a;
  IF TG_OP <> 'INSERT' THEN
    old_row := to_jsonb(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_row := to_jsonb(NEW);
  END IF;
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
-- What every company table gets, and what the table guard checks: row level
-- security, enabled and forced; the three policies; the history trigger with
-- the table's key column; the truncate trigger; SELECT for the app and the
-- readers. Each table then grants the app only the writes it needs.
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
  EXECUTE format('GRANT SELECT ON %s TO nortfox_app, nortfox_reader', target);
END
$protect$;

CREATE TRIGGER companies_keys BEFORE INSERT OR UPDATE ON ledger.companies
  FOR EACH ROW EXECUTE FUNCTION ledger.companies_keys();
SELECT meta.protect_company_table('ledger.companies', 'company_id');
GRANT INSERT, UPDATE ON ledger.companies TO nortfox_app;

-- The reader roles' bindings: the owner's company policy, and a reader's own
-- row by its name. The app has no access at all.
ALTER TABLE ledger.reader_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.reader_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY company_owner ON ledger.reader_roles TO nortfox_owner
  USING (company_id = ledger.current_company_id()) WITH CHECK (company_id = ledger.current_company_id());
CREATE POLICY own_binding ON ledger.reader_roles FOR SELECT TO nortfox_reader
  USING (role_name = CURRENT_USER);
CREATE TRIGGER audit_history AFTER INSERT OR UPDATE OR DELETE ON ledger.reader_roles
  FOR EACH ROW EXECUTE FUNCTION audit.write_history('id');
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON ledger.reader_roles
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.refuse_truncate();
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
GRANT SELECT ON audit.history TO nortfox_app, nortfox_reader;

-- The helpers that the policies call.
GRANT EXECUTE ON FUNCTION ledger.current_company_id() TO nortfox_app, nortfox_reader;
GRANT EXECUTE ON FUNCTION ledger.reader_company_id() TO nortfox_reader;
