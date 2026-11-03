// SPDX-License-Identifier: AGPL-3.0-only

// A list's cursor is opaque to the caller. It holds the sort key of the last
// item of a page, and the server signs it, so a cursor that the server did
// not make for this list, in this company, is refused (400 cursor-invalid).
//
// The form: base64url of the payload {"v":1,"after":[...]}, a point, and
// base64url of HMAC-SHA256 over the operation's id, the company's id and the
// payload's base64url text. The key is made when the server starts, so a
// cursor lasts as long as the process: after a restart, a client starts its
// list again.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Which list a cursor belongs to: one operation in one company. */
export interface CursorScope {
  readonly operationId: string;
  readonly companyId: string;
}

const VERSION = 1;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SIGNATURE_BYTES = 32;

function signature(key: Uint8Array, scope: CursorScope, payload: string): Buffer {
  return createHmac("sha256", key).update(JSON.stringify([scope.operationId, scope.companyId, payload])).digest();
}

/** The cursor of the page after the item whose sort key is `after`. */
export function signCursor(key: Uint8Array, scope: CursorScope, after: readonly string[]): string {
  const payload = Buffer.from(JSON.stringify({ v: VERSION, after })).toString("base64url");
  return `${payload}.${signature(key, scope, payload).toString("base64url")}`;
}

function isSortKey(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((part) => typeof part === "string");
}

/** The payload's sort key, or undefined when the payload is not one of this version. */
function sortKeyIn(payload: string): readonly string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const { v, after } = parsed as { readonly v?: unknown; readonly after?: unknown };
  return v === VERSION && isSortKey(after) ? after : undefined;
}

/** The sort key in a cursor that this server made for this list, or undefined for any other text. */
export function readCursor(key: Uint8Array, scope: CursorScope, cursor: string): readonly string[] | undefined {
  const point = cursor.indexOf(".");
  const payload = cursor.slice(0, point);
  const signed = cursor.slice(point + 1);
  if (point < 0 || !BASE64URL.test(payload) || !BASE64URL.test(signed)) {
    return undefined;
  }
  const given = Buffer.from(signed, "base64url");
  if (given.length !== SIGNATURE_BYTES || !timingSafeEqual(given, signature(key, scope, payload))) {
    return undefined;
  }
  return sortKeyIn(payload);
}
