-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0006 the login identities: the schema access and its install-wide tables,
-- the lookup functions that sign a person in, and the purge. See db/README.md,
-- the schema access, and decisions 0008 and 0009 in docs/decisions/.
--
-- Every table here belongs to no company, so none has a company_id column.
-- The table guard holds each one to its class (apps/server/src/db/table-guard.ts,
-- INSTALL_TABLES): a person table shows the app only the rows of the
-- transaction's person, and a secret table shows the app nothing. The app
-- reaches a secret table only through the lookup functions below. They run
-- as the owner, whose one policy on each table reads and writes every row.
-- These tables have no history trigger: their rows are no company's data.
--
-- The times that a rule compares with come from the server's clock, which
-- the server passes in, so a test can move it. The database stamps the times
-- that no rule reads, such as when an identity was made, with its own clock.

-- A refusal ------------------------------------------------------------------
--
-- install_not_empty: a setup link is made, and used, only on an install that
-- has no identity yet. The list gets the new reason in its place by code.
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
-- The app may use it. A reader may not: no table here is a company's, and a
-- reader reads only its company's rows.
CREATE SCHEMA access;
GRANT USAGE ON SCHEMA access TO nortfox_app;

-- The transaction's person: nortfox.actor_id when the actor is a user, or an
-- integration that acts for one (decision 2), and NULL otherwise. The
-- internal system user is nobody's person. The person policies compare with
-- it, so with no person set they show nothing.
CREATE FUNCTION access.current_person_id() RETURNS uuid
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
RETURN CASE
  WHEN current_setting('nortfox.actor_kind', true) IN ('user', 'integration') THEN NULLIF(current_setting('nortfox.actor_id', true), '')::uuid
END;
GRANT EXECUTE ON FUNCTION access.current_person_id() TO nortfox_app;

-- What every install-wide table gets: row level security, enabled and
-- forced; the owner's one policy over every row, which the lookup functions
-- read and write through; and the truncate trigger. Each table then gets the
-- app policies of its class and the app's privileges. The table guard checks
-- all of it.
CREATE FUNCTION meta.protect_install_table(target regclass) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $protect$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format('CREATE POLICY install_owner ON %s TO nortfox_owner USING (true) WITH CHECK (true)', target);
  EXECUTE format('CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION ledger.refuse_truncate()', target);
END
$protect$;

-- A column that is set once and then never changes, nor is cleared, by any
-- role: such as the time a row that works once was used. Its arguments are
-- the columns.
CREATE FUNCTION access.keep_set_once() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $once$
DECLARE
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
  kept text;
BEGIN
  FOREACH kept IN ARRAY TG_ARGV LOOP
    IF old_row -> kept <> 'null'::jsonb AND (new_row -> kept) IS DISTINCT FROM (old_row -> kept) THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', kept, 'operation', 'update'));
    END IF;
  END LOOP;
  RETURN NEW;
END
$once$;

-- The identities ---------------------------------------------------------------
--
-- One login identity per person, for every company (issue 12). Its e-mail
-- address is unique in any letter case: the unique index folds the case
-- with casefold() under pg_unicode_fast, so Å and å are one letter as A and
-- a are, and the address keeps the case it was given in. Its personnummer is
-- unique, in its twelve digits with the hyphen. A deleted identity keeps its
-- row, its id and its name, so it stays the actor on its entries, and holds
-- no e-mail address, personnummer or mobile number: so its address and its
-- number are free for another identity.
CREATE TABLE access.identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text,
  personal_identity_number text CONSTRAINT identities_personal_identity_number_form CHECK (personal_identity_number ~ '^[0-9]{8}-[0-9]{4}$'),
  mobile text,
  language text NOT NULL DEFAULT 'sv' CONSTRAINT identities_language_known CHECK (language IN ('sv', 'en')),
  two_step text NOT NULL DEFAULT 'new_device_90_days' CONSTRAINT identities_two_step_known CHECK (two_step IN ('new_device_90_days', 'every_login')),
  status text NOT NULL DEFAULT 'active' CONSTRAINT identities_status_known CHECK (status IN ('active', 'deleted')),
  created_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CONSTRAINT identities_email_while_active CHECK ((email IS NULL) = (status = 'deleted')),
  CONSTRAINT identities_deleted_holds_nothing CHECK (status = 'active' OR (personal_identity_number IS NULL AND mobile IS NULL)),
  CONSTRAINT identities_deleted_at CHECK ((deleted_at IS NOT NULL) = (status = 'deleted')),
  CONSTRAINT identities_personal_identity_number_key UNIQUE (personal_identity_number)
);
CREATE UNIQUE INDEX identities_email_key ON access.identities (casefold(email COLLATE pg_catalog.pg_unicode_fast));

