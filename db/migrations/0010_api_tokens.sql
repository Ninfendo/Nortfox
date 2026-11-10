-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0010 the API tokens, and the via in the behandlingshistorik: a member's
-- API token for one company, kept only as its hash; and a write through an
-- API token or from an MCP client records the token or the client beside
-- the person and the kind integration. See db/README.md, the schema access,
-- and decisions 0002 and 0008 in docs/decisions/.

-- The via -----------------------------------------------------------------------
--
-- A request with an API token, or from an MCP client, runs as an
-- integration that acts for its person (decision 2). The server sets two
-- more settings for such a transaction, with the actor: nortfox.via_kind,
-- api-token or mcp-client, and nortfox.via_id, the token's id or the
-- client's. An integration always names both, and a user and the internal
-- system user name neither. A later slice that adds a kind of via, such as
-- 2e's clients and service accounts, widens the checks.
--
-- The behandlingshistorik records the via of each change. Three checks hold
-- it on every row, also one that no trigger wrote: a row has a via exactly
-- when its kind is integration, a via is whole, and its kind is known. No
-- install holds a history row of the kind integration yet: no server before
-- this one had a credential that gives one. So the checks hold for every
-- row from the start.
ALTER TABLE audit.history
  ADD COLUMN via_kind text CONSTRAINT history_via_known CHECK (via_kind IN ('api-token', 'mcp-client')),
  ADD COLUMN via_id uuid,
  ADD CONSTRAINT history_via_whole CHECK ((via_kind IS NULL) = (via_id IS NULL)),
  ADD CONSTRAINT history_via_by_kind CHECK ((actor_kind = 'integration') = (via_kind IS NOT NULL OR via_id IS NOT NULL));
SELECT meta.hide_statistics('audit.history');

-- A transaction keeps one via, as it keeps one actor and one channel: the
-- via is kept with the actor at the transaction's first write.
ALTER TABLE ledger.transaction_actors ADD COLUMN via_kind text, ADD COLUMN via_id uuid;

-- ledger.current_actor() gets two more columns, the via's kind and id, so its
-- columns change and it is made again, as 0005 made it. Every caller is a
-- trigger function in PL/pgSQL that selects its columns by name, so none
-- changes. As before, no role may call it: the triggers run as the owner.
DROP FUNCTION ledger.current_actor();

-- The transaction's actor, its kind, its channel and its via. A write with no
-- actor is refused (actor_missing, naming the setting), and so is a write by
-- an integration that names no whole via of a known kind, or by a user or
-- the system user that names one, or half of one. A write under another
-- actor, kind, via or channel than the transaction's first write had is
-- refused too (insufficient privilege, 42501). An empty setting is none. The
-- writes of a savepoint that rolled back keep nothing. The row keeps the
-- time the transaction began, which does not move while it runs. So a clock
-- set back during the transaction never makes its own row look like an
-- earlier one, which would let another actor in.
CREATE FUNCTION ledger.current_actor(OUT actor_id uuid, OUT actor_kind text, OUT channel text, OUT via_kind text, OUT via_id uuid)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $actor$
DECLARE
  id_setting text := NULLIF(current_setting('nortfox.actor_id', true), '');
  kind_setting text := NULLIF(current_setting('nortfox.actor_kind', true), '');
  via_kind_setting text := NULLIF(current_setting('nortfox.via_kind', true), '');
  via_id_setting text := NULLIF(current_setting('nortfox.via_id', true), '');
  kept_transaction xid8;
  kept_began timestamptz;
  kept_id uuid;
  kept_kind text;
  kept_channel text;
  kept_via_kind text;
  kept_via_id uuid;
