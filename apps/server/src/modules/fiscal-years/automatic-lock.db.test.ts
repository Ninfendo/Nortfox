// SPDX-License-Identifier: AGPL-3.0-only

// The automatic lock (rules 35 and 36 of the slice): a setting per company,
// off for a new company, and a function that works out its date in Swedish
// time from the day, the interval and, for the year interval, the company's
// fiscal years. No job runs for it. A period is locked on the 50th day after
// the end of its month or quarter, and on the 60th day after the end of the
// fiscal year; quarters are calendar quarters. The tests use days away from
// those boundaries, which slice 3b settles. Today is the day in Sweden when
// the statement began, in winter time and in summer time.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHECK_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  UNIQUE_VIOLATION,
  backendPid,
  begin,
  expectError,
  expectRefusal,
  freshDatabase,
  inTransaction,
  untilWaitingForLock,
  type TestDatabase,
} from "../../../test/database.ts";
import {
  AUTOMATIC_LOCK_COLUMNS,
  addBooks,
  addCompany,
  addFiscalYear,
  balanced,
  bookVoucher,
  setAutomaticLock,
  someUser,
  type AutomaticInterval,
  type AutomaticLock,
} from "../../../test/ledger.ts";

/** The dates the slice's issue gives: the interval, the day, and the date the lock reaches. */
const ISSUE_DATES: readonly { interval: AutomaticInterval; today: string; through: string }[] = [
  { interval: "month_end_50", today: "2026-11-02", through: "2026-08-31" },
  { interval: "month_end_50", today: "2026-11-25", through: "2026-09-30" },
  { interval: "quarter_end_50", today: "2026-11-02", through: "2026-06-30" },
  { interval: "quarter_end_50", today: "2026-11-25", through: "2026-09-30" },
  { interval: "year_end_60", today: "2026-11-02", through: "2025-12-31" },
  { interval: "year_end_60", today: "2027-03-10", through: "2026-12-31" },
];

/** Time zones far apart: 14 hours ahead of UTC, 11 hours behind, and two between. */
const TIME_ZONES = ["Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC", "America/Los_Angeles"];