-- The rules no policy keeps: no identity is deleted, by any role; the
-- database stamps when an identity was made and when it was deleted, and
-- refuses a stamp that is given; an identity is made active, and once
-- deleted it stays deleted; its id never changes; and its personnummer is
-- set once: from none to a number, never to another number, and back to none
-- only in the update that deletes the identity.
CREATE FUNCTION access.identities_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM ledger.refuse('append_only', jsonb_build_object('table', 'access.identities', 'operation', 'DELETE'));
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_at IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_at', 'operation', 'create'));
    END IF;
    IF NEW.deleted_at IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'deleted_at', 'operation', 'create'));
    END IF;
    IF NEW.status IS DISTINCT FROM 'active' THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'status', 'operation', 'create'));
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'id', 'operation', 'update'));
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_at', 'operation', 'update'));
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'deleted_at', 'operation', 'update'));
  END IF;
  IF OLD.status = 'deleted' AND NEW.status IS DISTINCT FROM 'deleted' THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'status', 'operation', 'update'));
  END IF;
  IF OLD.personal_identity_number IS NOT NULL AND NEW.personal_identity_number IS DISTINCT FROM OLD.personal_identity_number
    AND NOT (NEW.personal_identity_number IS NULL AND OLD.status = 'active' AND NEW.status = 'deleted') THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'personal_identity_number', 'operation', 'update'));
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'deleted' THEN
    NEW.deleted_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$rules$;

CREATE TRIGGER identities_rules BEFORE INSERT OR UPDATE OR DELETE ON access.identities
  FOR EACH ROW EXECUTE FUNCTION access.identities_rules();
SELECT meta.protect_install_table('access.identities');
-- A person table: the app reads and changes only the person's own row. Only
-- the database's own functions make an identity.
CREATE POLICY person_select ON access.identities FOR SELECT TO nortfox_app USING (id = access.current_person_id());
CREATE POLICY person_update ON access.identities FOR UPDATE TO nortfox_app
  USING (id = access.current_person_id()) WITH CHECK (id = access.current_person_id());
GRANT SELECT, UPDATE ON access.identities TO nortfox_app;

-- The secrets of a sign-in --------------------------------------------------------
--
-- Each token is kept only as the SHA-256 of the whole token, 32 bytes, under
-- a unique key. No column holds a token, a password or a TOTP secret in
-- clear. These tables are secret: the app has no policy and no privilege on
-- them, and reaches them only through the lookup functions.

-- The password, as an Argon2id hash in the PHC string format. The server
-- hashes it (decision 8). A value of any other form is refused.
CREATE TABLE access.password_credentials (
  identity_id uuid PRIMARY KEY REFERENCES access.identities (id),
  password_hash text NOT NULL
    CONSTRAINT password_credentials_argon2id CHECK (password_hash ~ '^\$argon2id\$v=19\$m=[0-9]+,t=[0-9]+,p=[0-9]+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$'),
  changed_at timestamptz NOT NULL
);
SELECT meta.protect_install_table('access.password_credentials');

-- A TOTP secret, sealed by the server with AES-256-GCM under a key from the
-- install secret: the format's version (1), the key's id (1 to 255), the
-- nonce (12 bytes), the ciphertext (20) and the tag (16), 50 bytes in all.
-- A pending secret waits for its first right code, which makes it active; a
-- replaced one is kept no more for the login. An identity has at most one
-- active and one pending secret. last_used_step is the last TOTP step that
-- a code was taken for: a code works once.
CREATE TABLE access.totp_secrets (
  id uuid PRIMARY KEY,
  identity_id uuid NOT NULL REFERENCES access.identities (id),
  secret bytea NOT NULL CONSTRAINT totp_secrets_sealed CHECK (octet_length(secret) = 50 AND get_byte(secret, 0) = 1 AND get_byte(secret, 1) <> 0),
  state text NOT NULL CONSTRAINT totp_secrets_state_known CHECK (state IN ('pending', 'active', 'replaced')),
  last_used_step bigint CONSTRAINT totp_secrets_step_positive CHECK (last_used_step >= 0),
  created_at timestamptz NOT NULL,
  confirmed_at timestamptz
);
CREATE UNIQUE INDEX totp_secrets_one_per_state ON access.totp_secrets (identity_id, state) WHERE state IN ('pending', 'active');
SELECT meta.protect_install_table('access.totp_secrets');