BEGIN
  IF id_setting IS NULL THEN
    PERFORM ledger.refuse('actor_missing', jsonb_build_object('setting', 'nortfox.actor_id'));
  END IF;
  IF kind_setting IS NULL OR kind_setting NOT IN ('user', 'system', 'integration') THEN
    PERFORM ledger.refuse('actor_missing', jsonb_build_object('setting', 'nortfox.actor_kind'));
  END IF;
  IF kind_setting = 'integration' THEN
    IF via_kind_setting IS NULL OR via_kind_setting NOT IN ('api-token', 'mcp-client') THEN
      PERFORM ledger.refuse('actor_missing', jsonb_build_object('setting', 'nortfox.via_kind'));
    END IF;
    IF via_id_setting IS NULL THEN
      PERFORM ledger.refuse('actor_missing', jsonb_build_object('setting', 'nortfox.via_id'));
    END IF;
  ELSIF via_kind_setting IS NOT NULL THEN
    PERFORM ledger.refuse('actor_missing', jsonb_build_object('setting', 'nortfox.via_kind'));
  ELSIF via_id_setting IS NOT NULL THEN
    PERFORM ledger.refuse('actor_missing', jsonb_build_object('setting', 'nortfox.via_id'));
  END IF;
  actor_id := id_setting::uuid;
  actor_kind := kind_setting;
  channel := NULLIF(current_setting('nortfox.channel', true), '');
  via_kind := via_kind_setting;
  via_id := via_id_setting::uuid;
  SELECT t.transaction_id, t.transaction_began, t.actor_id, t.actor_kind, t.channel, t.via_kind, t.via_id
  INTO kept_transaction, kept_began, kept_id, kept_kind, kept_channel, kept_via_kind, kept_via_id
  FROM ledger.transaction_actors AS t
  WHERE t.backend_pid = pg_backend_pid();
  IF ledger.in_this_transaction(kept_transaction, kept_began) THEN
    IF kept_id IS DISTINCT FROM current_actor.actor_id OR kept_kind IS DISTINCT FROM current_actor.actor_kind THEN
      RAISE EXCEPTION USING
        ERRCODE = 'insufficient_privilege',
        MESSAGE = 'The transaction''s actor changed after its first write. A transaction keeps one actor.';
    END IF;
    IF kept_via_kind IS DISTINCT FROM current_actor.via_kind OR kept_via_id IS DISTINCT FROM current_actor.via_id THEN
      RAISE EXCEPTION USING
        ERRCODE = 'insufficient_privilege',
        MESSAGE = 'The transaction''s via changed after its first write. A transaction keeps the token or the client it acts through.';
    END IF;
    IF kept_channel IS DISTINCT FROM current_actor.channel THEN
      RAISE EXCEPTION USING
        ERRCODE = 'insufficient_privilege',
        MESSAGE = 'The transaction''s channel changed after its first write. A transaction keeps one channel.';
    END IF;
    RETURN;
  END IF;
  INSERT INTO ledger.transaction_actors AS t (backend_pid, transaction_id, transaction_began, actor_id, actor_kind, channel, via_kind, via_id)
  VALUES (
    pg_backend_pid(), pg_current_xact_id(), transaction_timestamp(),
    current_actor.actor_id, current_actor.actor_kind, current_actor.channel, current_actor.via_kind, current_actor.via_id
  )
  ON CONFLICT (backend_pid) DO UPDATE
  SET transaction_id = excluded.transaction_id, transaction_began = excluded.transaction_began,
    actor_id = excluded.actor_id, actor_kind = excluded.actor_kind, channel = excluded.channel,
    via_kind = excluded.via_kind, via_id = excluded.via_id;
END
$actor$;

-- Writes the history row of one row change, now with the via. The rest is as
-- 0005 made it: its argument is the table's key column; it refuses a write
-- at another level than READ COMMITTED, and a row that would move to another
-- company.
CREATE OR REPLACE FUNCTION audit.write_history() RETURNS trigger
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
  SELECT a.actor_id, a.actor_kind, a.channel, a.via_kind, a.via_id INTO actor FROM ledger.current_actor() AS a;
  INSERT INTO audit.history
    (company_id, table_name, row_id, operation, old_values, new_values, actor_id, actor_kind, channel, via_kind, via_id, transaction_id, at)
  VALUES (
    (COALESCE(new_row, old_row) ->> 'company_id')::uuid,
    TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
    (COALESCE(new_row, old_row) ->> TG_ARGV[0])::uuid,
    TG_OP,
    old_row,
    new_row,
    actor.actor_id,
    actor.actor_kind,
    actor.channel,
    actor.via_kind,
    actor.via_id,
    pg_current_xact_id(),
    clock_timestamp()
  );
  RETURN NULL;
