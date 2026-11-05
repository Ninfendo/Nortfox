-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0007 the companies and their members: a company's memberships, the
-- behandlingshistorik entries that change no company row, the members' work
-- contacts, the person's recent companies, the session's chosen company, and
-- the one function that says which companies a person may enter. Every
-- company has an active system administrator from its first commit. See
-- db/README.md, the schema access, and decisions 0002, 0008 and 0009 in
-- docs/decisions/.
--
-- The memberships and the entries are company tables: they follow every rule
-- of a company table, the history trigger among them, so every change of a
-- membership is in the behandlingshistorik. The work contacts and the recent
-- companies are install-wide tables, of the company class and the person
-- class, and keep no history.

-- A refusal ------------------------------------------------------------------
--
-- last_system_administrator: a company would be left without an active system
-- administrator. The list gets the new reason in its place by code.
CREATE OR REPLACE FUNCTION ledger.refusal_reasons() RETURNS TABLE (reason text, code text)
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
    ('install_not_empty', 'NF021'),
    ('last_system_administrator', 'NF022'),
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

-- The schema -------------------------------------------------------------------
--
-- A reader may now use it: it holds company tables, whose rows a reader reads
-- as it reads every company table's. It still gets nothing on an install-wide
-- table.
GRANT USAGE ON SCHEMA access TO nortfox_reader;

-- Companies --------------------------------------------------------------------
--
-- A company's tenant id comes from the sequence, and neither it, nor the
-- company_id, nor the organisation number ever changes (issue 12).
CREATE OR REPLACE FUNCTION ledger.companies_keys() RETURNS trigger
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
  IF NEW.organization_number IS DISTINCT FROM OLD.organization_number THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'organization_number', 'operation', 'update'));
  END IF;
  RETURN NEW;
END
$keys$;

-- The memberships ----------------------------------------------------------------
--
-- A membership is a person in a company: Användare in the company. Its status
-- is invited, active, inactive, removed or left. user_id is the person's
-- identity, and is empty while the membership is invited, at first and after
-- a disconnect. live_user_id is user_id while the membership is live, and
-- empty once it is removed or left: so a person has one live membership per
-- company, and a removed or left person may be invited again. admin_level is
-- the system administrator's level, owner or admin, or none. The idle time,
-- "Utloggning efter inaktivitet", is one of the five values the established
-- screen offers, 2 hours by default. The database stamps when the membership
-- was made. company_id and id together are a key, so a table that names a
-- membership pairs it with its company.
CREATE TABLE access.memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES ledger.companies (company_id),
  user_id uuid REFERENCES access.identities (id),
  live_user_id uuid,
  status text NOT NULL CONSTRAINT memberships_status_known CHECK (status IN ('invited', 'active', 'inactive', 'removed', 'left')),
  admin_level text CONSTRAINT memberships_admin_level_known CHECK (admin_level IN ('owner', 'admin')),
  idle_timeout_minutes integer NOT NULL DEFAULT 120 CONSTRAINT memberships_idle_timeout_known CHECK (idle_timeout_minutes IN (15, 30, 60, 120, 480)),
  created_at timestamptz NOT NULL,
  CONSTRAINT memberships_user_by_status CHECK (CASE status WHEN 'invited' THEN user_id IS NULL WHEN 'removed' THEN true ELSE user_id IS NOT NULL END),
  CONSTRAINT memberships_live_user CHECK (live_user_id IS NOT DISTINCT FROM CASE WHEN status IN ('removed', 'left') THEN NULL ELSE user_id END),
  CONSTRAINT memberships_one_live UNIQUE (company_id, live_user_id),
  CONSTRAINT memberships_company_id_id_key UNIQUE (company_id, id)
);

