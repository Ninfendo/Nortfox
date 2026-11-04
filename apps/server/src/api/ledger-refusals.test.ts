// SPDX-License-Identifier: AGPL-3.0-only

// The ledger's refusals as the API answers them. Each reason the database
// gives is either a rule a request can break, answered with 422 and its own
// code and facts, or a fault of the server, answered with 500. The table
// says which for every reason, so a new reason does not compile until someone
// decides.

import { PROBLEM_CODES } from "@nortfox/contract";
import { describe, expect, it } from "vitest";
import { REFUSALS, codeOf, type RefusalReason } from "../db/refusals.ts";
import { LEDGER_REFUSALS, ledgerRule } from "./ledger-refusals.ts";

/** An error as PostgreSQL gives a refusal: the reason's SQLSTATE, the reason as the message, the facts as JSON in the detail. */
function refusal(reason: RefusalReason, facts: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(reason), { code: codeOf(reason), detail: JSON.stringify(facts) });
}

/** The seven reasons that a request through the server never meets, unless the server is at fault. */
const FAULTS: readonly RefusalReason[] = [
  "actor_missing",
  "append_only",
  "internal_only",
  "row_removal",
  "counter_move",
  "void_range_not_at_counter",
  "read_committed_only",
];

const RULES = REFUSALS.map(({ reason }) => reason).filter((reason) => !FAULTS.includes(reason));

describe("the ledger's refusals", () => {
  it("say for every reason whether it is a rule or a fault, and no more", () => {
    expect(Object.keys(LEDGER_REFUSALS).sort()).toEqual(REFUSALS.map(({ reason }) => reason).sort());
  });

  it("are faults of the server for exactly the seven reasons that no request meets", () => {
    expect(
      Object.entries(LEDGER_REFUSALS)
        .filter(([, entry]) => !entry.rule)
        .map(([reason]) => reason)
        .sort(),
    ).toEqual([...FAULTS].sort());
    for (const reason of FAULTS) {
      expect(ledgerRule(refusal(reason, { setting: "nortfox.actor_id" })), reason).toBeUndefined();
    }
  });

  it("are rules for NF001 to NF022, period_outside_fiscal_year and fiscal_year_strands_rows", () => {
    expect(RULES.map(codeOf)).toEqual([...Array.from({ length: 22 }, (_unused, index) => `NF${String(index + 1).padStart(3, "0")}`), "NF056", "NF057"]);
  });

  it.each(RULES)("answer %s with its code in kebab-case, which PROBLEM_CODES lists at 422, and a sentence", (reason) => {
    const rule = ledgerRule(refusal(reason));
    const code = reason.replaceAll("_", "-");
    expect(rule?.code).toBe(code);
    expect(rule?.detail).toMatch(/^[A-Z].*\.$/);
    expect(rule?.data).toEqual({});
    expect(Object.keys(rule ?? {}).sort()).toEqual(["code", "data", "detail"]);
    expect(PROBLEM_CODES[code as keyof typeof PROBLEM_CODES]).toBe(422);
  });

  it("are every ledger code that PROBLEM_CODES lists, and no other", () => {
    const listed = Object.entries(PROBLEM_CODES)
      // The surface's own 422 and the sign-in's refusals are no rule of the ledger.
      .filter(([code, status]) => status === 422 && !["idempotency-key-reused", "sign-in-failed", "setup-link-invalid"].includes(code))
      .map(([code]) => code)
      .sort();
    expect(listed).toEqual(RULES.map((reason) => reason.replaceAll("_", "-")).sort());
  });

  it("give the facts with camelCase keys, as /v1 names its fields, also inside a fact", () => {
    expect(
      ledgerRule(
        refusal("period_locked_manual", {
          end_date: "2090-06-30",
          source: "integration",
          user_id: null,
          set_by: "1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b",
          set_by_kind: "user",
          set_at: "2090-01-02T10:11:12.123456+00:00",
        }),
      ),
    ).toEqual({
      code: "period-locked-manual",
      detail: "The date is in a locked period.",
      data: {
        endDate: "2090-06-30",
        source: "integration",
        userId: null,
        setBy: "1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b",
        setByKind: "user",
        setAt: "2090-01-02T10:11:12.123456+00:00",
      },
    });
    expect(
      ledgerRule(refusal("date_outside_fiscal_year", { date: "2091-01-01", year: { year_number: 1, from_date: "2090-01-01", to_date: "2090-12-31" } }))
        ?.data,
    ).toEqual({ date: "2091-01-01", year: { yearNumber: 1, fromDate: "2090-01-01", toDate: "2090-12-31" } });
    expect(ledgerRule(refusal("value_too_long", { field: "transaction_information", value: "x", list_of: [{ snake_name: 1 }, 2] }))?.data).toEqual({
      field: "transaction_information",
      value: "x",
      listOf: [{ snakeName: 1 }, 2],
    });
  });

  it("give the amounts of unbalanced as Money, from the database's strings of öre", () => {
    expect(ledgerRule(refusal("unbalanced", { debit: "12550", credit: "-5" }))).toEqual({
      code: "unbalanced",
      detail: "The voucher's debit and credit differ.",
      data: { debit: { amount: "125.50", currency: "SEK" }, credit: { amount: "-0.05", currency: "SEK" } },
    });
    expect(ledgerRule(refusal("unbalanced", { debit: "92233720368547758070", credit: "0" }))?.data).toEqual({
      debit: { amount: "922337203685477580.70", currency: "SEK" },
      credit: { amount: "0.00", currency: "SEK" },
    });
  });

  it("are faults for every error that is not a refusal: a plain 42501, a 23505, a code outside the list, or no error at all", () => {
    for (const error of [
      Object.assign(new Error("permission denied for table vouchers"), { code: "42501" }),
      Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505", detail: "{}" }),
      Object.assign(new Error("unbalanced"), { code: "NF999", detail: "{}" }),
      Object.assign(new Error("other"), { code: "NF001", detail: "{}" }),
      new Error("unbalanced"),
      "unbalanced",
      undefined,
    ]) {
      expect(ledgerRule(error), String(error)).toBeUndefined();
    }
  });
});
