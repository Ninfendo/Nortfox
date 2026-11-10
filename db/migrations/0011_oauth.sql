-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0011 OAuth 2.1 for MCP clients: the clients that register themselves, the
-- requests of the authorization step, the consents that people give, and
-- the codes and the access and refresh tokens of the login. See
-- db/README.md, the schema access, and decision 0008 in docs/decisions/.
--
-- Every table here is install-wide (apps/server/src/db/table-guard.ts,
-- INSTALL_TABLES). A client is public: the app reads every client, and only
-- the registration function adds one. A consent is of the company class, as
-- an API token is: the app reads, gives and revokes only the transaction's
-- company's. The requests, the codes and the tokens are secret: the app
-- reaches them only through the functions below. Each request, code and
-- token is kept only as the SHA-256 of the whole token, 32 bytes, under a
-- unique key, and no column holds one in clear.
--
-- The times come from the server's clock, which the server passes in, so a
-- test can move it. The database stamps two, to the millisecond: when a
-- consent was given, and when a newer one replaced it. A client's first
-- consent takes that consent's time.

-- The form of a redirect URI ---------------------------------------------------------
--
-- A redirect URI of an MCP client as the database holds it: https to a host
-- or an address, or http to a loopback host, where a native client listens
-- (RFC 8252: 127.0.0.1, [::1], or localhost, which MCP clients use), with a
-- port, a path and a query, and no user, no fragment, no space and nothing
-- outside visible ASCII, of at most 2000 characters. A list holds 1 to 5, in
-- one dimension, with no NULL. The server holds the rest of a
-- registration's rules (RFC 7591). The checks of the clients, the requests
-- and the codes call it, as the owner; no role but the owner may.
CREATE FUNCTION access.oauth_redirect_uris_form(uris text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT COALESCE(
    array_ndims(oauth_redirect_uris_form.uris) = 1
      AND array_lower(oauth_redirect_uris_form.uris, 1) = 1
      AND cardinality(oauth_redirect_uris_form.uris) BETWEEN 1 AND 5
      AND NOT EXISTS (
        SELECT FROM unnest(oauth_redirect_uris_form.uris) AS u (uri)
        WHERE u.uri IS NULL
          OR char_length(u.uri) > 2000
          OR u.uri !~ '^(https://([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])|http://(127\.0\.0\.1|\[::1\]|localhost))(:[0-9]{1,5})?([/?][\x21\x24-\x7e]*)?$'
      ),
    false);
END;

-- The clients --------------------------------------------------------------------
--
-- An MCP client that registered itself (RFC 7591, issue 12 open point 8):
-- its client id, nfk_ and 22 characters from 16 random bytes, which is
-- public, its name, 1 to 100 characters on one line, its redirect URIs, its
-- grant types, authorization_code, alone or with refresh_token after it,
-- when it registered, by the server's clock, and when it got its first
-- consent. A public install-wide table: the app reads every client, with or
-- without a person or a company, and writes none. A client that has no
-- consent 24 hours after it registered is purged (below). A client never
-- changes, but for its first consent's time, which is set once.
CREATE TABLE access.oauth_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL CONSTRAINT oauth_clients_client_id_form CHECK (client_id ~ '^nfk_[A-Za-z0-9_-]{22}$'),
  client_name text NOT NULL
    CONSTRAINT oauth_clients_client_name_length CHECK (char_length(client_name) BETWEEN 1 AND 100)
    CONSTRAINT oauth_clients_client_name_one_line CHECK (client_name !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]'),
  redirect_uris text[] NOT NULL CONSTRAINT oauth_clients_redirect_uris_form CHECK (access.oauth_redirect_uris_form(redirect_uris)),
  grant_types text[] NOT NULL CONSTRAINT oauth_clients_grant_types_known CHECK (grant_types::text IN ('{authorization_code}', '{authorization_code,refresh_token}')),
  created_at timestamptz NOT NULL,
  first_consent_at timestamptz,
  CONSTRAINT oauth_clients_client_id_key UNIQUE (client_id)
);

-- The rules no policy keeps, for every role: a first consent's time is not
-- given with a new client, and nothing of a client changes but that time,
-- which is set once (the set-once trigger). A refusal is immutable_field,
-- with the field.
CREATE FUNCTION access.oauth_clients_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
DECLARE
  field text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.first_consent_at IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'first_consent_at', 'operation', 'create'));
    END IF;
    RETURN NEW;
  END IF;
  FOREACH field IN ARRAY ARRAY['id', 'client_id', 'client_name', 'redirect_uris', 'grant_types', 'created_at'] LOOP
    IF (to_jsonb(NEW) -> field) IS DISTINCT FROM (to_jsonb(OLD) -> field) THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', field, 'operation', 'update'));
    END IF;
  END LOOP;
  RETURN NEW;
END
$rules$;

