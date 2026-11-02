-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0004 vouchers: the vouchers and their rows, the reversing link, and the
-- record of deleted vouchers, with the rules of Bokför, Ändra, Stryk rad,
-- Ändringsverifikation and Radera. See db/README.md, and decisions 0002 and
-- 0005 in docs/decisions/.
--
-- As in 0001: every name of ours is written in full, every function pins its
-- search path, and every trigger function runs with the owner's rights.
--
-- The locks. A booking, a change and a deletion of a voucher each lock what
-- the period lock reads, FOR SHARE, in this order: the voucher's fiscal year,
-- its series, and the company's automatic lock row
-- (ledger.lock_voucher_period). A booking reads its series' manual flag
-- under that lock. It then locks the voucher it reverses, then the series'
-- counter. A new row locks its voucher, then those three rows (a row of the
-- booking's own transaction holds them from the booking), and then its
-- account FOR SHARE, which it reads the active flag from. A deletion locks
-- its voucher first, as its statement's target, then those three rows, then
-- the counter, and then its own rows, by the cascade. A change of a row locks
-- the row first, as its statement's target, then its voucher, then those
-- three rows.
-- So a row change and a deletion of the same voucher take the voucher and the
-- row in opposite orders, and can deadlock: every caller that changes a row
-- first locks its voucher (SELECT ... FROM ledger.vouchers WHERE id = ...
-- FOR NO KEY UPDATE). A change of a fiscal year's dates, of a series' name,
-- manual flag or closing mark, or of an account locks only that row, and a
-- change of a lock date locks its own row and then the automatic lock row, so
-- none of them waits in a circle with a single change of a voucher. A
-- transaction that makes more than one of these changes makes them in the
-- order a voucher locks those rows: the fiscal year, the series, the lock
-- dates, then the accounts. In another order it can deadlock with a change of
-- a voucher.

-- Vouchers --------------------------------------------------------------------
--
-- A voucher is booked in one fiscal year and one of its series. Booking gives
-- it its number at once, from the series' counter, in the same transaction:
-- there is no draft. It has a description of 1 to 200 characters, comments of
-- at most 1000, a date inside its own fiscal year, one of seven reference
-- types and a reference number. The created stamps, the transaction that
-- booked it and its modified time come from the trigger. The altered stamps
-- are set by every change after the booking's own transaction. A voucher may
-- name the one it reverses, and at most one voucher reverses another at a
-- time. The checks below hold the lengths, the numbers and the stamps also
-- when the triggers are off; the triggers give the refusals with their
-- reasons.

CREATE TABLE ledger.vouchers (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  company_id uuid NOT NULL,
  fiscal_year_id uuid NOT NULL,
  series_code text NOT NULL,
  number integer NOT NULL,
  description text NOT NULL,
  comments text NOT NULL DEFAULT '',
  transaction_date date NOT NULL,
  reference_type text NOT NULL,
  reference_number text NOT NULL DEFAULT '',
  reverses_voucher_id uuid,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_by_kind text NOT NULL,
  created_xact xid8 NOT NULL,
  modified_at timestamptz NOT NULL,
  altered_at timestamptz,
  altered_by uuid,
  altered_by_kind text,
  UNIQUE (company_id, id),
  -- The rows' key to their voucher carries the year, so a row is always in its voucher's year.
  CONSTRAINT vouchers_key_with_year UNIQUE (company_id, id, fiscal_year_id),
  CONSTRAINT vouchers_series FOREIGN KEY (company_id, fiscal_year_id, series_code)
    REFERENCES ledger.voucher_series (company_id, fiscal_year_id, code) ON DELETE RESTRICT,
  CONSTRAINT vouchers_number_unique UNIQUE (company_id, fiscal_year_id, series_code, number),
  CONSTRAINT vouchers_reverses FOREIGN KEY (company_id, reverses_voucher_id) REFERENCES ledger.vouchers (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT vouchers_reference_type CHECK (
    reference_type IN ('INVOICE', 'SUPPLIERINVOICE', 'INVOICEPAYMENT', 'SUPPLIERPAYMENT', 'MANUAL', 'CASHINVOICE', 'ACCRUAL')
  ),
  CONSTRAINT vouchers_number_positive CHECK (number >= 1),
  CONSTRAINT vouchers_description_length CHECK (char_length(description) BETWEEN 1 AND 200),
  CONSTRAINT vouchers_comments_length CHECK (char_length(comments) <= 1000),
  CONSTRAINT vouchers_created_by_kind CHECK (created_by_kind IN ('user', 'system', 'integration')),
  CONSTRAINT vouchers_altered_stamps CHECK (
    (altered_at IS NULL) = (altered_by IS NULL) AND (altered_by IS NULL) = (altered_by_kind IS NULL)
    AND (altered_by_kind IS NULL OR altered_by_kind IN ('user', 'system', 'integration'))
  )
);
CREATE UNIQUE INDEX vouchers_one_reversing ON ledger.vouchers (company_id, reverses_voucher_id) WHERE reverses_voucher_id IS NOT NULL;
CREATE INDEX vouchers_by_date ON ledger.vouchers (company_id, fiscal_year_id, transaction_date);

-- Voucher rows ----------------------------------------------------------------
--
-- A row has an account of its voucher's year, a debit and a credit in öre,
-- each zero or more and kept as they were sent, so one row can hold both
-- (decision 5), a text of at most 100 characters, and a quantity: a decimal
-- of any scale that may be negative, 0 when none is given. Its position is
-- the next in its voucher, and rows keep that order. A row is never removed
-- from a voucher that stays: it is struck, with who struck it and when, and
-- counts in no balance from then on. The rows go only with their voucher, by
-- the cascade, after the deletion has moved them to the record.

CREATE TABLE ledger.voucher_rows (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  company_id uuid NOT NULL,
  voucher_id uuid NOT NULL,
  fiscal_year_id uuid NOT NULL,
  position integer NOT NULL,
  account_number integer NOT NULL,
  debit bigint NOT NULL DEFAULT 0,
  credit bigint NOT NULL DEFAULT 0,
  transaction_information text NOT NULL DEFAULT '',
  quantity numeric NOT NULL DEFAULT 0,
  removed boolean NOT NULL DEFAULT false,
  removed_at timestamptz,
  removed_by uuid,
  removed_by_kind text,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_by_kind text NOT NULL,
  UNIQUE (company_id, id),
  CONSTRAINT voucher_rows_voucher FOREIGN KEY (company_id, voucher_id, fiscal_year_id)
    REFERENCES ledger.vouchers (company_id, id, fiscal_year_id) ON DELETE CASCADE,
  CONSTRAINT voucher_rows_account FOREIGN KEY (company_id, fiscal_year_id, account_number)
    REFERENCES ledger.accounts (company_id, fiscal_year_id, number) ON DELETE RESTRICT,
  CONSTRAINT voucher_rows_position_unique UNIQUE (company_id, voucher_id, position),
  CONSTRAINT voucher_rows_position_positive CHECK (position >= 1),
  CONSTRAINT voucher_rows_debit_not_negative CHECK (debit >= 0),
  CONSTRAINT voucher_rows_credit_not_negative CHECK (credit >= 0),
  CONSTRAINT voucher_rows_text_length CHECK (char_length(transaction_information) <= 100),
  CONSTRAINT voucher_rows_created_by_kind CHECK (created_by_kind IN ('user', 'system', 'integration')),
  CONSTRAINT voucher_rows_removed_stamps CHECK (
    removed = (removed_at IS NOT NULL) AND (removed_at IS NULL) = (removed_by IS NULL) AND (removed_by IS NULL) = (removed_by_kind IS NULL)
    AND (removed_by_kind IS NULL OR removed_by_kind IN ('user', 'system', 'integration'))
  )
);
CREATE INDEX voucher_rows_by_account ON ledger.voucher_rows (company_id, fiscal_year_id, account_number);

-- The record of deleted vouchers ------------------------------------------------
--
-- Deleting a voucher moves it here, with every column it had, and its rows
-- with every column they had and their account's name at the deletion. Each
-- deletion is its own entry, with how many times its number has been deleted
-- in its series and year (1, 2, ...), and who deleted it and when. An entry
-- and each of its rows have an id of their own, and keep the deleted
-- voucher's id in voucher_id and each row's id in row_id. So the deletion of
-- a voucher whose id an earlier deleted voucher had, here or in another
-- company, is an entry of its own too. Only the deletion writes the record,
-- and no role changes or deletes it. The series stays while the record names
-- it.

CREATE TABLE ledger.deleted_vouchers (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  voucher_id uuid NOT NULL,
  company_id uuid NOT NULL,
  fiscal_year_id uuid NOT NULL,
  series_code text NOT NULL,
  number integer NOT NULL,
  description text NOT NULL,
  comments text NOT NULL,
  transaction_date date NOT NULL,
  reference_type text NOT NULL,
  reference_number text NOT NULL,
  reverses_voucher_id uuid,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_by_kind text NOT NULL,
  created_xact xid8 NOT NULL,
  modified_at timestamptz NOT NULL,
  altered_at timestamptz,
  altered_by uuid,
  altered_by_kind text,
  deletion_count integer NOT NULL,
  deleted_at timestamptz NOT NULL,
  deleted_by uuid NOT NULL,
  deleted_by_kind text NOT NULL,
  deleted_xact xid8 NOT NULL,
  UNIQUE (company_id, id),
  CONSTRAINT deleted_vouchers_series FOREIGN KEY (company_id, fiscal_year_id, series_code)
    REFERENCES ledger.voucher_series (company_id, fiscal_year_id, code) ON DELETE RESTRICT,
  CONSTRAINT deleted_vouchers_count_unique UNIQUE (company_id, fiscal_year_id, series_code, number, deletion_count),
  CONSTRAINT deleted_vouchers_count_positive CHECK (deletion_count >= 1),
  CONSTRAINT deleted_vouchers_deleted_by_kind CHECK (deleted_by_kind IN ('user', 'system', 'integration'))
);

CREATE TABLE ledger.deleted_voucher_rows (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  row_id uuid NOT NULL,
  company_id uuid NOT NULL,
  deleted_voucher_id uuid NOT NULL,
  fiscal_year_id uuid NOT NULL,
  position integer NOT NULL,
  account_number integer NOT NULL,
  debit bigint NOT NULL,
  credit bigint NOT NULL,
  transaction_information text NOT NULL,
  quantity numeric NOT NULL,
  removed boolean NOT NULL,
  removed_at timestamptz,
  removed_by uuid,
  removed_by_kind text,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_by_kind text NOT NULL,
  account_description text NOT NULL,
  UNIQUE (company_id, id),
  CONSTRAINT deleted_voucher_rows_entry FOREIGN KEY (company_id, deleted_voucher_id)
    REFERENCES ledger.deleted_vouchers (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT deleted_voucher_rows_position_unique UNIQUE (company_id, deleted_voucher_id, position),
  CONSTRAINT deleted_voucher_rows_debit_not_negative CHECK (debit >= 0),
  CONSTRAINT deleted_voucher_rows_credit_not_negative CHECK (credit >= 0)
);

-- Helpers -------------------------------------------------------------------------

-- The triggers that run after a row is written, and the checks at commit,
-- read the voucher's rows through row level security, as the company that is
-- set when they run. So each of them is refused when that company is not the
-- voucher's: in a statement that changes the company between its rows, and
-- in a transaction that has written a voucher and has another company, or
-- none, set at its commit. The database does not keep one company for the
-- whole transaction, as it keeps one actor: a transaction that switches to
-- another company and back before its checks run is not refused. The server
-- sets the company once, at the start of each transaction.
CREATE FUNCTION ledger.assert_company(company uuid) RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $company$
BEGIN
  IF assert_company.company IS DISTINCT FROM ledger.current_company_id() THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'The transaction''s company is not the voucher''s company when its check runs.';
  END IF;
END
$company$;

-- Refuses a voucher's date outside every fiscal year of the company
-- (no_fiscal_year), and then outside the voucher's own year
-- (date_outside_fiscal_year, with the year). It locks the own year's row FOR
-- SHARE until the transaction ends, so the year's dates cannot change under
-- the voucher, and it reads the years after that lock.
CREATE FUNCTION ledger.assert_in_own_year(company uuid, fiscal_year uuid, day date) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $year$
DECLARE
  own record;
BEGIN
  SELECT y.year_number, y.from_date, y.to_date INTO own
  FROM ledger.fiscal_years AS y
  WHERE y.company_id = assert_in_own_year.company AND y.id = assert_in_own_year.fiscal_year
  FOR SHARE;
  IF NOT EXISTS (
    SELECT FROM ledger.fiscal_years AS y
    WHERE y.company_id = assert_in_own_year.company AND assert_in_own_year.day BETWEEN y.from_date AND y.to_date
  ) THEN
    PERFORM ledger.refuse('no_fiscal_year', jsonb_build_object('date', assert_in_own_year.day));
  END IF;
  IF assert_in_own_year.day < own.from_date OR assert_in_own_year.day > own.to_date THEN
    PERFORM ledger.refuse(
      'date_outside_fiscal_year',
      jsonb_build_object(
        'date', assert_in_own_year.day,
        'year', jsonb_build_object('year_number', own.year_number, 'from_date', own.from_date, 'to_date', own.to_date)
      )
    );
  END IF;
END
$year$;

-- Locks FOR SHARE, until the transaction ends, the rows that the period lock
-- on a voucher reads, in the lock order at the top of this file: the
-- voucher's fiscal year, its series and the company's automatic lock row.
-- Gives the series' closing mark, read from the locked row.
CREATE FUNCTION ledger.lock_voucher_period(company uuid, fiscal_year uuid, series_code text) RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $period$
DECLARE
  closing boolean;
BEGIN
  PERFORM 1 FROM ledger.fiscal_years AS y
  WHERE y.company_id = lock_voucher_period.company AND y.id = lock_voucher_period.fiscal_year
  FOR SHARE;
  SELECT s.is_closing INTO closing
  FROM ledger.voucher_series AS s
  WHERE s.company_id = lock_voucher_period.company AND s.fiscal_year_id = lock_voucher_period.fiscal_year
    AND s.code = lock_voucher_period.series_code
  FOR SHARE;
  PERFORM 1 FROM ledger.automatic_locks AS a WHERE a.company_id = lock_voucher_period.company FOR SHARE;
  RETURN closing;
END
$period$;

-- Refuses the transaction's actor a voucher whose date `day` is locked for it
-- (ledger.assert_open), in the voucher's fiscal year and series. What the
-- lock says depends on rows that other transactions can change: the lock
-- dates and the automatic lock, the end of the fiscal year, which places the
-- automatic lock at 60 days after it, and the series' closing mark. So it
-- first locks the year's row, the series' row and the automatic lock row
-- (ledger.lock_voucher_period), and reads the mark from the locked row. A
-- change of the year's dates or of the mark waits for an open change of a
-- voucher, and a change of a voucher waits for an open change of either, and
-- then reads it. Of the years' ends, only the voucher's own year's matters:
-- the automatic lock reaches a date of that year only once some year that
-- ends on or after the date ended 60 days ago, and every such year ends no
-- earlier than the voucher's own.
CREATE FUNCTION ledger.assert_voucher_open(company uuid, fiscal_year uuid, series_code text, day date) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $open$
BEGIN
  PERFORM ledger.assert_open(
    assert_voucher_open.company,
    assert_voucher_open.day,
    ledger.lock_voucher_period(assert_voucher_open.company, assert_voucher_open.fiscal_year, assert_voucher_open.series_code)
  );
END
$open$;

-- How many vouchers hold a row on the account, struck rows included. A
-- deleted voucher holds none: its rows are in the record.
CREATE OR REPLACE FUNCTION ledger.account_voucher_count(company uuid, fiscal_year uuid, account_number integer) RETURNS bigint
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT count(DISTINCT r.voucher_id)
  FROM ledger.voucher_rows AS r
  WHERE r.company_id = account_voucher_count.company
    AND r.fiscal_year_id = account_voucher_count.fiscal_year
    AND r.account_number = account_voucher_count.account_number;
END;

-- Booking --------------------------------------------------------------------------

-- Bokför. The checks run in a fixed order, and the first that fails is the
-- refusal: the columns that the database writes, the description, the
-- comments, the series, the manual flag, the date's fiscal year, the date in
-- the voucher's own year (the closing series too), the period lock (not for
-- the closing series), and the voucher it reverses: locked first, then an
-- earlier voucher of the company, then of the same reference type, then not
-- reversed already. Then the series' counter is locked until the transaction
-- ends and gives the number. The rows follow, and at commit the voucher needs
-- two rows and a balance.
CREATE FUNCTION ledger.vouchers_book() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $book$
DECLARE
  series record;
  reversed record;
  reversing record;
  counter integer;
  actor record;
  stamp timestamptz;
BEGIN
  -- A row of another company than the transaction's: row level security
  -- refuses it right after this trigger, so no rule is checked for it here.
  IF NEW.company_id IS DISTINCT FROM ledger.current_company_id() THEN
    RETURN NEW;
  END IF;
  IF NEW.number IS NOT NULL THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'number', 'operation', 'create'));
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
  IF NEW.modified_at IS NOT NULL THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'modified_at', 'operation', 'create'));
  END IF;
  IF NEW.altered_at IS NOT NULL THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'altered_at', 'operation', 'create'));
  END IF;
  IF NEW.altered_by IS NOT NULL THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'altered_by', 'operation', 'create'));
  END IF;
  IF NEW.altered_by_kind IS NOT NULL THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'altered_by_kind', 'operation', 'create'));
  END IF;
  IF NEW.description IS NULL OR NEW.description = '' THEN
    PERFORM ledger.refuse('description_missing');
  END IF;
  IF char_length(NEW.description) > 200 THEN
    PERFORM ledger.refuse('value_too_long', jsonb_build_object('field', 'description', 'value', NEW.description));
  END IF;
  IF char_length(NEW.comments) > 1000 THEN
    PERFORM ledger.refuse('value_too_long', jsonb_build_object('field', 'comments', 'value', NEW.comments));
  END IF;
  -- The manual flag is read from the series' row locked FOR SHARE until the
  -- transaction ends, after the year's row, in the lock order at the top of
  -- this file. So a change of the flag waits for this booking, and this
  -- booking waits for a change of the flag and then reads it.
  PERFORM 1 FROM ledger.fiscal_years AS y
  WHERE y.company_id = NEW.company_id AND y.id = NEW.fiscal_year_id
  FOR SHARE;
  SELECT s.manual INTO series
  FROM ledger.voucher_series AS s
  WHERE s.company_id = NEW.company_id AND s.fiscal_year_id = NEW.fiscal_year_id AND s.code = NEW.series_code
  FOR SHARE;
  IF NOT FOUND THEN
    PERFORM ledger.refuse('series_missing', jsonb_build_object('code', NEW.series_code));
  END IF;
  IF NEW.reference_type = 'MANUAL' AND NOT series.manual THEN
    PERFORM ledger.refuse('series_not_manual', jsonb_build_object('code', NEW.series_code));
  END IF;
  PERFORM ledger.assert_in_own_year(NEW.company_id, NEW.fiscal_year_id, NEW.transaction_date);
  PERFORM ledger.assert_voucher_open(NEW.company_id, NEW.fiscal_year_id, NEW.series_code, NEW.transaction_date);
  IF NEW.reverses_voucher_id IS NOT NULL THEN
    -- The old voucher stays locked until the transaction ends, so a second
    -- reversing voucher booked at the same time waits and then sees this
    -- one, and a deletion of the old voucher waits too. The lock changes
    -- nothing in it.
    SELECT v.reference_type INTO reversed
    FROM ledger.vouchers AS v
    WHERE v.company_id = NEW.company_id AND v.id = NEW.reverses_voucher_id
    FOR NO KEY UPDATE;
    -- The old voucher is an earlier one, already there in this company. The
    -- foreign key alone would also take the new voucher itself, or one
    -- booked later in the same statement, since it is checked at the
    -- statement's end. Such a voucher could never be deleted and never get
    -- a real reversing voucher.
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'foreign_key_violation',
        CONSTRAINT = 'vouchers_reverses',
        MESSAGE = 'A voucher reverses only an earlier voucher of its company (vouchers_reverses).',
        DETAIL = pg_catalog.format('Key (company_id, reverses_voucher_id)=(%s, %s) names no voucher booked before this one.', NEW.company_id, NEW.reverses_voucher_id);
    END IF;
    IF reversed.reference_type IS DISTINCT FROM NEW.reference_type THEN
      PERFORM ledger.refuse('reversing_other_module', jsonb_build_object('reversed_type', reversed.reference_type, 'reversing_type', NEW.reference_type));
    END IF;
    SELECT r.series_code, r.number INTO reversing
    FROM ledger.vouchers AS r
    WHERE r.company_id = NEW.company_id AND r.reverses_voucher_id = NEW.reverses_voucher_id;
    IF FOUND THEN
      PERFORM ledger.refuse('reversing_voucher_exists', jsonb_build_object('series', reversing.series_code, 'number', reversing.number));
    END IF;
  END IF;
  SELECT c.next_number INTO counter
  FROM ledger.voucher_counters AS c
  JOIN ledger.voucher_series AS s ON s.company_id = c.company_id AND s.id = c.series_id
  WHERE s.company_id = NEW.company_id AND s.fiscal_year_id = NEW.fiscal_year_id AND s.code = NEW.series_code
  FOR UPDATE OF c;
  -- The counter moves after the row is in, at the end of the statement. A
  -- statement that books several vouchers in one series sees the ones before
  -- this one already, so each gets the next number.
  NEW.number := greatest(
    counter,
    (
      SELECT COALESCE(max(v.number), 0) + 1
      FROM ledger.vouchers AS v
      WHERE v.company_id = NEW.company_id AND v.fiscal_year_id = NEW.fiscal_year_id AND v.series_code = NEW.series_code
    )
  );
  SELECT a.actor_id, a.actor_kind INTO actor FROM ledger.current_actor() AS a;
  stamp := clock_timestamp();
  NEW.created_at := stamp;
  NEW.created_by := actor.actor_id;
  NEW.created_by_kind := actor.actor_kind;
  NEW.created_xact := pg_current_xact_id();
  NEW.modified_at := stamp;
  RETURN NEW;
