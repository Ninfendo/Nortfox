// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { REFUSALS, codeOf, readRefusal, refusalDrift } from "./refusals.ts";

describe("the list of refusals", () => {
  it("gives each reason its own code in the class NF, and each code one reason", () => {
    expect(REFUSALS.length).toBe(33);
    expect(new Set(REFUSALS.map((refusal) => refusal.reason)).size).toBe(REFUSALS.length);
    expect(new Set(REFUSALS.map((refusal) => refusal.code)).size).toBe(REFUSALS.length);
    for (const { reason, code } of REFUSALS) {
      expect(reason).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
      expect(code).toMatch(/^NF[0-9]{3}$/);
    }
  });

  it("keeps the reasons of rule 44 from NF001, the rules a request can break up to NF049, and the database's own from NF050", () => {
    expect(codeOf("unbalanced")).toBe("NF001");
    expect(codeOf("immutable_field")).toBe("NF020");
    expect(codeOf("install_not_empty")).toBe("NF021");
    expect(codeOf("last_system_administrator")).toBe("NF022");
    expect(codeOf("view_permission_missing")).toBe("NF023");
    expect(codeOf("not_in_program")).toBe("NF024");
    expect(codeOf("actor_missing")).toBe("NF050");
    expect(codeOf("fiscal_year_strands_rows")).toBe("NF057");
    expect(codeOf("read_committed_only")).toBe("NF058");
  });
});

describe("readRefusal", () => {
  const error = (fields: Record<string, unknown>): Error => Object.assign(new Error(String(fields["message"])), fields);

  it("reads the reason and the facts of a refusal", () => {
    expect(readRefusal(error({ code: "NF050", message: "actor_missing", detail: '{"setting": "nortfox.actor_id"}' }))).toEqual({
      reason: "actor_missing",
      code: "NF050",
      facts: { setting: "nortfox.actor_id" },
    });
    expect(readRefusal(error({ code: "NF009", message: "description_missing", detail: "{}" }))).toEqual({
      reason: "description_missing",
      code: "NF009",
      facts: {},
    });
  });

  it.each([
    ["no error at all", undefined],
    ["a string", "actor_missing"],
    ["an error without a code", new Error("actor_missing")],
    ["another SQLSTATE", error({ code: "42501", message: "permission denied for table companies" })],
    ["an unknown code in the class", error({ code: "NF999", message: "actor_missing", detail: "{}" })],
    ["a code with another reason", error({ code: "NF050", message: "append_only", detail: "{}" })],
    ["no detail", error({ code: "NF050", message: "actor_missing" })],
    ["a detail that is not JSON", error({ code: "NF050", message: "actor_missing", detail: "setting" })],
    ["a detail that is not an object", error({ code: "NF050", message: "actor_missing", detail: "[1]" })],
    ["a detail that is null", error({ code: "NF050", message: "actor_missing", detail: "null" })],
  ])("finds no refusal in %s", (_case, value) => {
    expect(readRefusal(value)).toBeUndefined();
  });
});

describe("refusalDrift", () => {
  const listed = REFUSALS.map(({ reason, code }) => ({ reason, code }));

  it("finds nothing when the database holds the same list, in any order", () => {
    expect(refusalDrift([...listed].reverse())).toEqual([]);
  });

  it("fails on a list with one entry more or one less", () => {
    expect(refusalDrift([...listed, { reason: "made_up", code: "NF099" }])).toEqual([
      "made_up (NF099) is in ledger.refusal_reasons() but not in apps/server/src/db/refusals.ts.",
    ]);
    expect(refusalDrift(listed.slice(1))).toEqual([
      "unbalanced (NF001) is in apps/server/src/db/refusals.ts but not in ledger.refusal_reasons().",
    ]);
  });

  it("fails on a reason with another code", () => {
    expect(refusalDrift(listed.map((entry) => (entry.reason === "unbalanced" ? { ...entry, code: "NF099" } : entry)))).toEqual([
      "unbalanced (NF001) is in apps/server/src/db/refusals.ts but not in ledger.refusal_reasons().",
      "unbalanced (NF099) is in ledger.refusal_reasons() but not in apps/server/src/db/refusals.ts.",
    ]);
  });
});
