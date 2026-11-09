// SPDX-License-Identifier: AGPL-3.0-only

// The one membership function in the server (issue 12, "Users in a company",
// behaviour 10). resolve.ts is the only caller of access.active_membership:
// it gives the transaction's person's active membership in a company, or
// every one, as memberships that only it can make. A lookup enters a company
// only with a membership that the function gave in that lookup, to the
// person it acts as, and only once (tx.enter). These run on PostgreSQL as
// nortfox_app, through the server's own database layer.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool } from "../../../test/api.ts";
import { failureOf, freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { addIdentity, deleteIdentity } from "../../../test/identities.ts";
import { addCompanyWithOwner } from "../../../test/ledger.ts";
import { aCompany, addMembership, changeMembership, membershipIn, type Company } from "../../../test/memberships.ts";
import { commit, type PersonSettings, type Queryable } from "../../db/database.ts";
import { ResolvedMembership, activeMemberships, resolveActive } from "./resolve.ts";

/** What the transaction holds of the company and the actor, "" when unset. */
async function settingsOf(tx: Queryable): Promise<{ company: string; actor: string; kind: string }> {
  const found = await tx.query<{ company: string; actor: string; kind: string }>(
    `SELECT COALESCE(pg_catalog.current_setting('nortfox.company_id', true), '') AS company,
       COALESCE(pg_catalog.current_setting('nortfox.actor_id', true), '') AS actor,
       COALESCE(pg_catalog.current_setting('nortfox.actor_kind', true), '') AS kind`,
  );
  const [row] = found.rows;
  if (row === undefined) {
    throw new Error("The transaction gave no settings.");
  }
  return row;
}

/** An object's own fields, as a plain object. */
function fieldsOf(value: object | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value ?? {}));
}

/** The membership, which a test expects the function to give. */
function present(membership: ResolvedMembership | undefined): ResolvedMembership {
  if (membership === undefined) {
    throw new Error("The one membership function gave no membership.");
  }
  return membership;
}

/** The companies whose rows the transaction reads, from the companies and from the memberships. */
async function companiesSeen(tx: Queryable): Promise<{ companies: string[]; memberships: string[] }> {
  const companies = await tx.query<{ company_id: string }>("SELECT company_id FROM ledger.companies ORDER BY company_id");
  const memberships = await tx.query<{ company_id: string }>("SELECT DISTINCT company_id FROM access.memberships ORDER BY company_id");
  return { companies: companies.rows.map((row) => row.company_id), memberships: memberships.rows.map((row) => row.company_id) };
}