END
$book$;

-- A booked voucher moves its series' counter past its number.
CREATE FUNCTION ledger.vouchers_move_counter() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $moved$
BEGIN
  PERFORM ledger.assert_company(NEW.company_id);
  UPDATE ledger.voucher_counters AS c
  SET next_number = NEW.number + 1
  FROM ledger.voucher_series AS s
  WHERE s.company_id = NEW.company_id AND s.fiscal_year_id = NEW.fiscal_year_id AND s.code = NEW.series_code
    AND c.company_id = s.company_id AND c.series_id = s.id;
  RETURN NULL;
END
$moved$;

-- Refuses a voucher with fewer than two rows, struck rows included
-- (too_few_rows, with the count).
CREATE FUNCTION ledger.assert_enough_rows(company uuid, voucher uuid) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $enough$
DECLARE
  found_rows bigint;
BEGIN
  found_rows := (
    SELECT count(*) FROM ledger.voucher_rows AS r
    WHERE r.company_id = assert_enough_rows.company AND r.voucher_id = assert_enough_rows.voucher
  );
  IF found_rows < 2 THEN
    PERFORM ledger.refuse('too_few_rows', jsonb_build_object('count', found_rows));
  END IF;
END
$enough$;

-- Refuses a voucher whose rows that are not struck differ in debit and
-- credit (unbalanced, with the two sums in öre, as strings). A row's debit
-- and its credit each count on their own side.
CREATE FUNCTION ledger.assert_balanced(company uuid, voucher uuid) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $balanced$
DECLARE
  sums record;
