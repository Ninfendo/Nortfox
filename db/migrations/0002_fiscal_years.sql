-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0002 fiscal years: the fiscal years and their periods, the period lock and
-- the automatic lock's settings, and the functions that say whether a date is
-- locked for an actor. See db/README.md, and decision 0002 in docs/decisions/.
--
-- As in 0001: every name of ours is written in full, every function pins its
-- search path, and every trigger function runs with the owner's rights.

-- Fiscal years ----------------------------------------------------------------
--
-- A fiscal year has a from and a to date, an accounting method and a chart
-- name. It has no open or closed state: a whole year is locked with the period
-- lock. Its year_number is the integer that the compatible API uses for the
-- year: the company's highest plus one, in the order the years are made,
-- unique in the company and never changed. A company has at most one default
-- year, and its years never overlap, not even by one day.

CREATE TABLE ledger.fiscal_years (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES ledger.companies (company_id),
  year_number integer NOT NULL,
  from_date date NOT NULL,
  to_date date NOT NULL,
  accounting_method text NOT NULL CONSTRAINT fiscal_years_accounting_method CHECK (accounting_method IN ('ACCRUAL', 'CASH')),
  account_chart_type text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  UNIQUE (company_id, id),
  CONSTRAINT fiscal_years_year_number_unique UNIQUE (company_id, year_number),
  CONSTRAINT fiscal_years_dates_in_order CHECK (from_date <= to_date),
  CONSTRAINT fiscal_years_no_overlap EXCLUDE USING gist (company_id WITH =, daterange(from_date, to_date, '[]') WITH &&)
);
CREATE UNIQUE INDEX fiscal_years_one_default ON ledger.fiscal_years (company_id) WHERE is_default;

-- Periods -----------------------------------------------------------------------
--
-- A fiscal year's periods, each with a from and a to date. A period lies
-- inside its year, and two periods of one year never overlap. A period has no
-- lock state of its own: a lock is a date, and a period is locked when its
-- dates are.

CREATE TABLE ledger.periods (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  company_id uuid NOT NULL,
  fiscal_year_id uuid NOT NULL,
  from_date date NOT NULL,
  to_date date NOT NULL,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, fiscal_year_id) REFERENCES ledger.fiscal_years (company_id, id),
  CONSTRAINT periods_dates_in_order CHECK (from_date <= to_date),
  CONSTRAINT periods_no_overlap EXCLUDE USING gist (fiscal_year_id WITH =, daterange(from_date, to_date, '[]') WITH &&)
);

-- The period lock ---------------------------------------------------------------
--
-- A locked-through date per company for each user, for the internal system
-- user, for integrations and for all users: one row per scope, and per user
-- for the user scope. Every date up to and including end_date is locked for
-- the actors the row applies to. A NULL end_date is a cleared lock. The rows
-- are never deleted, and each date is set and cleared on its own. The trigger
-- writes who set the date and when.

CREATE TABLE ledger.period_locks (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES ledger.companies (company_id),
  scope text NOT NULL CONSTRAINT period_locks_scope CHECK (scope IN ('user', 'system', 'integration', 'all')),
  user_id uuid,
  end_date date,
  set_by uuid NOT NULL,
  set_by_kind text NOT NULL CONSTRAINT period_locks_set_by_kind CHECK (set_by_kind IN ('user', 'system', 'integration')),
  set_at timestamptz NOT NULL,
  UNIQUE (company_id, id),
  CONSTRAINT period_locks_one_per_scope UNIQUE NULLS NOT DISTINCT (company_id, scope, user_id),
  CONSTRAINT period_locks_user_only_for_user CHECK ((user_id IS NOT NULL) = (scope = 'user'))
);

-- The automatic lock --------------------------------------------------------------
--
-- One row per company, made with the company and off. When it is on, it has
-- one of the three intervals: 50 days after the end of the month, 50 days
-- after the end of the quarter, or 60 days after the end of the fiscal year.
-- notice_days is how many days before a lock the users are told, for the
-- reminders of a later slice. The trigger writes who changed it and when.

CREATE TABLE ledger.automatic_locks (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES ledger.companies (company_id),
  enabled boolean NOT NULL DEFAULT false,
  interval text CONSTRAINT automatic_locks_interval CHECK (interval IN ('month_end_50', 'quarter_end_50', 'year_end_60')),
  notice_days integer CONSTRAINT automatic_locks_notice_days CHECK (notice_days >= 0),
  set_by uuid NOT NULL,
  set_by_kind text NOT NULL CONSTRAINT automatic_locks_set_by_kind CHECK (set_by_kind IN ('user', 'system', 'integration')),
  set_at timestamptz NOT NULL,
  UNIQUE (company_id, id),
  CONSTRAINT automatic_locks_one_per_company UNIQUE (company_id),
  CONSTRAINT automatic_locks_interval_when_on CHECK (NOT enabled OR interval IS NOT NULL)
);

