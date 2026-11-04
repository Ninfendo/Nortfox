// SPDX-License-Identifier: AGPL-3.0-only

// The memberships (db/README.md, the schema access). A membership is a
// person in a company, and a company table: every change of it is in the
// behandlingshistorik. The database keeps the rules that no policy keeps,
// for every role: no membership is deleted; removed and left are final; a
// person has one live membership per company; the idle time is one of five
// values; the owner level comes only with the company's first membership; the
// status moves only along the server's operations, and the person changes
// only through a disconnect and an acceptance; and only the member's own
// person leaves. A session's chosen membership pairs with its company.

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
import { addIdentity, tokenHash } from "../../../test/identities.ts";
import { insertCompany } from "../../../test/ledger.ts";
import {
  STATUSES,
  aCompany,
  addMembership,
  asMember,
  changeMembership,
  membershipIn,
  membershipOf,
  type Company,
  type Status,
} from "../../../test/memberships.ts";

/** PostgreSQL's SQLSTATE for a foreign key that refused a row. */
const FOREIGN_KEY_VIOLATION = "23503";

/** The moves of the status that the server's operations make: accept or withdraw an invitation; deactivate, activate, disconnect, remove or leave. */
const ALLOWED: ReadonlySet<string> = new Set([
  "invited active",
  "invited removed",
  "active inactive",
  "active invited",
  "active removed",
  "active left",
  "inactive active",
  "inactive invited",
  "inactive removed",
  "inactive left",
]);