CREATE TRIGGER oauth_clients_rules BEFORE INSERT OR UPDATE ON access.oauth_clients
  FOR EACH ROW EXECUTE FUNCTION access.oauth_clients_rules();
CREATE TRIGGER oauth_clients_set_once BEFORE UPDATE ON access.oauth_clients
  FOR EACH ROW EXECUTE FUNCTION access.keep_set_once('first_consent_at');
SELECT meta.protect_install_table('access.oauth_clients');
CREATE POLICY public_select ON access.oauth_clients FOR SELECT TO nortfox_app USING (true);
GRANT SELECT ON access.oauth_clients TO nortfox_app;

-- The authorization requests -----------------------------------------------------
--
-- A request of the authorization step (nfq_): the client, one of its redirect
-- URIs, the scopes it asks for, the code challenge (S256: 43 characters of
-- base64url), the state that goes back to the client, if any (visible ASCII,
-- 1 to 1000 characters), the resource it names, if any, the hash of the
-- login cookie that binds it to the browser that started it, when it was
-- made, its end, and when it was used, by an approval or a denial. It works
-- once, until its end. A secret install-wide table.
--
-- The client has no foreign key: the purge deletes a client with no consent
-- 24 hours after it registered, and a request made just before that must
-- neither stop the purge nor wait for it. A request whose client is gone is
-- found by no function, since each finds a request with its client.
CREATE TABLE access.oauth_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL CONSTRAINT oauth_requests_token_hash_form CHECK (octet_length(token_hash) = 32),
  oauth_client_id uuid NOT NULL,
  redirect_uri text NOT NULL CONSTRAINT oauth_requests_redirect_uri_form CHECK (access.oauth_redirect_uris_form(ARRAY[redirect_uri])),
  scopes text[] NOT NULL CONSTRAINT oauth_requests_scopes_form CHECK (scopes::text ~ '^\{[a-z]+(,[a-z]+)*\}$'),
  code_challenge text NOT NULL CONSTRAINT oauth_requests_code_challenge_form CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  state text CONSTRAINT oauth_requests_state_form CHECK (char_length(state) BETWEEN 1 AND 1000 AND state ~ '^[\x20-\x7e]+$'),
  resource text CONSTRAINT oauth_requests_resource_form CHECK (char_length(resource) BETWEEN 1 AND 2000 AND resource ~ '^https?://[\x21\x24-\x7e]+$'),
  binding_hash bytea NOT NULL CONSTRAINT oauth_requests_binding_hash_form CHECK (octet_length(binding_hash) = 32),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CONSTRAINT oauth_requests_token_hash_key UNIQUE (token_hash),
  CONSTRAINT oauth_requests_binding_hash_key UNIQUE (binding_hash)
);
CREATE TRIGGER oauth_requests_set_once BEFORE UPDATE ON access.oauth_requests
  FOR EACH ROW EXECUTE FUNCTION access.keep_set_once('used_at');
SELECT meta.protect_install_table('access.oauth_requests');

-- The consents -------------------------------------------------------------------
--
-- A consent (issue 12, OAuth for MCP clients 3): the scopes a person approved
-- for one MCP client in one company, who approved them and when. It belongs
-- to its company and to the membership of its person there, paired with the
-- company, so a consent can never name company A and a membership of
-- company B. Its scopes are one or more words of small letters, as an API
-- token's. It is revoked once, and then kept, so the history can name it. A
-- person has one live consent for a client in a company: a new one revokes
-- the live one (below), and a unique index holds it.
--
-- An install-wide table of the company class: the app reads, gives and
-- revokes only the transaction's company's, so a request in one company
-- never sees or gives a consent of the person's other companies. It keeps no
-- history of its own: its trigger writes each consent's entries in its
-- company's behandlingshistorik instead.
CREATE TABLE access.consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consent_company_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  oauth_client_id uuid NOT NULL REFERENCES access.oauth_clients (id),
  identity_id uuid NOT NULL REFERENCES access.identities (id),
  scopes text[] NOT NULL CONSTRAINT consents_scopes_form CHECK (scopes::text ~ '^\{[a-z]+(,[a-z]+)*\}$'),
  approved_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid,
  CONSTRAINT consents_membership_fkey FOREIGN KEY (consent_company_id, membership_id) REFERENCES access.memberships (company_id, id)
);
CREATE UNIQUE INDEX consents_one_live ON access.consents (consent_company_id, identity_id, oauth_client_id) WHERE revoked_at IS NULL;
-- The consents of a person in a company, which the person lists.
CREATE INDEX consents_person ON access.consents (consent_company_id, identity_id, approved_at);