BEGIN
  SELECT COALESCE(sum(r.debit), 0) AS debit, COALESCE(sum(r.credit), 0) AS credit
  INTO sums
  FROM ledger.voucher_rows AS r
  WHERE r.company_id = assert_balanced.company AND r.voucher_id = assert_balanced.voucher AND NOT r.removed;
  IF sums.debit <> sums.credit THEN
    PERFORM ledger.refuse('unbalanced', jsonb_build_object('debit', sums.debit::text, 'credit', sums.credit::text));
  END IF;
END
$balanced$;

-- At commit: a voucher that is still there has at least two rows, struck
-- rows included. A voucher deleted before the commit made this check, and
-- the next one, at its deletion (ledger.vouchers_delete).
CREATE FUNCTION ledger.vouchers_enough_rows() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $enough$
BEGIN
  PERFORM ledger.assert_company(NEW.company_id);
  IF NOT EXISTS (SELECT FROM ledger.vouchers AS v WHERE v.company_id = NEW.company_id AND v.id = NEW.id) THEN
    RETURN NULL;
  END IF;
  PERFORM ledger.assert_enough_rows(NEW.company_id, NEW.id);
  RETURN NULL;
END
$enough$;

-- At commit: debit equals credit over the voucher's rows that are not
-- struck.
CREATE FUNCTION ledger.voucher_rows_balance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $balance$
BEGIN
  PERFORM ledger.assert_company(NEW.company_id);
  PERFORM ledger.assert_balanced(NEW.company_id, NEW.voucher_id);
  RETURN NULL;
