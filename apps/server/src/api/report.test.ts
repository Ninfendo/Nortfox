// SPDX-License-Identifier: AGPL-3.0-only

// What the server logs of an error that it did not expect. The default
// reporter logs only the error's class, its code (a database error's
// SQLSTATE), the constraint, schema, table and column it names, its message
// and its stack. It never logs a database error's detail, where, hint or
// internal query, nor the parameters of a statement: they can hold a row
// with a person's data, or a secret. It also takes every token
// (nf?_...), every personnummer form (8 or 6 digits and 4, with or without a
// hyphen or a plus) and every e-mail address out of the message and the stack.

import { DatabaseError } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_INSTALL_KEY, CURSOR_KEY, TEST_VERSION, principalOf, testResolver, untouchedDatabase } from "../../test/api.ts";
import { createApp } from "../app.ts";
import { newToken } from "../auth/tokens.ts";
import { errorReport, reportSafely, scrub } from "./report.ts";

const TOKEN = newToken("session");

/** A database error as the driver gives it, with every field PostgreSQL can send. */
function databaseError(): DatabaseError {
  const error = new DatabaseError('duplicate key value violates unique constraint "identities_personal_identity_number_key"', 200, "error");
  Object.assign(error, {
    severity: "ERROR",
    code: "23505",
    detail: "Key (personal_identity_number)=(19900101-2385) already exists.",
    hint: "The hint holds anna.lind@example.com.",
    where: `PL/pgSQL function access.complete_setup(bytea) line 12 at SQL statement, with ${TOKEN}`,
    internalQuery: "INSERT INTO access.identities VALUES ('19900101-2385')",
    schema: "access",
    table: "identities",
    column: "personal_identity_number",
    constraint: "identities_personal_identity_number_key",
    routine: "_bt_check_unique",
  });
  return error;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scrubbing a text", () => {
  it.each([
    ["a session token", `The cookie held ${TOKEN}.`, "The cookie held [token]."],
    ["a token of any kind", `Bearer nft_${"A".repeat(43)} and nfo_${"b".repeat(43)}`, "Bearer [token] and [token]"],
    ["a cut token", "nfs_abc", "[token]"],
    ["a personnummer of 12 digits with a hyphen", "pnr 19900101-2385 here", "pnr [personnummer] here"],
    ["a personnummer of 12 digits", "pnr 199001012385 here", "pnr [personnummer] here"],
    ["a personnummer of 10 digits with a hyphen", "pnr 900101-2385 here", "pnr [personnummer] here"],
    ["a personnummer of 10 digits", "pnr=9001012385;", "pnr=[personnummer];"],
    ["a personnummer of 10 digits with a plus", "(900101+2380)", "([personnummer])"],
    ["an e-mail address", "to anna.lind@example.com, cc: bo+kopia@sub.example.org.", "to [e-mail], cc: [e-mail]."],
    ["an address with å in its local part", "failed for åsa@example.com", "failed for [e-mail]"],
    ["an address with letters beyond ASCII in its domain", "failed for anna@räkning.example.org and Åsa.Nilsson@ekonomi.exämpel.example.com now", "failed for [e-mail] and [e-mail] now"],
    ["an address in Greek letters, and one written decomposed", "for \u0390rene@example.com and A\u030asa@example.com.", "for [e-mail] and [e-mail]."],
    ["an address with every symbol that a local part may hold", "for a!b#c$d%e&f'g*h+i/j=k?l^m_n`o{p|q}r~s-t@example.org", "for [e-mail]"],
  ])("takes out %s", (_case, text, scrubbed) => {
    expect(scrub(text)).toBe(scrubbed);
  });

  it("leaves what is not one alone: a longer run of digits, a date, a uuid's parts, and a package path with @", () => {
    const text =
      "at 1730000000000 on 2026-11-04 in 2c0e8400-e29b-41d4-a716-44665544000a " +
      "(file:///repo/node_modules/.pnpm/@hono+node-server@2.1.5/node_modules/@hono/node-server/dist/index.mjs:12:34)";
    expect(scrub(text)).toBe(text);
  });
});

