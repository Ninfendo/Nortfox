-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0008 a new setup link for a first identity that never confirmed its TOTP
-- secret (issue 54). completeSetup's answer holds the only copy of the first
-- identity's pending TOTP secret. When that answer is lost, the setup command
-- may make a new link, while the install's only identity is the one that a
-- setup link made and it has never confirmed its secret. Using the new link
-- replaces that identity: it is deleted, so it keeps no e-mail address,
-- personnummer or mobile number; its password, its pending TOTP secret and
-- its open login challenges are deleted; and a new identity comes from the
-- new link's input, with a new pending secret. Once the identity has
-- confirmed its secret, nothing changes: the setup command makes no link,
-- and a link made before refuses (install_not_empty). See db/README.md, the
-- schema access.

-- The identities of the setup links -------------------------------------------
--
-- A used link names the identity it made, and only a used link names one;
-- each identity was made by one link at most. A link made while the install
-- has an unfinished identity names the identity that its use replaces. Both
-- are set once. A used link stays past its end (the purge, below), so the
-- setup functions can tell the identities of the setup links from every
-- other identity.
ALTER TABLE access.setup_tokens
  ADD COLUMN identity_id uuid CONSTRAINT setup_tokens_identity_id_fkey REFERENCES access.identities (id),
  ADD COLUMN replaces_identity_id uuid CONSTRAINT setup_tokens_replaces_identity_id_fkey REFERENCES access.identities (id),
  ADD CONSTRAINT setup_tokens_identity_id_key UNIQUE (identity_id);

-- A link used before this migration names no identity. Until now a link was
-- used only on an empty install, where its use made the install's one
-- identity: completeSetup was the only way to make one. So on an install
-- with one identity and one used link, that link made it. A used link that
-- cannot be paired so works for nothing and names nothing, so it is deleted,
-- as the purge would have deleted it at its end.
UPDATE access.setup_tokens AS t SET identity_id = (SELECT i.id FROM access.identities AS i)
WHERE t.used_at IS NOT NULL
  AND (SELECT count(*) FROM access.identities) = 1
  AND (SELECT count(*) FROM access.setup_tokens AS u WHERE u.used_at IS NOT NULL) = 1;
DELETE FROM access.setup_tokens AS t WHERE t.used_at IS NOT NULL AND t.identity_id IS NULL;
ALTER TABLE access.setup_tokens ADD CONSTRAINT setup_tokens_used_with_identity CHECK ((used_at IS NULL) = (identity_id IS NULL));

DROP TRIGGER setup_tokens_set_once ON access.setup_tokens;
CREATE TRIGGER setup_tokens_set_once BEFORE UPDATE ON access.setup_tokens
  FOR EACH ROW EXECUTE FUNCTION access.keep_set_once('used_at', 'superseded_at', 'identity_id', 'replaces_identity_id');

-- The install's unfinished identity -------------------------------------------
--
-- The install's one active identity, when a setup link made it and it has
-- never confirmed a TOTP secret, and every other identity of the install is
-- one that a used setup link replaced; NULL otherwise. A TOTP secret is
-- confirmed once it is no longer pending, or has a time of confirmation.
-- Only the two setup functions call it, as the owner.
CREATE FUNCTION access.unfinished_setup_identity() RETURNS uuid
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT i.id
  FROM access.identities AS i
  JOIN access.setup_tokens AS t ON t.identity_id = i.id
  WHERE i.status = 'active'
    AND NOT EXISTS (
      SELECT FROM access.totp_secrets AS s
      WHERE s.identity_id = i.id AND (s.state <> 'pending' OR s.confirmed_at IS NOT NULL)
    )
    AND NOT EXISTS (
      SELECT FROM access.identities AS o
      WHERE o.id <> i.id
        AND NOT (o.status = 'deleted' AND EXISTS (
          SELECT FROM access.setup_tokens AS r WHERE r.replaces_identity_id = o.id AND r.identity_id IS NOT NULL
        ))
    );
END;

-- The setup functions -----------------------------------------------------------

