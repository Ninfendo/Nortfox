// SPDX-License-Identifier: AGPL-3.0-only

// Idempotency keys, as /v1 and MCP take them for every write (the IETF draft
// for the Idempotency-Key header). The key is a rule of those two surfaces,
// not of the operation: the runner gets the key policy from the surface, and
// the compatible surface (slice 2e) passes "none".
//
// - On REST the key is the Idempotency-Key header. The draft writes it as a
//   Structured Field string, "key"; a bare key is taken too. On MCP it is the
//   tool argument idempotencyKey.
// - A key is 1 to 255 characters of visible ASCII without " and \. No key is
//   idempotency-key-missing, and any other value idempotency-key-invalid,
//   both at /idempotencyKey, in the one 400 with the input's own problems.
// - The request's fingerprint is the HMAC-SHA256 of the canonical JSON of
//   the operation's id, its path parameters when it takes any, the query and
//   the body as the operation's schemas parsed them, under a key that the
//   install secret derives for it (idempotency-fingerprint v1). So the same
//   input by REST and by MCP is the same request, the same key on two paths
//   is two, and "1.5" and "1.50" are two. A body can hold a password, and a
//   plain SHA-256 of a mostly known JSON would let anyone with a copy of the
//   database test guesses at SHA-256's speed; without the install secret, a
//   stored fingerprint tells nothing.
// - Keys are kept per company and actor, and a signed-in person's own write,
//   which works in no company, keeps its keys per person, as createCompany
//   does, whose company is new on each try. Such a write through a token
//   holds the token in its fingerprint: a key that the person's session or
//   another of the person's tokens used is another request for it (422), so
//   a token never replays an answer that another credential stored, such as
//   a company that the token did not make. While a request runs, its key is
//   in flight in this process, and a second request with it gets 409 before
//   it asks the pool for a connection. NortFox runs one server process
//   (decision 3); across processes the database's unique key decides.
// - The key and the first answer are stored in the write's own transaction,
//   after the output passed its check: a write in a company in
//   ledger.idempotency_keys, a person's own write in access.idempotency_keys,
//   which belongs to no company. A write in a company whose answer holds a
//   person's contact data (personalOutput) keeps its key in
//   access.idempotency_keys too, with the company, so that data never reaches
//   a company table and its behandlingshistorik. So does a write whose input
//   names its company and whose answer has no body, leaveCompany: its own
//   success makes the person no member there, so its repeat reads the key
//   before any company is set (operation.ts). A write in a company looks its
//   key up in both of the company's tables, its own first, so a key that
//   one write of the company used is another request for any other write
//   there, whichever table keeps it. The two tables have no unique key in
//   common: the key in flight, whose scope is the company for both, keeps
//   two such writes of one process apart. A refused or failed write stores
//   nothing, so a retry with the key runs again.
// - A write whose answer holds a secret, such as a token shown once
//   (secretOutput), keeps its key with the answer less each secret field
//   (withoutSecrets), so no table and no behandlingshistorik holds the
//   secret. A repeat of the same request gets 409 answer-shown-once with
//   that answer, such as the id of what the first call made (operation.ts).
// - A write that runs before sign-in takes no key: there is no actor to keep
//   it for.

import { createHmac } from "node:crypto";
import { IDEMPOTENCY_KEY_ARGUMENT, IDEMPOTENCY_KEY_MAX_LENGTH, IDEMPOTENCY_KEY_PATTERN, jsonPointer, type FieldIssue, type JsonValue } from "@nortfox/contract";
import type { Queryable, Via } from "../db/database.ts";

/** A key after its check: the key, or its one problem. */
export type KeyCheck = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly problems: readonly FieldIssue[] };

const POINTER = jsonPointer([IDEMPOTENCY_KEY_ARGUMENT]);
const ALPHABET = new RegExp(IDEMPOTENCY_KEY_PATTERN);

/**
 * The key in an Idempotency-Key header: the draft's quoted form loses its one
 * pair of quotes, and anything else is passed on as it is, for checkKey to
 * refuse. A broken or escaped quoted form keeps a quote or a backslash, so it
 * is refused.
 */