END
$balance$;

-- Ändra ------------------------------------------------------------------------------

-- A change to a voucher. Only its description and its date inside its own
-- fiscal year change: the series, the number, the year, the reference type
-- and number, the comments, what it reverses and the created stamps never do
-- (immutable_field), and only the database writes the modified time and the
-- altered stamps (internal_only). The period lock applies by the old date and
-- by the new date. A change after the booking's own transaction sets the
-- altered stamps and the modified time. A row's change comes here too, from
-- the row's trigger, which sets those stamps itself.
CREATE FUNCTION ledger.vouchers_alter() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $alter$
DECLARE
  actor record;
  stamp timestamptz;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'id', 'operation', 'update'));
  END IF;
  IF NEW.series_code IS DISTINCT FROM OLD.series_code THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'series_code', 'operation', 'update'));
  END IF;
  IF NEW.number IS DISTINCT FROM OLD.number THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'number', 'operation', 'update'));
  END IF;
  IF NEW.fiscal_year_id IS DISTINCT FROM OLD.fiscal_year_id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'fiscal_year_id', 'operation', 'update'));
  END IF;
  IF NEW.reference_type IS DISTINCT FROM OLD.reference_type THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'reference_type', 'operation', 'update'));
  END IF;
  IF NEW.reference_number IS DISTINCT FROM OLD.reference_number THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'reference_number', 'operation', 'update'));
  END IF;
  IF NEW.comments IS DISTINCT FROM OLD.comments THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'comments', 'operation', 'update'));
  END IF;
  IF NEW.reverses_voucher_id IS DISTINCT FROM OLD.reverses_voucher_id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'reverses_voucher_id', 'operation', 'update'));
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_at', 'operation', 'update'));
  END IF;
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_by', 'operation', 'update'));
  END IF;
  IF NEW.created_by_kind IS DISTINCT FROM OLD.created_by_kind THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_by_kind', 'operation', 'update'));
  END IF;
  IF NEW.created_xact IS DISTINCT FROM OLD.created_xact THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_xact', 'operation', 'update'));
  END IF;
  IF pg_trigger_depth() < 2 THEN
    IF NEW.modified_at IS DISTINCT FROM OLD.modified_at THEN
      PERFORM ledger.refuse('internal_only', jsonb_build_object('table', 'ledger.vouchers', 'field', 'modified_at'));
    END IF;
    IF NEW.altered_at IS DISTINCT FROM OLD.altered_at THEN
      PERFORM ledger.refuse('internal_only', jsonb_build_object('table', 'ledger.vouchers', 'field', 'altered_at'));
    END IF;
    IF NEW.altered_by IS DISTINCT FROM OLD.altered_by THEN
      PERFORM ledger.refuse('internal_only', jsonb_build_object('table', 'ledger.vouchers', 'field', 'altered_by'));
    END IF;
    IF NEW.altered_by_kind IS DISTINCT FROM OLD.altered_by_kind THEN
      PERFORM ledger.refuse('internal_only', jsonb_build_object('table', 'ledger.vouchers', 'field', 'altered_by_kind'));
    END IF;
  END IF;
  IF NEW.description IS NULL OR NEW.description = '' THEN
    PERFORM ledger.refuse('description_missing');
  END IF;
  IF char_length(NEW.description) > 200 THEN
    PERFORM ledger.refuse('value_too_long', jsonb_build_object('field', 'description', 'value', NEW.description));
  END IF;
  IF NEW.transaction_date IS DISTINCT FROM OLD.transaction_date THEN
    PERFORM ledger.assert_in_own_year(NEW.company_id, NEW.fiscal_year_id, NEW.transaction_date);
  END IF;
  PERFORM ledger.assert_voucher_open(OLD.company_id, OLD.fiscal_year_id, OLD.series_code, OLD.transaction_date);
  IF NEW.transaction_date IS DISTINCT FROM OLD.transaction_date THEN
    PERFORM ledger.assert_voucher_open(NEW.company_id, NEW.fiscal_year_id, NEW.series_code, NEW.transaction_date);
  END IF;
  IF pg_trigger_depth() < 2 AND OLD.created_xact <> pg_current_xact_id()
    AND (NEW.description IS DISTINCT FROM OLD.description OR NEW.transaction_date IS DISTINCT FROM OLD.transaction_date) THEN
    SELECT a.actor_id, a.actor_kind INTO actor FROM ledger.current_actor() AS a;
    stamp := clock_timestamp();
    NEW.modified_at := stamp;
    NEW.altered_at := stamp;
    NEW.altered_by := actor.actor_id;
    NEW.altered_by_kind := actor.actor_kind;
  END IF;
  RETURN NEW;
