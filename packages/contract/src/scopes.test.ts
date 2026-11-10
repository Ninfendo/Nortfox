// SPDX-License-Identifier: AGPL-3.0-only

// The scopes (issue 12, "Scopes"; plan 2.11; open point 14). SCOPES holds
// the established API's names that the plan's modules use, also those that
// no operation names yet, since slice 2e takes them in its login flow, and
// NortFox's own scope of each module that the established API has none for.
// The list is pinned here, so a new scope or a rename changes this test.

import { describe, expect, it } from "vitest";
import * as contract from "./index.ts";
import { SCOPES } from "./scopes.ts";

describe("SCOPES", () => {
  it("holds the established API's names, NortFox's own per module, in the issue's order", () => {
    expect(SCOPES).toEqual([
      "companyinformation",
      "profile",
      "companies",
      "users",
      "tokens",
      "bookkeeping",
      "settings",
      "costcenter",
      "project",
      "currency",
      "supplier",
      "supplierinvoice",
      "payment",
      "connectfile",
      "inbox",
      "archive",
      "deletevoucher",
    ]);
  });

  it("names each scope once, in the small letters a to z alone, the form that access.api_tokens takes", () => {
    expect(new Set(SCOPES).size).toBe(SCOPES.length);
    for (const scope of SCOPES) {
      expect(scope).toMatch(/^[a-z]+$/);
    }
  });

  it("is case-sensitive: a name that differs only in letter case is no scope", () => {
    const names: readonly string[] = SCOPES;
    expect(names).toContain("profile");
    expect(names).not.toContain("Profile");
    expect(names).not.toContain("PROFILE");
    expect(names).not.toContain("companyInformation");
  });

  it("is what the package exports", () => {
    expect(contract.SCOPES).toBe(SCOPES);
  });
});