export function readKeyHeader(header: string | null): string | undefined {
  if (header === null) {
    return undefined;
  }
  return header.length >= 2 && header.startsWith('"') && header.endsWith('"') ? header.slice(1, -1) : header;
}

/** A value as a field issue keeps it: a JSON scalar, or nothing. */
function scalar(value: unknown): { value?: JsonValue } {
  const kept = value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
  return kept ? { value } : {};
}

/** The key a surface read, after its check. The texts name no surface, so REST and MCP give the same problem. */
export function checkKey(key: unknown): KeyCheck {
  if (key === undefined) {
    return {
      ok: false,
      problems: [
        {
          code: "idempotency-key-missing",
          detail: `The field ${POINTER} is missing. A write takes an idempotency key.`,
          pointer: POINTER,
          data: { expected: "string" },
        },
      ],
    };
  }
  if (typeof key === "string" && key.length <= IDEMPOTENCY_KEY_MAX_LENGTH && ALPHABET.test(key)) {
    return { ok: true, value: key };
  }
  return {
    ok: false,
    problems: [
      {
        code: "idempotency-key-invalid",
        detail: `The field ${POINTER} must be 1 to ${String(IDEMPOTENCY_KEY_MAX_LENGTH)} characters of visible ASCII without " and \\.`,
        pointer: POINTER,
        data: { expected: "string", ...scalar(key) },
      },
    ],
  };
}

/**
 * JSON with the keys of every object sorted, so the same value always gives
 * the same text. A property whose value is undefined is left out, as JSON
 * leaves it out. A value JSON cannot hold throws.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error(`JSON cannot hold this ${typeof value}, so it has no canonical form.`);
}

/**
 * The request's fingerprint: the HMAC-SHA256 under `key`, the install's
 * fingerprint key, of the canonical JSON of the operation, its path
 * parameters when it takes any, the query and the body, and the token or
 * client a person's own write came through when it names one (`via`), as 64
 * lower-case hexadecimal digits.
 */
export function requestHash(key: Uint8Array, operationId: string, query: unknown, body: unknown, params?: unknown, via?: Via): string {
  return createHmac("sha256", key).update(canonicalJson({ operation: operationId, params, query, body, via })).digest("hex");
}

/** The segments of a JSON Pointer (RFC 6901), unescaped: "" is the whole value, "/a~1b/*" is "a/b" and "*". */
function segmentsOf(pointer: string): string[] {
  return pointer === "" ? [] : pointer.slice(1).split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/**
 * A copy of `value` without the field that the segments name, or undefined
 * when they name the value itself. "*" stands for each item of a list and
 * each value of an object, as the registry's pointers write it. A field that
 * the value does not have, or a value that holds no field, is passed over.
 */
function without(value: unknown, segments: readonly string[]): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) {
    return undefined;
  }
  const keep = (item: unknown): unknown[] => {
    const kept = without(item, rest);
    return kept === undefined ? [] : [kept];
  };
  if (Array.isArray(value)) {
    return head === "*" ? value.flatMap(keep) : value;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).flatMap(([name, item]) => (head === "*" || head === name ? keep(item).map((kept) => [name, kept]) : [[name, item]])));
}

/**
 * The answer a write keeps with its key: its first answer less each secret
 * field that `pointers`, the operation's secretOutput, names. The answer
 * itself is not changed: the first call still gives it whole. An answer
 * that is a secret as a whole keeps nothing, an empty object.
 */
export function withoutSecrets(answer: unknown, pointers: readonly string[]): unknown {
  return pointers.reduce<unknown>((kept, pointer) => without(kept, segmentsOf(pointer)) ?? {}, answer);
}

/**
 * The keys of the writes that run now in this process, each for its scope
 * and actor. The scope is the company, or "" for a person's own write. A
 * request claims its key before it asks the pool for a connection, and lets
 * it go when it ends.
 */
export class KeysInFlight {
  readonly #held = new Set<string>();

  /** Holds the key, and gives the function that lets it go; undefined when a running request holds it. */
  claim(scope: string, actorId: string, key: string): (() => void) | undefined {
    const slot = JSON.stringify([scope, actorId, key]);
    if (this.#held.has(slot)) {
      return undefined;
    }
    this.#held.add(slot);
    let held = true;
    return () => {
      if (held) {
        held = false;
        this.#held.delete(slot);
      }
    };
  }
}