END
$alter$;

-- A new row. It locks its voucher until the transaction ends, takes the
-- voucher's fiscal year and the next position, and needs an account of that
-- year that is active, read under a lock on the account's row, and a text of
-- at most 100 characters. The database writes its year, its position and its
-- created stamps, and a row is never made struck. A row added after the
-- booking's own transaction is a change by Ändra: the period lock applies by
-- the voucher's date.
CREATE FUNCTION ledger.voucher_rows_add() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $add$
DECLARE
  voucher record;
  has_voucher boolean;
  account record;
  actor record;
BEGIN
  -- A row of another company: row level security refuses it right after this trigger.
  IF NEW.company_id IS DISTINCT FROM ledger.current_company_id() THEN
    RETURN NEW;
  END IF;
  SELECT v.fiscal_year_id, v.series_code, v.transaction_date, v.created_xact INTO voucher
  FROM ledger.vouchers AS v
  WHERE v.company_id = NEW.company_id AND v.id = NEW.voucher_id
  FOR NO KEY UPDATE;
  has_voucher := FOUND;
  IF NEW.fiscal_year_id IS NOT NULL THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'fiscal_year_id', 'operation', 'create'));
  END IF;
  IF NEW.position IS NOT NULL THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'position', 'operation', 'create'));
  END IF;
  IF NEW.removed IS TRUE THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'removed', 'operation', 'create'));
  END IF;
  IF NEW.removed_at IS NOT NULL THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'removed_at', 'operation', 'create'));
  END IF;
  IF NEW.removed_by IS NOT NULL THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'removed_by', 'operation', 'create'));
  END IF;
  IF NEW.removed_by_kind IS NOT NULL THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'removed_by_kind', 'operation', 'create'));
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
  -- With no voucher, the row has no fiscal year, and its NOT NULL refuses it.
  IF NOT has_voucher THEN
    RETURN NEW;
  END IF;
  NEW.fiscal_year_id := voucher.fiscal_year_id;
  -- The active flag is read from the account's row locked FOR SHARE until
  -- the transaction ends, after the rows that the period lock reads (the
  -- lock order at the top of this file). So a change of the flag waits for
  -- this row, and this row waits for a change of the flag and then reads it.
  -- A row of the booking's own transaction holds those rows from the
  -- booking.
  IF voucher.created_xact <> pg_current_xact_id() THEN
    PERFORM ledger.lock_voucher_period(NEW.company_id, voucher.fiscal_year_id, voucher.series_code);
  END IF;
  SELECT a.active INTO account
  FROM ledger.accounts AS a
  WHERE a.company_id = NEW.company_id AND a.fiscal_year_id = NEW.fiscal_year_id AND a.number = NEW.account_number
  FOR SHARE;
  IF NOT FOUND THEN
    PERFORM ledger.refuse('account_missing', jsonb_build_object('number', NEW.account_number));
  END IF;
  IF NOT account.active THEN
    PERFORM ledger.refuse('account_inactive', jsonb_build_object('number', NEW.account_number));
  END IF;
  IF char_length(NEW.transaction_information) > 100 THEN
    PERFORM ledger.refuse('value_too_long', jsonb_build_object('field', 'transaction_information', 'value', NEW.transaction_information));
  END IF;
  -- A row of the booking's own transaction is part of the booking, which was
  -- checked for the transaction's one actor (ledger.current_actor).
  IF voucher.created_xact <> pg_current_xact_id() THEN
    PERFORM ledger.assert_voucher_open(NEW.company_id, voucher.fiscal_year_id, voucher.series_code, voucher.transaction_date);
  END IF;
  NEW.position := (
    SELECT COALESCE(max(r.position), 0) + 1 FROM ledger.voucher_rows AS r WHERE r.company_id = NEW.company_id AND r.voucher_id = NEW.voucher_id
  );
  SELECT a.actor_id, a.actor_kind INTO actor FROM ledger.current_actor() AS a;
  NEW.created_at := clock_timestamp();
  NEW.created_by := actor.actor_id;
  NEW.created_by_kind := actor.actor_kind;
  RETURN NEW;
