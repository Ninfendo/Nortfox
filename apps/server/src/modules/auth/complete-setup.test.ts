// SPDX-License-Identifier: AGPL-3.0-only

// completeSetup's own check of the password. The body's schema refuses a bad
// password beside the other field problems, so the API never brings one to
// the handler. The handler still hashes through the one wrapper, which
// checks the rule again: a password that came past the schema is refused as
// the same field problem, and nothing touches the database.

import { describe, expect, it } from "vitest";
import { TEST_INSTALL_KEY, TEST_NOW, testPasswords, untouchedDatabase } from "../../../test/api.ts";
import type { NoneCall } from "../../api/operation.ts";
import { completeSetupHandler } from "./complete-setup.ts";

describe("completeSetup's handler", () => {
  it("refuses a password that breaks the rule through the wrapper, also when the schema did not, and touches nothing", async () => {
    const database = untouchedDatabase();
    const call: NoneCall = {
      principal: undefined,
      database,
      services: { passwords: testPasswords(), installKey: TEST_INSTALL_KEY },
      channel: "rest",
      request: {},
      now: () => TEST_NOW,
      later: () => undefined,
    };
    const input: Parameters<typeof completeSetupHandler.run>[1] = { params: { token: `nfu_${"A".repeat(43)}` }, query: {}, body: { name: "Signe Ek", email: "signe.ek@example.com", password: "elva-tecken" } };
    expect(await completeSetupHandler.run(call, input)).toEqual({
      ok: false,
      refusal: {
        kind: "invalid",
        problems: [{ code: "too-short", detail: "The field /password must be at least 12 characters long.", pointer: "/password", data: { minimum: 12 } }],
      },
    });
    expect(database.asked).toEqual([]);
  });
});
