-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0003 accounts and series: each fiscal year's accounts, its voucher series,
-- each series' counter of the next number, and the void ranges that a restore
-- records. See db/README.md, and decisions 0002 and 0007 in docs/decisions/.
--
-- As in 0001: every name of ours is written in full, every function pins its
-- search path, and every trigger function runs with the owner's rights.

-- Accounts --------------------------------------------------------------------
--
-- An account belongs to a fiscal year: its number, which never changes, its
-- name (description) and its active flag. modified_at moves with every
-- accepted change, and only the trigger writes it. An unused account can be
-- removed, and the behandlingshistorik keeps its last state. One that holds
-- rows cannot: 0004 counts them.

CREATE TABLE ledger.accounts (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  company_id uuid NOT NULL,
  fiscal_year_id uuid NOT NULL,
  number integer NOT NULL,
  description text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  modified_at timestamptz NOT NULL,
  UNIQUE (company_id, id),
  CONSTRAINT accounts_fiscal_year FOREIGN KEY (company_id, fiscal_year_id) REFERENCES ledger.fiscal_years (company_id, id),
  CONSTRAINT accounts_number_unique UNIQUE (company_id, fiscal_year_id, number)
);

-- Voucher series ----------------------------------------------------------------
--
-- A series belongs to a fiscal year: a code of 1 to 10 digits and capital
-- letters, Å, Ä and Ö included, that is unique in its year and never changes;
-- a name of at most 200 characters, which may be empty; the manual flag; and
-- the closing mark, which at most one series of a year carries. modified_at
-- moves with every accepted change, and only the trigger writes it. The
-- trigger gives the code's refusals with their reasons; the checks and the
-- unique key below hold the same rules if it is ever off.
--
-- The next number is the series' too, as the compatible API shows it, so
-- every move of it is a change of the series. The counter is a table of its
-- own, with a modified time of its own that each move sets. The series'
-- modified time, as lastmodified reads it, is the later of the two.

CREATE TABLE ledger.voucher_series (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  company_id uuid NOT NULL,
  fiscal_year_id uuid NOT NULL,
  code text NOT NULL,
  description text NOT NULL DEFAULT '',
  manual boolean NOT NULL,
  is_closing boolean NOT NULL DEFAULT false,
  modified_at timestamptz NOT NULL,
  UNIQUE (company_id, id),
  CONSTRAINT voucher_series_fiscal_year FOREIGN KEY (company_id, fiscal_year_id) REFERENCES ledger.fiscal_years (company_id, id),
  CONSTRAINT voucher_series_code_unique UNIQUE (company_id, fiscal_year_id, code),
  CONSTRAINT voucher_series_code_form CHECK (code ~ '^[0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZÅÄÖ]{1,10}$'),
  CONSTRAINT voucher_series_description_length CHECK (char_length(description) <= 200)
);
CREATE UNIQUE INDEX voucher_series_one_closing ON ledger.voucher_series (company_id, fiscal_year_id) WHERE is_closing;

-- Counters ----------------------------------------------------------------------
--
-- The next number of each series in its fiscal year. A trigger makes it at 1
-- with its series, and it goes only with its series. Only the database's own
-- triggers move it, and only with proof in the same transaction: past a void
-- range that starts at it. 0004 adds the booking that moves it up by one and
-- the deletion of the last voucher that moves it back by one. modified_at is
-- when it was made or last moved.

CREATE TABLE ledger.voucher_counters (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  company_id uuid NOT NULL,
  series_id uuid NOT NULL,
  next_number integer NOT NULL DEFAULT 1,
  modified_at timestamptz NOT NULL,
  UNIQUE (company_id, id),
  CONSTRAINT voucher_counters_one_per_series UNIQUE (company_id, series_id),
  CONSTRAINT voucher_counters_series FOREIGN KEY (company_id, series_id) REFERENCES ledger.voucher_series (company_id, id) ON DELETE CASCADE,
  CONSTRAINT voucher_counters_next_number CHECK (next_number >= 1)
);