END
$add$;

-- A change to a row: only its text changes, and it can be struck, though not
-- in the booking's own transaction. Its account, debit, credit, position,
-- quantity, voucher, year and created stamps never change, a struck row never
-- loses its mark, and who struck it and when never change (immutable_field).
-- The period lock applies by the voucher's date. A strike gets who struck the
-- row and when from the transaction. The row is locked as the statement's
-- target before this trigger locks its voucher, so the caller locks the
-- voucher first (the lock order at the top of this file).
CREATE FUNCTION ledger.voucher_rows_alter() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $alter$
DECLARE
  voucher record;
  actor record;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'id', 'operation', 'update'));
  END IF;
  IF NEW.account_number IS DISTINCT FROM OLD.account_number THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'account_number', 'operation', 'update'));
  END IF;
  IF NEW.debit IS DISTINCT FROM OLD.debit THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'debit', 'operation', 'update'));
  END IF;
  IF NEW.credit IS DISTINCT FROM OLD.credit THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'credit', 'operation', 'update'));
  END IF;
  IF NEW.position IS DISTINCT FROM OLD.position THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'position', 'operation', 'update'));
  END IF;
  IF NEW.quantity IS DISTINCT FROM OLD.quantity THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'quantity', 'operation', 'update'));
  END IF;
  IF NEW.voucher_id IS DISTINCT FROM OLD.voucher_id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'voucher_id', 'operation', 'update'));
  END IF;
  IF NEW.fiscal_year_id IS DISTINCT FROM OLD.fiscal_year_id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'fiscal_year_id', 'operation', 'update'));
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_at', 'operation', 'update'));
  END IF;
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_by', 'operation', 'update'));
  END IF;
  IF NEW.created_by_kind IS DISTINCT FROM OLD.created_by_kind THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_by_kind', 'operation', 'update'));
  END IF;
  IF OLD.removed AND NEW.removed IS DISTINCT FROM true THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'removed', 'operation', 'update'));
  END IF;
  IF NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'removed_at', 'operation', 'update'));
  END IF;
  IF NEW.removed_by IS DISTINCT FROM OLD.removed_by THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'removed_by', 'operation', 'update'));
  END IF;
  IF NEW.removed_by_kind IS DISTINCT FROM OLD.removed_by_kind THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'removed_by_kind', 'operation', 'update'));
  END IF;
  IF char_length(NEW.transaction_information) > 100 THEN
    PERFORM ledger.refuse('value_too_long', jsonb_build_object('field', 'transaction_information', 'value', NEW.transaction_information));
  END IF;
  SELECT v.fiscal_year_id, v.series_code, v.transaction_date, v.created_xact INTO voucher
  FROM ledger.vouchers AS v
  WHERE v.company_id = OLD.company_id AND v.id = OLD.voucher_id
  FOR NO KEY UPDATE;
  -- A new voucher has no struck row: the established system's new voucher
  -- takes a row away before it is booked, and striking is a change by Ändra.
  -- So a strike in the booking's own transaction is refused, as a row made
  -- struck is, and a booked voucher never holds fewer than two rows that count.
  IF NEW.removed AND NOT OLD.removed AND voucher.created_xact = pg_current_xact_id() THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'removed', 'operation', 'create'));
  END IF;
  PERFORM ledger.assert_voucher_open(OLD.company_id, voucher.fiscal_year_id, voucher.series_code, voucher.transaction_date);
  IF NEW.removed AND NOT OLD.removed THEN
    SELECT a.actor_id, a.actor_kind INTO actor FROM ledger.current_actor() AS a;
    NEW.removed_at := clock_timestamp();
    NEW.removed_by := actor.actor_id;
    NEW.removed_by_kind := actor.actor_kind;
  END IF;
  RETURN NEW;
END
$alter$;

-- An added row, a changed text or a strike after the booking's own
-- transaction is a change to its voucher: it moves the voucher's altered
-- stamps and modified time.
CREATE FUNCTION ledger.voucher_rows_touch_voucher() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $touch$
DECLARE
  booked xid8;
  actor record;
  stamp timestamptz;