-- The rules no policy keeps, for every role:
-- - no consent is deleted (append_only);
-- - the database stamps the consent's person, the transaction's actor, and
--   when it was given, to the millisecond, as the API gives a time, and
--   refuses each of them, and a revoke, when they are given with a new
--   consent;
-- - a new consent locks its client's row first, FOR NO KEY UPDATE, so the
--   new consents of one client take turns; then it revokes the person's live
--   consent for the same client in the same company, at its own time, and
--   gives the client its first consent's time when it has none;
-- - a consent is revoked once: revoked_at, which the server gives, is set
--   once and never changes or clears again, and the database stamps who
--   revoked it, the transaction's actor, and refuses one that is given;
-- - nothing else of a consent ever changes.
-- A refusal of a given or changed field is immutable_field, with the field.
CREATE FUNCTION access.consents_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM ledger.refuse('append_only', jsonb_build_object('table', 'access.consents', 'operation', 'DELETE'));
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.identity_id IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'identity_id', 'operation', 'create'));
    END IF;
    IF NEW.approved_at IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'approved_at', 'operation', 'create'));
    END IF;
    IF NEW.revoked_at IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'revoked_at', 'operation', 'create'));
    END IF;
    IF NEW.revoked_by IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'revoked_by', 'operation', 'create'));
    END IF;
    SELECT a.actor_id INTO NEW.identity_id FROM ledger.current_actor() AS a;
    NEW.approved_at := date_trunc('milliseconds', clock_timestamp());
    PERFORM FROM access.oauth_clients AS c WHERE c.id = NEW.oauth_client_id FOR NO KEY UPDATE;
    UPDATE access.consents AS k SET revoked_at = NEW.approved_at
    WHERE k.consent_company_id = NEW.consent_company_id AND k.identity_id = NEW.identity_id
      AND k.oauth_client_id = NEW.oauth_client_id AND k.revoked_at IS NULL;
    UPDATE access.oauth_clients AS c SET first_consent_at = NEW.approved_at
    WHERE c.id = NEW.oauth_client_id AND c.first_consent_at IS NULL;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'id', 'operation', 'update'));
  END IF;
  IF NEW.consent_company_id IS DISTINCT FROM OLD.consent_company_id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'consent_company_id', 'operation', 'update'));
  END IF;
  IF NEW.membership_id IS DISTINCT FROM OLD.membership_id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'membership_id', 'operation', 'update'));
  END IF;
  IF NEW.oauth_client_id IS DISTINCT FROM OLD.oauth_client_id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'oauth_client_id', 'operation', 'update'));
  END IF;
  IF NEW.identity_id IS DISTINCT FROM OLD.identity_id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'identity_id', 'operation', 'update'));
  END IF;
  IF NEW.scopes IS DISTINCT FROM OLD.scopes THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'scopes', 'operation', 'update'));
  END IF;
  IF NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'approved_at', 'operation', 'update'));
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

CREATE TRIGGER consents_rules BEFORE INSERT OR UPDATE OR DELETE ON access.consents
  FOR EACH ROW EXECUTE FUNCTION access.consents_rules();

-- A consent's entries in the behandlingshistorik (issue 12,
-- Behandlingshistorik 2): one when it is given, and one when it is revoked.
-- Each is a row of access.events in the consent's company, by the stable
-- codes of the program Användare (users) and the headings consent-given and
-- consent-revoked, about the consent's person, with the consent's id, the
-- client's id and name, and the scopes, and the time it was given or
-- revoked. Its insert's history row is the entry, with the transaction's
-- actor and via. The entry goes through the owner's company policy on
-- access.events, so a consent whose company is not the transaction's is
-- refused here too, also as the owner. A statement that revokes no consent
-- writes none. The revoke of a replaced consent, which the new one's rules
-- make, writes its entry before the new one's.
CREATE FUNCTION access.consents_entries() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $entries$
DECLARE
  client record;
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  SELECT c.client_id, c.client_name INTO client FROM access.oauth_clients AS c WHERE c.id = NEW.oauth_client_id;
  INSERT INTO access.events (company_id, program, heading, subject_id, details, at)
  VALUES (
    NEW.consent_company_id,
    'users',
    CASE TG_OP WHEN 'INSERT' THEN 'consent-given' ELSE 'consent-revoked' END,
    NEW.identity_id,
    jsonb_build_object('consentId', NEW.id, 'clientId', client.client_id, 'clientName', client.client_name, 'scopes', to_jsonb(NEW.scopes)),
    CASE TG_OP WHEN 'INSERT' THEN NEW.approved_at ELSE NEW.revoked_at END
  );
  RETURN NULL;
END
$entries$;

CREATE TRIGGER consents_entries AFTER INSERT OR UPDATE ON access.consents
  FOR EACH ROW EXECUTE FUNCTION access.consents_entries();
SELECT meta.protect_install_table('access.consents');
CREATE POLICY company_select ON access.consents FOR SELECT TO nortfox_app USING (consent_company_id = ledger.current_company_id());
CREATE POLICY company_insert ON access.consents FOR INSERT TO nortfox_app WITH CHECK (consent_company_id = ledger.current_company_id());
CREATE POLICY company_update ON access.consents FOR UPDATE TO nortfox_app
  USING (consent_company_id = ledger.current_company_id()) WITH CHECK (consent_company_id = ledger.current_company_id());