-- Void ranges -------------------------------------------------------------------
--
-- A recorded skip in a series: the series, its fiscal year, the first and the
-- last number skipped, and the reason. Only the owner records one, as the
-- restore tool will (decision 7), and only from the series' counter, which
-- then moves past it. So a range never leaves a gap and never covers a number
-- that was given out. The trigger writes who recorded it and when. No role
-- changes or deletes one, and the series it names stays while it is there.

CREATE TABLE ledger.void_ranges (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  company_id uuid NOT NULL,
  fiscal_year_id uuid NOT NULL,
  series_code text NOT NULL,
  first_number integer NOT NULL,
  last_number integer NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_by_kind text NOT NULL CONSTRAINT void_ranges_created_by_kind CHECK (created_by_kind IN ('user', 'system', 'integration')),
  created_xact xid8 NOT NULL,
  UNIQUE (company_id, id),
  CONSTRAINT void_ranges_series FOREIGN KEY (company_id, fiscal_year_id, series_code)
    REFERENCES ledger.voucher_series (company_id, fiscal_year_id, code) ON DELETE RESTRICT,
  CONSTRAINT void_ranges_numbers_in_order CHECK (first_number <= last_number),
  CONSTRAINT void_ranges_reason_given CHECK (reason <> '')
);

-- Triggers ------------------------------------------------------------------------

-- How many vouchers hold a row on the account, struck rows included. Until
-- 0004 adds the vouchers, none can.
CREATE FUNCTION ledger.account_voucher_count(company uuid, fiscal_year uuid, account_number integer) RETURNS bigint
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
RETURN 0;

-- An account's number, its year and its id never change, and the trigger
-- alone writes its modified time. An account with rows cannot be removed.
CREATE FUNCTION ledger.accounts_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
DECLARE
  used bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    used := ledger.account_voucher_count(OLD.company_id, OLD.fiscal_year_id, OLD.number);
    IF used > 0 THEN
      PERFORM ledger.refuse('account_has_rows', jsonb_build_object('number', OLD.number, 'count', used));
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.modified_at IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'modified_at', 'operation', 'create'));
    END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'id', 'operation', 'update'));
    END IF;
    IF NEW.fiscal_year_id IS DISTINCT FROM OLD.fiscal_year_id THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'fiscal_year_id', 'operation', 'update'));
    END IF;
    IF NEW.number IS DISTINCT FROM OLD.number THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'number', 'operation', 'update'));
    END IF;
    IF NEW.modified_at IS DISTINCT FROM OLD.modified_at THEN
      PERFORM ledger.refuse('internal_only', jsonb_build_object('table', 'ledger.accounts', 'field', 'modified_at'));
    END IF;
  END IF;
  NEW.modified_at := clock_timestamp();
  RETURN NEW;
END
$rules$;

-- A series' code: 1 to 10 of these characters, written out rather than as a
-- range, so that no collation can widen the set. It is unique in its year and
-- never changes. A series made now waits for another one made in the same
-- year, by a lock on the year's row, so the check of the code sees every
-- series and refuses a duplicate with its reason. A series' year and id never
-- change, its name is at most 200 characters, and the trigger alone writes
-- its modified time. The closing mark decides whether the period lock applies
-- to the series' vouchers. A change of a voucher locks its series' row FOR
-- SHARE before it reads the mark (ledger.assert_voucher_open, 0004), so a
-- change of the mark waits for it, and it waits for a change of the mark.
CREATE FUNCTION ledger.voucher_series_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.modified_at IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'modified_at', 'operation', 'create'));
    END IF;
    IF NEW.code IS NULL OR NEW.code !~ '^[0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZÅÄÖ]{1,10}$' THEN
      PERFORM ledger.refuse('series_code_invalid', jsonb_build_object('code', NEW.code));
    END IF;
    PERFORM 1 FROM ledger.fiscal_years AS y WHERE y.company_id = NEW.company_id AND y.id = NEW.fiscal_year_id FOR NO KEY UPDATE;
    IF EXISTS (
      SELECT FROM ledger.voucher_series AS s
      WHERE s.company_id = NEW.company_id AND s.fiscal_year_id = NEW.fiscal_year_id AND s.code = NEW.code
    ) THEN
      PERFORM ledger.refuse('series_code_duplicate', jsonb_build_object('code', NEW.code));
    END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'id', 'operation', 'update'));
    END IF;
    IF NEW.fiscal_year_id IS DISTINCT FROM OLD.fiscal_year_id THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'fiscal_year_id', 'operation', 'update'));
    END IF;
    IF NEW.code IS DISTINCT FROM OLD.code THEN
      PERFORM ledger.refuse('series_code_changed', jsonb_build_object('code', OLD.code));
    END IF;
    IF NEW.modified_at IS DISTINCT FROM OLD.modified_at THEN
      PERFORM ledger.refuse('internal_only', jsonb_build_object('table', 'ledger.voucher_series', 'field', 'modified_at'));
    END IF;
  END IF;
  IF char_length(NEW.description) > 200 THEN
    PERFORM ledger.refuse('value_too_long', jsonb_build_object('field', 'description', 'value', NEW.description));
  END IF;
  NEW.modified_at := clock_timestamp();
  RETURN NEW;
