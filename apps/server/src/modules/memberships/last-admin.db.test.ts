// SPDX-License-Identifier: AGPL-3.0-only

// A company always has at least one active system administrator, from its
// first commit (issue 12, behaviour 7 of "Users in a company"). At the commit
// of each transaction that makes a company or changes a membership, the
// database checks the company, and refuses the commit with
// last_system_administrator when no active member of the owner or the admin
// level is left. The check locks the company's row before it reads, so two
// changes at once, which each take away one of the last two, never both
// commit.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backendPid, begin, expectRefusal, failureOf, freshDatabase, inTransaction, untilWaitingForLock, type TestDatabase } from "../../../test/database.ts";
import { addIdentity } from "../../../test/identities.ts";
import { insertCompany, insertOwner } from "../../../test/ledger.ts";
import { aCompany, addMembership, changeMembership, membershipIn, membershipOf, type Company } from "../../../test/memberships.ts";
import { readRefusal } from "../../db/refusals.ts";

/** A change that takes a system administrator away, and whether the member makes it, as a leave. */
interface TakeAway {
  readonly what: string;
  readonly set: string;
  readonly byMember: boolean;
}

const TAKE_AWAY: readonly TakeAway[] = [
  { what: "a demotion", set: "admin_level = NULL", byMember: false },
  { what: "a deactivation", set: "status = 'inactive'", byMember: false },
  { what: "a removal", set: "status = 'removed'", byMember: false },
  { what: "a disconnect", set: "status = 'invited', user_id = NULL", byMember: false },
  { what: "a leave", set: "status = 'left'", byMember: true },
];