-- A consent is never deleted, so the app may read, give and revoke them only.
GRANT SELECT, INSERT, UPDATE ON access.consents TO nortfox_app;

-- The codes and the tokens -----------------------------------------------------------
--
-- A code (nfa_) of an approved request, for its consent, with the request's
-- redirect URI and code challenge, when it was issued, its end, and when it
-- was used. A request gives one code at most. It works once, until its end.
-- The request has no foreign key: the purge deletes a request at its end,
-- before its code's.
--
-- An access token (nfo_) and a refresh token (nfr_) of a consent, in a grant
-- family: every token that came from the same code, whose id is the
-- family's. Each holds its scopes, within its consent's, when it was issued,
-- its end, and when it was revoked; a refresh token also when it was used.
-- A refresh token works once. A code or a refresh token that comes back
-- after its use revokes every live token of its family (OAuth 2.1, section
-- 4.3.1; RFC 9700, section 4.14.2). All three are secret install-wide
-- tables.
CREATE TABLE access.oauth_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL CONSTRAINT oauth_codes_token_hash_form CHECK (octet_length(token_hash) = 32),
  request_id uuid NOT NULL,
  consent_id uuid NOT NULL REFERENCES access.consents (id),
  redirect_uri text NOT NULL CONSTRAINT oauth_codes_redirect_uri_form CHECK (access.oauth_redirect_uris_form(ARRAY[redirect_uri])),
  code_challenge text NOT NULL CONSTRAINT oauth_codes_code_challenge_form CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CONSTRAINT oauth_codes_token_hash_key UNIQUE (token_hash),
  CONSTRAINT oauth_codes_request_key UNIQUE (request_id)
);
CREATE TRIGGER oauth_codes_set_once BEFORE UPDATE ON access.oauth_codes
  FOR EACH ROW EXECUTE FUNCTION access.keep_set_once('used_at');
SELECT meta.protect_install_table('access.oauth_codes');

CREATE TABLE access.oauth_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL CONSTRAINT oauth_access_tokens_token_hash_form CHECK (octet_length(token_hash) = 32),
  consent_id uuid NOT NULL REFERENCES access.consents (id),
  family_id uuid NOT NULL,
  scopes text[] NOT NULL CONSTRAINT oauth_access_tokens_scopes_form CHECK (scopes::text ~ '^\{[a-z]+(,[a-z]+)*\}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT oauth_access_tokens_token_hash_key UNIQUE (token_hash)
);
CREATE INDEX oauth_access_tokens_family ON access.oauth_access_tokens (family_id);
CREATE TRIGGER oauth_access_tokens_set_once BEFORE UPDATE ON access.oauth_access_tokens
  FOR EACH ROW EXECUTE FUNCTION access.keep_set_once('revoked_at');
SELECT meta.protect_install_table('access.oauth_access_tokens');

CREATE TABLE access.oauth_refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL CONSTRAINT oauth_refresh_tokens_token_hash_form CHECK (octet_length(token_hash) = 32),
  consent_id uuid NOT NULL REFERENCES access.consents (id),
  family_id uuid NOT NULL,
  scopes text[] NOT NULL CONSTRAINT oauth_refresh_tokens_scopes_form CHECK (scopes::text ~ '^\{[a-z]+(,[a-z]+)*\}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT oauth_refresh_tokens_token_hash_key UNIQUE (token_hash)
);
CREATE INDEX oauth_refresh_tokens_family ON access.oauth_refresh_tokens (family_id);
CREATE TRIGGER oauth_refresh_tokens_set_once BEFORE UPDATE ON access.oauth_refresh_tokens
  FOR EACH ROW EXECUTE FUNCTION access.keep_set_once('used_at', 'revoked_at');
SELECT meta.protect_install_table('access.oauth_refresh_tokens');

-- The functions of the login -------------------------------------------------------
--
-- The app's only way to the secret tables, and to add a client. Each runs as
-- the owner, with its search path pinned, and only the app may call it. Each
-- takes a hash, and gives the columns its caller needs, of one row. Each one
-- that uses up a row that works once locks the row first and reads it after
-- the lock, or uses it with one conditional update: of two parallel calls,
-- the second waits for the first, and then finds the row used.

-- Registers a client, at the server's time, and gives its row's id.
CREATE FUNCTION access.register_oauth_client(client_id text, client_name text, redirect_uris text[], grant_types text[], at timestamptz) RETURNS uuid
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  INSERT INTO access.oauth_clients (client_id, client_name, redirect_uris, grant_types, created_at)
  VALUES (
    register_oauth_client.client_id, register_oauth_client.client_name, register_oauth_client.redirect_uris,
    register_oauth_client.grant_types, register_oauth_client.at
  )
  RETURNING id;
END;