-- The rules no policy keeps, for every role:
-- - no membership is deleted;
-- - the database stamps when it was made and keeps live_user_id, and refuses
--   either when it is given; its id and its company never change;
-- - a membership is made invited, or active;
-- - the owner level is given only with the company: on the insert of the
--   company's first membership, read after the company's row is locked, and
--   never by an update;
-- - the status moves only as the server's operations move it: an invited
--   membership is accepted (active) or removed; a live one is activated,
--   deactivated, disconnected (invited again), removed or left. removed and
--   left are final: such a membership never changes again;
-- - the person changes only through a disconnect, which empties user_id as
--   the status goes from active or inactive to invited, and an acceptance,
--   which sets it as the status goes from invited to active. A change from one
--   identity straight to another is refused;
-- - only the member's own person leaves: the transaction's actor, a user or an
--   integration that acts for that person.
-- Each refusal is immutable_field, with the field.
CREATE FUNCTION access.memberships_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
DECLARE
  actor record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM ledger.refuse('append_only', jsonb_build_object('table', 'access.memberships', 'operation', 'DELETE'));
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_at IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_at', 'operation', 'create'));
    END IF;
    IF NEW.live_user_id IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'live_user_id', 'operation', 'create'));
    END IF;
    IF NEW.status NOT IN ('invited', 'active') THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'status', 'operation', 'create'));
    END IF;
    IF NEW.admin_level = 'owner' THEN
      PERFORM 1 FROM ledger.companies AS c WHERE c.company_id = NEW.company_id FOR NO KEY UPDATE;
      IF EXISTS (SELECT FROM access.memberships AS m WHERE m.company_id = NEW.company_id) THEN
        PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'admin_level', 'operation', 'create'));
      END IF;
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.live_user_id := NEW.user_id;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'id', 'operation', 'update'));
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'company_id', 'operation', 'update'));
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_at', 'operation', 'update'));
  END IF;
  IF NEW.live_user_id IS DISTINCT FROM OLD.live_user_id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'live_user_id', 'operation', 'update'));
  END IF;
  IF OLD.status IN ('removed', 'left') AND NEW IS DISTINCT FROM OLD THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'status', 'operation', 'update'));
  END IF;
  IF NEW.admin_level = 'owner' AND OLD.admin_level IS DISTINCT FROM 'owner' THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'admin_level', 'operation', 'update'));
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'invited' AND NEW.status IN ('active', 'removed'))
    OR (OLD.status IN ('active', 'inactive') AND NEW.status IN ('active', 'inactive', 'invited', 'removed', 'left'))
  ) THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'status', 'operation', 'update'));
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id AND NOT (
    (NEW.user_id IS NULL AND OLD.status IN ('active', 'inactive') AND NEW.status = 'invited')
    OR (OLD.user_id IS NULL AND OLD.status = 'invited' AND NEW.status = 'active')
  ) THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'user_id', 'operation', 'update'));
  END IF;
  IF NEW.status = 'left' AND OLD.status IS DISTINCT FROM 'left' THEN
    SELECT a.actor_id, a.actor_kind INTO actor FROM ledger.current_actor() AS a;
    IF actor.actor_kind NOT IN ('user', 'integration') OR actor.actor_id IS DISTINCT FROM OLD.user_id THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'status', 'operation', 'update'));
    END IF;
  END IF;
  NEW.live_user_id := CASE WHEN NEW.status IN ('removed', 'left') THEN NULL ELSE NEW.user_id END;
  RETURN NEW;
END
$rules$;

CREATE TRIGGER memberships_rules BEFORE INSERT OR UPDATE OR DELETE ON access.memberships
  FOR EACH ROW EXECUTE FUNCTION access.memberships_rules();
SELECT meta.protect_company_table('access.memberships', 'id');
-- The owner also reads the live memberships of the transaction's person, in
-- every company: only access.active_membership reads through this policy,
-- which the app may call, and the rules that a later part adds for an
-- identity's deletion. The app itself has only the company policies, so it
-- never reads a membership outside the transaction's company.
CREATE POLICY person_owner ON access.memberships FOR SELECT TO nortfox_owner USING (live_user_id = access.current_person_id());
-- A membership is never deleted, so the app may add and change them only.
GRANT INSERT, UPDATE ON access.memberships TO nortfox_app;

-- The owner reads the companies where the transaction's person has a live
-- membership, through the same function. The company policies stay as they
-- are for every other read.
CREATE POLICY person_owner ON ledger.companies FOR SELECT TO nortfox_owner
  USING (EXISTS (SELECT FROM access.memberships AS m WHERE m.company_id = companies.company_id AND m.live_user_id = access.current_person_id()));