-- Triggers ------------------------------------------------------------------------

-- A fiscal year's number: the company's highest plus one, under a lock on the
-- company's row, so two years made at the same time get the next two numbers.
-- The number and the id never change, and new dates never leave a period of
-- the year outside it.
CREATE FUNCTION ledger.fiscal_years_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
DECLARE
  stranded bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.year_number IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'year_number', 'operation', 'create'));
    END IF;
    PERFORM 1 FROM ledger.companies AS c WHERE c.company_id = NEW.company_id FOR NO KEY UPDATE;
    NEW.year_number := (SELECT COALESCE(max(y.year_number), 0) + 1 FROM ledger.fiscal_years AS y WHERE y.company_id = NEW.company_id);
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'id', 'operation', 'update'));
  END IF;
  IF NEW.year_number IS DISTINCT FROM OLD.year_number THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'year_number', 'operation', 'update'));
  END IF;
  IF NEW.from_date IS DISTINCT FROM OLD.from_date OR NEW.to_date IS DISTINCT FROM OLD.to_date THEN
    -- A period that is added now waits for this row: ledger.periods_rules
    -- locks the year's row FOR SHARE, so this count sees every period.
    stranded := (
      SELECT count(*) FROM ledger.periods AS p
      WHERE p.company_id = NEW.company_id AND p.fiscal_year_id = NEW.id
        AND (p.from_date < NEW.from_date OR p.to_date > NEW.to_date)
    );
    IF stranded > 0 THEN
      PERFORM ledger.refuse('fiscal_year_strands_rows', jsonb_build_object('table', 'ledger.periods', 'count', stranded));
    END IF;
  END IF;
  RETURN NEW;
END
$rules$;

-- A period lies inside its year. It locks the year's row FOR SHARE until the
-- transaction ends, so the year's dates cannot change under it. When the year
-- is not there, the foreign key or row level security refuses the period.
CREATE FUNCTION ledger.periods_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
DECLARE
  fiscal record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'id', 'operation', 'update'));
  END IF;
  SELECT y.from_date, y.to_date INTO fiscal
  FROM ledger.fiscal_years AS y
  WHERE y.company_id = NEW.company_id AND y.id = NEW.fiscal_year_id
  FOR SHARE;
  IF FOUND AND (NEW.from_date < fiscal.from_date OR NEW.to_date > fiscal.to_date) THEN
    PERFORM ledger.refuse('period_outside_fiscal_year', jsonb_build_object('from_date', NEW.from_date, 'to_date', NEW.to_date));
  END IF;
  RETURN NEW;
END
$rules$;

-- Who set a lock date and when come from the transaction's actor, never from
-- the caller. A row's scope, its user and its id never change.
CREATE FUNCTION ledger.period_locks_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
DECLARE
  actor record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.set_by IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'set_by', 'operation', 'create'));
    END IF;
    IF NEW.set_by_kind IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'set_by_kind', 'operation', 'create'));
    END IF;
    IF NEW.set_at IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'set_at', 'operation', 'create'));
    END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'id', 'operation', 'update'));
    END IF;
    IF NEW.scope IS DISTINCT FROM OLD.scope THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'scope', 'operation', 'update'));
    END IF;
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'user_id', 'operation', 'update'));
    END IF;
    IF NEW.set_by IS DISTINCT FROM OLD.set_by THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'set_by', 'operation', 'update'));
    END IF;
    IF NEW.set_by_kind IS DISTINCT FROM OLD.set_by_kind THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'set_by_kind', 'operation', 'update'));
    END IF;
    IF NEW.set_at IS DISTINCT FROM OLD.set_at THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'set_at', 'operation', 'update'));
    END IF;
  END IF;
  SELECT a.actor_id, a.actor_kind INTO actor FROM ledger.current_actor() AS a;
  NEW.set_by := actor.actor_id;
  NEW.set_by_kind := actor.actor_kind;
  NEW.set_at := clock_timestamp();
  RETURN NEW;
END
$rules$;