-- Opens a request of a client for one of the client's redirect URIs, and
-- gives its id; NULL for a client that does not exist, or a redirect URI
-- that is not exactly one of the client's.
CREATE FUNCTION access.open_oauth_request(
  token_hash bytea, oauth_client uuid, redirect_uri text, scopes text[], code_challenge text, state text, resource text,
  binding_hash bytea, at timestamptz, expires_at timestamptz
) RETURNS uuid
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  INSERT INTO access.oauth_requests (token_hash, oauth_client_id, redirect_uri, scopes, code_challenge, state, resource, binding_hash, created_at, expires_at)
  SELECT open_oauth_request.token_hash, c.id, open_oauth_request.redirect_uri, open_oauth_request.scopes, open_oauth_request.code_challenge,
    open_oauth_request.state, open_oauth_request.resource, open_oauth_request.binding_hash, open_oauth_request.at, open_oauth_request.expires_at
  FROM access.oauth_clients AS c
  WHERE c.id = open_oauth_request.oauth_client AND open_oauth_request.redirect_uri = ANY (c.redirect_uris)
  RETURNING id;
END;

-- A live request, by its hash and the hash of the login cookie it is bound
-- to: not used, before its end, with its client. Nothing for any other.
CREATE FUNCTION access.oauth_request_by_token(token_hash bytea, binding_hash bytea, at timestamptz)
RETURNS TABLE (request_id uuid, oauth_client_id uuid, client_id text, client_name text, redirect_uri text, scopes text[], state text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT r.id, c.id, c.client_id, c.client_name, r.redirect_uri, r.scopes, r.state
  FROM access.oauth_requests AS r JOIN access.oauth_clients AS c ON c.id = r.oauth_client_id
  WHERE r.token_hash = oauth_request_by_token.token_hash AND r.binding_hash = oauth_request_by_token.binding_hash
    AND r.used_at IS NULL AND r.expires_at > oauth_request_by_token.at;
END;

-- Uses a live request once, as an approval or a denial does, and gives it as
-- access.oauth_request_by_token does; nothing when it is not live. It locks
-- the request's row and its client's, FOR NO KEY UPDATE, and reads them
-- after the locks: of two uses at once, the second finds the request used,
-- and the purge of a client with no consent waits for the use's transaction,
-- so a consent that the approval gives keeps its client.
CREATE FUNCTION access.use_oauth_request(token_hash bytea, binding_hash bytea, at timestamptz)
RETURNS TABLE (request_id uuid, oauth_client_id uuid, client_id text, client_name text, redirect_uri text, scopes text[], state text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $use$
DECLARE
  found_request uuid;
BEGIN
  SELECT r.id INTO found_request
  FROM access.oauth_requests AS r JOIN access.oauth_clients AS c ON c.id = r.oauth_client_id
  WHERE r.token_hash = use_oauth_request.token_hash AND r.binding_hash = use_oauth_request.binding_hash
    AND r.used_at IS NULL AND r.expires_at > use_oauth_request.at
  FOR NO KEY UPDATE OF r, c;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  UPDATE access.oauth_requests AS r SET used_at = use_oauth_request.at WHERE r.id = found_request;
  RETURN QUERY
    SELECT r.id, c.id, c.client_id, c.client_name, r.redirect_uri, r.scopes, r.state
    FROM access.oauth_requests AS r JOIN access.oauth_clients AS c ON c.id = r.oauth_client_id
    WHERE r.id = found_request;
END
$use$;

-- Issues the code of a used request, for a live consent of the transaction's
-- person in the transaction's company for the request's client, with the
-- request's redirect URI and challenge, and gives its id; NULL otherwise,
-- and for a request that has a code already.
CREATE FUNCTION access.issue_oauth_code(token_hash bytea, request uuid, consent uuid, at timestamptz, expires_at timestamptz) RETURNS uuid
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  INSERT INTO access.oauth_codes (token_hash, request_id, consent_id, redirect_uri, code_challenge, created_at, expires_at)
  SELECT issue_oauth_code.token_hash, r.id, k.id, r.redirect_uri, r.code_challenge, issue_oauth_code.at, issue_oauth_code.expires_at
  FROM access.oauth_requests AS r JOIN access.consents AS k ON k.oauth_client_id = r.oauth_client_id
  WHERE r.id = issue_oauth_code.request AND r.used_at IS NOT NULL
    AND k.id = issue_oauth_code.consent AND k.revoked_at IS NULL
    AND k.consent_company_id = ledger.current_company_id() AND k.identity_id = access.current_person_id()
  ON CONFLICT ON CONSTRAINT oauth_codes_request_key DO NOTHING
  RETURNING id;
END;

-- Redeems a code, as the token endpoint does with authorization_code. The
-- code must have been issued to the client of `client_id`, for the redirect
-- URI and the challenge given (the server gives BASE64URL(SHA256) of the
-- verifier). It locks the code's row and reads it after the lock. A live
-- code of a live consent is used, and gives an access token, and a refresh
-- token when the client registered the refresh grant, in the code's family,
-- with the consent's scopes: the outcome issued. A used one revokes every
-- live token of its family, and gives the outcome reused, with no tokens.
-- Nothing for any other: an unknown code, another client's, redirect URI or
-- verifier, a code past its end, or one whose consent is revoked, and none
-- of them changes the code. Of two redemptions at once, the second waits for
-- the first's commit, finds the code used, and revokes what the first got.
-- So it runs at READ COMMITTED only (read_committed_only): each statement
-- then reads what is committed.
CREATE FUNCTION access.redeem_oauth_code(
  token_hash bytea, client_id text, redirect_uri text, code_challenge text, access_hash bytea, refresh_hash bytea,
  at timestamptz, access_expires_at timestamptz, refresh_expires_at timestamptz
) RETURNS TABLE (outcome text, identity_id uuid, scopes text[], access_token_id uuid, refresh_token_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $redeem$
DECLARE
  code record;
  made_access uuid;
  made_refresh uuid;
BEGIN
  PERFORM ledger.assert_read_committed();
  SELECT c.id, c.used_at, c.expires_at, k.id AS consent, k.revoked_at AS consent_revoked_at, k.identity_id AS person, k.scopes AS granted, l.grant_types AS grants
  INTO code
  FROM access.oauth_codes AS c
  JOIN access.consents AS k ON k.id = c.consent_id
  JOIN access.oauth_clients AS l ON l.id = k.oauth_client_id
  WHERE c.token_hash = redeem_oauth_code.token_hash AND l.client_id = redeem_oauth_code.client_id
    AND c.redirect_uri = redeem_oauth_code.redirect_uri AND c.code_challenge = redeem_oauth_code.code_challenge
  FOR NO KEY UPDATE OF c;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF code.used_at IS NOT NULL THEN
    UPDATE access.oauth_access_tokens AS t SET revoked_at = redeem_oauth_code.at
    WHERE t.family_id = code.id AND t.revoked_at IS NULL AND t.expires_at > redeem_oauth_code.at;
    UPDATE access.oauth_refresh_tokens AS t SET revoked_at = redeem_oauth_code.at
    WHERE t.family_id = code.id AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > redeem_oauth_code.at;
    RETURN QUERY SELECT 'reused'::text, code.person, code.granted, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;
  IF code.expires_at <= redeem_oauth_code.at OR code.consent_revoked_at IS NOT NULL THEN
    RETURN;
  END IF;
  UPDATE access.oauth_codes AS c SET used_at = redeem_oauth_code.at WHERE c.id = code.id;
  INSERT INTO access.oauth_access_tokens (token_hash, consent_id, family_id, scopes, created_at, expires_at)
  VALUES (redeem_oauth_code.access_hash, code.consent, code.id, code.granted, redeem_oauth_code.at, redeem_oauth_code.access_expires_at)
  RETURNING id INTO made_access;
  IF 'refresh_token' = ANY (code.grants) THEN
    INSERT INTO access.oauth_refresh_tokens (token_hash, consent_id, family_id, scopes, created_at, expires_at)
    VALUES (redeem_oauth_code.refresh_hash, code.consent, code.id, code.granted, redeem_oauth_code.at, redeem_oauth_code.refresh_expires_at)
    RETURNING id INTO made_refresh;
  END IF;
  RETURN QUERY SELECT 'issued'::text, code.person, code.granted, made_access, made_refresh;
END
$redeem$;

-- Redeems a refresh token, as the token endpoint does with refresh_token.
-- The token must have been issued to the client of `client_id`. It locks
-- the token's row and reads it after the lock. A live token of a live
-- consent is used, and gives a new access token and a new refresh token of
-- the same family, with the scopes asked, which must be within the token's,
-- or the token's own when none are asked: the outcome issued. Scopes asked
-- outside the token's give the outcome invalid-scope, and change nothing. A
-- token that is used or revoked revokes every live token of its family, and
-- gives the outcome reused, with no tokens. Nothing for any other: an
-- unknown token, another client's, one past its end, or one whose consent
-- is revoked, and none of them changes the token. Of two redemptions at
-- once, the second waits for the first's commit, finds the token used, and
-- revokes the family, with what the first got. So it runs at READ COMMITTED
-- only (read_committed_only).
CREATE FUNCTION access.redeem_oauth_refresh_token(
  token_hash bytea, client_id text, wanted_scopes text[], access_hash bytea, refresh_hash bytea,
  at timestamptz, access_expires_at timestamptz, refresh_expires_at timestamptz
) RETURNS TABLE (outcome text, identity_id uuid, scopes text[], access_token_id uuid, refresh_token_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $redeem$
DECLARE
  kept record;
  given text[];
  made_access uuid;
  made_refresh uuid;
BEGIN
  PERFORM ledger.assert_read_committed();
  SELECT t.id, t.family_id, t.used_at, t.revoked_at, t.expires_at, t.scopes AS held, k.id AS consent, k.revoked_at AS consent_revoked_at, k.identity_id AS person
  INTO kept
  FROM access.oauth_refresh_tokens AS t
  JOIN access.consents AS k ON k.id = t.consent_id
  JOIN access.oauth_clients AS l ON l.id = k.oauth_client_id
  WHERE t.token_hash = redeem_oauth_refresh_token.token_hash AND l.client_id = redeem_oauth_refresh_token.client_id
  FOR NO KEY UPDATE OF t;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF kept.used_at IS NOT NULL OR kept.revoked_at IS NOT NULL THEN
    UPDATE access.oauth_access_tokens AS a SET revoked_at = redeem_oauth_refresh_token.at
    WHERE a.family_id = kept.family_id AND a.revoked_at IS NULL AND a.expires_at > redeem_oauth_refresh_token.at;
    UPDATE access.oauth_refresh_tokens AS r SET revoked_at = redeem_oauth_refresh_token.at
    WHERE r.family_id = kept.family_id AND r.used_at IS NULL AND r.revoked_at IS NULL AND r.expires_at > redeem_oauth_refresh_token.at;
    RETURN QUERY SELECT 'reused'::text, kept.person, kept.held, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;
  IF kept.expires_at <= redeem_oauth_refresh_token.at OR kept.consent_revoked_at IS NOT NULL THEN
    RETURN;
  END IF;
  given := COALESCE(redeem_oauth_refresh_token.wanted_scopes, kept.held);
  IF NOT (kept.held @> given) THEN
    RETURN QUERY SELECT 'invalid-scope'::text, kept.person, kept.held, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;
  UPDATE access.oauth_refresh_tokens AS r SET used_at = redeem_oauth_refresh_token.at WHERE r.id = kept.id;
  INSERT INTO access.oauth_access_tokens (token_hash, consent_id, family_id, scopes, created_at, expires_at)
  VALUES (redeem_oauth_refresh_token.access_hash, kept.consent, kept.family_id, given, redeem_oauth_refresh_token.at, redeem_oauth_refresh_token.access_expires_at)
  RETURNING id INTO made_access;
  INSERT INTO access.oauth_refresh_tokens (token_hash, consent_id, family_id, scopes, created_at, expires_at)
  VALUES (redeem_oauth_refresh_token.refresh_hash, kept.consent, kept.family_id, given, redeem_oauth_refresh_token.at, redeem_oauth_refresh_token.refresh_expires_at)
  RETURNING id INTO made_refresh;
  RETURN QUERY SELECT 'issued'::text, kept.person, given, made_access, made_refresh;
END
$redeem$;

-- A client's revocation of one of its tokens (RFC 7009), by its hash, for
-- the client of `client_id`. An access token is revoked; a refresh token
-- revokes its whole family, every live refresh and access token of it. It
-- gives the kind, access or refresh, how many live tokens it revoked, and
-- what the entry in the behandlingshistorik needs: the consent, its person,
-- company and membership, and the client. Nothing for an unknown token or
-- another client's, which stays as it is.
CREATE FUNCTION access.revoke_oauth_token(token_hash bytea, client_id text, at timestamptz)
RETURNS TABLE (
  kind text, revoked integer, consent_id uuid, identity_id uuid, consent_company_id uuid, membership_id uuid, oauth_client_id uuid, client_name text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $revoke$
DECLARE
  found_token record;
  changed integer;
  more integer;
BEGIN
  SELECT 'access'::text AS kind, t.id, t.family_id, k.id AS consent, k.identity_id AS person, k.consent_company_id AS company,
    k.membership_id AS membership, l.id AS client, l.client_name AS name
  INTO found_token
  FROM access.oauth_access_tokens AS t
  JOIN access.consents AS k ON k.id = t.consent_id
  JOIN access.oauth_clients AS l ON l.id = k.oauth_client_id
  WHERE t.token_hash = revoke_oauth_token.token_hash AND l.client_id = revoke_oauth_token.client_id;
  IF FOUND THEN
    UPDATE access.oauth_access_tokens AS t SET revoked_at = revoke_oauth_token.at
    WHERE t.id = found_token.id AND t.revoked_at IS NULL AND t.expires_at > revoke_oauth_token.at;
    GET DIAGNOSTICS changed = ROW_COUNT;
  ELSE
    SELECT 'refresh'::text AS kind, t.id, t.family_id, k.id AS consent, k.identity_id AS person, k.consent_company_id AS company,
      k.membership_id AS membership, l.id AS client, l.client_name AS name
    INTO found_token
    FROM access.oauth_refresh_tokens AS t
    JOIN access.consents AS k ON k.id = t.consent_id
    JOIN access.oauth_clients AS l ON l.id = k.oauth_client_id
    WHERE t.token_hash = revoke_oauth_token.token_hash AND l.client_id = revoke_oauth_token.client_id;
    IF NOT FOUND THEN
      RETURN;
    END IF;
    UPDATE access.oauth_refresh_tokens AS t SET revoked_at = revoke_oauth_token.at
    WHERE t.family_id = found_token.family_id AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > revoke_oauth_token.at;
    GET DIAGNOSTICS changed = ROW_COUNT;
    UPDATE access.oauth_access_tokens AS t SET revoked_at = revoke_oauth_token.at
    WHERE t.family_id = found_token.family_id AND t.revoked_at IS NULL AND t.expires_at > revoke_oauth_token.at;
    GET DIAGNOSTICS more = ROW_COUNT;
    changed := changed + more;
  END IF;
  RETURN QUERY SELECT found_token.kind, changed, found_token.consent, found_token.person, found_token.company,
    found_token.membership, found_token.client, found_token.name;
END
$revoke$;

-- A live access token by its hash, at `at`: not revoked, before its end, of a
-- consent that is not revoked. It gives the token's id, the consent's person
-- with the identity's status, the consent, its company and membership, the
-- client, and the token's scopes. The resolver reads it before it knows any
-- company, then acts as the person, an integration through the client, and
-- takes the token only while the one membership function gives the
-- consent's membership as the person's active one in its company.
CREATE FUNCTION access.oauth_access_token_by_token(token_hash bytea, at timestamptz)
RETURNS TABLE (
  token_id uuid, identity_id uuid, status text, consent_id uuid, consent_company_id uuid, membership_id uuid,
  oauth_client_id uuid, client_id text, client_name text, scopes text[]
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT t.id, k.identity_id, i.status, k.id, k.consent_company_id, k.membership_id, l.id, l.client_id, l.client_name, t.scopes
  FROM access.oauth_access_tokens AS t
  JOIN access.consents AS k ON k.id = t.consent_id
  JOIN access.oauth_clients AS l ON l.id = k.oauth_client_id
  JOIN access.identities AS i ON i.id = k.identity_id
  WHERE t.token_hash = oauth_access_token_by_token.token_hash AND t.revoked_at IS NULL
    AND t.expires_at > oauth_access_token_by_token.at AND k.revoked_at IS NULL;
END;

-- The purge, as 0009 made it, and the rows of the MCP login after the rest:
-- the authorization requests, the codes and the access tokens at their end,
-- used and revoked ones too; a grant family's refresh tokens once every one
-- of them has passed its end, so a used or revoked one stays until then and
-- its reuse is still found; and a client that has no consent 24 hours after
-- it registered. A client's purge waits for a use of its request, which
-- locks the client: when that approval gives the client its first consent,
-- the client is kept. It deletes no identity and no consent.
CREATE OR REPLACE FUNCTION access.purge_expired(at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $purge$
BEGIN
  DELETE FROM access.setup_tokens AS t WHERE t.expires_at <= purge_expired.at AND t.used_at IS NULL;
  DELETE FROM access.invitation_links AS l WHERE l.expires_at <= purge_expired.at;
  DELETE FROM access.login_challenges AS c WHERE c.expires_at <= purge_expired.at;
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
  DELETE FROM access.oauth_requests AS r WHERE r.expires_at <= purge_expired.at;
  DELETE FROM access.oauth_codes AS c WHERE c.expires_at <= purge_expired.at;
  DELETE FROM access.oauth_access_tokens AS t WHERE t.expires_at <= purge_expired.at;
  DELETE FROM access.oauth_refresh_tokens AS t
  WHERE NOT EXISTS (
    SELECT FROM access.oauth_refresh_tokens AS f WHERE f.family_id = t.family_id AND f.expires_at > purge_expired.at
  );
  DELETE FROM access.oauth_clients AS c
  WHERE c.first_consent_at IS NULL AND c.created_at <= purge_expired.at - interval '24 hours'
    AND NOT EXISTS (SELECT FROM access.consents AS k WHERE k.oauth_client_id = c.id);
END
$purge$;

GRANT EXECUTE ON FUNCTION
  access.register_oauth_client(text, text, text[], text[], timestamptz),
  access.open_oauth_request(bytea, uuid, text, text[], text, text, text, bytea, timestamptz, timestamptz),
  access.oauth_request_by_token(bytea, bytea, timestamptz),
  access.use_oauth_request(bytea, bytea, timestamptz),
  access.issue_oauth_code(bytea, uuid, uuid, timestamptz, timestamptz),
  access.redeem_oauth_code(bytea, text, text, text, bytea, bytea, timestamptz, timestamptz, timestamptz),
  access.redeem_oauth_refresh_token(bytea, text, text[], bytea, bytea, timestamptz, timestamptz, timestamptz),
  access.revoke_oauth_token(bytea, text, timestamptz),
  access.oauth_access_token_by_token(bytea, timestamptz)
TO nortfox_app;
