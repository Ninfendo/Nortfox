-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0005 the channel and the idempotency keys: the behandlingshistorik records
-- through which client each change came, and a write through /v1 or MCP
-- stores its idempotency key and its first answer. See db/README.md.

-- The channel ----------------------------------------------------------------
--
-- The server sets nortfox.channel for each transaction, with the company, the
-- actor and its kind: rest or mcp in this slice. A write outside a request,
-- such as one of the owner's tools, sets none, and its history rows hold
-- NULL, as the rows from before this migration do. A later slice that adds a
-- channel widens the check.
ALTER TABLE audit.history ADD COLUMN channel text CONSTRAINT history_channel_known CHECK (channel IN ('rest', 'mcp'));
SELECT meta.hide_statistics('audit.history');

-- A transaction keeps one channel, as it keeps one actor: any role can change
-- a setting at any time, also in the middle of a statement. So the channel
-- is kept with the actor at the transaction's first write.
ALTER TABLE ledger.transaction_actors ADD COLUMN channel text;

-- ledger.current_actor() gets a third column, the channel, so its columns
-- change and it is made again. Every caller is a trigger function in
-- PL/pgSQL that selects actor_id and actor_kind by name, so none changes.
-- As before, no role may call it: the triggers run as the owner.
DROP FUNCTION ledger.current_actor();

-- The transaction's actor, its kind and its channel. A write with no actor is
-- refused, and so is a write under another actor, kind or channel than the
-- transaction's first write had (insufficient privilege, 42501). An empty
-- channel is none, and none is a channel of its own: a write with none after
-- a write with one is refused too. The writes of a savepoint that rolled back
-- keep nothing. The row keeps the time the transaction began, which does not
-- move while it runs. So a clock set back during the transaction never makes
-- its own row look like an earlier one, which would let another actor in.
CREATE FUNCTION ledger.current_actor(OUT actor_id uuid, OUT actor_kind text, OUT channel text)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $actor$
DECLARE
  id_setting text := NULLIF(current_setting('nortfox.actor_id', true), '');
  kind_setting text := NULLIF(current_setting('nortfox.actor_kind', true), '');
  kept_transaction xid8;
  kept_began timestamptz;
  kept_id uuid;
  kept_kind text;
  kept_channel text;
BEGIN
  IF id_setting IS NULL THEN
    PERFORM ledger.refuse('actor_missing', jsonb_build_object('setting', 'nortfox.actor_id'));
  END IF;
  IF kind_setting IS NULL OR kind_setting NOT IN ('user', 'system', 'integration') THEN
    PERFORM ledger.refuse('actor_missing', jsonb_build_object('setting', 'nortfox.actor_kind'));
  END IF;
  actor_id := id_setting::uuid;
  actor_kind := kind_setting;
  channel := NULLIF(current_setting('nortfox.channel', true), '');
  SELECT t.transaction_id, t.transaction_began, t.actor_id, t.actor_kind, t.channel
  INTO kept_transaction, kept_began, kept_id, kept_kind, kept_channel
  FROM ledger.transaction_actors AS t
  WHERE t.backend_pid = pg_backend_pid();
  IF ledger.in_this_transaction(kept_transaction, kept_began) THEN
    IF kept_id IS DISTINCT FROM current_actor.actor_id OR kept_kind IS DISTINCT FROM current_actor.actor_kind THEN
      RAISE EXCEPTION USING
        ERRCODE = 'insufficient_privilege',
        MESSAGE = 'The transaction''s actor changed after its first write. A transaction keeps one actor.';
    END IF;
    IF kept_channel IS DISTINCT FROM current_actor.channel THEN
      RAISE EXCEPTION USING
        ERRCODE = 'insufficient_privilege',
        MESSAGE = 'The transaction''s channel changed after its first write. A transaction keeps one channel.';
    END IF;
    RETURN;
  END IF;
  INSERT INTO ledger.transaction_actors AS t (backend_pid, transaction_id, transaction_began, actor_id, actor_kind, channel)
  VALUES (pg_backend_pid(), pg_current_xact_id(), transaction_timestamp(), current_actor.actor_id, current_actor.actor_kind, current_actor.channel)
  ON CONFLICT (backend_pid) DO UPDATE
  SET transaction_id = excluded.transaction_id, transaction_began = excluded.transaction_began,
    actor_id = excluded.actor_id, actor_kind = excluded.actor_kind, channel = excluded.channel;
END
$actor$;

-- Writes the history row of one row change, now with the channel. The rest is
-- as 0001 made it: its argument is the table's key column; it refuses a write
-- at another level than READ COMMITTED, and a row that would move to another
-- company. The channel's check refuses one this database does not know.
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
  SELECT a.actor_id, a.actor_kind, a.channel INTO actor FROM ledger.current_actor() AS a;
  INSERT INTO audit.history
    (company_id, table_name, row_id, operation, old_values, new_values, actor_id, actor_kind, channel, transaction_id, at)
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
    pg_current_xact_id(),
    clock_timestamp()
  );
  RETURN NULL;
END
$history$;

-- The idempotency keys ----------------------------------------------------------
--
-- A write through /v1 or MCP stores its key and its first answer in the same
-- transaction as the write, so the same key and request give that answer
-- again and write nothing twice. A key is kept per company and actor: the
-- unique key holds both, and row level security the company. The key is 1 to
-- 255 characters of visible ASCII but the double quote and the backslash, the
-- same as the server's own check (packages/contract), so its quoted form in
-- the header needs no escape. The range in the check runs by code point, in
-- any collation. request_hash is the SHA-256 of the request, in hexadecimal.
-- The answer is a success: a refused write stores no key. Keys never expire
-- in this slice. The stored answer also lands in the behandlingshistorik,
-- through the history trigger, as every company row does.
CREATE TABLE ledger.idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES ledger.companies (company_id),
  actor_id uuid NOT NULL,
  actor_kind text NOT NULL,
  idempotency_key text NOT NULL CONSTRAINT idempotency_keys_key_form CHECK (idempotency_key ~ '^[\x21\x23-\x5b\x5d-\x7e]{1,255}$'),
  operation_id text NOT NULL,
  request_hash text NOT NULL CONSTRAINT idempotency_keys_request_hash_form CHECK (request_hash ~ '^[0123456789abcdef]{64}$'),
  response_status smallint NOT NULL CONSTRAINT idempotency_keys_response_status_success CHECK (response_status BETWEEN 200 AND 299),
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (company_id, actor_id, idempotency_key)
);

-- A key belongs to the transaction's actor: the trigger writes the actor, its
-- kind and the time, and refuses each when it is given (immutable_field).
CREATE FUNCTION ledger.idempotency_keys_rules() RETURNS trigger
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
  IF NEW.created_at IS NOT NULL THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_at', 'operation', 'create'));
  END IF;
  SELECT a.actor_id, a.actor_kind INTO actor FROM ledger.current_actor() AS a;
  NEW.actor_id := actor.actor_id;
  NEW.actor_kind := actor.actor_kind;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$rules$;

CREATE TRIGGER idempotency_keys_rules BEFORE INSERT ON ledger.idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION ledger.idempotency_keys_rules();
SELECT meta.protect_company_table('ledger.idempotency_keys', 'id');
-- A key is written once, with its answer: the app never changes or deletes one.
GRANT INSERT ON ledger.idempotency_keys TO nortfox_app;