-- Makes a setup link, stops every older link, and gives the link's id and
-- whether its use replaces the install's unfinished identity. On an install
-- that has an identity, it makes one only while that identity is unfinished
-- (above), and the link names it; otherwise it refuses (install_not_empty).
-- It takes the setup links' table lock, as complete_setup does, so the two
-- never overlap: the install has at most one live link, and no identity
-- comes between the check and the link. It takes the place of 0006's, which
-- gave the id alone.
DROP FUNCTION access.create_setup_token(bytea, timestamptz, timestamptz);
CREATE FUNCTION access.create_setup_token(token_hash bytea, at timestamptz, expires_at timestamptz)
RETURNS TABLE (link_id uuid, replaces_identity boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $create$
DECLARE
  replaced uuid;
  made uuid;
BEGIN
  LOCK TABLE access.setup_tokens IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (SELECT FROM access.identities) THEN
    replaced := access.unfinished_setup_identity();
    IF replaced IS NULL THEN
      PERFORM ledger.refuse('install_not_empty');
    END IF;
  END IF;
  UPDATE access.setup_tokens AS t SET superseded_at = create_setup_token.at WHERE t.used_at IS NULL AND t.superseded_at IS NULL;
  INSERT INTO access.setup_tokens (token_hash, created_at, expires_at, replaces_identity_id)
  VALUES (create_setup_token.token_hash, create_setup_token.at, create_setup_token.expires_at, replaced)
  RETURNING id INTO made;
  RETURN QUERY SELECT made, replaced IS NOT NULL;
END
$create$;

-- Uses a live setup link once, and makes an identity with it: its password
-- and its pending TOTP secret. The server picks the identity's and the
-- secret's ids, which the sealed secret is bound to. It gives false when the
-- link is unknown, used, stopped or past its end. A link that names no
-- identity to replace makes the first identity of an empty install, and
-- refuses (install_not_empty) when the install has an identity. A link that
-- names one replaces it, while it is still the install's unfinished identity:
-- it deletes its open login challenges, its TOTP secrets and its password,
-- and marks it deleted, with no e-mail address, personnummer or mobile
-- number. Otherwise, such as when the identity has confirmed its secret
-- since the link was made, it refuses (install_not_empty), and changes
-- nothing. The link is used last, with the identity it made.
--
-- It locks the identity's rows in the order a TOTP step does, its
-- challenges and then its secrets, and checks the identity again only after
-- the locks. So a TOTP step of the identity that runs at the same time
-- either confirms the secret first, and this refuses, or waits, and then
-- finds its challenge or its secret gone. The identity stays the actor on
-- what it did, as every deleted identity does. A challenge that a password
-- step opens at the same time names a deleted identity once this commits,
-- and the TOTP step refuses it.
CREATE OR REPLACE FUNCTION access.complete_setup(
  token_hash bytea, at timestamptz, person uuid, name text, email text, password_hash text, totp_secret_id uuid, totp_secret bytea
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $complete$
DECLARE
  link uuid;
  replaced uuid;
BEGIN
  LOCK TABLE access.setup_tokens IN SHARE ROW EXCLUSIVE MODE;
  SELECT t.id, t.replaces_identity_id INTO link, replaced
  FROM access.setup_tokens AS t
  WHERE t.token_hash = complete_setup.token_hash AND t.used_at IS NULL AND t.superseded_at IS NULL AND t.expires_at > complete_setup.at;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF replaced IS NULL THEN
    IF EXISTS (SELECT FROM access.identities) THEN
      PERFORM ledger.refuse('install_not_empty');
    END IF;
  ELSE
    DELETE FROM access.login_challenges AS c WHERE c.identity_id = replaced;
    PERFORM FROM access.totp_secrets AS s WHERE s.identity_id = replaced FOR UPDATE;
    PERFORM FROM access.identities AS i WHERE i.id = replaced FOR NO KEY UPDATE;
    IF access.unfinished_setup_identity() IS DISTINCT FROM replaced THEN
      PERFORM ledger.refuse('install_not_empty');
    END IF;
    DELETE FROM access.totp_secrets AS s WHERE s.identity_id = replaced;
    DELETE FROM access.password_credentials AS p WHERE p.identity_id = replaced;
    UPDATE access.identities AS i SET status = 'deleted', email = NULL, personal_identity_number = NULL, mobile = NULL WHERE i.id = replaced;
  END IF;
  INSERT INTO access.identities (id, name, email) VALUES (complete_setup.person, complete_setup.name, complete_setup.email);
  INSERT INTO access.password_credentials (identity_id, password_hash, changed_at)
  VALUES (complete_setup.person, complete_setup.password_hash, complete_setup.at);
  INSERT INTO access.totp_secrets (id, identity_id, secret, state, created_at)
  VALUES (complete_setup.totp_secret_id, complete_setup.person, complete_setup.totp_secret, 'pending', complete_setup.at);
  UPDATE access.setup_tokens AS t SET used_at = complete_setup.at, identity_id = complete_setup.person WHERE t.id = link;
  RETURN true;
END
$complete$;

-- The purge, as 0007 made it, but for one thing: it deletes a setup link at
-- its end only when it was not used. A used link names the identity it made,
-- and the one it replaced, which the setup functions read. It deletes no
-- identity.
CREATE OR REPLACE FUNCTION access.purge_expired(at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $purge$
BEGIN
  DELETE FROM access.login_challenges AS c WHERE c.expires_at <= purge_expired.at;
  DELETE FROM access.setup_tokens AS t WHERE t.expires_at <= purge_expired.at AND t.used_at IS NULL;
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

GRANT EXECUTE ON FUNCTION access.create_setup_token(bytea, timestamptz, timestamptz) TO nortfox_app;