BEGIN
  PERFORM ledger.assert_company(NEW.company_id);
  IF TG_OP = 'UPDATE' AND NEW.transaction_information IS NOT DISTINCT FROM OLD.transaction_information AND NEW.removed IS NOT DISTINCT FROM OLD.removed THEN
    RETURN NULL;
  END IF;
  SELECT v.created_xact INTO booked FROM ledger.vouchers AS v WHERE v.company_id = NEW.company_id AND v.id = NEW.voucher_id;
  IF booked = pg_current_xact_id() THEN
    RETURN NULL;
  END IF;
  SELECT a.actor_id, a.actor_kind INTO actor FROM ledger.current_actor() AS a;
  stamp := clock_timestamp();
  UPDATE ledger.vouchers AS v
  SET modified_at = stamp, altered_at = stamp, altered_by = actor.actor_id, altered_by_kind = actor.actor_kind
  WHERE v.company_id = NEW.company_id AND v.id = NEW.voucher_id;
  RETURN NULL;
END
$touch$;

-- A row is never removed from a voucher that stays. The rows of a deleted
-- voucher go by the cascade, once the voucher itself is gone.
CREATE FUNCTION ledger.voucher_rows_keep() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $keep$
BEGIN
  IF EXISTS (SELECT FROM ledger.vouchers AS v WHERE v.company_id = OLD.company_id AND v.id = OLD.voucher_id) THEN
    PERFORM ledger.refuse('row_removal', jsonb_build_object('voucher', OLD.voucher_id));
  END IF;
  RETURN OLD;
END
$keep$;

-- Radera ------------------------------------------------------------------------------

-- Radera: the period lock applies by the voucher's date (not in the closing
-- series); the voucher is the last of its series, directly below the
-- counter, so the voucher just below a void range is never last; no voucher
-- reverses it; and, as it stands now, it has two rows and they balance. The
-- checks at commit never see a voucher that is gone, so a deletion in the
-- transaction that booked the voucher, or that changed its rows, makes those
-- two checks here: the record holds no voucher that could not have been
-- booked. Then it moves to the record with its rows, each with its account's
-- name, as its number's next deletion, with who deleted it and when. The
-- counter goes back by one, and the rows go by the cascade. The voucher is
-- locked as the statement's target before this trigger runs, and its rows
-- after it, by the cascade (the lock order at the top of this file).
CREATE FUNCTION ledger.vouchers_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $delete$
DECLARE
  series record;
  counter integer;
  reversing record;
  actor record;
  stamp timestamptz;
  deletions integer;
  entry uuid;
BEGIN
  PERFORM ledger.assert_company(OLD.company_id);
  PERFORM ledger.assert_voucher_open(OLD.company_id, OLD.fiscal_year_id, OLD.series_code, OLD.transaction_date);
  SELECT s.id INTO series
  FROM ledger.voucher_series AS s
  WHERE s.company_id = OLD.company_id AND s.fiscal_year_id = OLD.fiscal_year_id AND s.code = OLD.series_code;
  SELECT c.next_number INTO counter
  FROM ledger.voucher_counters AS c
  WHERE c.company_id = OLD.company_id AND c.series_id = series.id
  FOR UPDATE;
  IF OLD.number <> counter - 1 THEN
    PERFORM ledger.refuse('not_last_in_series', jsonb_build_object('series', OLD.series_code, 'number', OLD.number));
  END IF;
  SELECT r.series_code, r.number INTO reversing
  FROM ledger.vouchers AS r
  WHERE r.company_id = OLD.company_id AND r.reverses_voucher_id = OLD.id;
  IF FOUND THEN
    PERFORM ledger.refuse('reversing_voucher_exists', jsonb_build_object('series', reversing.series_code, 'number', reversing.number));
  END IF;
  PERFORM ledger.assert_enough_rows(OLD.company_id, OLD.id);
  PERFORM ledger.assert_balanced(OLD.company_id, OLD.id);
  SELECT a.actor_id, a.actor_kind INTO actor FROM ledger.current_actor() AS a;
  stamp := clock_timestamp();
  deletions := 1 + (
    SELECT count(*) FROM ledger.deleted_vouchers AS d
    WHERE d.company_id = OLD.company_id AND d.fiscal_year_id = OLD.fiscal_year_id AND d.series_code = OLD.series_code AND d.number = OLD.number
  );
  INSERT INTO ledger.deleted_vouchers (
    voucher_id, company_id, fiscal_year_id, series_code, number, description, comments, transaction_date, reference_type, reference_number,
    reverses_voucher_id, created_at, created_by, created_by_kind, created_xact, modified_at, altered_at, altered_by, altered_by_kind,
    deletion_count, deleted_at, deleted_by, deleted_by_kind, deleted_xact
  ) VALUES (
    OLD.id, OLD.company_id, OLD.fiscal_year_id, OLD.series_code, OLD.number, OLD.description, OLD.comments, OLD.transaction_date,
    OLD.reference_type, OLD.reference_number, OLD.reverses_voucher_id, OLD.created_at, OLD.created_by, OLD.created_by_kind,
    OLD.created_xact, OLD.modified_at, OLD.altered_at, OLD.altered_by, OLD.altered_by_kind,
    deletions, stamp, actor.actor_id, actor.actor_kind, pg_current_xact_id()
  )
  RETURNING id INTO entry;
  INSERT INTO ledger.deleted_voucher_rows (
    row_id, company_id, deleted_voucher_id, fiscal_year_id, position, account_number, debit, credit, transaction_information, quantity,
    removed, removed_at, removed_by, removed_by_kind, created_at, created_by, created_by_kind, account_description
  )
  SELECT r.id, r.company_id, entry, r.fiscal_year_id, r.position, r.account_number, r.debit, r.credit, r.transaction_information, r.quantity,
    r.removed, r.removed_at, r.removed_by, r.removed_by_kind, r.created_at, r.created_by, r.created_by_kind, a.description
  FROM ledger.voucher_rows AS r
  JOIN ledger.accounts AS a ON a.company_id = r.company_id AND a.fiscal_year_id = r.fiscal_year_id AND a.number = r.account_number
  WHERE r.company_id = OLD.company_id AND r.voucher_id = OLD.id
  ORDER BY r.position;
  UPDATE ledger.voucher_counters AS c SET next_number = OLD.number WHERE c.company_id = OLD.company_id AND c.series_id = series.id;
  RETURN OLD;
END
$delete$;