describe("the one membership function in the server", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let pool: AppPool;
  let person: string;
  let alfa: Company;
  let beta: Company;
  let gamma: Company;
  let inBeta: string;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    pool = appPool(db, 2);
    person = await addIdentity(owner, { name: "Ingrid Vall" });
    // The person made Alfa, so owns it, is an active member of Beta with 30
    // minutes, and an inactive admin of Gamma.
    const made = await addCompanyWithOwner(app, { actor: person, kind: "user" }, { name: "Testbolaget Alfa AB", organizationNumber: "556000-0167" });
    alfa = { ...made, id: made.row.company_id, asOwner: { actor: person, kind: "user" } };
    beta = await aCompany(app, "Testbolaget Beta AB");
    inBeta = await addMembership(app, owner, beta, { user: person, idle: 30 });
    gamma = await aCompany(app, "Testbolaget Gamma AB");
    const inGamma = await addMembership(app, owner, gamma, { user: person, adminLevel: "admin" });
    await changeMembership(app, gamma, inGamma, "status = 'inactive'");
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** A person's transaction in no company, as a signed-in request's. */
  function asThePerson(who = person, kind: PersonSettings["actorKind"] = "user"): PersonSettings {
    return { actorId: who, actorKind: kind, channel: "rest" };
  }

  describe("resolveActive", () => {
    it("gives the person's active membership in the company, with the company, the admin level, the idle time and the person", async () => {
      const found = await pool.database.read(asThePerson(), async (tx) => commit(await resolveActive(tx, alfa.id)));
      expect(found).toBeInstanceOf(ResolvedMembership);
      expect(fieldsOf(found)).toEqual({
        personId: person,
        membershipId: alfa.membership,
        companyId: alfa.id,
        adminLevel: "owner",
        idleTimeoutMinutes: 120,
        company: { name: "Testbolaget Alfa AB", organizationNumber: "556000-0167", databaseNumber: alfa.row.database_number },
      });
      const inB = await pool.database.read(asThePerson(), async (tx) => commit(await resolveActive(tx, beta.id)));
      expect([inB?.membershipId, inB?.adminLevel, inB?.idleTimeoutMinutes]).toEqual([inBeta, null, 30]);
    });

    it("gives the same in a lookup once it acts as the person, as an integration too", async () => {
      for (const kind of ["user", "integration"] as const) {
        const found = await pool.database.lookup("rest", async (tx) => {
          await tx.actAs(person, kind);
          return commit(await resolveActive(tx, beta.id));
        });
        expect([found?.personId, found?.membershipId]).toEqual([person, inBeta]);
      }
    });

    it.each(["inactive", "removed", "left"] as const)("gives nothing for a membership that is %s", async (status) => {
      const company = await aCompany(app, `Testbolaget ${status} AB`);
      const { user } = await membershipIn(app, owner, company, status);
      expect(await pool.database.read(asThePerson(user ?? ""), async (tx) => commit(await resolveActive(tx, company.id)))).toBeUndefined();
    });

    it("gives nothing for the person's inactive membership, for another person's company, and for a company that does not exist", async () => {
      expect(await pool.database.read(asThePerson(), async (tx) => commit(await resolveActive(tx, gamma.id)))).toBeUndefined();
      const elsewhere = await aCompany(app, "Testbolaget Delta AB");
      expect(await pool.database.read(asThePerson(), async (tx) => commit(await resolveActive(tx, elsewhere.id)))).toBeUndefined();
      expect(await pool.database.read(asThePerson(), async (tx) => commit(await resolveActive(tx, randomUUID())))).toBeUndefined();
    });

    it("gives nothing before a lookup acts as the person, and nothing for the internal system user", async () => {
      expect(await pool.database.lookup("rest", async (tx) => commit(await resolveActive(tx, alfa.id)))).toBeUndefined();
      expect(await pool.database.read(asThePerson(person, "system"), async (tx) => commit(await resolveActive(tx, alfa.id)))).toBeUndefined();
    });

    it("gives nothing for an identity that is not active", async () => {
      const company = await aCompany(app, "Testbolaget Epsilon AB");
      expect((await pool.database.read(asThePerson(company.owner), async (tx) => commit(await resolveActive(tx, company.id))))?.companyId).toBe(company.id);
      await deleteIdentity(app, company.owner);
      expect(await pool.database.read(asThePerson(company.owner), async (tx) => commit(await resolveActive(tx, company.id)))).toBeUndefined();
    });
  });

  describe("activeMemberships", () => {
    it("gives the person's active memberships in every company, by the company's name, and never an inactive one", async () => {
      const found = await pool.database.read(asThePerson(), async (tx) => commit(await activeMemberships(tx)));
      expect(found.every((membership) => membership instanceof ResolvedMembership)).toBe(true);
      expect(found.map((membership) => [membership.company.name, membership.membershipId, membership.adminLevel])).toEqual([
        ["Testbolaget Alfa AB", alfa.membership, "owner"],
        ["Testbolaget Beta AB", inBeta, null],
      ]);
    });

    it("gives nothing for a person with no active membership, or with no person", async () => {
      const nobody = await addIdentity(owner, { name: "Sixten Ros" });
      expect(await pool.database.read(asThePerson(nobody), async (tx) => commit(await activeMemberships(tx)))).toEqual([]);
      expect(await pool.database.lookup("rest", async (tx) => commit(await activeMemberships(tx)))).toEqual([]);
    });
  });

  describe("tx.enter", () => {
    it("sets the lookup's company from the membership that the function gave, so it reads that company's rows and no other's", async () => {
      const seen = await pool.database.lookup("rest", async (tx) => {
        await tx.actAs(person, "user");
        const before = await companiesSeen(tx);
        const membership = await resolveActive(tx, beta.id);
        if (membership === undefined) {
          throw new Error("The person is an active member of Beta.");
        }
        await tx.enter(membership);
        return commit({ before, settings: await settingsOf(tx), after: await companiesSeen(tx) });
      });
      expect(seen.before).toEqual({ companies: [], memberships: [] });
      expect(seen.settings).toEqual({ company: beta.id, actor: person, kind: "user" });
      expect(seen.after).toEqual({ companies: [beta.id], memberships: [beta.id] });
    });

    it("enters a company of the person's list too", async () => {
      const entered = await pool.database.lookup("mcp", async (tx) => {
        await tx.actAs(person, "integration");
        const [first] = await activeMemberships(tx);
        if (first === undefined) {
          throw new Error("The person has active memberships.");
        }
        await tx.enter(first);
        return commit(await settingsOf(tx));
      });
      expect(entered).toEqual({ company: alfa.id, actor: person, kind: "integration" });
    });

    it("refuses a plain object with a membership's fields, and enters nothing", async () => {
      const refused = await pool.database.lookup("rest", async (tx) => {
        await tx.actAs(person, "user");
        const plain = fieldsOf(await resolveActive(tx, beta.id));
        const error = await failureOf(tx.enter(plain as unknown as ResolvedMembership));
        return commit({ error, settings: await settingsOf(tx) });
      });
      expect(refused.error).toEqual(new Error("tx.enter takes only a membership that the one membership function gave in this transaction (modules/memberships/resolve.ts)."));
      expect(refused.settings.company).toBe("");
    });

    it("refuses a membership that the function gave in another transaction, also one of the same person and company", async () => {
      const earlier = await pool.database.lookup("rest", async (tx) => {
        await tx.actAs(person, "user");
        return commit(await resolveActive(tx, beta.id));
      });
      const outside = await pool.database.read(asThePerson(), async (tx) => commit(await resolveActive(tx, beta.id)));
      for (const membership of [earlier, outside]) {
        const refused = await pool.database.lookup("rest", async (tx) => {
          await tx.actAs(person, "user");
          const error = await failureOf(tx.enter(present(membership)));
          return commit({ error, settings: await settingsOf(tx) });
        });
        expect(refused.error).toEqual(new Error("tx.enter takes only a membership that the one membership function gave in this transaction (modules/memberships/resolve.ts)."));
        expect(refused.settings.company).toBe("");
      }
    });

    it("refuses a membership of a person other than the one the lookup acts as", async () => {
      // The work sets another actor by hand, past actAs, and the function answers for that one.
      const refused = await pool.database.lookup("rest", async (tx) => {
        await tx.actAs(person, "user");
        await tx.query("SELECT pg_catalog.set_config('nortfox.actor_id', $1, true)", [beta.owner]);
        const membership = await resolveActive(tx, beta.id);
        const error = await failureOf(tx.enter(present(membership)));
        return commit({ membership: membership?.personId, error, settings: await settingsOf(tx) });
      });
      expect(refused.membership).toBe(beta.owner);
      expect(refused.error).toEqual(new Error("tx.enter takes a membership of the person the lookup acts as."));
      expect(refused.settings.company).toBe("");
    });

    it("refuses a second company, and the same company again", async () => {
      const refused = await pool.database.lookup("rest", async (tx) => {
        await tx.actAs(person, "user");
        const [inAlfa, inB] = await activeMemberships(tx);
        if (inAlfa === undefined || inB === undefined) {
          throw new Error("The person has two active memberships.");
        }
        await tx.enter(inB);
        const other = await failureOf(tx.enter(inAlfa));
        const same = await failureOf(tx.enter(inB));
        return commit({ other, same, settings: await settingsOf(tx) });
      });
      const twice = new Error("The lookup has entered its company already. A lookup enters one company.");
      expect(refused).toEqual({ other: twice, same: twice, settings: { company: beta.id, actor: person, kind: "user" } });
    });

    it("refuses after the lookup has ended", async () => {
      let ended: { readonly tx: Parameters<Parameters<AppPool["database"]["lookup"]>[1]>[0]; readonly membership: ResolvedMembership } | undefined;
      await pool.database.lookup("rest", async (tx) => {
        await tx.actAs(person, "user");
        const membership = await resolveActive(tx, alfa.id);
        if (membership === undefined) {
          throw new Error("The person owns Alfa.");
        }
        ended = { tx, membership };
        return commit(undefined);
      });
      expect(await failureOf(ended?.tx.enter(ended.membership) ?? Promise.resolve())).toEqual(
        new Error("The transaction has ended. A query after its end would run outside it."),
      );
    });
  });

  // A signed-in request whose input names its company runs as the person in
  // no company, asks the one function, and enters the company only with its
  // answer (database.person). createCompany works in a company that it makes,
  // whose id the database layer picks.
  describe("a person's transaction", () => {
    const SET_ALREADY = new Error("The transaction works in a company already. It sets its company once.");

    it("enters the company of a membership that the function gave in it, as a read and as a write", async () => {
      for (const mode of ["read", "write"] as const) {
        const seen = await pool.database.person(mode, asThePerson(), async (tx) => {
          const before = await companiesSeen(tx);
          await tx.enter(present(await resolveActive(tx, beta.id)));
          const mode = await tx.query<{ read_only: string; level: string }>(
            "SELECT pg_catalog.current_setting('transaction_read_only') AS read_only, pg_catalog.current_setting('transaction_isolation') AS level",
          );
          return commit({ before, settings: await settingsOf(tx), after: await companiesSeen(tx), mode: mode.rows[0] });
        });
        expect(seen.before).toEqual({ companies: [], memberships: [] });
        expect(seen.settings).toEqual({ company: beta.id, actor: person, kind: "user" });
        expect(seen.after).toEqual({ companies: [beta.id], memberships: [beta.id] });
        expect(seen.mode).toEqual(mode === "read" ? { read_only: "on", level: "repeatable read" } : { read_only: "off", level: "read committed" });
      }
    });

    it("refuses a plain object, a membership of another transaction, and one of another person, and enters nothing", async () => {
      const outside = await pool.database.read(asThePerson(), async (tx) => commit(await resolveActive(tx, beta.id)));
      const refused = await pool.database.person("write", asThePerson(), async (tx) => {
        const plain = await failureOf(tx.enter(fieldsOf(await resolveActive(tx, beta.id)) as unknown as ResolvedMembership));
        const earlier = await failureOf(tx.enter(present(outside)));
        await tx.query("SELECT pg_catalog.set_config('nortfox.actor_id', $1, true)", [beta.owner]);
        const another = await failureOf(tx.enter(present(await resolveActive(tx, beta.id))));
        return commit({ plain, earlier, another, settings: await settingsOf(tx) });
      });
      const notHere = new Error("tx.enter takes only a membership that the one membership function gave in this transaction (modules/memberships/resolve.ts).");
      expect(refused).toEqual({
        plain: notHere,
        earlier: notHere,
        another: new Error("tx.enter takes a membership of the person the transaction acts as."),
        settings: { company: "", actor: beta.owner, kind: "user" },
      });
    });

    it("works in a new company while the work runs, with an id it picks, and in none before and after", async () => {
      const seen = await pool.database.person("write", asThePerson(), async (tx) => {
        const before = await settingsOf(tx);
        const inside = await tx.inNewCompany(async (companyId) => ({ companyId, settings: await settingsOf(tx) }));
        return commit({ before, inside, after: await settingsOf(tx) });
      });
      expect(seen.inside.companyId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(seen.inside.settings).toEqual({ company: seen.inside.companyId, actor: person, kind: "user" });
      expect(seen.before.company).toBe("");
      expect(seen.after.company).toBe("");
      const other = await pool.database.person("write", asThePerson(), async (tx) => commit(await tx.inNewCompany((companyId) => Promise.resolve(companyId))));
      expect(other).not.toBe(seen.inside.companyId);
    });

    it("sets its company once: no second company, and no new company beside an entered one", async () => {
      const refused = await pool.database.person("write", asThePerson(), async (tx) => {
        const [inAlfa, inB] = await activeMemberships(tx);
        await tx.enter(present(inB));
        const second = await failureOf(tx.enter(present(inAlfa)));
        const made = await failureOf(tx.inNewCompany(() => Promise.resolve(undefined)));
        return commit({ second, made, settings: await settingsOf(tx) });
      });
      expect(refused).toEqual({ second: SET_ALREADY, made: SET_ALREADY, settings: { company: beta.id, actor: person, kind: "user" } });
      const afterNew = await pool.database.person("write", asThePerson(), async (tx) => {
        await tx.inNewCompany(() => Promise.resolve(undefined));
        const again = await failureOf(tx.inNewCompany(() => Promise.resolve(undefined)));
        const entered = await failureOf(tx.enter(present(await resolveActive(tx, beta.id))));
        return commit({ again, entered, settings: await settingsOf(tx) });
      });
      expect(afterNew).toEqual({ again: SET_ALREADY, entered: SET_ALREADY, settings: { company: "", actor: person, kind: "user" } });
    });

    it("rolls back what the work in a new company wrote when it throws", async () => {
      const failed = new Error("The test's work failed.");
      const thrown = await failureOf(
        pool.database.person("write", asThePerson(), (tx) =>
          tx.inNewCompany(async (companyId) => {
            await tx.query("INSERT INTO ledger.companies (company_id, name, organization_number) VALUES ($1, 'Testbolaget Noll AB', '556000-0167')", [companyId]);
            throw failed;
          }),
        ),
      );
      expect(thrown).toBe(failed);
      expect((await owner.query("SELECT 1 FROM ledger.companies WHERE name = 'Testbolaget Noll AB'")).rows).toEqual([]);
    });
  });
});
