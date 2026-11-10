// SPDX-License-Identifier: AGPL-3.0-only

// The parts of the idempotency keys that need no database: the header's
// forms on REST, the key's check, the request's fingerprint and the keys in
// flight, and the answer a write keeps when its first answer holds a
// secret. idempotency.db.test.ts runs the whole flow on PostgreSQL.

import { createHmac } from "node:crypto";
import { IDEMPOTENCY_KEY_MAX_LENGTH } from "@nortfox/contract";
import { describe, expect, it } from "vitest";
import { FINGERPRINT_KEY } from "../../test/api.ts";
import { KeysInFlight, canonicalJson, checkKey, readKeyHeader, requestHash, withoutSecrets } from "./idempotency.ts";

const MISSING = {
  code: "idempotency-key-missing",
  detail: "The field /idempotencyKey is missing. A write takes an idempotency key.",
  pointer: "/idempotencyKey",
  data: { expected: "string" },
};

function invalid(value?: unknown) {
  return {
    ok: false,
    problems: [
      {
        code: "idempotency-key-invalid",
        detail: 'The field /idempotencyKey must be 1 to 255 characters of visible ASCII without " and \\.',
        pointer: "/idempotencyKey",
        data: value === undefined ? { expected: "string" } : { expected: "string", value },
      },
    ],
  };
}

describe("readKeyHeader", () => {
  it("gives no key for no header", () => {
    expect(readKeyHeader(null)).toBeUndefined();
  });

  it.each([
    ["8e03978e-40d5-43e8-bc93-6894a57f9324", "8e03978e-40d5-43e8-bc93-6894a57f9324"],
    ['"8e03978e-40d5-43e8-bc93-6894a57f9324"', "8e03978e-40d5-43e8-bc93-6894a57f9324"],
    ['"abc', '"abc'],
    ['abc"', 'abc"'],
    ['"a\\"b"', 'a\\"b'],
    ['""abc""', '"abc"'],
    ['""', ""],
    ['"', '"'],
    ["", ""],
  ])("reads the header %j as the key %j: the quoted form loses one pair of quotes, and anything else stays", (header, key) => {
    expect(readKeyHeader(header)).toBe(key);
  });
});

describe("checkKey", () => {
  it("refuses no key with idempotency-key-missing at /idempotencyKey", () => {
    expect(checkKey(undefined)).toEqual({ ok: false, problems: [MISSING] });
  });

  it("takes 1 to 255 characters of visible ASCII but the double quote and the backslash", () => {
    const taken: string[] = [];
    for (let code = 0; code <= 0x7f; code += 1) {
      const character = String.fromCodePoint(code);
      const checked = checkKey(`k${character}`);
      if (checked.ok) {
        expect(checked.value).toBe(`k${character}`);
        taken.push(character);
      } else {
        expect(checked).toEqual(invalid(`k${character}`));
      }
    }
    expect(taken.length).toBe(0x7e - 0x21 + 1 - 2);
    expect(taken).not.toContain('"');
    expect(taken).not.toContain("\\");
    expect(taken).not.toContain(" ");
    expect(checkKey("k")).toEqual({ ok: true, value: "k" });
    expect(checkKey("a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH))).toEqual({ ok: true, value: "a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH) });
  });

  it.each(["", "a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1), "two words", "é", "\u{1f600}", 'a"b', "a\\b", "a\tb", "a\nb"])(
    "refuses the key %j with idempotency-key-invalid, and keeps the value for a second surface",
    (key) => {
      expect(checkKey(key)).toEqual(invalid(key));
    },
  );

  it("refuses a key that is not a string, and keeps only a JSON scalar as the value", () => {
    expect(checkKey(5)).toEqual(invalid(5));
    expect(checkKey(true)).toEqual(invalid(true));
    expect(checkKey(null)).toEqual(invalid(null));
    expect(checkKey(Number.NaN)).toEqual(invalid());
    expect(checkKey({ key: "k" })).toEqual(invalid());
    expect(checkKey(["k"])).toEqual(invalid());
  });

  it("refuses the header's broken and escaped quoted forms", () => {
    for (const header of ['"abc', 'abc"', '"a\\"b"', '"a\\\\b"', '""', '"', '"a b"', "a, b"]) {
      expect(checkKey(readKeyHeader(header)).ok, header).toBe(false);
    }
    expect(checkKey(readKeyHeader('"abc"'))).toEqual({ ok: true, value: "abc" });
  });
});

describe("canonicalJson", () => {
  it("writes JSON with the keys of every object sorted, and arrays in their order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: true, x: null }], c: "é\n" } })).toBe('{"a":{"c":"é\\n","d":[3,{"x":null,"y":true}]},"b":1}');
  });

  it("leaves out a property whose value is undefined, as JSON does", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it.each([[1n], [Number.NaN], [Number.POSITIVE_INFINITY], [undefined], [() => 1], [[undefined]], [{ a: Symbol("s") }]])(
    "refuses %s, which JSON cannot hold",
    (value) => {
      expect(() => canonicalJson(value)).toThrow("JSON cannot hold");
    },
  );
});

/** The fingerprint as the server makes it: HMAC-SHA256 under the install's fingerprint key. */
function hmacOf(text: string): string {
  return createHmac("sha256", FINGERPRINT_KEY).update(text).digest("hex");
}

