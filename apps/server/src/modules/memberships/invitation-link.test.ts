// SPDX-License-Identifier: AGPL-3.0-only

// acceptInvitation's own check of a new identity's password. The body's
// schema refuses a bad password beside the other field problems, so the API
// never brings one to the handler. The handler still hashes through the one
// wrapper, which checks the rule again: a password that came past the schema
// is refused as the same field problem, at /newIdentity/password, and
// nothing touches the database. invitations.db.test.ts runs the rest on
// PostgreSQL.

import { describe, expect, it } from "vitest";
import { TEST_NOW, testServices, untouchedDatabase } from "../../../test/api.ts";
import type { NoneCall } from "../../api/operation.ts";
import { acceptInvitationHandler } from "./invitation-link.ts";

describe("acceptInvitation's handler", () => {
  it("refuses a new identity's password that breaks the rule through the wrapper, also when the schema did not, and touches nothing", async () => {
    const database = untouchedDatabase();
    const call: NoneCall = {
      principal: undefined,
      database,
      services: testServices(),
      channel: "rest",
      request: {},
      now: () => TEST_NOW,
      later: () => undefined,
    };
    const input: Parameters<typeof acceptInvitationHandler.run>[1] = {
      params: { token: `nfi_${"A".repeat(43)}` },
      query: {},
      body: { newIdentity: { name: "Signe Ek", password: "elva-tecken" } },
    };
    expect(await acceptInvitationHandler.run(call, input)).toEqual({
      ok: false,
      refusal: {
        kind: "invalid",
        problems: [
          { code: "too-short", detail: "The field /newIdentity/password must be at least 12 characters long.", pointer: "/newIdentity/password", data: { minimum: 12 } },
        ],
      },
    });
    expect(database.asked).toEqual([]);
  });
});
