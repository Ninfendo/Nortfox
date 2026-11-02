// SPDX-License-Identifier: AGPL-3.0-only

// The reasons the database gives when it refuses a write. Each reason has its
// own SQLSTATE in the class NF: the error's message is the reason, and its
// detail is the facts as JSON. ledger.refusal_reasons() in
// db/migrations/0001_foundation.sql holds the same list, and a test fails when
// the two differ. NF001 to NF020 are the reasons that later slices answer with
// the established system's messages; from NF050 on they guard the database's
// own rules, and have no such answer.

export const REFUSALS = [
  { reason: "unbalanced", code: "NF001" },
  { reason: "too_few_rows", code: "NF002" },
  { reason: "account_missing", code: "NF003" },
  { reason: "account_inactive", code: "NF004" },
  { reason: "series_missing", code: "NF005" },
  { reason: "series_not_manual", code: "NF006" },
  { reason: "no_fiscal_year", code: "NF007" },
  { reason: "date_outside_fiscal_year", code: "NF008" },
  { reason: "description_missing", code: "NF009" },
  { reason: "value_too_long", code: "NF010" },
  { reason: "period_locked_manual", code: "NF011" },
  { reason: "period_locked_automatic", code: "NF012" },
  { reason: "not_last_in_series", code: "NF013" },
  { reason: "reversing_voucher_exists", code: "NF014" },
  { reason: "reversing_other_module", code: "NF015" },
  { reason: "account_has_rows", code: "NF016" },
  { reason: "series_code_invalid", code: "NF017" },
  { reason: "series_code_duplicate", code: "NF018" },
  { reason: "series_code_changed", code: "NF019" },
  { reason: "immutable_field", code: "NF020" },
  { reason: "actor_missing", code: "NF050" },
  { reason: "append_only", code: "NF051" },
  { reason: "internal_only", code: "NF052" },
  { reason: "row_removal", code: "NF053" },
  { reason: "counter_move", code: "NF054" },
  { reason: "void_range_not_at_counter", code: "NF055" },
  { reason: "period_outside_fiscal_year", code: "NF056" },
  { reason: "fiscal_year_strands_rows", code: "NF057" },
] as const;

export type RefusalReason = (typeof REFUSALS)[number]["reason"];

/** A refusal read from an error: its reason, its code and its facts. */
export interface Refusal {
  readonly reason: RefusalReason;
  readonly code: string;
  readonly facts: Readonly<Record<string, unknown>>;
}

const byCode: ReadonlyMap<string, RefusalReason> = new Map(REFUSALS.map(({ reason, code }) => [code, reason]));
const codes = Object.fromEntries(REFUSALS.map(({ reason, code }) => [reason, code])) as Record<RefusalReason, string>;

/** The SQLSTATE of a reason. */
export function codeOf(reason: RefusalReason): string {
  return codes[reason];
}

function field(error: object, name: string): unknown {
  return (error as Record<string, unknown>)[name];
}

/**
 * The refusal in an error from the database, or undefined when the error is
 * not one: another SQLSTATE, a code that is not on the list, a message that is
 * not that code's reason, or a detail that is not a JSON object.
 */
export function readRefusal(error: unknown): Refusal | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = field(error, "code");
  if (typeof code !== "string") {
    return undefined;
  }
  const reason = byCode.get(code);
  const detail = field(error, "detail");
  if (reason === undefined || field(error, "message") !== reason || typeof detail !== "string") {
    return undefined;
  }
  let facts: unknown;
  try {
    facts = JSON.parse(detail);
  } catch {
    return undefined;
  }
  if (typeof facts !== "object" || facts === null || Array.isArray(facts)) {
    return undefined;
  }
  return { reason, code, facts: facts as Record<string, unknown> };
}

/** A reason and its code, as ledger.refusal_reasons() gives them. */
export interface ReasonRow {
  readonly reason: string;
  readonly code: string;
}

/** What differs between the database's list and this file's, in plain words; empty when nothing does. */
export function refusalDrift(inDatabase: readonly ReasonRow[], inCode: readonly ReasonRow[] = REFUSALS): string[] {
  const key = ({ reason, code }: ReasonRow): string => `${reason} (${code})`;
  const database = new Set(inDatabase.map(key));
  const code = new Set(inCode.map(key));
  return [
    ...[...code].filter((entry) => !database.has(entry)).map((entry) => `${entry} is in apps/server/src/db/refusals.ts but not in ledger.refusal_reasons().`),
    ...[...database].filter((entry) => !code.has(entry)).map((entry) => `${entry} is in ledger.refusal_reasons() but not in apps/server/src/db/refusals.ts.`),
  ];
}