END
$history$;

-- The API tokens -------------------------------------------------------------------
--
-- A member's API token for one company, with a name and its scopes (issue 12,
-- API tokens). The token itself is random and shown once. The table keeps
-- only the SHA-256 of the whole token, 32 bytes, under a unique key, and no
-- column holds the token in clear. A token belongs to its company and to the
-- membership of its person there, paired with the company, so a token can
-- never name company A and a membership of company B. Its person is the
-- identity that made it, and it acts as that person, within its scopes. Its
-- name is 1 to 100 characters on one line, as the server's own check. Its
-- scopes are one or more names of the server's list (packages/contract),
-- each a word of small letters: the database checks their form, and the
-- server the list. A token never ends by itself: it is revoked, once, and
-- then kept, so the history can name it.
--
-- An install-wide table of the company class: the app reads and writes only
-- the tokens of the transaction's company, so a request in one company never
-- sees or makes a token of the person's other companies. It keeps no
-- history of its own: its trigger writes each token's entries in its
-- company's behandlingshistorik instead (below).
CREATE TABLE access.api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL CONSTRAINT api_tokens_token_hash_form CHECK (octet_length(token_hash) = 32),
  token_company_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  identity_id uuid NOT NULL REFERENCES access.identities (id),
  name text NOT NULL
    CONSTRAINT api_tokens_name_length CHECK (char_length(name) BETWEEN 1 AND 100)
    CONSTRAINT api_tokens_name_one_line CHECK (name !~ '[\u0001-\u001f\u007f-\u009f  ؜‎‏‪-‮⁦-⁩]'),
  -- The list's text form holds an element unquoted only when it is a word
  -- of small letters, and holds no NULL, no empty element and no second
  -- dimension in this form.
  scopes text[] NOT NULL CONSTRAINT api_tokens_scopes_form CHECK (scopes::text ~ '^\{[a-z]+(,[a-z]+)*\}$'),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid,
  CONSTRAINT api_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT api_tokens_membership_fkey FOREIGN KEY (token_company_id, membership_id) REFERENCES access.memberships (company_id, id)
);
-- The tokens of a person in a company, which the person lists.
CREATE INDEX api_tokens_person ON access.api_tokens (token_company_id, identity_id, created_at);

-- The rules no policy keeps, for every role:
-- - no token is deleted (append_only);
-- - the database stamps the token's person, the transaction's actor, and when
--   it was made, to the millisecond, as the API gives a time, and refuses
--   each of them, and a revoke, when they are given with a new token;
-- - a token is revoked once: revoked_at is set once and never changes again,
--   and the database stamps who revoked it, the transaction's actor, and
--   refuses one that is given;
-- - nothing else of a token ever changes.
-- A refusal of a given or changed field is immutable_field, with the field.
CREATE FUNCTION access.api_tokens_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM ledger.refuse('append_only', jsonb_build_object('table', 'access.api_tokens', 'operation', 'DELETE'));
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.identity_id IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'identity_id', 'operation', 'create'));
    END IF;
    IF NEW.created_at IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_at', 'operation', 'create'));
    END IF;
    IF NEW.revoked_at IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'revoked_at', 'operation', 'create'));
    END IF;
    IF NEW.revoked_by IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'revoked_by', 'operation', 'create'));
    END IF;
    SELECT a.actor_id INTO NEW.identity_id FROM ledger.current_actor() AS a;
    NEW.created_at := date_trunc('milliseconds', clock_timestamp());
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'id', 'operation', 'update'));
  END IF;
  IF NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'token_hash', 'operation', 'update'));
  END IF;
  IF NEW.token_company_id IS DISTINCT FROM OLD.token_company_id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'token_company_id', 'operation', 'update'));
  END IF;
  IF NEW.membership_id IS DISTINCT FROM OLD.membership_id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'membership_id', 'operation', 'update'));
  END IF;
  IF NEW.identity_id IS DISTINCT FROM OLD.identity_id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'identity_id', 'operation', 'update'));
  END IF;
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'name', 'operation', 'update'));
  END IF;
  IF NEW.scopes IS DISTINCT FROM OLD.scopes THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'scopes', 'operation', 'update'));
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_at', 'operation', 'update'));
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'revoked_at', 'operation', 'update'));
  END IF;
  IF NEW.revoked_by IS DISTINCT FROM OLD.revoked_by THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'revoked_by', 'operation', 'update'));
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    SELECT a.actor_id INTO NEW.revoked_by FROM ledger.current_actor() AS a;
  END IF;
  RETURN NEW;
