// SPDX-License-Identifier: AGPL-3.0-only

// The work e-mail address (issue 12, "Users in a company" 9; the owner's
// choice of 2026-11-05, as the established screen requires Epost): every
// active and inactive membership has one. updateMyMembership and a system
// administrator's updateUser refuse null for it, and both take the phone
// away with null. createCompany gives the owner the identity's personal
// e-mail as the work e-mail. When the rule arrives, migration 0009 gives each
// active and inactive membership without one its identity's e-mail, and
// leaves the invited, removed and left ones as they were. A change of the
// work contacts writes no behandlingshistorik entry. An invitation's address
// as the new member's work e-mail comes with the invitations, in the next
// step.

import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { emptyDatabase, freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { addIdentity } from "../../../test/identities.ts";
import { addCompanyWithOwner } from "../../../test/ledger.ts";
import { addMembership, aCompany, asMember, changeMembership, membershipIn, type Company } from "../../../test/memberships.ts";
import {
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  getAs,
  jsonOf,
  signInApp,
  testClock,
  writeAs,
  type SignInApp,
} from "../../../test/sign-in.ts";
import { apiCompany, calls, newMember, type ApiCompany } from "../../../test/users.ts";
import { migrate, readMigrations } from "../../db/migrate.ts";
import { tableGuardProblems } from "../../db/table-guard.ts";

interface Contacts {
  readonly work_email: string | null;
  readonly work_phone: string | null;
}

describe("the work e-mail address", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let superuser: Client;
  let pool: AppPool;
  let server: SignInApp;
  let company: ApiCompany;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    superuser = await db.admin();
    pool = appPool(db, 4);
    server = signInApp(pool.database, { clock: testClock(new Date()) });
    company = await apiCompany(server, { app, owner });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  async function contactsOf(membership: string): Promise<Contacts[]> {
    return (await superuser.query<Contacts>("SELECT work_email, work_phone FROM access.membership_contacts WHERE membership_id = $1", [membership])).rows;
  }

  async function historyCount(): Promise<number> {
    return Number((await superuser.query<{ n: string }>("SELECT count(*) AS n FROM audit.history WHERE company_id = $1", [company.id])).rows[0]?.n);
  }

  it("createCompany fills the owner's work e-mail from the identity's e-mail", async () => {
    expect(await contactsOf(company.membership)).toEqual([{ work_email: company.creator.email, work_phone: null }]);
    const me = await jsonOf<{ membership: { workEmail?: string } }>(await getAs(server, company.session, "/v1/me"));
    expect(me.membership.workEmail).toBe(company.creator.email);
  });

  it("updateMyMembership refuses null for the work e-mail, while the phone may be cleared", async () => {
    const path = `/v1/me/companies/${company.id}`;
    expect((await jsonOf<{ workPhone?: string }>(await writeAs(server, company.session, "PATCH", path, { workPhone: "070-174 06 07" }))).workPhone).toBe("070-174 06 07");
    const before = await historyCount();
    const problem = await jsonOf<ProblemBody>(await writeAs(server, company.session, "PATCH", path, { workEmail: null }), 400);
    expect(problem.errors).toEqual([{ code: "invalid-type", detail: "The field /workEmail must be a string.", pointer: "/workEmail", data: { expected: "string" } }]);
    expect(await contactsOf(company.membership)).toEqual([{ work_email: company.creator.email, work_phone: "070-174 06 07" }]);
    const cleared = await jsonOf<{ workEmail?: string; workPhone?: string }>(await writeAs(server, company.session, "PATCH", path, { workPhone: null }));
    expect(cleared).toMatchObject({ workEmail: company.creator.email });
    expect(cleared.workPhone).toBeUndefined();
    const changed = await jsonOf<{ workEmail?: string }>(await writeAs(server, company.session, "PATCH", path, { workEmail: "alva.arbete@example.org" }));
    expect(changed.workEmail).toBe("alva.arbete@example.org");
    expect(await contactsOf(company.membership)).toEqual([{ work_email: "alva.arbete@example.org", work_phone: null }]);
    // No change of the work contacts is in the behandlingshistorik.
    expect(await historyCount()).toBe(before);
  });

  it("updateUser refuses null for the work e-mail, while the phone may be cleared", async () => {
    const member = await newMember(server, { app, owner }, company);
    const set = await jsonOf<{ workEmail?: string; workPhone?: string }>(
      await calls.updateUser(server, company.session, member.id, { workEmail: "gunnar.arbete@example.com", workPhone: "070-174 06 11" }),
    );
    expect(set).toMatchObject({ workEmail: "gunnar.arbete@example.com", workPhone: "070-174 06 11" });
    const before = await historyCount();
    const problem = await jsonOf<ProblemBody>(await calls.updateUser(server, company.session, member.id, { workEmail: null, workPhone: null }), 400);
    expect(problem.errors).toEqual([{ code: "invalid-type", detail: "The field /workEmail must be a string.", pointer: "/workEmail", data: { expected: "string" } }]);
    expect(await contactsOf(member.id)).toEqual([{ work_email: "gunnar.arbete@example.com", work_phone: "070-174 06 11" }]);
    const cleared = await jsonOf<{ workEmail?: string; workPhone?: string }>(await calls.updateUser(server, company.session, member.id, { workPhone: null }));
    expect(cleared.workEmail).toBe("gunnar.arbete@example.com");
    expect(cleared.workPhone).toBeUndefined();
    expect(await contactsOf(member.id)).toEqual([{ work_email: "gunnar.arbete@example.com", work_phone: null }]);
    expect(await historyCount()).toBe(before);
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});

describe("migration 0009 on an install with memberships from before it", () => {
  const databases: TestDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  it("gives a membership that existed without one its identity's e-mail", async () => {
    const database = await emptyDatabase();
    databases.push(database);
    const migrator = await database.connect("owner");
    const before = readMigrations().filter((migration) => migration.name < "0009");
    expect(before.map((migration) => migration.name).at(-1)).toBe("0008_setup_new_link.sql");
    await migrate(migrator, before);
    const app = await database.connect("app");
    const owner = await database.connect("owner");
    // A company with its owner, as createCompany made it before 0009: no work contacts.
    const firstOwner = await addIdentity(owner, { email: "agnes.ager@example.com" });
    const made = await addCompanyWithOwner(app, { actor: firstOwner, kind: "user" });
    const company: Company = { ...made, id: made.row.company_id, asOwner: { actor: made.owner, kind: "user" } };
    // An active member with only a phone, an inactive one, one with a work e-mail of their own, and invited, removed and left ones.
    const withPhone = await addIdentity(owner, { email: "bertil.berg@example.com" });
    const phoneOnly = await addMembership(app, owner, company, { user: withPhone });
    await asMember(app, company.id, company.asOwner, "INSERT INTO access.membership_contacts (contact_company_id, membership_id, work_phone) VALUES ($1, $2, '070-174 06 07')", [
      company.id,
      phoneOnly,
    ]);
    const inactivePerson = await addIdentity(owner, { email: "cecilia.cedergren@example.com" });
    const inactive = await addMembership(app, owner, company, { user: inactivePerson });
    await changeMembership(app, company, inactive, "status = 'inactive'");
    const ownPerson = await addIdentity(owner, { email: "david.dal@example.com" });
    const own = await addMembership(app, owner, company, { user: ownPerson });
    await asMember(app, company.id, company.asOwner, "INSERT INTO access.membership_contacts (contact_company_id, membership_id, work_email) VALUES ($1, $2, 'david.arbete@example.org')", [
      company.id,
      own,
    ]);
    const invited = await membershipIn(app, owner, company, "invited");
    const removed = await membershipIn(app, owner, company, "removed");
    const left = await membershipIn(app, owner, company, "left");
    // A second company, so the migration fills every company's, not one set in the session.
    const other = await aCompany(app, "Testbolaget Beta AB");
    const otherOwnerEmail = (await owner.query<{ email: string }>("SELECT email FROM access.identities WHERE id = $1", [other.owner])).rows[0]?.email;

    expect(await migrate(migrator, readMigrations())).toContain("0009_roles_programs.sql");
    expect(await tableGuardProblems(migrator)).toEqual([]);

    const superuser = await database.admin();
    const contacts = await superuser.query<{ membership_id: string; work_email: string | null; work_phone: string | null }>(
      "SELECT membership_id, work_email, work_phone FROM access.membership_contacts",
    );
    const byMembership = new Map(contacts.rows.map((row) => [row.membership_id, { work_email: row.work_email, work_phone: row.work_phone }]));
    expect(byMembership.get(company.membership)).toEqual({ work_email: "agnes.ager@example.com", work_phone: null });
    expect(byMembership.get(phoneOnly)).toEqual({ work_email: "bertil.berg@example.com", work_phone: "070-174 06 07" });
    expect(byMembership.get(inactive)).toEqual({ work_email: "cecilia.cedergren@example.com", work_phone: null });
    expect(byMembership.get(own)).toEqual({ work_email: "david.arbete@example.org", work_phone: null });
    expect(byMembership.get(other.membership)).toEqual({ work_email: otherOwnerEmail, work_phone: null });
    for (const untouched of [invited.id, removed.id, left.id]) {
      expect(byMembership.has(untouched)).toBe(false);
    }
    expect(contacts.rows).toHaveLength(5);
    // Row level security is forced on the memberships again, for the owner too.
    const forced = await superuser.query<{ relforcerowsecurity: boolean }>("SELECT relforcerowsecurity FROM pg_catalog.pg_class WHERE oid = 'access.memberships'::regclass");
    expect(forced.rows).toEqual([{ relforcerowsecurity: true }]);
    // And no fill wrote the behandlingshistorik.
    const history = await superuser.query("SELECT 1 FROM audit.history WHERE table_name = 'access.membership_contacts'");
    expect(history.rows).toEqual([]);
  });
});
