// SPDX-License-Identifier: AGPL-3.0-only

// The details of a sign-in's entry in the behandlingshistorik (plan 2.10):
// the method, the second step when it had one, the time of the
// identification for a sign-in that succeeded, the personnummer when the
// method gives one, the application, the IP address when the server knows
// it, and the outcome. sign-in-entries.db.test.ts writes them on PostgreSQL.

import { describe, expect, it } from "vitest";
import { ENTRY_WORDS, signInEntryDetails } from "./entries.ts";

describe("signInEntryDetails", () => {
  it("gives every fact the sign-in has, in the order of the screen", () => {
    const details = signInEntryDetails({
      method: "password-personnummer",
      secondStep: "known-device",
      identifiedAt: new Date("2090-03-15T09:58:12.000Z"),
      personalIdentityNumber: "19900101-2385",
      request: { ipAddress: "192.0.2.5" },
      outcome: "succeeded",
    });
    expect(details).toEqual({
      method: "password-personnummer",
      secondStep: "known-device",
      identifiedAt: "2090-03-15T09:58:12.000Z",
      personalIdentityNumber: "19900101-2385",
      application: "web",
      ipAddress: "192.0.2.5",
      outcome: "succeeded",
    });
    expect(Object.keys(details)).toEqual(["method", "secondStep", "identifiedAt", "personalIdentityNumber", "application", "ipAddress", "outcome"]);
  });

  it("leaves out what the sign-in does not have: a second step, a time of identification, a personnummer and an address", () => {
    expect(signInEntryDetails({ method: "bankid", request: {}, outcome: "failed" })).toEqual({ method: "bankid", application: "web", outcome: "failed" });
  });

  it("has a screen word for each code it writes, and one line for the method and the time of the identification", () => {
    expect(ENTRY_WORDS.events["sign-in"]).toBe("Inloggning via NortFox ID");
    expect(ENTRY_WORDS.details.identifiedAt).toBe(ENTRY_WORDS.details.method);
  });
});