END
$rules$;

-- Every new series gets its counter, at 1.
CREATE FUNCTION ledger.voucher_series_make_counter() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $made$
BEGIN
  INSERT INTO ledger.voucher_counters (company_id, series_id) VALUES (NEW.company_id, NEW.id);
  RETURN NULL;
END
$made$;

-- The internal-write rule for the counters: only the database's own triggers
-- make, move or remove one, never a statement that a caller sent. Every
-- change of the next number needs its proof in the same transaction: a void
-- range recorded in it that starts at the old next number and ends just
-- before the new one. Anything else is a counter_move. Each accepted move
-- sets the modified time. A counter goes only when its series has gone, which
-- is the cascade. Its id and its series never change.
CREATE FUNCTION ledger.voucher_counters_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
DECLARE
  series record;
BEGIN
  IF pg_trigger_depth() < 2 THEN
    PERFORM ledger.refuse('internal_only', jsonb_build_object('table', 'ledger.voucher_counters', 'field', CASE WHEN TG_OP = 'UPDATE' THEN 'next_number' END));
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.modified_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT FROM ledger.voucher_series AS s WHERE s.company_id = OLD.company_id AND s.id = OLD.series_id) THEN
      PERFORM ledger.refuse('internal_only', jsonb_build_object('table', 'ledger.voucher_counters', 'field', NULL));
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'id', 'operation', 'update'));
  END IF;
  IF NEW.series_id IS DISTINCT FROM OLD.series_id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'series_id', 'operation', 'update'));
  END IF;
  SELECT s.fiscal_year_id, s.code INTO series
  FROM ledger.voucher_series AS s
  WHERE s.company_id = NEW.company_id AND s.id = NEW.series_id;
  IF EXISTS (
    SELECT FROM ledger.void_ranges AS v
    WHERE v.company_id = NEW.company_id AND v.fiscal_year_id = series.fiscal_year_id AND v.series_code = series.code
      AND v.first_number = OLD.next_number AND v.last_number + 1 = NEW.next_number
      AND v.created_xact = pg_current_xact_id()
  ) THEN
    NEW.modified_at := clock_timestamp();
    RETURN NEW;
  END IF;
  PERFORM ledger.refuse('counter_move', jsonb_build_object('series', series.code, 'from', OLD.next_number, 'to', NEW.next_number));
  RETURN NULL;
END
$rules$;