-- A system administrator ---------------------------------------------------------
--
-- A company always has at least one active system administrator, from its
-- first commit (issue 12): at the commit of each transaction that makes a
-- company or changes a membership, the company has an active member whose
-- admin level is owner or admin, or the commit is refused
-- (last_system_administrator). The check locks the company's row first, FOR
-- NO KEY UPDATE, and then reads the memberships in a statement of its own,
-- at READ COMMITTED. So of two changes at once that each take away one of
-- the last two administrators, the second waits for the first's commit, then
-- reads it, and is refused. The check reads the company's rows as the
-- company's own transaction does, with the company set for its two
-- statements, whatever company the transaction set last, and sets the
-- transaction's company back after them.
CREATE FUNCTION access.keep_system_administrator() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $admin$
DECLARE
  company uuid := NEW.company_id;
  kept text := current_setting('nortfox.company_id', true);
BEGIN
  PERFORM set_config('nortfox.company_id', company::text, true);
  PERFORM 1 FROM ledger.companies AS c WHERE c.company_id = company FOR NO KEY UPDATE;
  IF NOT EXISTS (
    SELECT FROM access.memberships AS m
    WHERE m.company_id = company AND m.status = 'active' AND m.admin_level IN ('owner', 'admin')
  ) THEN
    PERFORM ledger.refuse('last_system_administrator', jsonb_build_object('company_id', company));
  END IF;
  PERFORM set_config('nortfox.company_id', COALESCE(kept, ''), true);
  RETURN NULL;
END
$admin$;

CREATE CONSTRAINT TRIGGER companies_system_administrator AFTER INSERT ON ledger.companies
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.keep_system_administrator();
CREATE CONSTRAINT TRIGGER memberships_system_administrator AFTER INSERT OR UPDATE ON access.memberships
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.keep_system_administrator();

-- The entries that change no company row -------------------------------------------
--
-- A behandlingshistorik entry for an act that changes no company row, such as
-- a sign-in: its program and its heading, as stable codes in kebab-case that
-- the server maps to the screen's words, the person it is about, its details
-- as an object, and when it happened by the server's clock. Its insert's
-- history row is the entry. No role changes or deletes one.
CREATE TABLE access.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES ledger.companies (company_id),
  program text NOT NULL CONSTRAINT events_program_form CHECK (program ~ '^[a-z]+(-[a-z]+)*$'),
  heading text NOT NULL CONSTRAINT events_heading_form CHECK (heading ~ '^[a-z]+(-[a-z]+)*$'),
  subject_id uuid REFERENCES access.identities (id),
  details jsonb NOT NULL DEFAULT '{}' CONSTRAINT events_details_object CHECK (jsonb_typeof(details) = 'object'),
  at timestamptz NOT NULL
);

CREATE FUNCTION access.events_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
BEGIN
  PERFORM ledger.refuse('append_only', jsonb_build_object('table', 'access.events', 'operation', TG_OP));
  RETURN NULL;
END
$rules$;

CREATE TRIGGER events_rules BEFORE UPDATE OR DELETE ON access.events
  FOR EACH ROW EXECUTE FUNCTION access.events_rules();
-- The server finds a person's latest entry in a company, for the bound of one
-- failed sign-in entry a minute.
CREATE INDEX events_subject ON access.events (company_id, subject_id, at);
SELECT meta.protect_company_table('access.events', 'id');
GRANT INSERT ON access.events TO nortfox_app;

-- The work contacts ---------------------------------------------------------------
--
-- Användaruppgifter: a member's work e-mail address and phone number in one
-- company, where the company's notices go. A company table of the install-wide
-- kind: the app reads and writes only the transaction's company's, and the
-- membership pairs with its company, so a row can never name company A and a
-- membership of company B. It keeps no history: the work e-mail and phone are
-- profile data, which an identity's deletion erases. The database stamps when
-- a row last changed.
CREATE TABLE access.membership_contacts (
  contact_company_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  work_email text CONSTRAINT membership_contacts_work_email_length CHECK (char_length(work_email) BETWEEN 1 AND 254),
  work_phone text CONSTRAINT membership_contacts_work_phone_length CHECK (char_length(work_phone) BETWEEN 1 AND 50),
  updated_at timestamptz NOT NULL,
  CONSTRAINT membership_contacts_pkey PRIMARY KEY (contact_company_id, membership_id),
  CONSTRAINT membership_contacts_membership_fkey FOREIGN KEY (contact_company_id, membership_id) REFERENCES access.memberships (company_id, id)
);

