// SPDX-License-Identifier: AGPL-3.0-only

// The ledger's refusals as the API answers them. The database refuses a write
// with a reason in the class NF (db/refusals.ts). Each reason is one of two:
//
// - A rule that a request can break: NF001 to NF020, which later slices also
//   answer with the established system's message, NF021 install_not_empty,
//   NF022 last_system_administrator, NF023 view_permission_missing, NF024
//   not_in_program, and period_outside_fiscal_year and
//   fiscal_year_strands_rows. The runner
//   answers it as a rule's refusal, 422. Its code is the reason in kebab-case,
//   and its facts are the database's with camelCase keys, as /v1 names its
//   fields, and with amounts as Money. It has no pointer: the database does
//   not know which field of the request it is about. A handler that knows may
//   catch the error and refuse with a pointer of its own.
// - A fault of the server, 500: a reason that no request through the server
//   meets unless the server is at fault. The server always sets the actor
//   (actor_missing), never writes the rows that only the database writes
//   (append_only, internal_only), has no DELETE on voucher rows
//   (row_removal), never records a void range (void_range_not_at_counter),
//   and writes at READ COMMITTED (read_committed_only). counter_move comes
//   only from a clock set back during a booking, and a retry books it.
//
// The table says which for every reason, so a new reason does not compile
// until someone decides. A plain 42501 and every other SQLSTATE are faults
// too: ledgerRule gives nothing for them.

import { oreToMoney, type JsonValue } from "@nortfox/contract";
import { readRefusal, type RefusalReason } from "../db/refusals.ts";
import type { RuleRefusal } from "./operation.ts";

/** How the API answers one reason: as a rule, with its sentence and the facts that are amounts, or as a fault. */
export type LedgerRefusal = { readonly rule: true; readonly detail: string; readonly amounts?: readonly string[] } | { readonly rule: false };

export const LEDGER_REFUSALS = {
  unbalanced: { rule: true, detail: "The voucher's debit and credit differ.", amounts: ["debit", "credit"] },
  too_few_rows: { rule: true, detail: "A voucher needs at least two rows." },
  account_missing: { rule: true, detail: "The account is not in the voucher's fiscal year." },
  account_inactive: { rule: true, detail: "The account is not active." },
  series_missing: { rule: true, detail: "The voucher series is not in the voucher's fiscal year." },
  series_not_manual: { rule: true, detail: "A manual voucher needs a manual voucher series." },
  no_fiscal_year: { rule: true, detail: "The date is in no fiscal year of the company." },
  date_outside_fiscal_year: { rule: true, detail: "The date is outside the voucher's fiscal year." },
  description_missing: { rule: true, detail: "The description is missing." },
  value_too_long: { rule: true, detail: "A value is longer than its field allows." },
  period_locked_manual: { rule: true, detail: "The date is in a locked period." },
  period_locked_automatic: { rule: true, detail: "The date is in a period that the automatic lock has locked." },
  not_last_in_series: { rule: true, detail: "Only the last voucher of its series can be deleted." },
  reversing_voucher_exists: { rule: true, detail: "Another voucher reverses this voucher." },
  reversing_other_module: { rule: true, detail: "A reversing voucher must have the reference type of the voucher it reverses." },
  account_has_rows: { rule: true, detail: "The account holds rows, so it cannot be removed." },
  series_code_invalid: { rule: true, detail: "A series code is 1 to 10 digits and capital letters A to Ö." },
  series_code_duplicate: { rule: true, detail: "The fiscal year has a voucher series with this code already." },
  series_code_changed: { rule: true, detail: "A voucher series keeps its code." },
  immutable_field: { rule: true, detail: "The field cannot be set or changed." },
  install_not_empty: { rule: true, detail: "The install has an identity already, so its setup is done." },
  last_system_administrator: { rule: true, detail: "A company needs at least one active system administrator." },
  view_permission_missing: { rule: true, detail: "An action right needs the view right of its group." },
  not_in_program: { rule: true, detail: "The program does not hold that right." },
  period_outside_fiscal_year: { rule: true, detail: "The period is not inside its fiscal year." },
  fiscal_year_strands_rows: { rule: true, detail: "The new dates would leave periods or vouchers outside the fiscal year." },
  actor_missing: { rule: false },
  append_only: { rule: false },
  internal_only: { rule: false },
  row_removal: { rule: false },
  counter_move: { rule: false },
  void_range_not_at_counter: { rule: false },
  read_committed_only: { rule: false },
} as const satisfies Readonly<Record<RefusalReason, LedgerRefusal>>;

/** A database name in camelCase, as /v1 names its fields: end_date is endDate. */
function camelCase(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

/** A fact with camelCase keys, inside it too. */
function camelKeys(value: unknown): JsonValue {
  if (Array.isArray(value)) {
    return value.map(camelKeys);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [camelCase(name), camelKeys(item)]));
  }
  return value as JsonValue;
}

/**
 * The rule's refusal in an error from the database, or undefined when the
 * error is a fault of the server: a reason of the server's own faults, a
 * plain 42501, any other SQLSTATE, or no database error at all.
 */
export function ledgerRule(error: unknown): RuleRefusal | undefined {
  const refusal = readRefusal(error);
  if (refusal === undefined) {
    return undefined;
  }
  const entry: LedgerRefusal = LEDGER_REFUSALS[refusal.reason];
  if (!entry.rule) {
    return undefined;
  }
  const amounts = new Set(entry.amounts);
  const data = Object.fromEntries(
    Object.entries(refusal.facts).map(([name, value]) => [
      camelCase(name),
      // The database gives an amount as a string of öre.
      amounts.has(name) ? oreToMoney(BigInt(value as string), "SEK") : camelKeys(value),
    ]),
  );
  return { code: refusal.reason.replaceAll("_", "-"), detail: entry.detail, data };
}