-- The same for the automatic lock's settings: who changed them and when come
-- from the transaction's actor, and the row's id never changes.
CREATE FUNCTION ledger.automatic_locks_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
DECLARE
  actor record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.set_by IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'set_by', 'operation', 'create'));
    END IF;
    IF NEW.set_by_kind IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'set_by_kind', 'operation', 'create'));
    END IF;
    IF NEW.set_at IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'set_at', 'operation', 'create'));
    END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'id', 'operation', 'update'));
    END IF;
    IF NEW.set_by IS DISTINCT FROM OLD.set_by THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'set_by', 'operation', 'update'));
    END IF;
    IF NEW.set_by_kind IS DISTINCT FROM OLD.set_by_kind THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'set_by_kind', 'operation', 'update'));
    END IF;
    IF NEW.set_at IS DISTINCT FROM OLD.set_at THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'set_at', 'operation', 'update'));
    END IF;
  END IF;
  SELECT a.actor_id, a.actor_kind INTO actor FROM ledger.current_actor() AS a;
  NEW.set_by := actor.actor_id;
  NEW.set_by_kind := actor.actor_kind;
  NEW.set_at := clock_timestamp();
  RETURN NEW;
END
$rules$;

-- Every new company gets its automatic lock row, off.
CREATE FUNCTION ledger.companies_automatic_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $made$
BEGIN
  INSERT INTO ledger.automatic_locks (company_id) VALUES (NEW.company_id);
  RETURN NULL;
END
$made$;

CREATE TRIGGER fiscal_years_rules BEFORE INSERT OR UPDATE ON ledger.fiscal_years
  FOR EACH ROW EXECUTE FUNCTION ledger.fiscal_years_rules();
CREATE TRIGGER periods_rules BEFORE INSERT OR UPDATE ON ledger.periods
  FOR EACH ROW EXECUTE FUNCTION ledger.periods_rules();
CREATE TRIGGER period_locks_rules BEFORE INSERT OR UPDATE ON ledger.period_locks
  FOR EACH ROW EXECUTE FUNCTION ledger.period_locks_rules();
CREATE TRIGGER automatic_locks_rules BEFORE INSERT OR UPDATE ON ledger.automatic_locks
  FOR EACH ROW EXECUTE FUNCTION ledger.automatic_locks_rules();
CREATE TRIGGER make_automatic_lock AFTER INSERT ON ledger.companies
  FOR EACH ROW EXECUTE FUNCTION ledger.companies_automatic_lock();

SELECT meta.protect_company_table('ledger.fiscal_years', 'id');
SELECT meta.protect_company_table('ledger.periods', 'id');
SELECT meta.protect_company_table('ledger.period_locks', 'id');
SELECT meta.protect_company_table('ledger.automatic_locks', 'id');
GRANT INSERT, UPDATE ON ledger.fiscal_years, ledger.periods, ledger.period_locks TO nortfox_app;
GRANT UPDATE ON ledger.automatic_locks TO nortfox_app;

-- Whether a date is locked ----------------------------------------------------------

-- The day in Sweden: the date in Europe/Stockholm when the transaction began.
-- It reads no setting, so neither the session's time zone nor any setting the
-- app can make moves it.
CREATE FUNCTION ledger.today_in_sweden() RETURNS date
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
RETURN (transaction_timestamp() AT TIME ZONE 'Europe/Stockholm')::date;

-- The date the automatic lock reaches on `today`, or NULL when it is off or
-- reaches nothing. A period that ends on day E is locked from day E + 50 on
-- (E + 60 for the fiscal year), so the lock reaches the last end of a month or
-- a calendar quarter on or before today - 50: the day before the first day of
-- the month or quarter of today - 49. For the fiscal year, it reaches the
-- latest end of one of the company's years with to_date + 60 <= today. No job
-- has to run for it.
CREATE FUNCTION ledger.automatic_lock_end_date(company uuid, today date) RETURNS date
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT CASE a.interval
      WHEN 'month_end_50' THEN
        make_date(extract(year FROM automatic_lock_end_date.today - 49)::integer, extract(month FROM automatic_lock_end_date.today - 49)::integer, 1) - 1
      WHEN 'quarter_end_50' THEN
        make_date(
          extract(year FROM automatic_lock_end_date.today - 49)::integer,
          (extract(quarter FROM automatic_lock_end_date.today - 49)::integer - 1) * 3 + 1,
          1
        ) - 1
      WHEN 'year_end_60' THEN
        (SELECT max(y.to_date) FROM ledger.fiscal_years AS y WHERE y.company_id = a.company_id AND y.to_date + 60 <= automatic_lock_end_date.today)
    END
  FROM ledger.automatic_locks AS a
  WHERE a.company_id = automatic_lock_end_date.company AND a.enabled;
END;