-- The row's membership never changes, and the database stamps the time of
-- each change, and refuses one that is given.
CREATE FUNCTION access.membership_contacts_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.updated_at IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'updated_at', 'operation', 'create'));
    END IF;
  ELSE
    IF NEW.contact_company_id IS DISTINCT FROM OLD.contact_company_id THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'contact_company_id', 'operation', 'update'));
    END IF;
    IF NEW.membership_id IS DISTINCT FROM OLD.membership_id THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'membership_id', 'operation', 'update'));
    END IF;
    IF NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'updated_at', 'operation', 'update'));
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$rules$;

CREATE TRIGGER membership_contacts_rules BEFORE INSERT OR UPDATE ON access.membership_contacts
  FOR EACH ROW EXECUTE FUNCTION access.membership_contacts_rules();
SELECT meta.protect_install_table('access.membership_contacts');
CREATE POLICY company_select ON access.membership_contacts FOR SELECT TO nortfox_app USING (contact_company_id = ledger.current_company_id());
CREATE POLICY company_insert ON access.membership_contacts FOR INSERT TO nortfox_app WITH CHECK (contact_company_id = ledger.current_company_id());
CREATE POLICY company_update ON access.membership_contacts FOR UPDATE TO nortfox_app
  USING (contact_company_id = ledger.current_company_id()) WITH CHECK (contact_company_id = ledger.current_company_id());