-- A known device: the device cookie's hash, with the identity, and when a
-- TOTP step last passed on it. The table lets one device token be known to
-- two identities; the server makes a new token for a person who does not
-- know the browser's, so in use each token is one person's.
CREATE TABLE access.known_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id uuid NOT NULL REFERENCES access.identities (id),
  device_hash bytea NOT NULL CONSTRAINT known_devices_device_hash_form CHECK (octet_length(device_hash) = 32),
  last_totp_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT known_devices_once UNIQUE (identity_id, device_hash)
);
SELECT meta.protect_install_table('access.known_devices');

-- A browser session: the session cookie's hash, the identity, how it signed
-- in, the device, and when it began, was last seen and ended, and why. An
-- ended session stays ended: the end is set once.
CREATE TABLE access.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL CONSTRAINT sessions_token_hash_form CHECK (octet_length(token_hash) = 32),
  identity_id uuid NOT NULL REFERENCES access.identities (id),
  method text NOT NULL CONSTRAINT sessions_method_known CHECK (method IN ('password-email', 'password-personnummer', 'bankid', 'oidc')),
  device_id uuid REFERENCES access.known_devices (id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  ended_at timestamptz,
  end_reason text CONSTRAINT sessions_end_reason_known CHECK (end_reason IN ('logout', 'idle', 'absolute', 'membership', 'credentials-changed', 'deleted')),
  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT sessions_ended_with_reason CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
CREATE TRIGGER sessions_set_once BEFORE UPDATE ON access.sessions
  FOR EACH ROW EXECUTE FUNCTION access.keep_set_once('ended_at', 'end_reason');
SELECT meta.protect_install_table('access.sessions');

-- A login challenge: the TOTP step after a right password. It works for its
-- time, and for five wrong codes: each attempt is claimed before its code is
-- checked, so parallel attempts get five in all. It is used once.
CREATE TABLE access.login_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL CONSTRAINT login_challenges_token_hash_form CHECK (octet_length(token_hash) = 32),
  identity_id uuid NOT NULL REFERENCES access.identities (id),
  method text NOT NULL CONSTRAINT login_challenges_method_known CHECK (method IN ('password-email', 'password-personnummer')),
  device_hash bytea CONSTRAINT login_challenges_device_hash_form CHECK (octet_length(device_hash) = 32),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  wrong_attempts smallint NOT NULL DEFAULT 0 CONSTRAINT login_challenges_attempts_range CHECK (wrong_attempts BETWEEN 0 AND 5),
  used_at timestamptz,
  CONSTRAINT login_challenges_token_hash_key UNIQUE (token_hash)
);
CREATE TRIGGER login_challenges_set_once BEFORE UPDATE ON access.login_challenges
  FOR EACH ROW EXECUTE FUNCTION access.keep_set_once('used_at');
SELECT meta.protect_install_table('access.login_challenges');

-- A setup link, which makes the first identity of an empty install. It works
-- once, for its time, and a newer link stops it. A link is used or stopped,
-- never both, and either mark is set once.
CREATE TABLE access.setup_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL CONSTRAINT setup_tokens_token_hash_form CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  superseded_at timestamptz,
  CONSTRAINT setup_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT setup_tokens_used_or_superseded CHECK (used_at IS NULL OR superseded_at IS NULL)
);
CREATE TRIGGER setup_tokens_set_once BEFORE UPDATE ON access.setup_tokens
  FOR EACH ROW EXECUTE FUNCTION access.keep_set_once('used_at', 'superseded_at');
SELECT meta.protect_install_table('access.setup_tokens');

-- The failures of each kind of guess, per subject: an identity's id, or, for
-- an identifier that names no identity, its HMAC with the key's id
-- (hmac:<key id>:<64 hexadecimal digits>), so an unknown identifier is
-- counted the same way. A window starts with its first failure. The server
-- holds the limits: how long a window is, the delays and the locks.
CREATE TABLE access.attempt_counters (
  subject text NOT NULL
    CONSTRAINT attempt_counters_subject_form CHECK (subject ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|hmac:[0-9]{1,3}:[0-9a-f]{64})$'),
  kind text NOT NULL CONSTRAINT attempt_counters_kind_known CHECK (kind IN ('password', 'totp', 'verification', 'recovery')),
  window_started_at timestamptz NOT NULL,
  failures integer NOT NULL CONSTRAINT attempt_counters_failures_positive CHECK (failures > 0),
  last_failure_at timestamptz NOT NULL,
  locked_until timestamptz,
  PRIMARY KEY (subject, kind)
);
SELECT meta.protect_install_table('access.attempt_counters');