describe("the report of an error", () => {
  it("names a database error's class, code, constraint, schema, table and column, and nothing of its detail, where, hint or internal query", () => {
    const report = errorReport(databaseError());
    expect(report.split("\n").slice(0, 2)).toEqual([
      'DatabaseError: duplicate key value violates unique constraint "identities_personal_identity_number_key"',
      "  code 23505, constraint identities_personal_identity_number_key, schema access, table identities, column personal_identity_number",
    ]);
    for (const left of ["19900101-2385", "already exists", "anna.lind", "PL/pgSQL", TOKEN, "INSERT INTO", "_bt_check_unique", "ERROR"]) {
      expect(report).not.toContain(left);
    }
  });

  it("keeps the stack's frames, scrubbed, and not the message a second time", () => {
    const error = new Error(`The handler failed for ${TOKEN}.`);
    error.stack = `Error: The handler failed for ${TOKEN}.\n    at handle (file:///app/dist/handler.js:10:5)\n    at run (file:///app/dist/run.js:3:1 for 19900101-2385)`;
    expect(errorReport(error)).toBe(
      "Error: The handler failed for [token].\n    at handle (file:///app/dist/handler.js:10:5)\n    at run (file:///app/dist/run.js:3:1 for [personnummer])",
    );
  });

  it("takes a token and a personnummer out of the message", () => {
    const report = errorReport(new TypeError(`Cannot read the session ${TOKEN} of 19900101-2385`));
    expect(report.split("\n")[0]).toBe("TypeError: Cannot read the session [token] of [personnummer]");
    expect(report).not.toContain(TOKEN);
    expect(report).not.toContain("19900101-2385");
  });

  it("reports an error's cause the same way, and stops after five", () => {
    const inner = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const outer = new Error("The pool failed.", { cause: inner });
    const report = errorReport(outer);
    expect(report).toContain("\nCaused by: Error: connect ECONNREFUSED\n  code ECONNREFUSED");
    let deep: unknown = new Error("the bottom");
    for (let level = 0; level < 8; level += 1) {
      deep = new Error(`level ${String(level)}`, { cause: deep });
    }
    expect(errorReport(deep).match(/Caused by:/g)).toHaveLength(5);
    expect(errorReport(new Error("x", { cause: "a reason as text" }))).toContain("Caused by: a thrown string, which is not an Error");
  });

  it("names a code only in the forms that codes take, and leaves out a field that is not text", () => {
    const error = Object.assign(new Error("odd"), { code: "has spaces and 19900101-2385", table: 5, column: "" });
    expect(errorReport(error).split("\n")[1]).not.toContain("code");
    expect(errorReport(error)).not.toContain("19900101-2385");
    expect(errorReport(error).split("\n")[1]?.startsWith("    at ") ?? true).toBe(true);
  });

  it("reports a thrown value that is not an Error by its type only", () => {
    expect(errorReport(`the password was ${TOKEN}`)).toBe("a thrown string, which is not an Error");
    expect(errorReport(null)).toBe("a thrown null, which is not an Error");
    expect(errorReport({ detail: "Key (personal_identity_number)=(19900101-2385) already exists." })).toBe("a thrown object, which is not an Error");
    expect(errorReport(undefined)).toBe("a thrown undefined, which is not an Error");
  });

  it("reports an error with no stack by its class and message", () => {
    const error = new RangeError("out of range");
    delete error.stack;
    expect(errorReport(error)).toBe("RangeError: out of range");
  });
});

describe("the default reporter", () => {
  it("writes the safe report as one console.error call", () => {
    const written = vi.spyOn(console, "error").mockImplementation(() => undefined);
    reportSafely(databaseError());
    expect(written).toHaveBeenCalledTimes(1);
    const line: unknown = written.mock.calls[0]?.[0];
    expect(typeof line).toBe("string");
    expect(String(line).startsWith('The server failed: DatabaseError: duplicate key value violates unique constraint "identities_personal_identity_number_key"')).toBe(
      true,
    );
    expect(String(line)).not.toContain("19900101-2385");
  });

  it("is what createApp reports a failed request with, when the caller gives no reporter", async () => {
    const written = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const database = { ...untouchedDatabase(), read: () => Promise.reject(databaseError()) };
    const { hono } = createApp({
      version: TEST_VERSION,
      resolve: testResolver({ t: await principalOf("0d1c2b3a-4958-4a6b-8c7d-9e0f1a2b3c4d", { kind: "user", permissions: ["company:read"] }) }),
      database,
      cursorKey: CURSOR_KEY,
      installKey: TEST_INSTALL_KEY,
    });
    const response = await hono.request("/v1/company", { headers: { authorization: "Bearer t" } });
    expect(response.status).toBe(500);
    const lines = written.mock.calls.map((call) => call.map(String).join(" "));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("code 23505");
    expect(lines[0]).not.toContain("19900101-2385");
    expect(lines[0]).not.toContain("anna.lind");
  });
});