CREATE POLICY company_delete ON access.membership_contacts FOR DELETE TO nortfox_app USING (contact_company_id = ledger.current_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON access.membership_contacts TO nortfox_app;

-- The recent companies ------------------------------------------------------------
--
-- The companies the person chose last, each once, with when, by the server's
-- clock. A person table: the app reads and writes only the person's own.
CREATE TABLE access.recent_companies (
  identity_id uuid NOT NULL REFERENCES access.identities (id),
  chosen_company_id uuid NOT NULL REFERENCES ledger.companies (company_id),
  chosen_at timestamptz NOT NULL,
  CONSTRAINT recent_companies_pkey PRIMARY KEY (identity_id, chosen_company_id)
);
SELECT meta.protect_install_table('access.recent_companies');
CREATE POLICY person_select ON access.recent_companies FOR SELECT TO nortfox_app USING (identity_id = access.current_person_id());
CREATE POLICY person_insert ON access.recent_companies FOR INSERT TO nortfox_app WITH CHECK (identity_id = access.current_person_id());
CREATE POLICY person_update ON access.recent_companies FOR UPDATE TO nortfox_app
  USING (identity_id = access.current_person_id()) WITH CHECK (identity_id = access.current_person_id());
GRANT SELECT, INSERT, UPDATE ON access.recent_companies TO nortfox_app;

-- A session's company --------------------------------------------------------------
--
-- The company a session chose, the membership it chose it with, paired with
-- the company, and the member's permissions when it chose, as an object of
-- each permission and the end of the grant that gives it, or null. A session
-- has all three or none.
ALTER TABLE access.sessions
  ADD COLUMN current_company_id uuid,
  ADD COLUMN current_membership_id uuid,
  ADD COLUMN permissions jsonb,
  ADD CONSTRAINT sessions_current_membership_fkey FOREIGN KEY (current_company_id, current_membership_id) REFERENCES access.memberships (company_id, id),
  ADD CONSTRAINT sessions_company_whole CHECK (num_nulls(current_company_id, current_membership_id, permissions) IN (0, 3)),
  ADD CONSTRAINT sessions_permissions_object CHECK (jsonb_typeof(permissions) = 'object');
-- The live sessions of a membership, which end when it stops being active.
CREATE INDEX sessions_current_membership ON access.sessions (current_company_id, current_membership_id) WHERE ended_at IS NULL;

-- A session ends at once when the membership it chose its company with stops
-- being active: deactivated, disconnected, removed or left (issue 12,
-- Sessions 2 and Users 4). So it stays ended when the membership is active
-- again, also when it made no request between. The server checks the
-- membership on every request too. Each such session ends with the reason
-- membership, at the database's clock.
CREATE FUNCTION access.end_membership_sessions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $end$
BEGIN
  UPDATE access.sessions AS s SET ended_at = clock_timestamp(), end_reason = 'membership'
  WHERE s.current_company_id = OLD.company_id AND s.current_membership_id = OLD.id AND s.ended_at IS NULL;
  RETURN NULL;
END
$end$;

CREATE TRIGGER memberships_end_sessions AFTER UPDATE ON access.memberships
  FOR EACH ROW WHEN (OLD.status = 'active' AND NEW.status IS DISTINCT FROM 'active') EXECUTE FUNCTION access.end_membership_sessions();

-- A session's second step: the TOTP step, or a known device inside its 90
-- days, for a sign-in with a password; none for the methods that need no
-- second step. A sign-in's entry in the behandlingshistorik names it. A
-- password session always had one. A session of 0006 holds no second step,
-- so each one is deleted first: its person signs in again.
DELETE FROM access.sessions;
ALTER TABLE access.sessions
  ADD COLUMN second_step text CONSTRAINT sessions_second_step_known CHECK (second_step IN ('totp', 'known-device')),
  ADD CONSTRAINT sessions_second_step_by_method CHECK ((method IN ('password-email', 'password-personnummer')) = (second_step IS NOT NULL));

-- The idle time a session was last seen under: the membership's "Utloggning
-- efter inaktivitet" while it works in a company, and 120 minutes while it
-- works in none. The server ends a session whose last sight is further back
-- than the lower of this and the idle time in force now. A lower idle time
-- of the membership lowers this at once, in the same transaction (the
-- trigger below), so it holds at once for every session of the membership,
-- also once the idle time is raised again. A higher one holds for a session
-- from its next request. So a session past its idle time never comes back
-- when the idle time is raised.
ALTER TABLE access.sessions
  ADD COLUMN idle_timeout_minutes integer NOT NULL DEFAULT 120 CONSTRAINT sessions_idle_timeout_known CHECK (idle_timeout_minutes IN (15, 30, 60, 120, 480));

-- Moves a live session's last sight on, never back, with the idle time it is
-- seen under, while the session works with `membership`, or in no company
-- when it is NULL: a request at the same time or later than the last sight
-- moves it. So a request that read the session before it chose another
-- company never gives it the old membership's idle time. It takes the place
-- of 0006's, which had no idle time.
DROP FUNCTION access.touch_session(uuid, timestamptz);
CREATE FUNCTION access.touch_session(session uuid, at timestamptz, idle_minutes integer, membership uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $touch$
BEGIN
  UPDATE access.sessions AS s SET last_seen_at = touch_session.at, idle_timeout_minutes = touch_session.idle_minutes
  WHERE s.id = touch_session.session AND s.ended_at IS NULL AND s.last_seen_at <= touch_session.at
    AND s.current_membership_id IS NOT DISTINCT FROM touch_session.membership
    AND (s.last_seen_at, s.idle_timeout_minutes) IS DISTINCT FROM (touch_session.at, touch_session.idle_minutes);
  RETURN FOUND;
END
$touch$;

-- A lower idle time of a membership lowers the idle time of each of its live
-- sessions at once, at the membership's update, so it holds for a session
-- that makes no request too. It first locks the row of every live session
-- of the membership, also one whose idle time is already as low or lower,
-- and only then lowers each one above the new idle time. A request of the
-- session that writes the session locks its row first
-- (access.lock_session), and reads the membership after the lock: so it
-- either comes first, and this lowers what it wrote, or waits for this
-- transaction and reads the lower idle time. So a request that read a
-- higher idle time before this commits never stores it.
CREATE FUNCTION access.lower_session_idle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $lower$
BEGIN
  PERFORM 1 FROM access.sessions AS s
  WHERE s.current_company_id = NEW.company_id AND s.current_membership_id = NEW.id AND s.ended_at IS NULL
  FOR NO KEY UPDATE OF s;
  UPDATE access.sessions AS s SET idle_timeout_minutes = NEW.idle_timeout_minutes
  WHERE s.current_company_id = NEW.company_id AND s.current_membership_id = NEW.id AND s.ended_at IS NULL
    AND s.idle_timeout_minutes > NEW.idle_timeout_minutes;
  RETURN NULL;
END
$lower$;

CREATE TRIGGER memberships_lower_session_idle AFTER UPDATE OF idle_timeout_minutes ON access.memberships
  FOR EACH ROW WHEN (NEW.idle_timeout_minutes < OLD.idle_timeout_minutes) EXECUTE FUNCTION access.lower_session_idle();

-- The purge, as 0006 made it, but for one thing: an identity's failed
-- sign-ins of the last hour stay past the 100 latest events, by the
-- database's clock, since the behandlingshistorik counts them (a failed
-- sign-in's entry holds the count of the identity's failed sign-ins in the
-- last hour, read from these events by the same clock). Kontoaktivitet
-- shows the 100 latest. It deletes no identity.
CREATE OR REPLACE FUNCTION access.purge_expired(at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $purge$
BEGIN
  DELETE FROM access.login_challenges AS c WHERE c.expires_at <= purge_expired.at;
  DELETE FROM access.setup_tokens AS t WHERE t.expires_at <= purge_expired.at;
  DELETE FROM access.sessions AS s
  WHERE s.ended_at <= purge_expired.at - interval '30 days'
    OR (s.ended_at IS NULL AND s.started_at <= purge_expired.at - interval '30 days 12 hours');
  DELETE FROM access.attempt_counters AS a
  WHERE a.window_started_at <= purge_expired.at - interval '1 hour' AND (a.locked_until IS NULL OR a.locked_until <= purge_expired.at);
  DELETE FROM access.idempotency_keys AS k WHERE k.created_at <= purge_expired.at - interval '24 hours';
  DELETE FROM access.account_events AS e
  WHERE e.id IN (
    SELECT r.id FROM (
      SELECT x.id, x.kind, x.details, x.at, row_number() OVER (PARTITION BY x.identity_id ORDER BY x.at DESC, x.id DESC) AS place
      FROM access.account_events AS x
    ) AS r
    WHERE r.place > 100
      AND NOT (r.kind = 'sign-in' AND r.details ->> 'outcome' IS NOT DISTINCT FROM 'failed' AND r.at > clock_timestamp() - interval '1 hour')
  );
END
$purge$;

-- Opens a session, with its second step, and gives its id. The device, if
-- any, is the person's. It takes the place of 0006's, which had no second
-- step.
DROP FUNCTION access.open_session(bytea, uuid, text, uuid, timestamptz);
CREATE FUNCTION access.open_session(token_hash bytea, person uuid, method text, second_step text, device uuid, at timestamptz) RETURNS uuid
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  INSERT INTO access.sessions (token_hash, identity_id, method, second_step, device_id, started_at, last_seen_at)
  SELECT open_session.token_hash, i.id, open_session.method, open_session.second_step, open_session.device, open_session.at, open_session.at
  FROM access.identities AS i
  WHERE i.id = open_session.person AND i.status = 'active'
    AND (open_session.device IS NULL OR EXISTS (
      SELECT FROM access.known_devices AS d WHERE d.id = open_session.device AND d.identity_id = open_session.person
    ))
  RETURNING id;
END;

-- A session that has not ended, by its hash, with the identity's status, its
-- second step, the idle time it was last seen under, and its company,
-- membership and permissions when it chose a company. The server ends one
-- that is past its time, or whose membership is no longer the person's
-- active one. It takes the place of 0006's.
DROP FUNCTION access.session_by_token(bytea);
CREATE FUNCTION access.session_by_token(token_hash bytea)
RETURNS TABLE (
  session_id uuid, identity_id uuid, status text, method text, second_step text, device_id uuid, started_at timestamptz, last_seen_at timestamptz,
  idle_timeout_minutes integer, current_company_id uuid, current_membership_id uuid, permissions jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT s.id, s.identity_id, i.status, s.method, s.second_step, s.device_id, s.started_at, s.last_seen_at,
    s.idle_timeout_minutes, s.current_company_id, s.current_membership_id, s.permissions
  FROM access.sessions AS s JOIN access.identities AS i ON i.id = s.identity_id
  WHERE s.token_hash = session_by_token.token_hash AND s.ended_at IS NULL;
END;

-- The same session as access.session_by_token gives, with its row locked
-- FOR NO KEY UPDATE until the transaction ends, read after the lock: a
-- session that ended while the caller waited is not given. The server reads
-- a session so before each write of its lookup, ends or notes it, and judges
-- it again on that row. So the requests of one session that write take
-- turns, and none writes from what it read before another one's write: a
-- burst past the idle time ends the session once and is refused whole.
CREATE FUNCTION access.lock_session(token_hash bytea)
RETURNS TABLE (
  session_id uuid, identity_id uuid, status text, method text, second_step text, device_id uuid, started_at timestamptz, last_seen_at timestamptz,
  idle_timeout_minutes integer, current_company_id uuid, current_membership_id uuid, permissions jsonb
)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT s.id, s.identity_id, i.status, s.method, s.second_step, s.device_id, s.started_at, s.last_seen_at,
    s.idle_timeout_minutes, s.current_company_id, s.current_membership_id, s.permissions
  FROM access.sessions AS s JOIN access.identities AS i ON i.id = s.identity_id
  WHERE s.token_hash = lock_session.token_hash AND s.ended_at IS NULL
  FOR NO KEY UPDATE OF s;
END;

-- Byt företag: a live session of the transaction's person works in a company
-- from now on, with the membership it chose it with and the person's
-- permissions there as an object of each permission and the end of the grant
-- that gives it, or null. The request that chooses is the session's last
-- sight, at `at`, under the membership's idle time, `idle_minutes`. It gives
-- false when the session is not the person's, or has ended. The server calls
-- it only with a membership that the one membership function gave in the
-- same transaction, after it locked the membership's row FOR SHARE and read
-- that it is still active: a change of its status waits for that lock, so
-- it either came first, and nothing is chosen, or ends the session through
-- memberships_end_sessions after the commit. The resolver checks on every
-- request that it is still the person's active one. The paired key holds
-- the membership to its company.
CREATE FUNCTION access.choose_company(session uuid, company uuid, membership uuid, permissions jsonb, idle_minutes integer, at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $choose$
BEGIN
  UPDATE access.sessions AS s
  SET current_company_id = choose_company.company, current_membership_id = choose_company.membership, permissions = choose_company.permissions,
    idle_timeout_minutes = choose_company.idle_minutes, last_seen_at = GREATEST(s.last_seen_at, choose_company.at)
  WHERE s.id = choose_company.session AND s.identity_id = access.current_person_id() AND s.ended_at IS NULL;
  RETURN FOUND;
END
$choose$;

GRANT EXECUTE ON FUNCTION
  access.open_session(bytea, uuid, text, text, uuid, timestamptz),
  access.session_by_token(bytea),
  access.lock_session(bytea),
  access.touch_session(uuid, timestamptz, integer, uuid),
  access.choose_company(uuid, uuid, uuid, jsonb, integer, timestamptz)
TO nortfox_app;

-- The one membership function --------------------------------------------------------
--
-- The transaction's person's active memberships, with their companies: in
-- `company`, or in every company when it is NULL; with `include_inactive` the
-- inactive ones too, which only an identity's deletion asks for. It reads the
-- person from the actor setting, never from a parameter, so no caller can ask
-- about another person, and it gives nothing for an identity that is not
-- active. It reads through the owner's two policies by person, on the
-- memberships and on the companies. The app has only the company policies on
-- both, so this is its only way to learn whether a person may enter a company
-- (issue 12: membership is resolved in one function).
CREATE FUNCTION access.active_membership(company uuid DEFAULT NULL, include_inactive boolean DEFAULT false)
RETURNS TABLE (
  membership_id uuid, company_id uuid, status text, admin_level text, idle_timeout_minutes integer,
  company_name text, organization_number text, database_number integer
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT m.id, m.company_id, m.status, m.admin_level, m.idle_timeout_minutes, c.name, c.organization_number, c.database_number
  FROM access.memberships AS m
  JOIN ledger.companies AS c ON c.company_id = m.company_id
  JOIN access.identities AS i ON i.id = m.live_user_id
  WHERE m.live_user_id = access.current_person_id()
    AND i.status = 'active'
    AND (active_membership.company IS NULL OR m.company_id = active_membership.company)
    AND (m.status = 'active' OR (active_membership.include_inactive AND m.status = 'inactive'))
  ORDER BY c.name, m.company_id;
END;

GRANT EXECUTE ON FUNCTION access.active_membership(uuid, boolean) TO nortfox_app;