-- The install key's check value: for each key id, a fixed text sealed under
-- a key that the install secret gives, as the first start stored it. A later
-- start whose key does not open it refuses to start. A check value never
-- changes and is never deleted, by any role.
CREATE TABLE access.install_keys (
  key_id smallint PRIMARY KEY CONSTRAINT install_keys_key_id_range CHECK (key_id BETWEEN 1 AND 255),
  check_value bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION access.install_keys_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
BEGIN
  PERFORM ledger.refuse('append_only', jsonb_build_object('table', 'access.install_keys', 'operation', TG_OP));
  RETURN NULL;
END
$rules$;

CREATE TRIGGER install_keys_rules BEFORE UPDATE OR DELETE ON access.install_keys
  FOR EACH ROW EXECUTE FUNCTION access.install_keys_rules();
SELECT meta.protect_install_table('access.install_keys');

-- The person's own rows -----------------------------------------------------------

-- Kontoaktivitet: the person's own events across companies, such as a
-- sign-in. The database stamps the time, and refuses one that is given. A
-- kind is a code in kebab-case, and the details are an object.
CREATE TABLE access.account_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id uuid NOT NULL REFERENCES access.identities (id),
  kind text NOT NULL CONSTRAINT account_events_kind_form CHECK (kind ~ '^[a-z]+(-[a-z]+)*$'),
  details jsonb NOT NULL DEFAULT '{}' CONSTRAINT account_events_details_object CHECK (jsonb_typeof(details) = 'object'),
  at timestamptz NOT NULL
);
CREATE INDEX account_events_latest ON access.account_events (identity_id, at);

CREATE FUNCTION access.account_events_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
BEGIN
  IF NEW.at IS NOT NULL THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'at', 'operation', 'create'));
  END IF;
  NEW.at := clock_timestamp();
  RETURN NEW;
END
$rules$;

CREATE TRIGGER account_events_rules BEFORE INSERT ON access.account_events
  FOR EACH ROW EXECUTE FUNCTION access.account_events_rules();
SELECT meta.protect_install_table('access.account_events');
CREATE POLICY person_select ON access.account_events FOR SELECT TO nortfox_app USING (identity_id = access.current_person_id());
CREATE POLICY person_insert ON access.account_events FOR INSERT TO nortfox_app WITH CHECK (identity_id = access.current_person_id());
GRANT SELECT, INSERT ON access.account_events TO nortfox_app;

-- The idempotency keys of a signed-in person's writes that keep no key in a
-- company table: a write in no company, and, from a later part, a write in a
-- company whose answer holds a person's contact data. The columns and checks
-- are those of ledger.idempotency_keys, with key_company_id, the company the
-- transaction works in, in place of company_id. The trigger stamps the
-- person, the kind, the company and the time, and refuses each when it is
-- given. A person has a key once per company, and once with no company.
CREATE TABLE access.idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_company_id uuid REFERENCES ledger.companies (company_id),
  actor_id uuid NOT NULL REFERENCES access.identities (id),
  actor_kind text NOT NULL,
  idempotency_key text NOT NULL CONSTRAINT idempotency_keys_key_form CHECK (idempotency_key ~ '^[\x21\x23-\x5b\x5d-\x7e]{1,255}$'),
  operation_id text NOT NULL,
  request_hash text NOT NULL CONSTRAINT idempotency_keys_request_hash_form CHECK (request_hash ~ '^[0123456789abcdef]{64}$'),
  response_status smallint NOT NULL CONSTRAINT idempotency_keys_response_status_success CHECK (response_status BETWEEN 200 AND 299),
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT idempotency_keys_once UNIQUE NULLS NOT DISTINCT (actor_id, key_company_id, idempotency_key)
);

CREATE FUNCTION access.idempotency_keys_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
DECLARE
  actor record;
BEGIN
  IF NEW.actor_id IS NOT NULL THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'actor_id', 'operation', 'create'));
  END IF;
  IF NEW.actor_kind IS NOT NULL THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'actor_kind', 'operation', 'create'));
  END IF;
  IF NEW.key_company_id IS NOT NULL THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'key_company_id', 'operation', 'create'));
  END IF;
  IF NEW.created_at IS NOT NULL THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_at', 'operation', 'create'));
  END IF;
  SELECT a.actor_id, a.actor_kind INTO actor FROM ledger.current_actor() AS a;
  NEW.actor_id := actor.actor_id;
  NEW.actor_kind := actor.actor_kind;
  NEW.key_company_id := ledger.current_company_id();
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$rules$;

CREATE TRIGGER idempotency_keys_rules BEFORE INSERT ON access.idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION access.idempotency_keys_rules();
SELECT meta.protect_install_table('access.idempotency_keys');
CREATE POLICY person_select ON access.idempotency_keys FOR SELECT TO nortfox_app USING (actor_id = access.current_person_id());
CREATE POLICY person_insert ON access.idempotency_keys FOR INSERT TO nortfox_app WITH CHECK (actor_id = access.current_person_id());
GRANT SELECT, INSERT ON access.idempotency_keys TO nortfox_app;