-- Every lock date that applies to an actor, with what a refusal names: the
-- actor's own row (the user's row for a user, the internal system user's row,
-- or the integrations' row), the all-users row, and the automatic lock, which
-- applies to everyone. A cleared date applies to no one. `precedence` orders
-- a tie: the actor's own row, then all users, then the automatic lock.
CREATE FUNCTION ledger.applicable_locks(company uuid, actor_kind text, actor_id uuid, today date)
RETURNS TABLE (source text, end_date date, user_id uuid, set_by uuid, set_by_kind text, set_at timestamptz, "interval" text, precedence integer)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $applicable$
BEGIN
  IF applicable_locks.actor_kind IS NULL OR applicable_locks.actor_kind NOT IN ('user', 'system', 'integration')
    OR (applicable_locks.actor_kind = 'user' AND applicable_locks.actor_id IS NULL) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'invalid_parameter_value',
      MESSAGE = 'The period lock needs the actor''s kind (user, system or integration), and a user''s id.';
  END IF;
  RETURN QUERY
    SELECT l.scope, l.end_date, l.user_id, l.set_by, l.set_by_kind, l.set_at, NULL::text, CASE WHEN l.scope = 'all' THEN 2 ELSE 1 END
    FROM ledger.period_locks AS l
    WHERE l.company_id = applicable_locks.company AND l.end_date IS NOT NULL
      AND (
        l.scope = 'all'
        OR (l.scope = 'user' AND applicable_locks.actor_kind = 'user' AND l.user_id = applicable_locks.actor_id)
        OR (l.scope IN ('system', 'integration') AND l.scope = applicable_locks.actor_kind)
      )
    UNION ALL
    SELECT 'automatic', e.through, NULL::uuid, NULL::uuid, NULL::text, NULL::timestamptz, a.interval, 3
    FROM ledger.automatic_locks AS a
    CROSS JOIN LATERAL (SELECT ledger.automatic_lock_end_date(a.company_id, applicable_locks.today) AS through) AS e
    WHERE a.company_id = applicable_locks.company AND a.enabled AND e.through IS NOT NULL;
END
$applicable$;

-- The lock that makes `day` locked for the actor on `today`, or no row: of the
-- dates that apply and reach `day`, the latest. On a tie, the actor's own
-- row, then the all-users row, then the automatic lock, so a refusal can name
-- who set it.
CREATE FUNCTION ledger.lock_covering(company uuid, actor_kind text, actor_id uuid, day date, today date)
RETURNS TABLE (source text, end_date date, user_id uuid, set_by uuid, set_by_kind text, set_at timestamptz, "interval" text)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT l.source, l.end_date, l.user_id, l.set_by, l.set_by_kind, l.set_at, l.interval
  FROM ledger.applicable_locks(lock_covering.company, lock_covering.actor_kind, lock_covering.actor_id, lock_covering.today) AS l
  WHERE l.end_date >= lock_covering.day
  ORDER BY l.end_date DESC, l.precedence
  LIMIT 1;
END;

-- The one date through which every date is locked for the actor on `today`,
-- or NULL: the latest date that applies.
CREATE FUNCTION ledger.locked_through(company uuid, actor_kind text, actor_id uuid, today date) RETURNS date
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT max(l.end_date)
  FROM ledger.applicable_locks(locked_through.company, locked_through.actor_kind, locked_through.actor_id, locked_through.today) AS l;
END;

-- Refuses the transaction's actor a date that is locked for it today:
-- period_locked_manual with the through-date, the row it comes from and who
-- set it, or period_locked_automatic with the through-date and the interval.
-- The closing series is exempt from every lock. The voucher triggers call it.
CREATE FUNCTION ledger.assert_open(company uuid, day date, is_closing_series boolean) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $open$
DECLARE
  actor record;
  covering record;
BEGIN
  IF assert_open.is_closing_series THEN
    RETURN;
  END IF;
  SELECT a.actor_id, a.actor_kind INTO actor FROM ledger.current_actor() AS a;
  SELECT c.source, c.end_date, c.user_id, c.set_by, c.set_by_kind, c.set_at, c.interval INTO covering
  FROM ledger.lock_covering(assert_open.company, actor.actor_kind, actor.actor_id, assert_open.day, ledger.today_in_sweden()) AS c;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF covering.source = 'automatic' THEN
    PERFORM ledger.refuse('period_locked_automatic', jsonb_build_object('end_date', covering.end_date, 'interval', covering.interval));
  END IF;
  PERFORM ledger.refuse(
    'period_locked_manual',
    jsonb_build_object(
      'end_date', covering.end_date,
      'source', covering.source,
      'user_id', covering.user_id,
      'set_by', covering.set_by,
      'set_by_kind', covering.set_by_kind,
      'set_at', covering.set_at
    )
  );
END
$open$;

-- The app reads the lock with these, as the compatible read of the locked
-- period will. Row level security keeps each read to the transaction's company.
GRANT EXECUTE ON FUNCTION
  ledger.today_in_sweden(),
  ledger.automatic_lock_end_date(uuid, date),
  ledger.applicable_locks(uuid, text, uuid, date),
  ledger.lock_covering(uuid, text, uuid, date, date),
  ledger.locked_through(uuid, text, uuid, date)
TO nortfox_app;