END
$rules$;

CREATE TRIGGER api_tokens_rules BEFORE INSERT OR UPDATE OR DELETE ON access.api_tokens
  FOR EACH ROW EXECUTE FUNCTION access.api_tokens_rules();

-- A token's entries in the behandlingshistorik (issue 12,
-- Behandlingshistorik 2): one when it is made, and one when it is revoked.
-- Each is a row of access.events in the token's company, by the stable
-- codes of the program Användare (users) and the headings
-- api-token-created and api-token-revoked, about the token's person, with
-- the token's id, name and scopes, and the time it was made or revoked. Its
-- insert's history row is the entry, with the transaction's actor and via.
-- The entry goes through the owner's company policy on access.events, so a
-- token whose company is not the transaction's is refused here too, also as
-- the owner, whose policy on the tokens reads every row. A statement that
-- revokes no token writes none.
CREATE FUNCTION access.api_tokens_entries() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $entries$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  INSERT INTO access.events (company_id, program, heading, subject_id, details, at)
  VALUES (
    NEW.token_company_id,
    'users',
    CASE TG_OP WHEN 'INSERT' THEN 'api-token-created' ELSE 'api-token-revoked' END,
    NEW.identity_id,
    jsonb_build_object('tokenId', NEW.id, 'name', NEW.name, 'scopes', to_jsonb(NEW.scopes)),
    CASE TG_OP WHEN 'INSERT' THEN NEW.created_at ELSE NEW.revoked_at END
  );
  RETURN NULL;
END
$entries$;

CREATE TRIGGER api_tokens_entries AFTER INSERT OR UPDATE ON access.api_tokens
  FOR EACH ROW EXECUTE FUNCTION access.api_tokens_entries();
SELECT meta.protect_install_table('access.api_tokens');
CREATE POLICY company_select ON access.api_tokens FOR SELECT TO nortfox_app USING (token_company_id = ledger.current_company_id());
CREATE POLICY company_insert ON access.api_tokens FOR INSERT TO nortfox_app WITH CHECK (token_company_id = ledger.current_company_id());
CREATE POLICY company_update ON access.api_tokens FOR UPDATE TO nortfox_app
  USING (token_company_id = ledger.current_company_id()) WITH CHECK (token_company_id = ledger.current_company_id());
-- A token is never deleted, so the app may read, add and revoke them only.
GRANT SELECT, INSERT, UPDATE ON access.api_tokens TO nortfox_app;

-- A live token by its hash: not revoked. It gives the token's person, the
-- identity's status, the company and the membership, and the scopes. The
-- resolver reads it before it knows any company, so it runs as the owner.
-- The resolver then acts as the person, and takes the token only while the
-- one membership function gives the token's membership as the person's
-- active one in the token's company.
CREATE FUNCTION access.api_token_by_token(token_hash bytea)
RETURNS TABLE (token_id uuid, identity_id uuid, status text, token_company_id uuid, membership_id uuid, scopes text[])
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT t.id, t.identity_id, i.status, t.token_company_id, t.membership_id, t.scopes
  FROM access.api_tokens AS t JOIN access.identities AS i ON i.id = t.identity_id
  WHERE t.token_hash = api_token_by_token.token_hash AND t.revoked_at IS NULL;
END;

GRANT EXECUTE ON FUNCTION access.api_token_by_token(bytea) TO nortfox_app;