describe("a company's system administrator", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
  });

  afterAll(async () => {
    await db.close();
  });

  /** How many active system administrators `company` has, as the app reads them. */
  async function administrators(company: string): Promise<number> {
    const found = await inTransaction(app, { company }, () =>
      app.query<{ count: bigint }>("SELECT count(*) AS count FROM access.memberships WHERE status = 'active' AND admin_level IS NOT NULL"),
    );
    return Number(found.rows[0]?.count);
  }

  /** Whether `company` exists, as the app reads it in that company. */
  async function exists(company: string): Promise<boolean> {
    const found = await inTransaction(app, { company }, () => app.query("SELECT FROM ledger.companies"));
    return found.rows.length === 1;
  }

  /** What a new company's transaction adds besides the company, by the company and its maker. */
  const MADE_WITH: readonly (readonly [string, (company: string, maker: string) => Promise<unknown>])[] = [
    ["no membership", () => Promise.resolve()],
    ["only an active member with no admin level", (company, maker) =>
      app.query("INSERT INTO access.memberships (company_id, user_id, status) VALUES ($1, $2, 'active')", [company, maker])],
    ["only an invited admin", (company) => app.query("INSERT INTO access.memberships (company_id, status, admin_level) VALUES ($1, 'invited', 'admin')", [company])],
    ["an owner made inactive in the same transaction", async (company, maker) => {
      const membership = await insertOwner(app, company, maker);
      await app.query("UPDATE access.memberships SET status = 'inactive' WHERE id = $1", [membership]);
    }],
  ];

  it.each(MADE_WITH)("refuses at its commit a company made with %s", async (_case, members) => {
    const company = randomUUID();
    const maker = await addIdentity(owner, { name: "Olof Rask" });
    await expectRefusal(
      inTransaction(app, { company, actor: maker, kind: "user", channel: "rest" }, async () => {
        await insertCompany(app, { id: company });
        await members(company, maker);
      }),
      "last_system_administrator",
      { company_id: company },
    );
    expect(await exists(company)).toBe(false);
  });

  it.each(TAKE_AWAY)("refuses at its commit $what of the last active system administrator, and keeps the membership as it was", async ({ set, byMember }) => {
    const company = await aCompany(app);
    const who = byMember ? { actor: company.owner, kind: "user" as const } : company.asOwner;
    await expectRefusal(changeMembership(app, company, company.membership, set, [], who), "last_system_administrator", { company_id: company.id });
    expect(await membershipOf(app, company.id, company.membership)).toMatchObject({ status: "active", admin_level: "owner", user_id: company.owner });
  });

  it.each(TAKE_AWAY)("lets $what through while another active system administrator is left, and refuses it for the last one", async ({ set, byMember }) => {
    const company = await aCompany(app);
    const admin = await addIdentity(owner, { name: "Petra Sund" });
    const second = await addMembership(app, owner, company, { user: admin, adminLevel: "admin" });
    expect(await administrators(company.id)).toBe(2);
    await changeMembership(app, company, company.membership, set, [], byMember ? { actor: company.owner, kind: "user" } : company.asOwner);
    expect(await administrators(company.id)).toBe(1);
    await expectRefusal(changeMembership(app, company, second, set, [], byMember ? { actor: admin, kind: "user" } : company.asOwner), "last_system_administrator", {
      company_id: company.id,
    });
    expect(await administrators(company.id)).toBe(1);
  });

  it("counts no inactive, invited, removed or left admin, and keeps the owner's change to the admin level", async () => {
    const company = await aCompany(app);
    for (const status of ["inactive", "removed", "left"] as const) {
      const { id } = await membershipIn(app, owner, company, "active");
      await changeMembership(app, company, id, "admin_level = 'admin'");
      await (status === "left"
        ? changeMembership(app, company, id, "status = 'left'", [], { actor: (await membershipOf(app, company.id, id))?.user_id ?? "", kind: "user" })
        : changeMembership(app, company, id, "status = $2", [status]));
    }
    await addMembership(app, owner, company, { status: "invited", adminLevel: "admin" });
    expect(await administrators(company.id)).toBe(1);
    await expectRefusal(changeMembership(app, company, company.membership, "admin_level = NULL"), "last_system_administrator", { company_id: company.id });
    expect(await changeMembership(app, company, company.membership, "admin_level = 'admin'")).toMatchObject({ admin_level: "admin" });
  });

  describe("whatever company the transaction set last", () => {
    it("checks each company it made, and sets the transaction's company back after the check", async () => {
      const [first, second] = [randomUUID(), randomUUID()];
      const maker = await addIdentity(owner, { name: "Rut Wall" });
      const kept = await inTransaction(app, { company: first, actor: maker, kind: "user" }, async () => {
        await insertCompany(app, { id: first });
        await insertOwner(app, first, maker);
        await app.query("SELECT pg_catalog.set_config('nortfox.company_id', $1, true)", [second]);
        await insertCompany(app, { id: second, name: "Testbolaget Beta AB" });
        await insertOwner(app, second, maker);
        await app.query("SET CONSTRAINTS ALL IMMEDIATE");
        return (await app.query<{ company: string }>("SELECT pg_catalog.current_setting('nortfox.company_id') AS company")).rows[0]?.company;
      });
      expect(kept).toBe(second);
      expect([await exists(first), await exists(second)]).toEqual([true, true]);
    });

    it("refuses the company that has no system administrator, when another company came after it", async () => {
      const [first, second] = [randomUUID(), randomUUID()];
      const maker = await addIdentity(owner, { name: "Sixten Borg" });
      await expectRefusal(
        inTransaction(app, { company: first, actor: maker, kind: "user" }, async () => {
          await insertCompany(app, { id: first });
          await app.query("SELECT pg_catalog.set_config('nortfox.company_id', $1, true)", [second]);
          await insertCompany(app, { id: second, name: "Testbolaget Beta AB" });
          await insertOwner(app, second, maker);
        }),
        "last_system_administrator",
        { company_id: first },
      );
    });
  });

  // Two system administrators, the owner and an admin, and two transactions
  // of the app that each demote one of them. Each commit waits for the
  // company's row, which a third transaction holds, so both reach the check
  // at once. Then the third lets go: one commits, and the other reads that
  // commit and is refused.
  describe("two demotions at once, as SQL from the app", () => {
    let others: Client[];

    beforeAll(async () => {
      others = [await db.connect("app"), await db.connect("app"), await db.connect("app"), await db.connect("app")];
    });

    it.each([
      ["the owner's demotion first", 0],
      ["the admin's demotion first", 1],
    ] as const)("leave one system administrator, %s", async (_order, firstIndex) => {
      const [demoteOwner, demoteAdmin, holder, watcher] = others as [Client, Client, Client, Client];
      const pids = new Map([
        [demoteOwner, await backendPid(demoteOwner)],
        [demoteAdmin, await backendPid(demoteAdmin)],
      ]);
      const company: Company = await aCompany(app);
      const admin = await addMembership(app, owner, company, { adminLevel: "admin" });
      await begin(demoteOwner, { company: company.id, ...company.asOwner });
      await demoteOwner.query("UPDATE access.memberships SET admin_level = NULL WHERE id = $1", [company.membership]);
      await begin(demoteAdmin, { company: company.id, ...company.asOwner });
      await demoteAdmin.query("UPDATE access.memberships SET admin_level = NULL WHERE id = $1", [admin]);
      await begin(holder, { company: company.id });
      await holder.query("SELECT FROM ledger.companies WHERE company_id = $1 FOR NO KEY UPDATE", [company.id]);
      const order = firstIndex === 0 ? [demoteOwner, demoteAdmin] : [demoteAdmin, demoteOwner];
      const commits: Promise<unknown>[] = [];
      for (const client of order) {
        commits.push(failureOf(client.query("COMMIT")));
        await untilWaitingForLock(watcher, pids.get(client) ?? 0);
      }
      await holder.query("ROLLBACK");
      const [firstFailure, secondFailure] = await Promise.all(commits);
      expect(firstFailure).toBeUndefined();
      expect(readRefusal(secondFailure)).toEqual({ reason: "last_system_administrator", code: "NF022", facts: { company_id: company.id } });
      expect(await administrators(company.id)).toBe(1);
      const kept = firstIndex === 0 ? admin : company.membership;
      expect((await membershipOf(app, company.id, kept))?.admin_level).not.toBeNull();
    });
  });
});