-- A void range starts at its series' counter, which it locks until the
-- transaction ends, so that a booking or another range waits and then sees
-- the counter it left. Who recorded the range and when come from the
-- transaction's actor, never from the caller. When the series is not there,
-- or not in the transaction's company, the foreign key or row level security
-- refuses the range. Its trigger refuses a change or a deletion of a range
-- from every role, the owner's statements too.
CREATE FUNCTION ledger.void_ranges_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
DECLARE
  actor record;
  counter record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM ledger.refuse('append_only', jsonb_build_object('table', 'ledger.void_ranges', 'operation', TG_OP));
  END IF;
  IF NEW.created_at IS NOT NULL THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_at', 'operation', 'create'));
  END IF;
  IF NEW.created_by IS NOT NULL THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_by', 'operation', 'create'));
  END IF;
  IF NEW.created_by_kind IS NOT NULL THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_by_kind', 'operation', 'create'));
  END IF;
  IF NEW.created_xact IS NOT NULL THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_xact', 'operation', 'create'));
  END IF;
  SELECT c.next_number INTO counter
  FROM ledger.voucher_counters AS c
  JOIN ledger.voucher_series AS s ON s.company_id = c.company_id AND s.id = c.series_id
  WHERE s.company_id = NEW.company_id AND s.fiscal_year_id = NEW.fiscal_year_id AND s.code = NEW.series_code
  FOR UPDATE OF c;
  IF FOUND AND NEW.first_number IS DISTINCT FROM counter.next_number THEN
    PERFORM ledger.refuse('void_range_not_at_counter', jsonb_build_object('first_number', NEW.first_number, 'next_number', counter.next_number));
  END IF;
  SELECT a.actor_id, a.actor_kind INTO actor FROM ledger.current_actor() AS a;
  NEW.created_at := clock_timestamp();
  NEW.created_by := actor.actor_id;
  NEW.created_by_kind := actor.actor_kind;
  NEW.created_xact := pg_current_xact_id();
  RETURN NEW;
END
$rules$;

-- A recorded void range moves its series' counter past it.
CREATE FUNCTION ledger.void_ranges_move_counter() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $moved$
BEGIN
  UPDATE ledger.voucher_counters AS c
  SET next_number = NEW.last_number + 1
  FROM ledger.voucher_series AS s
  WHERE s.company_id = NEW.company_id AND s.fiscal_year_id = NEW.fiscal_year_id AND s.code = NEW.series_code
    AND c.company_id = s.company_id AND c.series_id = s.id;
  RETURN NULL;
END
$moved$;

CREATE TRIGGER accounts_rules BEFORE INSERT OR UPDATE OR DELETE ON ledger.accounts
  FOR EACH ROW EXECUTE FUNCTION ledger.accounts_rules();
CREATE TRIGGER voucher_series_rules BEFORE INSERT OR UPDATE ON ledger.voucher_series
  FOR EACH ROW EXECUTE FUNCTION ledger.voucher_series_rules();
CREATE TRIGGER voucher_series_make_counter AFTER INSERT ON ledger.voucher_series
  FOR EACH ROW EXECUTE FUNCTION ledger.voucher_series_make_counter();
CREATE TRIGGER voucher_counters_rules BEFORE INSERT OR UPDATE OR DELETE ON ledger.voucher_counters
  FOR EACH ROW EXECUTE FUNCTION ledger.voucher_counters_rules();
CREATE TRIGGER void_ranges_rules BEFORE INSERT OR UPDATE OR DELETE ON ledger.void_ranges
  FOR EACH ROW EXECUTE FUNCTION ledger.void_ranges_rules();
CREATE TRIGGER void_ranges_move_counter AFTER INSERT ON ledger.void_ranges
  FOR EACH ROW EXECUTE FUNCTION ledger.void_ranges_move_counter();
-- A change of a voucher's row locks its account FOR SHARE, and a booking its
-- series' row and its year's row (0004). So a change or a deletion of an
-- account or a series, and a new series, which locks its year's row for
-- update, first take the company's turn alone (0002).
CREATE TRIGGER take_turn_alone BEFORE UPDATE OR DELETE ON ledger.accounts
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.take_turn_alone();
CREATE TRIGGER take_turn_alone BEFORE INSERT OR UPDATE OR DELETE ON ledger.voucher_series
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.take_turn_alone();

SELECT meta.protect_company_table('ledger.accounts', 'id');
SELECT meta.protect_company_table('ledger.voucher_series', 'id');
SELECT meta.protect_company_table('ledger.voucher_counters', 'id');
SELECT meta.protect_company_table('ledger.void_ranges', 'id');
GRANT INSERT, UPDATE, DELETE ON ledger.accounts, ledger.voucher_series TO nortfox_app;