describe("the memberships", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let company: Company;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    company = await aCompany(app);
  });

  afterAll(async () => {
    await db.close();
  });

  it("makes the company's maker its owner: an active membership of the owner level, stamped by the database, with the idle time of 2 hours", async () => {
    const row = await membershipOf(app, company.id, company.membership);
    expect(row).toEqual({
      id: company.membership,
      company_id: company.id,
      user_id: company.owner,
      live_user_id: company.owner,
      status: "active",
      admin_level: "owner",
      idle_timeout_minutes: 120,
      created_at: expect.any(String) as unknown,
    });
  });

  it("deletes no membership, for the owner neither, and gives the app no DELETE", async () => {
    await expectError(asMember(app, company.id, company.asOwner, "DELETE FROM access.memberships WHERE id = $1", [company.membership]), INSUFFICIENT_PRIVILEGE, /permission denied/);
    await expectRefusal(
      inTransaction(owner, { company: company.id, ...company.asOwner }, () => owner.query("DELETE FROM access.memberships WHERE id = $1", [company.membership])),
      "append_only",
      { table: "access.memberships", operation: "DELETE" },
    );
    expect(await membershipOf(app, company.id, company.membership)).toMatchObject({ status: "active" });
  });

  it("takes the idle times of the established screen, 15, 30, 60, 120 and 480 minutes, and refuses every other", async () => {
    for (const idle of [15, 30, 60, 120, 480]) {
      const id = await addMembership(app, owner, company, { idle });
      expect((await membershipOf(app, company.id, id))?.idle_timeout_minutes).toBe(idle);
    }
    for (const idle of [0, 14, 45, 90, 240, 481, 1440]) {
      await expectError(addMembership(app, owner, company, { idle }), CHECK_VIOLATION, /memberships_idle_timeout_known/);
      await expectError(changeMembership(app, company, company.membership, "idle_timeout_minutes = $2", [idle]), CHECK_VIOLATION, /memberships_idle_timeout_known/);
    }
    expect(await changeMembership(app, company, company.membership, "idle_timeout_minutes = 480")).toMatchObject({ idle_timeout_minutes: 480 });
  });

  it("keeps one live membership per person and company, and lets a removed or left person in again", async () => {
    const person = await addIdentity(owner, { name: "Ivar Strand" });
    const first = await addMembership(app, owner, company, { user: person });
    await expectError(addMembership(app, owner, company, { user: person }), UNIQUE_VIOLATION, /memberships_one_live/);
    // In another company the person may be a member too, and two invitations wait side by side.
    const other = await aCompany(app, "Testbolaget Beta AB");
    await addMembership(app, owner, other, { user: person });
    await addMembership(app, owner, company, { status: "invited" });
    await addMembership(app, owner, company, { status: "invited" });
    // Removed, the person is no longer live in the company, and may be let in again.
    await changeMembership(app, company, first, "status = 'removed'");
    const again = await addMembership(app, owner, company, { user: person });
    // Left, the same.
    await changeMembership(app, company, again, "status = 'left'", [], { actor: person, kind: "user" });
    await addMembership(app, owner, company, { user: person });
    // A disconnected membership holds no person, so the person may hold another.
    const disconnected = await membershipIn(app, owner, company, "active");
    await changeMembership(app, company, disconnected.id, "status = 'invited', user_id = NULL");
    await addMembership(app, owner, company, { user: disconnected.user });
  });

  it("is made invited or active, and refuses a membership made inactive, removed or left", async () => {
    const person = await addIdentity(owner, { name: "Jenny Åberg" });
    for (const status of ["inactive", "removed", "left"]) {
      await expectRefusal(
        asMember(app, company.id, company.asOwner, "INSERT INTO access.memberships (company_id, user_id, status) VALUES ($1, $2, $3)", [company.id, person, status]),
        "immutable_field",
        { field: "status", operation: "create" },
      );
    }
    // An invitation holds no person yet, and a live membership holds one.
    await expectError(addMembership(app, owner, company, { status: "invited", user: person }), CHECK_VIOLATION, /memberships_user_by_status/);
    await expectError(addMembership(app, owner, company, { status: "active", user: null }), CHECK_VIOLATION, /memberships_user_by_status/);
  });

  it("stamps when a membership was made and its live person, refuses either when given, and never changes its id or its company", async () => {
    const insert = "INSERT INTO access.memberships (company_id, status, created_at) VALUES ($1, 'invited', pg_catalog.now())";
    await expectRefusal(asMember(app, company.id, company.asOwner, insert, [company.id]), "immutable_field", { field: "created_at", operation: "create" });
    await expectRefusal(
      asMember(app, company.id, company.asOwner, "INSERT INTO access.memberships (company_id, user_id, live_user_id, status) VALUES ($1, $2, $2, 'active')", [
        company.id,
        await addIdentity(owner),
      ]),
      "immutable_field",
      { field: "live_user_id", operation: "create" },
    );
    const { id } = await membershipIn(app, owner, company, "active");
    for (const [set, params, field] of [
      ["created_at = pg_catalog.now() - interval '1 day'", [], "created_at"],
      ["live_user_id = NULL", [], "live_user_id"],
      ["id = $2", [randomUUID()], "id"],
      ["company_id = $2", [(await aCompany(app, "Testbolaget Gamma AB")).id], "company_id"],
    ] as const) {
      await expectRefusal(changeMembership(app, company, id, set, params), "immutable_field", { field, operation: "update" });
    }
  });

  describe("the owner level", () => {
    it("comes only with the company's first membership, by its insert", async () => {
      for (const status of ["active", "invited"] as const) {
        await expectRefusal(addMembership(app, owner, company, { status, adminLevel: "owner" }), "immutable_field", { field: "admin_level", operation: "create" });
      }
      // Also when the first membership came earlier in the company's own transaction.
      const late = randomUUID();
      const maker = await addIdentity(owner, { name: "Kerstin Lövgren" });
      await expectRefusal(
        inTransaction(app, { company: late, actor: maker, kind: "user" }, async () => {
          await insertCompany(app, { id: late, name: "Testbolaget Delta AB", organizationNumber: "599999-0129" });
          await app.query("INSERT INTO access.memberships (company_id, status) VALUES ($1, 'invited')", [late]);
          await app.query("INSERT INTO access.memberships (company_id, user_id, status, admin_level) VALUES ($1, $2, 'active', 'owner')", [late, maker]);
        }),
        "immutable_field",
        { field: "admin_level", operation: "create" },
      );
      // The admin level is given freely.
      expect(await membershipOf(app, company.id, await addMembership(app, owner, company, { adminLevel: "admin" }))).toMatchObject({ admin_level: "admin" });
    });

    it("is never given by an update, from the admin level or from none, and the owner keeps it through other changes", async () => {
      for (const from of ["admin", null] as const) {
        const id = await addMembership(app, owner, company, { adminLevel: from });
        await expectRefusal(changeMembership(app, company, id, "admin_level = 'owner'"), "immutable_field", { field: "admin_level", operation: "update" });
      }
      expect(await changeMembership(app, company, company.membership, "idle_timeout_minutes = 60")).toMatchObject({ admin_level: "owner", idle_timeout_minutes: 60 });
      // The owner may become an admin, which keeps the company's system administrator.
      const other = await aCompany(app, "Testbolaget Epsilon AB");
      expect(await changeMembership(app, other, other.membership, "admin_level = 'admin'")).toMatchObject({ admin_level: "admin" });
      await expectRefusal(changeMembership(app, other, other.membership, "admin_level = 'owner'"), "immutable_field", { field: "admin_level", operation: "update" });
    });
  });

  describe("the status", () => {
    /** The change that moves a membership of `user` from `from` to `to`, and who makes it: the owner, or for a leave the member. */
    function move(from: Status, to: Status, user: string | null): { set: string; params: unknown[]; asMember: boolean } {
      if (from === "invited" && to !== "invited" && to !== "removed") {
        return { set: "status = $2, user_id = $3", params: [to, user], asMember: to === "left" };
      }
      if (to === "invited") {
        return { set: "status = 'invited', user_id = NULL", params: [], asMember: false };
      }
      return { set: "status = $2", params: [to], asMember: to === "left" };
    }

    it.each(STATUSES.flatMap((from) => STATUSES.filter((to) => to !== from).map((to) => [from, to] as const)))(
      "moves from %s to %s only as the server's operations do",
      async (from, to) => {
        const made = await membershipIn(app, owner, company, from);
        const person = made.user ?? (await addIdentity(owner, { name: "Lars Mattsson" }));
        const { set, params, asMember: byMember } = move(from, to, person);
        const changed = changeMembership(app, company, made.id, set, params, byMember ? { actor: person, kind: "user" } : company.asOwner);
        if (ALLOWED.has(`${from} ${to}`)) {
          expect(await changed).toMatchObject({ status: to, live_user_id: to === "removed" || to === "left" || to === "invited" ? null : person });
        } else {
          await expectRefusal(changed, "immutable_field", { field: "status", operation: "update" });
          expect((await membershipOf(app, company.id, made.id))?.status).toBe(from);
        }
      },
    );

    it("keeps a removed or left membership as it is, in every column", async () => {
      for (const status of ["removed", "left"] as const) {
        const { id } = await membershipIn(app, owner, company, status);
        for (const set of ["idle_timeout_minutes = 30", "admin_level = 'admin'"]) {
          await expectRefusal(changeMembership(app, company, id, set), "immutable_field", { field: "status", operation: "update" });
        }
        // A change that changes nothing changes nothing.
        expect(await changeMembership(app, company, id, "status = status")).toMatchObject({ status });
      }
    });

    it("lets only the member's own person leave: a user, or an integration that acts for that person, and never the system user or another person", async () => {
      const { id, user } = await membershipIn(app, owner, company, "active");
      for (const who of [company.asOwner, { actor: user ?? "", kind: "system" } as const]) {
        await expectRefusal(changeMembership(app, company, id, "status = 'left'", [], who), "immutable_field", { field: "status", operation: "update" });
      }
      expect(await changeMembership(app, company, id, "status = 'left'", [], { actor: user ?? "", kind: "integration" })).toMatchObject({ status: "left" });
      const inactive = await membershipIn(app, owner, company, "inactive");
      expect(await changeMembership(app, company, inactive.id, "status = 'left'", [], { actor: inactive.user ?? "", kind: "user" })).toMatchObject({
        status: "left",
        user_id: inactive.user,
        live_user_id: null,
      });
    });
  });

  describe("the person", () => {
    it("changes from one identity to another never directly, in any status", async () => {
      for (const status of ["active", "inactive"] as const) {
        const { id } = await membershipIn(app, owner, company, status);
        const other = await addIdentity(owner, { name: "Maja Nyberg" });
        await expectRefusal(changeMembership(app, company, id, "user_id = $2", [other]), "immutable_field", { field: "user_id", operation: "update" });
        // Not on its way to a disconnect, a removal or a deactivation either.
        for (const set of ["status = 'invited', user_id = $2", "status = 'removed', user_id = $2"]) {
          await expectRefusal(changeMembership(app, company, id, set, [other]), "immutable_field", { field: "user_id", operation: "update" });
        }
      }
    });

    it("empties only in a disconnect, and is set only in an acceptance", async () => {
      const { id, user } = await membershipIn(app, owner, company, "active");
      for (const set of ["user_id = NULL", "status = 'removed', user_id = NULL", "status = 'inactive', user_id = NULL"]) {
        await expectRefusal(changeMembership(app, company, id, set), "immutable_field", { field: "user_id", operation: "update" });
      }
      // A disconnect that keeps the person is no disconnect: an invited membership holds no person.
      await expectError(changeMembership(app, company, id, "status = 'invited'"), CHECK_VIOLATION, /memberships_user_by_status/);
      expect(await changeMembership(app, company, id, "status = 'invited', user_id = NULL")).toMatchObject({ status: "invited", user_id: null });
      // An acceptance sets a person, the same or another; one with no person is no acceptance.
      await expectError(changeMembership(app, company, id, "status = 'active'"), CHECK_VIOLATION, /memberships_user_by_status/);
      const other = await addIdentity(owner, { name: "Nils Öberg" });
      expect(await changeMembership(app, company, id, "status = 'active', user_id = $2", [other])).toMatchObject({
        status: "active",
        user_id: other,
        live_user_id: other,
      });
      expect(user).not.toBe(other);
      // An invited membership takes no person but by its acceptance.
      const invited = await addMembership(app, owner, company, { status: "invited" });
      await expectRefusal(changeMembership(app, company, invited, "user_id = $2", [other]), "immutable_field", { field: "user_id", operation: "update" });
    });

    it("keeps the old person in the history row of a disconnect", async () => {
      const { id, user } = await membershipIn(app, owner, company, "active");
      await changeMembership(app, company, id, "status = 'invited', user_id = NULL");
      const found = await inTransaction(app, { company: company.id }, () =>
        app.query<{ old: Record<string, unknown>; new: Record<string, unknown>; actor_id: string }>(
          `SELECT old_values AS old, new_values AS new, actor_id FROM audit.history
           WHERE table_name = 'access.memberships' AND row_id = $1 AND operation = 'UPDATE' ORDER BY id`,
          [id],
        ),
      );
      expect(found.rows).toEqual([
        {
          old: expect.objectContaining({ status: "active", user_id: user, live_user_id: user }) as unknown,
          new: expect.objectContaining({ status: "invited", user_id: null, live_user_id: null }) as unknown,
          actor_id: company.owner,
        },
      ]);
    });
  });

  describe("a session's chosen membership", () => {
    const insert = `INSERT INTO access.sessions (token_hash, identity_id, method, started_at, last_seen_at, current_company_id, current_membership_id, permissions)
                    VALUES ($1, $2, 'password-email', pg_catalog.now(), pg_catalog.now(), $3, $4, $5)`;

    it("pairs with its company, and comes with the permissions, or none of the three", async () => {
      const other = await aCompany(app, "Testbolaget Zeta AB");
      await owner.query(insert, [tokenHash(), company.owner, company.id, company.membership, { "company:read": null }]);
      await owner.query(insert, [tokenHash(), company.owner, null, null, null]);
      await expectError(
        owner.query(insert, [tokenHash(), company.owner, company.id, other.membership, {}]),
        FOREIGN_KEY_VIOLATION,
        /sessions_current_membership_fkey/,
      );
      for (const [chosen, membership, permissions] of [
        [company.id, null, null],
        [company.id, company.membership, null],
        [null, null, {}],
      ] as const) {
        await expectError(owner.query(insert, [tokenHash(), company.owner, chosen, membership, permissions]), CHECK_VIOLATION, /sessions_company_whole/);
      }
      await expectError(owner.query(insert, [tokenHash(), company.owner, company.id, company.membership, JSON.stringify(["company:read"])]), CHECK_VIOLATION, /sessions_permissions_object/);
    });
  });
});
