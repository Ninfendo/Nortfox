// SPDX-License-Identifier: AGPL-3.0-only

// M10 (issue 12, "Users in a company" 7): a company always has at least one
// active system administrator. Removing, deactivating or demoting the last
// one, and the last one leaving, are refused through REST with 422
// last-system-administrator: the server refuses each early, with its own
// check, and the database stays the authority, refusing at the commit what
// a race got past that check. So of two system administrators who remove
// each other at once, of a removal and a demotion at once, of two who leave
// at once, and of a removal and a leave at once, exactly one succeeds and
// the other gets the same code. Each case asserts the code, never only the
// status.
//
// This is the REST half of slice 2c. The last one deleting their identity
// comes in part 6, and the same paths through MCP once MCP clients sign in
// (part 5): each extends this file.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { expectRefusal, freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { changeMembership } from "../../../test/memberships.ts";
import {
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  holdingWrites,
  jsonOf,
  signInApp,
  testClock,
  type SignInApp,
} from "../../../test/sign-in.ts";
import { apiCompany, calls, newMember, sessionIn, type ApiCompany, type TestMember } from "../../../test/users.ts";

interface Row {
  readonly status: string;
  readonly admin_level: string | null;
}

describe("the last system administrator", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let superuser: Client;
  let pool: AppPool;
  let server: SignInApp;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    superuser = await db.admin();
    pool = appPool(db, 6);
    server = signInApp(pool.database, { clock: testClock(new Date()) });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** The refusal of each path, for `company`. */
  function lastAdministrator(company: ApiCompany): ProblemBody {
    return {
      type: "about:blank",
      title: "Unprocessable Content",
      status: 422,
      detail: "A company needs at least one active system administrator.",
      code: "last-system-administrator",
      data: { companyId: company.id },
    };
  }

  async function rowsOf(company: ApiCompany): Promise<Readonly<Record<string, Row>>> {
    const found = await superuser.query<Row & { id: string }>("SELECT id, status, admin_level FROM access.memberships WHERE company_id = $1", [company.id]);
    return Object.fromEntries(found.rows.map((row) => [row.id, { status: row.status, admin_level: row.admin_level }]));
  }

  /** A company with its owner, and a second system administrator who works in it. */
  async function twoAdministrators(): Promise<{ company: ApiCompany; admin: TestMember; adminSession: string }> {
    const company = await apiCompany(server, { app, owner });
    const admin = await newMember(server, { app, owner }, company);
    expect((await calls.updateUser(server, company.session, admin.id, { adminLevel: "admin" })).status).toBe(200);
    const adminSession = await sessionIn(server, admin.person, company.id);
    return { company, admin, adminSession };
  }

  describe("each path is refused by REST with last-system-administrator", () => {
    it("deactivating the last one", async () => {
      const company = await apiCompany(server, { app, owner });
      // An inactive system administrator does not count.
      const inactive = await newMember(server, { app, owner }, company);
      await calls.updateUser(server, company.session, inactive.id, { adminLevel: "admin", active: false });
      const before = await rowsOf(company);
      expect(await jsonOf<ProblemBody>(await calls.updateUser(server, company.session, company.membership, { active: false }), 422)).toEqual(lastAdministrator(company));
      expect(await rowsOf(company)).toEqual(before);
    });

    it("demoting the last one", async () => {
      const company = await apiCompany(server, { app, owner });
      const before = await rowsOf(company);
      expect(await jsonOf<ProblemBody>(await calls.updateUser(server, company.session, company.membership, { adminLevel: null }), 422)).toEqual(lastAdministrator(company));
      // With the rest of the change, nothing of it is kept.
      expect(await jsonOf<ProblemBody>(await calls.updateUser(server, company.session, company.membership, { adminLevel: null, idleTimeout: 30 }), 422)).toEqual(
        lastAdministrator(company),
      );
      expect(await rowsOf(company)).toEqual(before);
    });

    it("removing the last one", async () => {
      // The second system administrator is demoted, and their session, which chose the company before, keeps users:admin until it chooses again (R11).
      const { company, admin, adminSession } = await twoAdministrators();
      expect((await calls.updateUser(server, company.session, admin.id, { adminLevel: null })).status).toBe(200);
      const before = await rowsOf(company);
      expect(await jsonOf<ProblemBody>(await calls.removeUser(server, adminSession, company.membership), 422)).toEqual(lastAdministrator(company));
      expect(await jsonOf<ProblemBody>(await calls.updateUser(server, adminSession, company.membership, { active: false }), 422)).toEqual(lastAdministrator(company));
      expect(await rowsOf(company)).toEqual(before);
    });

    it("the last one leaving", async () => {
      const { company, admin, adminSession } = await twoAdministrators();
      expect((await calls.leaveCompany(server, adminSession, company.id)).status).toBe(204);
      const before = await rowsOf(company);
      expect(await jsonOf<ProblemBody>(await calls.leaveCompany(server, company.session, company.id), 422)).toEqual(lastAdministrator(company));
      expect(await rowsOf(company)).toEqual(before);
      expect(before[admin.id]).toEqual({ status: "left", admin_level: "admin" });
    });

    it("but not one of two: the other stays", async () => {
      const { company, admin } = await twoAdministrators();
      expect((await calls.updateUser(server, company.session, admin.id, { adminLevel: null })).status).toBe(200);
      expect((await calls.updateUser(server, company.session, admin.id, { adminLevel: "admin" })).status).toBe(200);
      expect((await calls.removeUser(server, company.session, admin.id)).status).toBe(204);
      expect((await rowsOf(company))[company.membership]).toEqual({ status: "active", admin_level: "owner" });
    });
  });

  /**
   * Runs `first` through a server whose write waits before its commit, with
   * its row locks held, until `second` has run to its answer; then lets the
   * first commit. Gives both answers, the first's first.
   */
  async function oneAfterTheOther(
    first: (racer: SignInApp) => Promise<Response>,
    second: () => Promise<Response>,
  ): Promise<readonly [Response, Response]> {
    const holding = holdingWrites(pool.database, () => true, "commit");
    const racer = signInApp(holding.database, { clock: server.clock });
    const running = first(racer);
    await holding.gate.reached;
    const done = await second();
    holding.gate.open();
    return [await running, done];
  }

  it("of two system administrators removing each other in parallel, exactly one succeeds", async () => {
    const { company, admin, adminSession } = await twoAdministrators();
    // Both read two active system administrators, so both pass the early check: the database refuses the second at its commit.
    const [first, second] = await oneAfterTheOther(
      (racer) => calls.removeUser(racer, company.session, admin.id),
      () => calls.removeUser(server, adminSession, company.membership),
    );
    expect(second.status).toBe(204);
    expect(await jsonOf<ProblemBody>(first, 422)).toEqual(lastAdministrator(company));
    const rows = await rowsOf(company);
    expect(rows[company.membership]).toEqual({ status: "removed", admin_level: "owner" });
    expect(rows[admin.id]).toEqual({ status: "active", admin_level: "admin" });
  });

  it("a removal racing a demotion: exactly one succeeds, in either order", async () => {
    {
      const { company, admin, adminSession } = await twoAdministrators();
      const [removal, demotion] = await oneAfterTheOther(
        (racer) => calls.removeUser(racer, company.session, admin.id),
        () => calls.updateUser(server, adminSession, company.membership, { adminLevel: null }),
      );
      expect(demotion.status).toBe(200);
      expect(await jsonOf<ProblemBody>(removal, 422)).toEqual(lastAdministrator(company));
      const rows = await rowsOf(company);
      expect(rows[company.membership]).toEqual({ status: "active", admin_level: null });
      expect(rows[admin.id]).toEqual({ status: "active", admin_level: "admin" });
    }
    {
      const { company, admin, adminSession } = await twoAdministrators();
      const [demotion, removal] = await oneAfterTheOther(
        (racer) => calls.updateUser(racer, adminSession, company.membership, { adminLevel: null }),
        () => calls.removeUser(server, company.session, admin.id),
      );
      expect(removal.status).toBe(204);
      expect(await jsonOf<ProblemBody>(demotion, 422)).toEqual(lastAdministrator(company));
      const rows = await rowsOf(company);
      expect(rows[company.membership]).toEqual({ status: "active", admin_level: "owner" });
      expect(rows[admin.id]).toEqual({ status: "removed", admin_level: "admin" });
    }
  });

  it("of two system administrators leaving in parallel, exactly one succeeds", async () => {
    const { company, admin, adminSession } = await twoAdministrators();
    const [first, second] = await oneAfterTheOther(
      (racer) => calls.leaveCompany(racer, company.session, company.id),
      () => calls.leaveCompany(server, adminSession, company.id),
    );
    expect(second.status).toBe(204);
    expect(await jsonOf<ProblemBody>(first, 422)).toEqual(lastAdministrator(company));
    const rows = await rowsOf(company);
    expect(rows[company.membership]).toEqual({ status: "active", admin_level: "owner" });
    expect(rows[admin.id]).toEqual({ status: "left", admin_level: "admin" });
  });

  it("a removal racing a leave: exactly one succeeds, in either order", async () => {
    // A third member was a system administrator, and their session, which chose the company before, keeps users:admin (R11).
    async function withStaleAdministrator(): Promise<{ company: ApiCompany; admin: TestMember; adminSession: string; staleSession: string }> {
      const made = await twoAdministrators();
      const stale = await newMember(server, { app, owner }, made.company);
      expect((await calls.updateUser(server, made.company.session, stale.id, { adminLevel: "admin" })).status).toBe(200);
      const staleSession = await sessionIn(server, stale.person, made.company.id);
      expect((await calls.updateUser(server, made.company.session, stale.id, { adminLevel: null })).status).toBe(200);
      return { ...made, staleSession };
    }
    {
      const { company, admin, adminSession, staleSession } = await withStaleAdministrator();
      const [leave, removal] = await oneAfterTheOther(
        (racer) => calls.leaveCompany(racer, adminSession, company.id),
        () => calls.removeUser(server, staleSession, company.membership),
      );
      expect(removal.status).toBe(204);
      expect(await jsonOf<ProblemBody>(leave, 422)).toEqual(lastAdministrator(company));
      const rows = await rowsOf(company);
      expect(rows[company.membership]).toEqual({ status: "removed", admin_level: "owner" });
      expect(rows[admin.id]).toEqual({ status: "active", admin_level: "admin" });
    }
    {
      const { company, admin, adminSession, staleSession } = await withStaleAdministrator();
      const [removal, leave] = await oneAfterTheOther(
        (racer) => calls.removeUser(racer, staleSession, company.membership),
        () => calls.leaveCompany(server, adminSession, company.id),
      );
      expect(leave.status).toBe(204);
      expect(await jsonOf<ProblemBody>(removal, 422)).toEqual(lastAdministrator(company));
      const rows = await rowsOf(company);
      expect(rows[company.membership]).toEqual({ status: "active", admin_level: "owner" });
      expect(rows[admin.id]).toEqual({ status: "left", admin_level: "admin" });
    }
  });

  it("a deactivation racing a demotion: exactly one succeeds", async () => {
    const { company, admin, adminSession } = await twoAdministrators();
    const [deactivation, demotion] = await oneAfterTheOther(
      (racer) => calls.updateUser(racer, company.session, admin.id, { active: false }),
      () => calls.updateUser(server, adminSession, company.membership, { adminLevel: null }),
    );
    expect(demotion.status).toBe(200);
    expect(await jsonOf<ProblemBody>(deactivation, 422)).toEqual(lastAdministrator(company));
    expect((await rowsOf(company))[admin.id]).toEqual({ status: "active", admin_level: "admin" });
  });

  it("the database refuses at the commit what the server's own check would refuse, as SQL from the app", async () => {
    const company = await apiCompany(server, { app, owner });
    await expectRefusal(changeMembership(app, company, company.membership, "status = 'inactive'"), "last_system_administrator", { company_id: company.id });
    expect((await rowsOf(company))[company.membership]).toEqual({ status: "active", admin_level: "owner" });
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
