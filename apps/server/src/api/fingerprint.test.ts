// SPDX-License-Identifier: AGPL-3.0-only

// The fingerprint that a write's idempotency key is stored with: an
// HMAC-SHA256 of the request's canonical JSON, under a key that HKDF derives
// from the install secret (idempotency-fingerprint v1). A request body can
// hold a password, and a plain SHA-256 of a mostly known JSON lets anyone
// with a copy of the database test guesses at SHA-256's speed. Without the
// install secret, a stored fingerprint tells nothing.

import { createHash, createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FINGERPRINT_KEY, TEST_INSTALL_KEY, principalOf, runnerDeps } from "../../test/api.ts";
import { fakeDatabase, testEndSession, testRemoveThing } from "../../test/shapes.ts";
import { InstallKey } from "../auth/install-key.ts";
import type { RequestContext } from "./context.ts";
import { canonicalJson, requestHash } from "./idempotency.ts";
import { handleData, handlePerson, ok, runOperation } from "./operation.ts";

const COMPANY = randomUUID();
const CONTEXT: RequestContext = { ...(await principalOf(COMPANY, { kind: "user" })), channel: "rest" };

/** The request_hash that a write's key was stored with, as the fake database saw the insert. */
function storedHash(queries: readonly { readonly text: string; readonly values: readonly unknown[] }[]): unknown {
  const insert = queries.find((query) => /^INSERT INTO \w+\.idempotency_keys\b/.test(query.text));
  return insert?.values.find((value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
}

describe("the fingerprint of a request", () => {
  it("is the fingerprint key of the install key", () => {
    expect(FINGERPRINT_KEY).toEqual(TEST_INSTALL_KEY.key("idempotency-fingerprint v1"));
  });

  it("is the HMAC-SHA256 of the canonical JSON under the install's fingerprint key, not its plain SHA-256", () => {
    const body = { description: "Kontorsmaterial", amount: { currency: "SEK", amount: "125.00" } };
    const text = canonicalJson({ operation: "testBookVoucher", query: {}, body });
    const hash = requestHash(FINGERPRINT_KEY, "testBookVoucher", {}, body);
    expect(hash).toBe(createHmac("sha256", FINGERPRINT_KEY).update(text).digest("hex"));
    expect(hash).not.toBe(createHash("sha256").update(text).digest("hex"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs under another install's key, for the same request", () => {
    const other = new InstallKey(9, Buffer.alloc(32, 0x42)).key("idempotency-fingerprint v1");
    expect(requestHash(other, "testEndSession", {}, undefined)).not.toBe(requestHash(FINGERPRINT_KEY, "testEndSession", {}, undefined));
  });

  it("is what a write in a company stores with its key in ledger.idempotency_keys", async () => {
    const database = fakeDatabase();
    const handler = handleData(testRemoveThing, () => Promise.resolve(ok({})));
    const params = { thingId: randomUUID() };
    const outcome = await runOperation(handler, { context: CONTEXT, input: { params, query: {}, body: undefined }, idempotency: { key: "k-1" } }, runnerDeps(database));
    expect(outcome.ok).toBe(true);
    const text = canonicalJson({ operation: "testRemoveThing", params, query: {} });
    expect(database.queries.some((query) => query.text.startsWith("INSERT INTO ledger.idempotency_keys"))).toBe(true);
    expect(storedHash(database.queries)).toBe(createHmac("sha256", FINGERPRINT_KEY).update(text).digest("hex"));
    expect(storedHash(database.queries)).not.toBe(createHash("sha256").update(text).digest("hex"));
  });

  it("is what a person's own write stores with its key in access.idempotency_keys", async () => {
    const database = fakeDatabase();
    const handler = handlePerson(testEndSession, () => Promise.resolve(ok({})));
    const outcome = await runOperation(handler, { context: CONTEXT, input: { query: {}, body: undefined }, idempotency: { key: "k-1" } }, runnerDeps(database));
    expect(outcome.ok).toBe(true);
    const text = canonicalJson({ operation: "testEndSession", query: {} });
    expect(database.queries.some((query) => query.text.startsWith("INSERT INTO access.idempotency_keys"))).toBe(true);
    expect(storedHash(database.queries)).toBe(createHmac("sha256", FINGERPRINT_KEY).update(text).digest("hex"));
    expect(storedHash(database.queries)).not.toBe(createHash("sha256").update(text).digest("hex"));
  });
});