/** A stored key's request and first answer. */
export interface StoredAnswer {
  readonly hash: string;
  readonly status: number;
  readonly body: unknown;
}

/** What a write stores with its key. */
export interface NewKey {
  readonly key: string;
  readonly operationId: string;
  readonly hash: string;
  readonly status: number;
  readonly body: unknown;
}

/** Where a write keeps its keys. */
export interface KeyStore {
  /** The scope its keys are claimed in while they are in flight: the company, or "" for a person's own write. */
  readonly scope: string;
  /** The key as the actor stored it, or undefined. */
  find(tx: Queryable, actorId: string, key: string): Promise<StoredAnswer | undefined>;
  /**
   * Stores the key with the write's answer, in the write's transaction. The
   * database writes the actor, its kind and the time. It gives false when
   * another transaction stored the same key first, and stores nothing then.
   */
  store(tx: Queryable, stored: NewKey): Promise<boolean>;
}

interface KeyRow {
  readonly request_hash: string;
  readonly response_status: number;
  readonly response_body: unknown;
}

function answerOf(rows: readonly KeyRow[]): StoredAnswer | undefined {
  const [row] = rows;
  return row === undefined ? undefined : { hash: row.request_hash, status: row.response_status, body: row.response_body };
}

/**
 * The keys of the writes in a company, in ledger.idempotency_keys. A lookup
 * has no company condition: row level security keeps it to the transaction's
 * company (decision 9).
 */
export function companyKeys(companyId: string): KeyStore {
  return {
    scope: companyId,
    find: async (tx, actorId, key) =>
      answerOf(
        (
          await tx.query<KeyRow>(
            "SELECT request_hash, response_status, response_body FROM ledger.idempotency_keys WHERE actor_id = $1 AND idempotency_key = $2",
            [actorId, key],
          )
        ).rows,
      ),
    store: async (tx, stored) => {
      const found = await tx.query(
        `INSERT INTO ledger.idempotency_keys (company_id, idempotency_key, operation_id, request_hash, response_status, response_body)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (company_id, actor_id, idempotency_key) DO NOTHING RETURNING id`,
        [companyId, stored.key, stored.operationId, stored.hash, stored.status, JSON.stringify(stored.body)],
      );
      return found.rows.length > 0;
    },
  };
}

/**
 * The keys of a signed-in person's own writes, which work in no company, in
 * access.idempotency_keys with no key_company_id. That table belongs to no
 * company: row level security keeps it to the transaction's person.
 */
export const personKeys: KeyStore = {
  scope: "",
  find: async (tx, actorId, key) =>
    answerOf(
      (
        await tx.query<KeyRow>(
          "SELECT request_hash, response_status, response_body FROM access.idempotency_keys WHERE actor_id = $1 AND key_company_id IS NULL AND idempotency_key = $2",
          [actorId, key],
        )
      ).rows,
    ),
  store: async (tx, stored) => {
    const found = await tx.query(
      `INSERT INTO access.idempotency_keys (idempotency_key, operation_id, request_hash, response_status, response_body)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (actor_id, key_company_id, idempotency_key) DO NOTHING RETURNING id`,
      [stored.key, stored.operationId, stored.hash, stored.status, JSON.stringify(stored.body)],
    );
    return found.rows.length > 0;
  },
};

/**
 * The keys of a signed-in person's writes in a company whose answer holds a
 * person's contact data (the operation's personalOutput), in
 * access.idempotency_keys with the company as key_company_id: the table
 * belongs to no company, so the answer never reaches a company's
 * behandlingshistorik. The trigger files the key under the transaction's
 * company, which is `companyId`.
 */
export function personCompanyKeys(companyId: string): KeyStore {
  return {
    scope: companyId,
    find: async (tx, actorId, key) =>
      answerOf(
        (
          await tx.query<KeyRow>(
            "SELECT request_hash, response_status, response_body FROM access.idempotency_keys WHERE actor_id = $1 AND key_company_id = $2 AND idempotency_key = $3",
            [actorId, companyId, key],
          )
        ).rows,
      ),
    store: (tx, stored) => personKeys.store(tx, stored),
  };
}