describe("requestHash", () => {
  it("is the HMAC-SHA256 of the canonical JSON of the operation, the query and the body, under the fingerprint key", () => {
    const text = '{"body":{"amount":{"amount":"1.50","currency":"SEK"}},"operation":"testBookVoucher","query":{}}';
    const expected = hmacOf(text);
    expect(requestHash(FINGERPRINT_KEY, "testBookVoucher", {}, { amount: { currency: "SEK", amount: "1.50" } })).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is the same for the same input in another key order, and differs for another operation, query or body", () => {
    const hash = requestHash(FINGERPRINT_KEY, "testBookVoucher", { a: 1 }, { description: "x", amount: "1.50" });
    expect(requestHash(FINGERPRINT_KEY, "testBookVoucher", { a: 1 }, { amount: "1.50", description: "x" })).toBe(hash);
    expect(requestHash(FINGERPRINT_KEY, "testOther", { a: 1 }, { description: "x", amount: "1.50" })).not.toBe(hash);
    expect(requestHash(FINGERPRINT_KEY, "testBookVoucher", { a: 2 }, { description: "x", amount: "1.50" })).not.toBe(hash);
    expect(requestHash(FINGERPRINT_KEY, "testBookVoucher", { a: 1 }, { description: "x", amount: "1.5" })).not.toBe(hash);
    expect(requestHash(FINGERPRINT_KEY, "testBookVoucher", {}, undefined)).toBe(hmacOf('{"operation":"testBookVoucher","query":{}}'));
  });

  it("holds the path parameters of an operation that takes them, so the same key on two paths is two requests", () => {
    const text = '{"operation":"testRemoveThing","params":{"thingId":"a"},"query":{}}';
    expect(requestHash(FINGERPRINT_KEY, "testRemoveThing", {}, undefined, { thingId: "a" })).toBe(hmacOf(text));
    expect(requestHash(FINGERPRINT_KEY, "testRemoveThing", {}, undefined, { thingId: "b" })).not.toBe(requestHash(FINGERPRINT_KEY, "testRemoveThing", {}, undefined, { thingId: "a" }));
  });
});

describe("KeysInFlight", () => {
  const COMPANY = "5d1e7c3a-9b2f-4e8d-a6c4-1f0e2d3c4b5a";
  const ACTOR = "1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b";

  it("holds a key for its company and actor until it is let go", () => {
    const keys = new KeysInFlight();
    const release = keys.claim(COMPANY, ACTOR, "k-1");
    expect(release).toBeTypeOf("function");
    expect(keys.claim(COMPANY, ACTOR, "k-1")).toBeUndefined();
    release?.();
    const again = keys.claim(COMPANY, ACTOR, "k-1");
    expect(again).toBeTypeOf("function");
    // A second release of the first claim lets nothing go: the key is the second claim's now.
    release?.();
    expect(keys.claim(COMPANY, ACTOR, "k-1")).toBeUndefined();
    again?.();
    expect(keys.claim(COMPANY, ACTOR, "k-1")).toBeTypeOf("function");
  });

  it("holds the key apart for another company, another actor and another key", () => {
    const keys = new KeysInFlight();
    expect(keys.claim(COMPANY, ACTOR, "k-1")).toBeTypeOf("function");
    expect(keys.claim("8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d", ACTOR, "k-1")).toBeTypeOf("function");
    expect(keys.claim(COMPANY, "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d", "k-1")).toBeTypeOf("function");
    expect(keys.claim(COMPANY, ACTOR, "k-2")).toBeTypeOf("function");
  });

  it("cannot be fooled by names that run together", () => {
    const keys = new KeysInFlight();
    expect(keys.claim("a", "b,c", "d")).toBeTypeOf("function");
    expect(keys.claim("a,b", "c", "d")).toBeTypeOf("function");
  });
});

describe("withoutSecrets", () => {
  const TOKEN = `nft_${"A".repeat(43)}`;

  it("leaves an answer as it is when its operation names no secret field", () => {
    const answer = { id: "a", name: "Kassa" };
    expect(withoutSecrets(answer, [])).toEqual(answer);
  });

  it("takes out each secret field, at any depth, and keeps the rest", () => {
    const answer = { id: "a", token: TOKEN, enrolment: { otpauthUri: "otpauth://totp/x", label: "x" } };
    expect(withoutSecrets(answer, ["/token", "/enrolment/otpauthUri"])).toEqual({ id: "a", enrolment: { label: "x" } });
  });

  it("follows * through each item of a list and each value of a record, and takes out a secret item itself", () => {
    const answer = { codes: [{ code: "1", label: "a" }, { code: "2", label: "b" }], byName: { a: { code: "3" } }, plain: ["x", "y"] };
    expect(withoutSecrets(answer, ["/codes/*/code", "/byName/*/code", "/plain/*"])).toEqual({ codes: [{ label: "a" }, { label: "b" }], byName: { a: {} }, plain: [] });
  });

  it("reads a pointer's escapes, ~1 as / and ~0 as ~", () => {
    expect(withoutSecrets({ "a/b": "1", "c~d": "2", e: "3" }, ["/a~1b", "/c~0d"])).toEqual({ e: "3" });
  });

  it("passes over a field that the answer leaves out, is null for, or holds no object in, and an index of a list, which the registry never names", () => {
    const answer = { enrolment: null, list: "text", count: 2, codes: [{ code: "1" }] };
    expect(withoutSecrets(answer, ["/token", "/enrolment/otpauthUri", "/list/*/code", "/count/x", "/codes/0/code"])).toEqual(answer);
  });

  it("keeps nothing of an answer that is a secret as a whole", () => {
    expect(withoutSecrets({ token: TOKEN }, [""])).toEqual({});
  });

  it("changes no part of the answer it is given, which the first call still answers", () => {
    const answer = { token: TOKEN, nested: { code: "1" }, list: [{ code: "2" }] };
    const copy = structuredClone(answer);
    withoutSecrets(answer, ["/token", "/nested/code", "/list/*/code"]);
    expect(answer).toEqual(copy);
  });
});