describe("the automatic lock", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  const who = someUser();

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
  });

  afterAll(async () => {
    await db.close();
  });

  async function settings(company: string): Promise<AutomaticLock | undefined> {
    return inTransaction(app, { company }, async () => {
      const found = await app.query<AutomaticLock>(`SELECT ${AUTOMATIC_LOCK_COLUMNS} FROM ledger.automatic_locks`);
      expect(found.rows.length).toBeLessThanOrEqual(1);
      return found.rows[0];
    });
  }

  async function asApp(company: string, sql: string, params: readonly unknown[] = []): Promise<unknown[]> {
    return inTransaction(app, { company, ...who }, async () => (await app.query<Record<string, unknown>>(sql, [...params])).rows);
  }

  /** ledger.automatic_lock_end_date for `today`, read with the session in `timeZone` when one is given. */
  async function endDate(company: string, today: string, timeZone?: string): Promise<string | null> {
    return inTransaction(app, { company }, async () => {
      if (timeZone !== undefined) {
        await app.query("SELECT pg_catalog.set_config('TimeZone', $1, true)", [timeZone]);
      }
      const found = await app.query<{ through: string | null }>("SELECT ledger.automatic_lock_end_date($1, $2)::text AS through", [company, today]);
      return found.rows[0]?.through ?? null;
    });
  }

  /** A company with calendar fiscal years from 2024 to 2027. */
  async function companyWithYears(): Promise<string> {
    const company = await addCompany(app);
    for (const year of [2024, 2025, 2026, 2027]) {
      await addFiscalYear(app, company, { from: `${String(year)}-01-01`, to: `${String(year)}-12-31` });
    }
    return company;
  }

  it("is off for a new company, with no interval and no days of notice, set by whoever made the company", async () => {
    const maker = someUser();
    const company = await addCompany(app, maker);
    expect(await settings(company)).toEqual({
      id: expect.any(String) as unknown,
      company_id: company,
      enabled: false,
      interval: null,
      notice_days: null,
      set_by: maker.actor,
      set_by_kind: "user",
      set_at: expect.any(String) as unknown,
    });
    expect(await endDate(company, "2026-11-02")).toBeNull();
  });

  it("lets the app turn it on and off and set the days of notice, with who did it and when, but not add or delete it", async () => {
    const company = await addCompany(app);
    const first = await settings(company);
    const on = await setAutomaticLock(app, company, "month_end_50", who);
    expect(on).toMatchObject({ id: first?.id, enabled: true, interval: "month_end_50", set_by: who.actor, set_by_kind: "user" });
    const integration = { actor: randomUUID(), kind: "integration" } as const;
    const [notice] = (await inTransaction(app, { company, ...integration }, async () =>
      (await app.query<AutomaticLock>(`UPDATE ledger.automatic_locks SET notice_days = 7 RETURNING ${AUTOMATIC_LOCK_COLUMNS}`)).rows,
    ));
    expect(notice).toMatchObject({ enabled: true, notice_days: 7, set_by: integration.actor, set_by_kind: "integration" });
    expect(await setAutomaticLock(app, company, null, who)).toMatchObject({ enabled: false, interval: "month_end_50", notice_days: 7 });
    await expectError(asApp(company, "INSERT INTO ledger.automatic_locks (company_id) VALUES ($1)", [company]), INSUFFICIENT_PRIVILEGE, /permission denied/);
    await expectError(asApp(company, "DELETE FROM ledger.automatic_locks"), INSUFFICIENT_PRIVILEGE, /permission denied/);
  });

  it("needs an interval when it is on, takes only its three intervals, and days of notice from 0", async () => {
    const company = await addCompany(app);
    for (const set of [
      "enabled = true",
      "enabled = true, interval = NULL",
      "interval = 'month_end_51'",
      "interval = 'week_end_50'",
      "notice_days = -1",
    ]) {
      await expectError(asApp(company, `UPDATE ledger.automatic_locks SET ${set}`), CHECK_VIOLATION);
    }
    await asApp(company, "UPDATE ledger.automatic_locks SET notice_days = 0, interval = 'year_end_60'");
    // Off, it keeps its interval or has none.
    await asApp(company, "UPDATE ledger.automatic_locks SET enabled = false, interval = NULL, notice_days = NULL");
    expect(await settings(company)).toMatchObject({ enabled: false, interval: null, notice_days: null });
  });

  it("sets who and when itself: a given value is refused, and so is a change of its id", async () => {
    const company = await addCompany(app);
    for (const [set, field] of [
      [`set_by = '${randomUUID()}'`, "set_by"],
      ["set_by_kind = 'system'", "set_by_kind"],
      ["set_at = '2026-01-01T00:00:00Z'", "set_at"],
      [`id = '${randomUUID()}'`, "id"],
    ] as const) {
      await expectRefusal(asApp(company, `UPDATE ledger.automatic_locks SET ${set}`), "immutable_field", { field, operation: "update" });
    }
    // As the owner, which may insert a row: the same on insert. The trigger
    // refuses it before the unique key would.
    await expectRefusal(
      inTransaction(owner, { company, ...who }, () =>
        owner.query("INSERT INTO ledger.automatic_locks (company_id, set_by) VALUES ($1, $2)", [company, randomUUID()]),
      ),
      "immutable_field",
      { field: "set_by", operation: "create" },
    );
  });

  it("is one row per company: the owner cannot add a second one", async () => {
    const company = await addCompany(app);
    await expectError(
      inTransaction(owner, { company, ...who }, () => owner.query("INSERT INTO ledger.automatic_locks (company_id) VALUES ($1)", [company])),
      UNIQUE_VIOLATION,
      /automatic_locks_one_per_company/,
    );
  });

  // Every change of a lock date, and every change of a voucher, locks this
  // row. Without it, they would lock nothing and never wait for each other.
  it("is never deleted, the owner's statements neither, so a lock date that is set still waits for an open change of a voucher", async () => {
    const books = await addBooks(app, who);
    const before = await settings(books.company);
    await expectRefusal(
      inTransaction(owner, { company: books.company, ...who }, () => owner.query("DELETE FROM ledger.automatic_locks")),
      "append_only",
      { table: "ledger.automatic_locks", operation: "DELETE" },
    );
    expect(await settings(books.company)).toEqual(before);
    const voucher = await bookVoucher(app, books.company, { year: books.year.id, series: "A", date: "2090-03-15", rows: balanced() }, who);
    const other = await db.connect("app");
    const otherPid = await backendPid(other);
    await begin(app, { company: books.company, ...who });
    await app.query("UPDATE ledger.vouchers SET description = 'Ny text' WHERE id = $1", [voucher.id]);
    await begin(other, { company: books.company, ...who });
    const locked = other.query("INSERT INTO ledger.period_locks (company_id, scope, end_date) VALUES ($1, 'all', '2090-06-30')", [books.company]);
    await untilWaitingForLock(app, otherPid);
    await app.query("COMMIT");
    await locked;
    await other.query("COMMIT");
  });

  it.each(ISSUE_DATES)("with $interval, reaches $through on $today", async ({ interval, today, through }) => {
    const company = await companyWithYears();
    await setAutomaticLock(app, company, interval);
    expect(await endDate(company, today)).toBe(through);
  });

  it("gives the same dates whatever the session's time zone", async () => {
    const company = await companyWithYears();
    for (const { interval, today, through } of ISSUE_DATES) {
      await setAutomaticLock(app, company, interval);
      for (const timeZone of TIME_ZONES) {
        expect(await endDate(company, today, timeZone), `${interval} on ${today} in ${timeZone}`).toBe(through);
      }
    }
  });

  it("locks by calendar quarters, and by the last day of a month of any length", async () => {
    const company = await companyWithYears();
    await setAutomaticLock(app, company, "quarter_end_50");
    expect(await endDate(company, "2026-02-01")).toBe("2025-09-30");
    expect(await endDate(company, "2026-04-01")).toBe("2025-12-31");
    expect(await endDate(company, "2026-07-15")).toBe("2026-03-31");
    await setAutomaticLock(app, company, "month_end_50");
    expect(await endDate(company, "2026-04-30")).toBe("2026-02-28");
    expect(await endDate(company, "2028-04-30")).toBe("2028-02-29");
    expect(await endDate(company, "2026-01-15")).toBe("2025-10-31");
  });

  it("with the fiscal year interval, reads the company's own years, and gives none before its first year has ended", async () => {
    const company = await addCompany(app);
    await setAutomaticLock(app, company, "year_end_60");
    expect(await endDate(company, "2026-11-02")).toBeNull();
    await addFiscalYear(app, company, { from: "2025-07-01", to: "2026-06-30" });
    expect(await endDate(company, "2026-08-15")).toBeNull();
    expect(await endDate(company, "2026-11-02")).toBe("2026-06-30");
    // Another company's years play no part.
    const other = await companyWithYears();
    await setAutomaticLock(app, other, "year_end_60");
    expect(await endDate(company, "2028-11-02")).toBe("2026-06-30");
    expect(await endDate(other, "2028-11-02")).toBe("2027-12-31");
  });

  it("takes today as the day in Sweden, whatever the session's time zone, and lets no setting move it", async () => {
    const company = await addCompany(app);
    const days = await inTransaction(app, { company }, async () => {
      const found: { zone: string; sweden: string; local: string; millis: bigint }[] = [];
      for (const timeZone of TIME_ZONES) {
        await app.query("SELECT pg_catalog.set_config('TimeZone', $1, true)", [timeZone]);
        await app.query("SELECT pg_catalog.set_config('nortfox.today', '2001-01-01', true)");
        const row = await app.query<{ sweden: string; local: string; millis: bigint }>(
          `SELECT ledger.today_in_sweden()::text AS sweden, CURRENT_DATE::text AS local,
             (extract(epoch FROM pg_catalog.statement_timestamp()) * 1000)::bigint AS millis`,
        );
        const [day] = row.rows;
        if (day !== undefined) {
          found.push({ zone: timeZone, ...day });
        }
      }
      return found;
    });
    const [first] = days;
    expect(days.length).toBe(TIME_ZONES.length);
    const inSweden = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" }).format(
      new Date(Number(first?.millis)),
    );
    expect(days.map((day) => day.sweden)).toEqual(TIME_ZONES.map(() => inSweden));
    // The session's own date does move: 25 hours lie between Kiritimati and Pago Pago.
    expect(new Set(days.map((day) => day.local)).size).toBeGreaterThan(1);
  });

  /** Instants in UTC, and the day in Sweden at each: either side of midnight in winter time and in summer time, and on the days the clock changes. */
  const SWEDISH_DAYS: readonly (readonly [instant: string, day: string])[] = [
    ["2026-11-01 22:59:59+00", "2026-11-01"],
    ["2026-11-01 23:30:00+00", "2026-11-02"],
    ["2026-06-30 21:59:59+00", "2026-06-30"],
    ["2026-06-30 22:30:00+00", "2026-07-01"],
    ["2026-03-28 22:59:59+00", "2026-03-28"],
    ["2026-03-28 23:00:00+00", "2026-03-29"],
    ["2026-03-29 21:59:59+00", "2026-03-29"],
    ["2026-03-29 22:00:00+00", "2026-03-30"],
    ["2026-10-24 21:59:59+00", "2026-10-24"],
    ["2026-10-24 22:00:00+00", "2026-10-25"],
    ["2026-10-25 22:59:59+00", "2026-10-25"],
    ["2026-10-25 23:00:00+00", "2026-10-26"],
  ];

  it("gives the day in Sweden at an instant, in winter time and in summer time, whatever the session's time zone", async () => {
    for (const timeZone of TIME_ZONES) {
      const days = await inTransaction(app, {}, async () => {
        await app.query("SELECT pg_catalog.set_config('TimeZone', $1, true)", [timeZone]);
        const found: string[] = [];
        for (const [instant] of SWEDISH_DAYS) {
          const row = await app.query<{ day: string }>("SELECT ledger.day_in_sweden($1::timestamptz)::text AS day", [instant]);
          found.push(row.rows[0]?.day ?? "");
        }
        return found;
      });
      expect(days, timeZone).toEqual(SWEDISH_DAYS.map(([, day]) => day));
    }
  });

  it("takes today from the instant the statement began, not the transaction, so a transaction kept open past midnight reads the new day", async () => {
    const found = await owner.query<{ body: string }>("SELECT pg_catalog.pg_get_functiondef('ledger.today_in_sweden()'::pg_catalog.regprocedure) AS body");
    expect(found.rows[0]?.body).toMatch(/\nRETURN ledger\.day_in_sweden\(statement_timestamp\(\)\)\n$/);
    expect(found.rows[0]?.body).not.toMatch(/transaction_timestamp|now\(\)|current_/);
    const same = await inTransaction(app, {}, async () => {
      await app.query("SELECT pg_catalog.pg_sleep(0.01)");
      const row = await app.query<{ same: boolean }>("SELECT ledger.today_in_sweden() = ledger.day_in_sweden(pg_catalog.statement_timestamp()) AS same");
      return row.rows[0]?.same;
    });
    expect(same).toBe(true);
  });
});