-- Only a deletion writes the record of deleted vouchers, and no role
-- changes or deletes it, the owner neither.
CREATE FUNCTION ledger.deleted_vouchers_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $append$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF pg_trigger_depth() < 2 THEN
      PERFORM ledger.refuse('internal_only', jsonb_build_object('table', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, 'field', NULL));
    END IF;
    RETURN NEW;
  END IF;
  PERFORM ledger.refuse('append_only', jsonb_build_object('table', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, 'operation', TG_OP));
  RETURN NULL;
END
$append$;

-- The counters, the fiscal years ---------------------------------------------------

-- The counters' rules from 0003, with the two proofs that the vouchers bring:
-- up by one when the voucher with the old next number was booked in the same
-- transaction, and back by one while the voucher with the new next number is
-- being deleted: it is in the record from this transaction, and not yet out
-- of the vouchers. Each accepted move sets the modified time.
CREATE OR REPLACE FUNCTION ledger.voucher_counters_rules() RETURNS trigger
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
  IF NEW.next_number = OLD.next_number + 1 AND EXISTS (
    SELECT FROM ledger.vouchers AS v
    WHERE v.company_id = NEW.company_id AND v.fiscal_year_id = series.fiscal_year_id AND v.series_code = series.code
      AND v.number = OLD.next_number AND v.created_xact = pg_current_xact_id()
  ) THEN
    NEW.modified_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.next_number = OLD.next_number - 1 AND EXISTS (
    SELECT FROM ledger.deleted_vouchers AS d
    JOIN ledger.vouchers AS v ON v.company_id = d.company_id AND v.id = d.voucher_id
    WHERE d.company_id = NEW.company_id AND d.fiscal_year_id = series.fiscal_year_id AND d.series_code = series.code
      AND d.number = NEW.next_number AND d.deleted_xact = pg_current_xact_id()
  ) THEN
    NEW.modified_at := clock_timestamp();
    RETURN NEW;
  END IF;
  PERFORM ledger.refuse('counter_move', jsonb_build_object('series', series.code, 'from', OLD.next_number, 'to', NEW.next_number));
  RETURN NULL;
END
$rules$;

-- The fiscal years' rules from 0002, with the vouchers: new dates may leave
-- neither a period nor a voucher of the year outside it. A booking and a
-- change of a voucher's date lock the year's row FOR SHARE until their
-- transaction ends, and writes run at READ COMMITTED
-- (ledger.assert_read_committed), so this count sees every voucher. The
-- year's end also places the automatic lock, at 60 days after it, so every
-- booking, change and deletion of one of the year's vouchers locks the year's
-- row FOR SHARE too (ledger.assert_voucher_open): a change of the year's
-- dates waits for each, and each waits for it and then reads the new end.
CREATE OR REPLACE FUNCTION ledger.fiscal_years_rules() RETURNS trigger
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
    stranded := (
      SELECT count(*) FROM ledger.periods AS p
      WHERE p.company_id = NEW.company_id AND p.fiscal_year_id = NEW.id
        AND (p.from_date < NEW.from_date OR p.to_date > NEW.to_date)
    );
    IF stranded > 0 THEN
      PERFORM ledger.refuse('fiscal_year_strands_rows', jsonb_build_object('table', 'ledger.periods', 'count', stranded));
    END IF;
    stranded := (
      SELECT count(*) FROM ledger.vouchers AS v
      WHERE v.company_id = NEW.company_id AND v.fiscal_year_id = NEW.id
        AND (v.transaction_date < NEW.from_date OR v.transaction_date > NEW.to_date)
    );
    IF stranded > 0 THEN
      PERFORM ledger.refuse('fiscal_year_strands_rows', jsonb_build_object('table', 'ledger.vouchers', 'count', stranded));
    END IF;
  END IF;
  RETURN NEW;
END
$rules$;

-- The triggers and the tables' protection ---------------------------------------------

CREATE TRIGGER vouchers_book BEFORE INSERT ON ledger.vouchers
  FOR EACH ROW EXECUTE FUNCTION ledger.vouchers_book();
CREATE TRIGGER vouchers_move_counter AFTER INSERT ON ledger.vouchers
  FOR EACH ROW EXECUTE FUNCTION ledger.vouchers_move_counter();
CREATE TRIGGER vouchers_alter BEFORE UPDATE ON ledger.vouchers
  FOR EACH ROW EXECUTE FUNCTION ledger.vouchers_alter();
CREATE TRIGGER vouchers_delete BEFORE DELETE ON ledger.vouchers
  FOR EACH ROW EXECUTE FUNCTION ledger.vouchers_delete();
CREATE CONSTRAINT TRIGGER vouchers_enough_rows AFTER INSERT ON ledger.vouchers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.vouchers_enough_rows();

CREATE TRIGGER voucher_rows_add BEFORE INSERT ON ledger.voucher_rows
  FOR EACH ROW EXECUTE FUNCTION ledger.voucher_rows_add();
CREATE TRIGGER voucher_rows_alter BEFORE UPDATE ON ledger.voucher_rows
  FOR EACH ROW EXECUTE FUNCTION ledger.voucher_rows_alter();
CREATE TRIGGER voucher_rows_keep BEFORE DELETE ON ledger.voucher_rows
  FOR EACH ROW EXECUTE FUNCTION ledger.voucher_rows_keep();
CREATE TRIGGER voucher_rows_touch_voucher AFTER INSERT OR UPDATE ON ledger.voucher_rows
  FOR EACH ROW EXECUTE FUNCTION ledger.voucher_rows_touch_voucher();
CREATE CONSTRAINT TRIGGER voucher_rows_balance AFTER INSERT OR UPDATE ON ledger.voucher_rows
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.voucher_rows_balance();

CREATE TRIGGER deleted_vouchers_append_only BEFORE INSERT OR UPDATE OR DELETE ON ledger.deleted_vouchers
  FOR EACH ROW EXECUTE FUNCTION ledger.deleted_vouchers_append_only();
CREATE TRIGGER deleted_voucher_rows_append_only BEFORE INSERT OR UPDATE OR DELETE ON ledger.deleted_voucher_rows
  FOR EACH ROW EXECUTE FUNCTION ledger.deleted_vouchers_append_only();

SELECT meta.protect_company_table('ledger.vouchers', 'id');
SELECT meta.protect_company_table('ledger.voucher_rows', 'id');
SELECT meta.protect_company_table('ledger.deleted_vouchers', 'id');
SELECT meta.protect_company_table('ledger.deleted_voucher_rows', 'id');
GRANT INSERT, UPDATE, DELETE ON ledger.vouchers TO nortfox_app;
GRANT INSERT, UPDATE ON ledger.voucher_rows TO nortfox_app;
