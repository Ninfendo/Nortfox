// SPDX-License-Identifier: AGPL-3.0-only

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readCursor, signCursor, type CursorScope } from "./cursor.ts";

const KEY = new Uint8Array(32).fill(1);
const SCOPE: CursorScope = { operationId: "testListAccounts", companyId: "3f1c2a8e-5b7d-4c9e-8a1f-0d2b4c6e8f10" };

function base64url(text: string): string {
  return Buffer.from(text).toString("base64url");
}

/** A cursor as the format says: the payload, a point, and the HMAC-SHA256 of the operation, the company and the payload. */
function cursorOf(payload: string, scope: CursorScope = SCOPE, key: Uint8Array = KEY): string {
  const encoded = base64url(payload);
  const signature = createHmac("sha256", key).update(JSON.stringify([scope.operationId, scope.companyId, encoded])).digest("base64url");
  return `${encoded}.${signature}`;
}

describe("signCursor and readCursor", () => {
  it("give back the sort key the cursor was made with", () => {
    const cursor = signCursor(KEY, SCOPE, ["0b8e5a2c-1d3f-4e6a-9b7c-5d4e3f2a1b0c", "x"]);
    expect(readCursor(KEY, SCOPE, cursor)).toEqual(["0b8e5a2c-1d3f-4e6a-9b7c-5d4e3f2a1b0c", "x"]);
  });

  it("write the payload and its signature as base64url, in the documented format", () => {
    const cursor = signCursor(KEY, SCOPE, ["a"]);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(cursor).toBe(cursorOf('{"v":1,"after":["a"]}'));
  });

  it("reads a cursor made with the same key, operation and company", () => {
    expect(readCursor(KEY, SCOPE, cursorOf('{"v":1,"after":["b","c"]}'))).toEqual(["b", "c"]);
  });

  it("refuses a cursor whose payload changed", () => {
    const [, signature] = signCursor(KEY, SCOPE, ["a"]).split(".");
    expect(readCursor(KEY, SCOPE, `${base64url('{"v":1,"after":["b"]}')}.${String(signature)}`)).toBeUndefined();
  });

  it("refuses a cursor whose signature changed", () => {
    const cursor = signCursor(KEY, SCOPE, ["a"]);
    const last = cursor.at(-1) === "A" ? "B" : "A";
    expect(readCursor(KEY, SCOPE, `${cursor.slice(0, -1)}${last}`)).toBeUndefined();
  });

  it("refuses a cursor of another operation, another company or another key", () => {
    const cursor = signCursor(KEY, SCOPE, ["a"]);
    expect(readCursor(KEY, { ...SCOPE, operationId: "listVouchers" }, cursor)).toBeUndefined();
    expect(readCursor(KEY, { ...SCOPE, companyId: "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d" }, cursor)).toBeUndefined();
    expect(readCursor(new Uint8Array(32).fill(2), SCOPE, cursor)).toBeUndefined();
  });

  it("refuses a signed payload of another version", () => {
    expect(readCursor(KEY, SCOPE, cursorOf('{"v":2,"after":["a"]}'))).toBeUndefined();
    expect(readCursor(KEY, SCOPE, cursorOf('{"after":["a"]}'))).toBeUndefined();
  });

  it.each(["not json", "null", "[]", '"a"', '{"v":1}', '{"v":1,"after":"a"}', '{"v":1,"after":[1]}', '{"v":1,"after":[null]}'])(
    "refuses a signed payload that is not a sort key: %s",
    (payload) => {
      expect(readCursor(KEY, SCOPE, cursorOf(payload))).toBeUndefined();
    },
  );

  it.each(["", ".", "a", "a.", ".a", "a.b.c", "!!!.???", "YQ.YQ", `${base64url("{}")}.${"A".repeat(43)}=`, "eyJ2IjoxfQ==.x"])(
    "refuses garbage: %j",
    (cursor) => {
      expect(readCursor(KEY, SCOPE, cursor)).toBeUndefined();
    },
  );

  it("refuses a signature of another length", () => {
    const [payload] = signCursor(KEY, SCOPE, ["a"]).split(".");
    expect(readCursor(KEY, SCOPE, `${String(payload)}.${Buffer.alloc(31).toString("base64url")}`)).toBeUndefined();
  });
});
