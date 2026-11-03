// SPDX-License-Identifier: AGPL-3.0-only

// Låsning av period (rules 34, 37 and 40 of the slice). A company has a
// locked-through date for each user, for the internal system user, for
// integrations and for all users, each with who set it and when, and the
// automatic lock on top. A date is locked for an actor when it is on or before
// the latest date that applies to that actor. ledger.lock_covering says which
// lock that is; ledger.assert_open, which the voucher triggers call, refuses
// with it. The vouchers' own lock tests come with the vouchers.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHECK_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  UNIQUE_VIOLATION,
  expectError,
  expectRefusal,
  freshDatabase,
  inTransaction,
  type TestDatabase,
} from "../../../test/database.ts";
import {
  PERIOD_LOCK_COLUMNS,
  addCompany,
  setAutomaticLock,
  setLock,
  someUser,
  type Actor,
  type LockScope,
  type PeriodLock,
} from "../../../test/ledger.ts";

/** The lock that covers a date for an actor, as ledger.lock_covering gives it. */
interface Covering {
  readonly source: string;
  readonly end_date: string;
  readonly user_id: string | null;
  readonly set_by: string | null;
  readonly set_by_kind: string | null;
  readonly set_at: string | null;
  readonly interval: string | null;
}

/** The day the manual-lock cases are read on. The automatic lock is off there, so the day plays no part. */
const TODAY = "2026-11-02";