-- The lookup functions -------------------------------------------------------------
--
-- The app's only way to the secret tables. Each runs as the owner, with its
-- search path pinned, and only the app may call it. Each takes a hash or an
-- identifier and gives the columns its caller needs, of one row, with the
-- identity's status where a row names one. A function that makes a row for
-- an identity makes it only for an active one, and gives NULL otherwise.
-- Each one that uses up a row that works once does it with one conditional
-- update, and gives false when no row changed: of two parallel calls, the
-- second waits for the first's row lock, then finds the row used.

-- The login of an identifier: a personnummer in its twelve digits with the
-- hyphen, or else an e-mail address in any letter case.
CREATE FUNCTION access.find_login(identifier text)
RETURNS TABLE (identity_id uuid, status text, two_step text, password_hash text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $find$
BEGIN
  IF find_login.identifier ~ '^[0-9]{8}-[0-9]{4}$' THEN
    RETURN QUERY
      SELECT i.id, i.status, i.two_step, p.password_hash
      FROM access.identities AS i LEFT JOIN access.password_credentials AS p ON p.identity_id = i.id
      WHERE i.personal_identity_number = find_login.identifier;
  ELSE
    RETURN QUERY
      SELECT i.id, i.status, i.two_step, p.password_hash
      FROM access.identities AS i LEFT JOIN access.password_credentials AS p ON p.identity_id = i.id
      WHERE casefold(i.email COLLATE pg_catalog.pg_unicode_fast) = casefold(find_login.identifier COLLATE pg_catalog.pg_unicode_fast);
  END IF;
END
$find$;

-- The form of an identifier that find_login matches on: a personnummer as it
-- is, and an e-mail address folded as the unique index folds it. casefold()
-- folds more than lower case does, such as the long s to s and the sharp s
-- to ss. The server counts the failures of an identifier that names no
-- identity under the HMAC of this form, so every spelling that would find
-- one identity is counted as one, as it is for an identity.
CREATE FUNCTION access.identifier_form(identifier text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT CASE
    WHEN identifier_form.identifier ~ '^[0-9]{8}-[0-9]{4}$' THEN identifier_form.identifier
    ELSE casefold(identifier_form.identifier COLLATE pg_catalog.pg_unicode_fast)
  END;
END;

-- Opens a login challenge after a right password, and gives its id.
CREATE FUNCTION access.open_challenge(token_hash bytea, person uuid, method text, device_hash bytea, at timestamptz, expires_at timestamptz) RETURNS uuid
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  INSERT INTO access.login_challenges (token_hash, identity_id, method, device_hash, created_at, expires_at)
  SELECT open_challenge.token_hash, i.id, open_challenge.method, open_challenge.device_hash, open_challenge.at, open_challenge.expires_at
  FROM access.identities AS i
  WHERE i.id = open_challenge.person AND i.status = 'active'
  RETURNING id;
END;

-- A live challenge by its hash: not used, before its end, with an attempt
-- left. With it, the person's TOTP secret: the active one, or else the
-- pending one.
CREATE FUNCTION access.challenge_by_token(token_hash bytea, at timestamptz)
RETURNS TABLE (
  challenge_id uuid, identity_id uuid, status text, method text, device_hash bytea, wrong_attempts smallint,
  totp_secret_id uuid, totp_secret bytea, totp_state text, totp_last_used_step bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT c.id, i.id, i.status, c.method, c.device_hash, c.wrong_attempts, s.id, s.secret, s.state, s.last_used_step
  FROM access.login_challenges AS c
  JOIN access.identities AS i ON i.id = c.identity_id
  LEFT JOIN LATERAL (
    SELECT t.id, t.secret, t.state, t.last_used_step
    FROM access.totp_secrets AS t
    WHERE t.identity_id = i.id AND t.state IN ('active', 'pending')
    ORDER BY t.state = 'active' DESC
    LIMIT 1
  ) AS s ON true
  WHERE c.token_hash = challenge_by_token.token_hash AND c.used_at IS NULL
    AND c.expires_at > challenge_by_token.at AND c.wrong_attempts < 5;
END;

-- Claims one attempt of a live challenge, before its code is checked, and
-- gives the attempt's number, or NULL when none is left.
CREATE FUNCTION access.claim_attempt(challenge uuid, at timestamptz) RETURNS integer
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  UPDATE access.login_challenges AS c SET wrong_attempts = c.wrong_attempts + 1
  WHERE c.id = claim_attempt.challenge AND c.used_at IS NULL AND c.expires_at > claim_attempt.at AND c.wrong_attempts < 5
  RETURNING c.wrong_attempts;
END;

-- Uses a challenge once, after a right code: an attempt was claimed for it,
-- and the right code gives that attempt back.
CREATE FUNCTION access.use_challenge(challenge uuid, at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $use$
BEGIN
  UPDATE access.login_challenges AS c SET used_at = use_challenge.at, wrong_attempts = c.wrong_attempts - 1
  WHERE c.id = use_challenge.challenge AND c.used_at IS NULL AND c.expires_at > use_challenge.at AND c.wrong_attempts > 0;
  RETURN FOUND;
END
$use$;

-- Takes a TOTP step of the person's secret once: only a later step than the
-- last one taken, so one code gives one session. A right step makes a
-- pending secret active, unless the person has an active one.
CREATE FUNCTION access.use_totp_step(secret uuid, person uuid, step bigint, at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $step$
BEGIN
  UPDATE access.totp_secrets AS t
  SET last_used_step = use_totp_step.step, state = 'active', confirmed_at = COALESCE(t.confirmed_at, use_totp_step.at)
  WHERE t.id = use_totp_step.secret AND t.identity_id = use_totp_step.person
    AND (t.last_used_step IS NULL OR t.last_used_step < use_totp_step.step)
    AND (
      t.state = 'active'
      OR (t.state = 'pending' AND NOT EXISTS (SELECT FROM access.totp_secrets AS a WHERE a.identity_id = t.identity_id AND a.state = 'active'))
    );
  RETURN FOUND;
END
$step$;

-- A subject's counter of one kind, or no row.
CREATE FUNCTION access.attempt_counter(subject text, kind text)
RETURNS TABLE (failures integer, window_started_at timestamptz, last_failure_at timestamptz, locked_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT a.failures, a.window_started_at, a.last_failure_at, a.locked_until
  FROM access.attempt_counters AS a
  WHERE a.subject = attempt_counter.subject AND a.kind = attempt_counter.kind;
END;

-- Counts one failure in the subject's window of `span`, or starts a new
-- window once the old one has passed, and gives the counter after the count
-- and as it was just before it (all NULL before the subject's first
-- failure). A lock is kept until its end. Parallel calls each count, one
-- after another: the insert waits for the row's lock, so each call sees the
-- counts before its own. So the server counts an attempt before it checks
-- it, and decides from the counter before the count whether the attempt
-- may run; when it may not, it rolls the count back.
CREATE FUNCTION access.count_failure(subject text, kind text, span interval, at timestamptz)
RETURNS TABLE (
  failures integer, window_started_at timestamptz, last_failure_at timestamptz, locked_until timestamptz,
  before_failures integer, before_window_started_at timestamptz, before_last_failure_at timestamptz, before_locked_until timestamptz
)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  INSERT INTO access.attempt_counters AS a (subject, kind, window_started_at, failures, last_failure_at)
  VALUES (count_failure.subject, count_failure.kind, count_failure.at, 1, count_failure.at)
  ON CONFLICT (subject, kind) DO UPDATE SET
    window_started_at = CASE WHEN a.window_started_at + count_failure.span > count_failure.at THEN a.window_started_at ELSE count_failure.at END,
    failures = CASE WHEN a.window_started_at + count_failure.span > count_failure.at THEN a.failures + 1 ELSE 1 END,
    last_failure_at = count_failure.at
  RETURNING new.failures, new.window_started_at, new.last_failure_at, new.locked_until,
    old.failures, old.window_started_at, old.last_failure_at, old.locked_until;
END;

-- Gives back a failure that was counted before its check, when the check
-- found none: a right TOTP code, or a password that the server could not
-- check. The last one forgets the counter. The row's lock comes first, so
-- parallel calls each give one back.
CREATE FUNCTION access.give_back_failure(subject text, kind text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $give$
DECLARE
  counted integer;
BEGIN
  SELECT a.failures INTO counted FROM access.attempt_counters AS a
  WHERE a.subject = give_back_failure.subject AND a.kind = give_back_failure.kind
  FOR UPDATE;
  IF counted = 1 THEN
    DELETE FROM access.attempt_counters AS a WHERE a.subject = give_back_failure.subject AND a.kind = give_back_failure.kind;
  ELSIF counted > 1 THEN
    UPDATE access.attempt_counters AS a SET failures = a.failures - 1 WHERE a.subject = give_back_failure.subject AND a.kind = give_back_failure.kind;
  END IF;
END
$give$;

-- Locks the subject's guesses of one kind until `until`. A shorter lock never
-- shortens a longer one.
CREATE FUNCTION access.lock_attempts(subject text, kind text, until timestamptz) RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  UPDATE access.attempt_counters AS a SET locked_until = GREATEST(a.locked_until, lock_attempts.until)
  WHERE a.subject = lock_attempts.subject AND a.kind = lock_attempts.kind;
END;

-- Clears the subject's counter of one kind, as a right password does.
CREATE FUNCTION access.clear_attempts(subject text, kind text) RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  DELETE FROM access.attempt_counters AS a WHERE a.subject = clear_attempts.subject AND a.kind = clear_attempts.kind;
END;

-- A device the person knows, by its hash, with the identity's status.
CREATE FUNCTION access.known_device(person uuid, device_hash bytea)
RETURNS TABLE (device_id uuid, status text, last_totp_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT d.id, i.status, d.last_totp_at
  FROM access.known_devices AS d JOIN access.identities AS i ON i.id = d.identity_id
  WHERE d.identity_id = known_device.person AND d.device_hash = known_device.device_hash;
END;

-- Remembers that a TOTP step passed on the device: makes it known to the
-- person, or moves its time on, and gives its id.
CREATE FUNCTION access.remember_device(person uuid, device_hash bytea, at timestamptz) RETURNS uuid
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  INSERT INTO access.known_devices AS d (identity_id, device_hash, last_totp_at, created_at)
  SELECT i.id, remember_device.device_hash, remember_device.at, remember_device.at
  FROM access.identities AS i
  WHERE i.id = remember_device.person AND i.status = 'active'
  ON CONFLICT ON CONSTRAINT known_devices_once DO UPDATE SET last_totp_at = GREATEST(d.last_totp_at, excluded.last_totp_at)
  RETURNING d.id;
END;

-- Opens a session, and gives its id. The device, if any, is the person's.
CREATE FUNCTION access.open_session(token_hash bytea, person uuid, method text, device uuid, at timestamptz) RETURNS uuid
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  INSERT INTO access.sessions (token_hash, identity_id, method, device_id, started_at, last_seen_at)
  SELECT open_session.token_hash, i.id, open_session.method, open_session.device, open_session.at, open_session.at
  FROM access.identities AS i
  WHERE i.id = open_session.person AND i.status = 'active'
    AND (open_session.device IS NULL OR EXISTS (
      SELECT FROM access.known_devices AS d WHERE d.id = open_session.device AND d.identity_id = open_session.person
    ))
  RETURNING id;
END;

-- A session that has not ended, by its hash, with the identity's status.
-- The server ends one that is past its time.
CREATE FUNCTION access.session_by_token(token_hash bytea)
RETURNS TABLE (session_id uuid, identity_id uuid, status text, method text, device_id uuid, started_at timestamptz, last_seen_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT s.id, s.identity_id, i.status, s.method, s.device_id, s.started_at, s.last_seen_at
  FROM access.sessions AS s JOIN access.identities AS i ON i.id = s.identity_id
  WHERE s.token_hash = session_by_token.token_hash AND s.ended_at IS NULL;
END;

-- Moves a live session's last sight on, never back.
CREATE FUNCTION access.touch_session(session uuid, at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $touch$
BEGIN
  UPDATE access.sessions AS s SET last_seen_at = touch_session.at
  WHERE s.id = touch_session.session AND s.ended_at IS NULL AND s.last_seen_at < touch_session.at;
  RETURN FOUND;
END
$touch$;

-- Ends a live session once, with its reason.
CREATE FUNCTION access.end_session(session uuid, reason text, at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $end$
BEGIN
  UPDATE access.sessions AS s SET ended_at = end_session.at, end_reason = end_session.reason
  WHERE s.id = end_session.session AND s.ended_at IS NULL;
  RETURN FOUND;
END
$end$;

-- Ends every live session of the person but the one it keeps, and gives how
-- many it ended.
CREATE FUNCTION access.end_other_sessions(person uuid, keep uuid, reason text, at timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $others$
DECLARE
  ended integer;
BEGIN
  UPDATE access.sessions AS s SET ended_at = end_other_sessions.at, end_reason = end_other_sessions.reason
  WHERE s.identity_id = end_other_sessions.person AND s.id IS DISTINCT FROM end_other_sessions.keep AND s.ended_at IS NULL;
  GET DIAGNOSTICS ended = ROW_COUNT;
  RETURN ended;
END
$others$;

-- Makes a setup link on an install that has no identity, stops every older
-- link, and gives its id. The setup command calls it. It takes the setup
-- links' table lock, as complete_setup does, so the two never overlap: the
-- install then has at most one live link, and no identity comes between the
-- check and the link.
CREATE FUNCTION access.create_setup_token(token_hash bytea, at timestamptz, expires_at timestamptz) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $create$
DECLARE
  made uuid;
BEGIN
  LOCK TABLE access.setup_tokens IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (SELECT FROM access.identities) THEN
    PERFORM ledger.refuse('install_not_empty');
  END IF;
  UPDATE access.setup_tokens AS t SET superseded_at = create_setup_token.at WHERE t.used_at IS NULL AND t.superseded_at IS NULL;
  INSERT INTO access.setup_tokens (token_hash, created_at, expires_at)
  VALUES (create_setup_token.token_hash, create_setup_token.at, create_setup_token.expires_at)
  RETURNING id INTO made;
  RETURN made;
END
$create$;

-- Uses a live setup link once, and makes the first identity with it: its
-- password and its pending TOTP secret. The server picks the identity's and
-- the secret's ids, which the sealed secret is bound to. It gives false when
-- the link is unknown, used, stopped or past its end, and refuses
-- (install_not_empty) when the install has an identity.
CREATE FUNCTION access.complete_setup(
  token_hash bytea, at timestamptz, person uuid, name text, email text, password_hash text, totp_secret_id uuid, totp_secret bytea
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $complete$
BEGIN
  LOCK TABLE access.setup_tokens IN SHARE ROW EXCLUSIVE MODE;
  UPDATE access.setup_tokens AS t SET used_at = complete_setup.at
  WHERE t.token_hash = complete_setup.token_hash AND t.used_at IS NULL AND t.superseded_at IS NULL AND t.expires_at > complete_setup.at;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT FROM access.identities) THEN
    PERFORM ledger.refuse('install_not_empty');
  END IF;
  INSERT INTO access.identities (id, name, email) VALUES (complete_setup.person, complete_setup.name, complete_setup.email);
  INSERT INTO access.password_credentials (identity_id, password_hash, changed_at)
  VALUES (complete_setup.person, complete_setup.password_hash, complete_setup.at);
  INSERT INTO access.totp_secrets (id, identity_id, secret, state, created_at)
  VALUES (complete_setup.totp_secret_id, complete_setup.person, complete_setup.totp_secret, 'pending', complete_setup.at);
  RETURN true;
END
$complete$;

-- Stores the check value of a key id when there is none, and gives the one
-- that is stored. Of two starts at once, the second waits for the first's
-- row and gets its value.
CREATE FUNCTION access.install_key(key_id integer, check_value bytea) RETURNS bytea
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $key$
DECLARE
  kept bytea;
BEGIN
  INSERT INTO access.install_keys AS k (key_id, check_value) VALUES (install_key.key_id, install_key.check_value)
  ON CONFLICT ON CONSTRAINT install_keys_pkey DO NOTHING;
  SELECT k.check_value INTO kept FROM access.install_keys AS k WHERE k.key_id = install_key.key_id;
  RETURN kept;
END
$key$;

-- The purge. The server runs it every ten minutes, with its clock. It
-- deletes what has passed: login challenges and setup links at their end,
-- sessions 30 days after they ended, or 30 days after the 12 hours of one
-- that never ended, attempt counters an hour after their window began once
-- their lock has ended, a person's idempotency keys 24 hours after they were
-- stored, and the account events past the 100 latest of each identity,
-- which Kontoaktivitet shows. It deletes no identity.
CREATE FUNCTION access.purge_expired(at timestamptz) RETURNS void
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
      SELECT x.id, row_number() OVER (PARTITION BY x.identity_id ORDER BY x.at DESC, x.id DESC) AS place
      FROM access.account_events AS x
    ) AS r
    WHERE r.place > 100
  );
END
$purge$;

GRANT EXECUTE ON FUNCTION
  access.find_login(text),
  access.identifier_form(text),
  access.open_challenge(bytea, uuid, text, bytea, timestamptz, timestamptz),
  access.challenge_by_token(bytea, timestamptz),
  access.claim_attempt(uuid, timestamptz),
  access.use_challenge(uuid, timestamptz),
  access.use_totp_step(uuid, uuid, bigint, timestamptz),
  access.attempt_counter(text, text),
  access.count_failure(text, text, interval, timestamptz),
  access.give_back_failure(text, text),
  access.lock_attempts(text, text, timestamptz),
  access.clear_attempts(text, text),
  access.known_device(uuid, bytea),
  access.remember_device(uuid, bytea, timestamptz),
  access.open_session(bytea, uuid, text, uuid, timestamptz),
  access.session_by_token(bytea),
  access.touch_session(uuid, timestamptz),
  access.end_session(uuid, text, timestamptz),
  access.end_other_sessions(uuid, uuid, text, timestamptz),
  access.create_setup_token(bytea, timestamptz, timestamptz),
  access.complete_setup(bytea, timestamptz, uuid, text, text, text, uuid, bytea),
  access.install_key(integer, bytea),
  access.purge_expired(timestamptz)
TO nortfox_app;
