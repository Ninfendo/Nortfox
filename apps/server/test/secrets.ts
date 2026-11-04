// SPDX-License-Identifier: AGPL-3.0-only

// The two secret scans (docs/api.md; db/README.md). Every sign-in, token,
// TOTP, recovery and verification test ends with both:
//
// - expectNoTokens reads what the server gave or told: answers, problems,
//   tool results and what the reporter received. It fails on any token of
//   NortFox's (nf, a letter, an underscore and 43 characters) that the test
//   did not expect there. A login challenge in the answer of
//   loginWithPassword is expected; a session's token never is, since it comes
//   only in a cookie.
// - expectNoSecretsAtRest reads, as the cluster's superuser, every column of
//   every table in ledger, audit and access, as text. It fails on any token,
//   and on any password, TOTP secret or code that the test used, in clear.

import { expect } from "vitest";
import { base32Encode } from "../src/auth/totp.ts";
import type { TestDatabase } from "./database.ts";

/** A token of any kind, anywhere in a text. */
export const ANY_TOKEN = /nf[a-z]_[A-Za-z0-9_-]{43}/g;

/** A value as the scan reads it: an Error by its message, stack and causes; anything else as JSON, or as text. */
function textOf(value: unknown): string {
  if (value instanceof Error) {
    return [value.message, value.stack ?? "", textOf(value.cause)].join("\n");
  }
  if (typeof value === "string") {
    return value;
  }
  return jsonOf(value) ?? String(value);
}

/** A value as JSON, or undefined for a value that JSON has no form for, such as undefined, which JSON.stringify gives back so. */
function jsonOf(value: unknown): string | undefined {
  return JSON.stringify(value);
}

/** The tokens in a value, in the order they come. */
export function tokensIn(value: unknown): string[] {
  return [...textOf(value).matchAll(ANY_TOKEN)].map((match) => match[0]);
}

/** Fails when any of the values holds a token that is not in `expected`. */
export function expectNoTokens(values: readonly unknown[], expected: readonly string[] = []): void {
  const allowed = new Set(expected);
  const found = values.flatMap(tokensIn).filter((token) => !allowed.has(token));
  expect(found, "A token reached an answer, a tool result or a report.").toEqual([]);
}

/** A body as JSON, or undefined when it is none, such as the empty body of a 204. */
function parsedBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether a body is loginWithPassword's answer of the TOTP step: its outcome and its challenge, and nothing else. */
function isChallengeAnswer(body: string): boolean {
  const parsed = parsedBody(body);
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    Object.keys(parsed).sort().join() === "challenge,outcome" &&
    (parsed as { outcome?: unknown }).outcome === "totp-required" &&
    /^nfc_[A-Za-z0-9_-]{43}$/.test(String((parsed as { challenge?: unknown }).challenge))
  );
}

/**
 * Fails on any token in the answers' bodies but the challenge in the answer
 * of loginWithPassword that gives it, and on any token at all in what the
 * reporter received. So a challenge that comes back in a problem or a report
 * fails too.
 */
export function expectNoTokensButChallenges(bodies: readonly string[], reports: readonly unknown[]): void {
  expectNoTokens(bodies.filter((body) => !isChallengeAnswer(body)));
  expectNoTokens(reports);
}

/** What a test used in clear, which the database must never hold so. */
export interface SecretsInClear {
  readonly passwords?: readonly string[];
  readonly totpSecrets?: readonly Uint8Array[];
  readonly codes?: readonly string[];
}

/** The schemas whose every table the scan reads. */
const SCANNED_SCHEMAS = ["ledger", "audit", "access"];

/**
 * Reads every row of every table in the scanned schemas as the superuser, as
 * JSON text, where a bytea is \x and its hexadecimal digits, and fails on a
 * token or on a secret of the test in clear.
 */
export async function expectNoSecretsAtRest(db: TestDatabase, secrets: SecretsInClear = {}): Promise<void> {
  const admin = await db.admin();
  try {
    const tables = await admin.query<{ schema: string; name: string }>(
      `SELECT n.nspname AS schema, c.relname AS name FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY ($1) ORDER BY 1, 2`,
      [SCANNED_SCHEMAS],
    );
    expect(tables.rows.map((table) => table.schema)).toContain("access");
    const wanted = [
      ...(secrets.passwords ?? []),
      ...(secrets.codes ?? []),
      ...(secrets.totpSecrets ?? []).flatMap((secret) => [Buffer.from(secret).toString("hex"), base32Encode(secret)]),
    ];
    const found: string[] = [];
    for (const { schema, name } of tables.rows) {
      const rows = await admin.query<{ row: string }>(`SELECT pg_catalog.to_jsonb(t)::text AS row FROM ${admin.escapeIdentifier(schema)}.${admin.escapeIdentifier(name)} AS t`);
      for (const { row } of rows.rows) {
        for (const token of row.matchAll(ANY_TOKEN)) {
          found.push(`${schema}.${name} holds a token`, token[0]);
        }
        const folded = row.toLowerCase();
        for (const secret of wanted) {
          if (folded.includes(secret.toLowerCase())) {
            found.push(`${schema}.${name} holds a secret in clear`);
          }
        }
      }
    }
    expect(found, "The database holds a token or a secret in clear.").toEqual([]);
  } finally {
    await admin.end();
  }
}