describe("the period lock", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  /** Who sets the lock dates in these tests. */
  const setter = someUser();
  const userOne: Actor = someUser();
  const userTwo: Actor = someUser();
  const system: Actor = { actor: randomUUID(), kind: "system" };
  const integration: Actor = { actor: randomUUID(), kind: "integration" };
  // The database takes an actor as its id and its kind (ledger.current_actor).
  // So the internal system user or an integration with userOne's id is not
  // userOne, and userOne's own date never locks it.
  const systemWithOnesId: Actor = { actor: userOne.actor, kind: "system" };
  const integrationWithOnesId: Actor = { actor: userOne.actor, kind: "integration" };
  const ACTORS = { userOne, userTwo, system, integration, systemWithOnesId, integrationWithOnesId } as const;
  type ActorName = keyof typeof ACTORS;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
  });

  afterAll(async () => {
    await db.close();
  });

  async function covering(company: string, who: Actor, day: string, today = TODAY): Promise<Covering | undefined> {
    return inTransaction(app, { company, ...who }, async () => {
      const found = await app.query<Covering>(
        `SELECT source, end_date::text AS end_date, user_id, set_by, set_by_kind, set_at::text AS set_at, interval
         FROM ledger.lock_covering($1, $2, $3, $4, $5)`,
        [company, who.kind, who.actor, day, today],
      );
      expect(found.rows.length).toBeLessThanOrEqual(1);
      return found.rows[0];
    });
  }

  async function lockedThrough(company: string, who: Actor, today = TODAY): Promise<string | null> {
    return inTransaction(app, { company, ...who }, async () => {
      const found = await app.query<{ through: string | null }>("SELECT ledger.locked_through($1, $2, $3, $4)::text AS through", [
        company,
        who.kind,
        who.actor,
        today,
      ]);
      return found.rows[0]?.through ?? null;
    });
  }

  /** What lock_covering gives for a manual lock row. */
  function manual(lock: PeriodLock): Covering {
    return {
      source: lock.scope,
      end_date: lock.end_date ?? "",
      user_id: lock.user_id,
      set_by: lock.set_by,
      set_by_kind: lock.set_by_kind,
      set_at: lock.set_at,
      interval: null,
    };
  }

  function automatic(endDate: string, interval: string): Covering {
    return { source: "automatic", end_date: endDate, user_id: null, set_by: null, set_by_kind: null, set_at: null, interval };
  }

  async function locksOf(company: string): Promise<PeriodLock[]> {
    return inTransaction(app, { company }, async () => {
      const found = await app.query<PeriodLock>(`SELECT ${PERIOD_LOCK_COLUMNS} FROM ledger.period_locks ORDER BY scope, user_id`);
      return found.rows;
    });
  }

  async function asApp(company: string, sql: string, params: readonly unknown[] = [], who: Actor = setter): Promise<unknown[]> {
    return inTransaction(app, { company, ...who }, async () => (await app.query<Record<string, unknown>>(sql, [...params])).rows);
  }

  describe("its rows", () => {
    it("holds a date for each user, for the internal system user, for integrations and for all users, with who set it and when", async () => {
      const company = await addCompany(app);
      const started = await inTransaction(app, { company, ...setter }, async () => {
        const found = await app.query<{ started: string }>("SELECT pg_catalog.transaction_timestamp()::text AS started");
        return found.rows[0]?.started ?? "";
      });
      const rows = [
        await setLock(app, company, "user", "2090-01-31", { user: userOne.actor, who: setter }),
        await setLock(app, company, "user", "2090-02-28", { user: userTwo.actor, who: system }),
        await setLock(app, company, "system", "2090-03-31", { who: integration }),
        await setLock(app, company, "integration", "2090-04-30", { who: setter }),
        await setLock(app, company, "all", null, { who: setter }),
      ];
      expect(rows.map(({ scope, user_id, end_date, set_by, set_by_kind }) => ({ scope, user_id, end_date, set_by, set_by_kind }))).toEqual([
        { scope: "user", user_id: userOne.actor, end_date: "2090-01-31", set_by: setter.actor, set_by_kind: "user" },
        { scope: "user", user_id: userTwo.actor, end_date: "2090-02-28", set_by: system.actor, set_by_kind: "system" },
        { scope: "system", user_id: null, end_date: "2090-03-31", set_by: integration.actor, set_by_kind: "integration" },
        { scope: "integration", user_id: null, end_date: "2090-04-30", set_by: setter.actor, set_by_kind: "user" },
        { scope: "all", user_id: null, end_date: null, set_by: setter.actor, set_by_kind: "user" },
      ]);
      // Each was set at a time after the first of these transactions started, and before now.
      const inWindow = await owner.query<{ within: boolean }>(
        "SELECT bool_and(t >= $1::timestamptz AND t <= pg_catalog.clock_timestamp()) AS within FROM pg_catalog.unnest($2::timestamptz[]) AS t",
        [started, rows.map((row) => row.set_at)],
      );
      expect(inWindow.rows[0]?.within).toBe(true);
    });

    it("names a user exactly on a user's row", async () => {
      const company = await addCompany(app);
      await expectError(setLock(app, company, "user", "2090-01-31"), CHECK_VIOLATION, /period_locks_user_only_for_user/);
      for (const scope of ["system", "integration", "all"] as const) {
        await expectError(setLock(app, company, scope, "2090-01-31", { user: userOne.actor }), CHECK_VIOLATION, /period_locks_user_only_for_user/);
      }
      await expectError(asApp(company, "INSERT INTO ledger.period_locks (company_id, scope) VALUES ($1, 'everyone')", [company]), CHECK_VIOLATION);
    });

    it("refuses a second row for one scope, or for one user", async () => {
      const company = await addCompany(app);
      const insert = "INSERT INTO ledger.period_locks (company_id, scope, user_id, end_date) VALUES ($1, $2, $3, '2090-01-31')";
      for (const [scope, user] of [
        ["user", userOne.actor],
        ["system", null],
        ["integration", null],
        ["all", null],
      ] as const) {
        await asApp(company, insert, [company, scope, user]);
        await expectError(asApp(company, insert, [company, scope, user]), UNIQUE_VIOLATION, /period_locks_one_per_scope/);
      }
      // Another user has a row of its own.
      await asApp(company, insert, [company, "user", userTwo.actor]);
      expect((await locksOf(company)).length).toBe(5);
    });

    it("sets who and when itself: a given value is refused, and so is a change of a row's scope, user or id", async () => {
      const company = await addCompany(app);
      for (const [column, value] of [
        ["set_by", randomUUID()],
        ["set_by_kind", "user"],
        ["set_at", "2026-01-01T00:00:00Z"],
      ] as const) {
        await expectRefusal(
          asApp(company, `INSERT INTO ledger.period_locks (company_id, scope, end_date, ${column}) VALUES ($1, 'all', '2090-01-31', $2)`, [company, value]),
          "immutable_field",
          { field: column, operation: "create" },
        );
      }
      const lock = await setLock(app, company, "user", "2090-01-31", { user: userOne.actor });
      for (const [set, field] of [
        [`set_by = '${randomUUID()}'`, "set_by"],
        ["set_by_kind = 'system'", "set_by_kind"],
        ["set_at = '2026-01-01T00:00:00Z'", "set_at"],
        ["scope = 'all', user_id = NULL", "scope"],
        [`user_id = '${userTwo.actor}'`, "user_id"],
        [`id = '${randomUUID()}'`, "id"],
      ] as const) {
        await expectRefusal(asApp(company, `UPDATE ledger.period_locks SET ${set} WHERE id = $1`, [lock.id]), "immutable_field", {
          field,
          operation: "update",
        });
      }
      expect(await locksOf(company)).toEqual([lock]);
    });

    it("lets the app set, change and clear a date, but never delete a row", async () => {
      const company = await addCompany(app);
      const lock = await setLock(app, company, "all", "2090-01-31");
      expect((await setLock(app, company, "all", "2090-06-30")).end_date).toBe("2090-06-30");
      expect((await setLock(app, company, "all", "2089-12-31")).end_date).toBe("2089-12-31");
      expect((await setLock(app, company, "all", null)).end_date).toBeNull();
      await expectError(asApp(company, "DELETE FROM ledger.period_locks WHERE id = $1", [lock.id]), INSUFFICIENT_PRIVILEGE, /permission denied/);
      expect((await locksOf(company)).map((row) => row.id)).toEqual([lock.id]);
    });

    it("leaves the other dates, and who set them and when, as they were when one date is changed or cleared", async () => {
      const company = await addCompany(app);
      await setLock(app, company, "user", "2090-01-31", { user: userOne.actor });
      await setLock(app, company, "user", "2090-02-28", { user: userTwo.actor });
      await setLock(app, company, "system", "2090-03-31");
      await setLock(app, company, "integration", "2090-04-30");
      await setLock(app, company, "all", "2090-05-31");
      let before = await locksOf(company);
      const changes: readonly { scope: LockScope; end: string | null; user?: string }[] = [
        { scope: "all", end: "2090-12-31" },
        { scope: "all", end: "2089-12-31" },
        { scope: "all", end: null },
        { scope: "system", end: null },
        { scope: "user", end: "2089-06-30", user: userOne.actor },
        { scope: "integration", end: "2091-01-31" },
        { scope: "all", end: "2090-05-31" },
      ];
      for (const { scope, end, user } of changes) {
        const changed = await setLock(app, company, scope, end, user === undefined ? { who: userTwo } : { user, who: userTwo });
        expect(changed).toMatchObject({ end_date: end, set_by: userTwo.actor });
        const after = await locksOf(company);
        expect(after.filter((row) => row.id !== changed.id), `after ${scope} set to ${String(end)}`).toEqual(
          before.filter((row) => row.id !== changed.id),
        );
        before = after;
      }
    });

    it("writes a history row with the old and the new date, the actor and its kind, for each change of a lock date", async () => {
      const company = await addCompany(app);
      const set = await setLock(app, company, "system", "2090-01-31", { who: setter });
      await setLock(app, company, "system", "2090-06-30", { who: system });
      await setLock(app, company, "system", null, { who: integration });
      const found = await inTransaction(app, { company }, async () =>
        app.query<{ operation: string; old: string | null; new: string | null; actor_id: string; actor_kind: string }>(
          `SELECT operation, old_values ->> 'end_date' AS old, new_values ->> 'end_date' AS new, actor_id, actor_kind
           FROM audit.history WHERE table_name = 'ledger.period_locks' AND row_id = $1 ORDER BY id`,
          [set.id],
        ),
      );
      expect(found.rows).toEqual([
        { operation: "INSERT", old: null, new: "2090-01-31", actor_id: setter.actor, actor_kind: "user" },
        { operation: "UPDATE", old: "2090-01-31", new: "2090-06-30", actor_id: system.actor, actor_kind: "system" },
        { operation: "UPDATE", old: "2090-06-30", new: null, actor_id: integration.actor, actor_kind: "integration" },
      ]);
    });

    it("writes a history row when the automatic lock is turned on and when it is turned off", async () => {
      const company = await addCompany(app, setter);
      await setAutomaticLock(app, company, "quarter_end_50", system);
      const off = await setAutomaticLock(app, company, null, integration);
      expect(off).toMatchObject({ enabled: false, interval: "quarter_end_50", set_by: integration.actor, set_by_kind: "integration" });
      const found = await inTransaction(app, { company }, async () =>
        app.query<{ operation: string; old: string | null; new: string | null; actor_id: string; actor_kind: string }>(
          `SELECT operation, old_values ->> 'enabled' AS old, new_values ->> 'enabled' AS new, actor_id, actor_kind
           FROM audit.history WHERE table_name = 'ledger.automatic_locks' AND row_id = $1 ORDER BY id`,
          [off.id],
        ),
      );
      expect(found.rows).toEqual([
        { operation: "INSERT", old: null, new: "false", actor_id: setter.actor, actor_kind: "user" },
        { operation: "UPDATE", old: "false", new: "true", actor_id: system.actor, actor_kind: "system" },
        { operation: "UPDATE", old: "true", new: "false", actor_id: integration.actor, actor_kind: "integration" },
      ]);
    });
  });

  describe("whom each date locks", () => {
    const END = "2090-06-30";
    const cases: readonly { scope: LockScope; user?: ActorName; locks: readonly ActorName[] }[] = [
      { scope: "user", user: "userOne", locks: ["userOne"] },
      { scope: "system", locks: ["system", "systemWithOnesId"] },
      { scope: "integration", locks: ["integration", "integrationWithOnesId"] },
      { scope: "all", locks: ["userOne", "userTwo", "system", "integration", "systemWithOnesId", "integrationWithOnesId"] },
    ];

    it.each(cases)("locks a date set only for $scope $user for those it applies to, the date itself included, and no one else, not the system user or an integration with the user's id", async ({ scope, user, locks }) => {
      const company = await addCompany(app);
      const lock = await setLock(app, company, scope, END, user === undefined ? { who: setter } : { user: ACTORS[user].actor, who: setter });
      for (const name of Object.keys(ACTORS) as ActorName[]) {
        const who = ACTORS[name];
        const applies = locks.includes(name);
        for (const day of [END, "2090-06-29", "2090-01-01", "1990-01-01"]) {
          expect(await covering(company, who, day), `${name} on ${day}`).toEqual(applies ? manual(lock) : undefined);
        }
        expect(await covering(company, who, "2090-07-01"), `${name} on the day after`).toBeUndefined();
        expect(await lockedThrough(company, who), name).toBe(applies ? END : null);
      }
    });

    it("locks nothing with a cleared date, nor with no row at all", async () => {
      const company = await addCompany(app);
      for (const who of Object.values(ACTORS)) {
        expect(await covering(company, who, "1990-01-01")).toBeUndefined();
        expect(await lockedThrough(company, who)).toBeNull();
      }
      await setLock(app, company, "all", END);
      await setLock(app, company, "all", null);
      await setLock(app, company, "system", null);
      for (const who of Object.values(ACTORS)) {
        expect(await covering(company, who, "1990-01-01")).toBeUndefined();
        expect(await lockedThrough(company, who)).toBeNull();
      }
    });

    it("locks up to the later of two dates that apply to one actor, and names the lock with the later date", async () => {
      const company = await addCompany(app);
      const own = await setLock(app, company, "user", "2090-03-31", { user: userOne.actor });
      const all = await setLock(app, company, "all", "2090-06-30");
      // The all-users date is later: it locks userOne through June, and it is the lock that covers March too.
      expect(await covering(company, userOne, "2090-03-15")).toEqual(manual(all));
      expect(await covering(company, userOne, "2090-06-30")).toEqual(manual(all));
      expect(await covering(company, userOne, "2090-07-01")).toBeUndefined();
      expect(await lockedThrough(company, userOne)).toBe("2090-06-30");
      // Now the user's own date is later.
      const later = await setLock(app, company, "user", "2090-09-30", { user: userOne.actor });
      expect(later.id).toBe(own.id);
      expect(await covering(company, userOne, "2090-03-15")).toEqual(manual(later));
      expect(await covering(company, userOne, "2090-09-30")).toEqual(manual(later));
      expect(await covering(company, userOne, "2090-10-01")).toBeUndefined();
      expect(await lockedThrough(company, userOne)).toBe("2090-09-30");
      // Another user keeps the all-users date.
      expect(await covering(company, userTwo, "2090-07-01")).toBeUndefined();
      expect(await lockedThrough(company, userTwo)).toBe("2090-06-30");
      // The same for the internal system user and for integrations.
      const systemLock = await setLock(app, company, "system", "2090-12-31");
      expect(await covering(company, system, "2090-11-30")).toEqual(manual(systemLock));
      expect(await covering(company, system, "2090-05-31")).toEqual(manual(systemLock));
      expect(await lockedThrough(company, system)).toBe("2090-12-31");
      const integrationLock = await setLock(app, company, "integration", "2090-01-31");
      expect(await covering(company, integration, "2090-01-15")).toEqual(manual(all));
      expect(await lockedThrough(company, integration)).toBe("2090-06-30");
      expect(integrationLock.end_date).toBe("2090-01-31");
    });

    it("names the actor's own lock when it ends on the same day as the all-users lock", async () => {
      const company = await addCompany(app);
      const all = await setLock(app, company, "all", END);
      const own = await setLock(app, company, "user", END, { user: userOne.actor });
      const systemLock = await setLock(app, company, "system", END);
      expect(await covering(company, userOne, END)).toEqual(manual(own));
      expect(await covering(company, userTwo, END)).toEqual(manual(all));
      expect(await covering(company, system, END)).toEqual(manual(systemLock));
      expect(await covering(company, integration, END)).toEqual(manual(all));
    });
  });

  describe("the automatic lock", () => {
    /** With "50 days after the end of the month", this day locks through 2090-06-30. */
    const LOCKS_JUNE = "2090-08-25";

    it("locks a date on or before its date for every actor, and names its interval", async () => {
      const company = await addCompany(app);
      await setAutomaticLock(app, company, "month_end_50");
      for (const who of Object.values(ACTORS)) {
        expect(await covering(company, who, "2090-06-30", LOCKS_JUNE)).toEqual(automatic("2090-06-30", "month_end_50"));
        expect(await covering(company, who, "2090-01-01", LOCKS_JUNE)).toEqual(automatic("2090-06-30", "month_end_50"));
        expect(await covering(company, who, "2090-07-01", LOCKS_JUNE)).toBeUndefined();
        expect(await lockedThrough(company, who, LOCKS_JUNE)).toBe("2090-06-30");
      }
    });

    it("locks nothing once it is turned off", async () => {
      const company = await addCompany(app);
      await setAutomaticLock(app, company, "month_end_50");
      await setAutomaticLock(app, company, null);
      for (const who of Object.values(ACTORS)) {
        expect(await covering(company, who, "1990-01-01", LOCKS_JUNE)).toBeUndefined();
        expect(await lockedThrough(company, who, LOCKS_JUNE)).toBeNull();
      }
    });

    it("locks up to the later of the automatic and a manual date, and names the manual lock when they end on the same day", async () => {
      const company = await addCompany(app);
      await setAutomaticLock(app, company, "month_end_50");
      const all = await setLock(app, company, "all", "2090-03-31");
      expect(await covering(company, userOne, "2090-03-31", LOCKS_JUNE)).toEqual(automatic("2090-06-30", "month_end_50"));
      expect(await lockedThrough(company, system, LOCKS_JUNE)).toBe("2090-06-30");
      const later = await setLock(app, company, "all", "2090-09-30");
      expect(later.id).toBe(all.id);
      expect(await covering(company, userOne, "2090-03-31", LOCKS_JUNE)).toEqual(manual(later));
      expect(await lockedThrough(company, integration, LOCKS_JUNE)).toBe("2090-09-30");
      const same = await setLock(app, company, "all", "2090-06-30");
      const own = await setLock(app, company, "integration", "2090-06-30");
      expect(await covering(company, userOne, "2090-06-30", LOCKS_JUNE)).toEqual(manual(same));
      expect(await covering(company, integration, "2090-06-30", LOCKS_JUNE)).toEqual(manual(own));
    });
  });

  describe("its reads", () => {
    it("refuses an actor kind it does not know, and a user with no id", async () => {
      const company = await addCompany(app);
      for (const [kind, actor] of [
        ["robot", randomUUID()],
        ["", randomUUID()],
        ["user", null],
      ] as const) {
        await expectError(
          asApp(company, "SELECT * FROM ledger.lock_covering($1, $2, $3, '2090-01-01', $4)", [company, kind, actor, TODAY]),
          "22023",
          /The period lock needs the actor's kind \(user, system or integration\), and a user's id/,
        );
        await expectError(
          asApp(company, "SELECT ledger.locked_through($1, $2, $3, $4)", [company, kind, actor, TODAY]),
          "22023",
          /The period lock needs the actor's kind \(user, system or integration\), and a user's id/,
        );
      }
    });

    it("reads only the locks of the transaction's company", async () => {
      const locked = await addCompany(app);
      const other = await addCompany(app);
      await setLock(app, locked, "all", "2090-06-30");
      await setAutomaticLock(app, locked, "month_end_50");
      const found = await inTransaction(app, { company: other, ...userOne }, async () =>
        app.query("SELECT * FROM ledger.lock_covering($1, 'user', $2, '1990-01-01', '2090-08-25')", [locked, userOne.actor]),
      );
      expect(found.rows).toEqual([]);
      expect(await covering(locked, userOne, "1990-01-01", "2090-08-25")).toMatchObject({ source: "all" });
    });
  });

  describe("ledger.assert_open, which the voucher triggers call (as the owner, the role they run as)", () => {
    async function assertOpen(company: string, day: string, closing: boolean, who: Actor): Promise<void> {
      await inTransaction(owner, { company, ...who }, () => owner.query("SELECT ledger.assert_open($1, $2, $3)", [company, day, closing]));
    }

    async function setAtAsJson(company: string, id: string): Promise<string> {
      const found = await inTransaction(owner, { company }, () =>
        owner.query<{ at: string }>("SELECT pg_catalog.to_jsonb(set_at) #>> '{}' AS at FROM ledger.period_locks WHERE id = $1", [id]),
      );
      return found.rows[0]?.at ?? "";
    }

    it("refuses a date inside a manual lock with the through-date, the row it comes from and who set it", async () => {
      const company = await addCompany(app);
      const own = await setLock(app, company, "user", "2090-06-30", { user: userOne.actor, who: setter });
      const systemLock = await setLock(app, company, "system", "2090-03-31", { who: integration });
      const ownSetAt = await setAtAsJson(company, own.id);
      const systemSetAt = await setAtAsJson(company, systemLock.id);
      await expectRefusal(assertOpen(company, "2090-06-30", false, userOne), "period_locked_manual", {
        end_date: "2090-06-30",
        source: "user",
        user_id: userOne.actor,
        set_by: setter.actor,
        set_by_kind: "user",
        set_at: ownSetAt,
      });
      await expectRefusal(assertOpen(company, "2090-01-01", false, system), "period_locked_manual", {
        end_date: "2090-03-31",
        source: "system",
        user_id: null,
        set_by: integration.actor,
        set_by_kind: "integration",
        set_at: systemSetAt,
      });
      // Open for the others, and after the date.
      await assertOpen(company, "2090-06-30", false, userTwo);
      await assertOpen(company, "2090-06-30", false, integration);
      await assertOpen(company, "2090-07-01", false, userOne);
      await assertOpen(company, "2090-04-01", false, system);
    });

    it("refuses a date inside the automatic lock with its date and interval, on the day in Sweden", async () => {
      const company = await addCompany(app);
      await setAutomaticLock(app, company, "month_end_50");
      const through = await inTransaction(app, { company }, async () => {
        const found = await app.query<{ through: string }>("SELECT ledger.automatic_lock_end_date($1, ledger.today_in_sweden())::text AS through", [company]);
        return found.rows[0]?.through ?? "";
      });
      expect(through).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const who of Object.values(ACTORS)) {
        await expectRefusal(assertOpen(company, "2020-05-15", false, who), "period_locked_automatic", { end_date: through, interval: "month_end_50" });
        await expectRefusal(assertOpen(company, through, false, who), "period_locked_automatic", { end_date: through, interval: "month_end_50" });
        await assertOpen(company, "2090-01-01", false, who);
      }
    });

    it("lets the closing series through every lock", async () => {
      const company = await addCompany(app);
      await setAutomaticLock(app, company, "month_end_50");
      await setLock(app, company, "all", "2090-06-30");
      for (const who of Object.values(ACTORS)) {
        await assertOpen(company, "2020-05-15", true, who);
        await assertOpen(company, "2090-06-30", true, who);
        await expectRefusal(assertOpen(company, "2090-06-30", false, who), "period_locked_manual");
      }
    });

    it("needs an actor", async () => {
      const company = await addCompany(app);
      await expectRefusal(
        inTransaction(owner, { company }, () => owner.query("SELECT ledger.assert_open($1, '2090-01-01', false)", [company])),
        "actor_missing",
        { setting: "nortfox.actor_id" },
      );
    });
  });
});
