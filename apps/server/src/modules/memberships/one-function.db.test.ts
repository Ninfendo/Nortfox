// SPDX-License-Identifier: AGPL-3.0-only

// The one membership function (issue 12, behaviour 10 of "Users in a
// company", and the catalog's half of the guard that every access check goes
// through it). access.active_membership gives the transaction's person's
// active memberships, with their companies, and with a flag the inactive ones
// too. It reads the person from the actor setting, never from a parameter,
// and gives nothing for an identity that is not active. It reads through the
// owner's two policies by person; the app has only the company policies on
// the memberships and the companies, so a request reads no membership and no
// company outside its company. Of the functions the app may run, no other
// reads the memberships or the companies as the owner. The probes show that
// the catalog check finds a second such function, also one that reads them
// through another function, and an app policy by person.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, inTransaction, type Settings, type TestDatabase } from "../../../test/database.ts";
import { addIdentity, deleteIdentity } from "../../../test/identities.ts";
import { addCompanyWithOwner } from "../../../test/ledger.ts";
import { aCompany, addMembership, changeMembership, type Company } from "../../../test/memberships.ts";

/** The function that every access check calls. */
const THE_FUNCTION = "access.active_membership";

/** The tables that only the one function reads across companies. */
const GUARDED_TABLES = ["access.memberships", "ledger.companies"] as const;

const COMPANY_CHECK = "(company_id = ledger.current_company_id())";

/** A row of the one function. */
interface ActiveMembership {
  readonly membership_id: string;
  readonly company_id: string;
  readonly status: string;
  readonly admin_level: string | null;
  readonly idle_timeout_minutes: number;
  readonly company_name: string;
  readonly organization_number: string;
  readonly database_number: number;
}

/**
 * What the catalog shows against the one function, as plain lines; empty when
 * nothing does. A function that the app may run and that runs as the owner
 * reads every company's memberships and companies that the owner's policies
 * by person show: it must be the one function. A function counts when it
 * names one of the two tables, or calls a function that does, at any depth.
 * And the app's only policy on either table is the company policy.
 */
async function oneFunctionProblems(client: Client): Promise<string[]> {
  const readers = await client.query<{ name: string }>(`
    WITH RECURSIVE functions AS (
      SELECT p.oid, n.nspname || '.' || p.proname AS name, pg_catalog.pg_get_functiondef(p.oid) AS body
      FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE p.prokind = 'f' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND NOT EXISTS (SELECT FROM pg_catalog.pg_depend AS d WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid = p.oid AND d.deptype = 'e')
    ), reading AS (
      SELECT f.oid, f.name FROM functions AS f
      WHERE f.body ~ '\\maccess\\.memberships\\M' OR f.body ~ '\\mledger\\.companies\\M'
      UNION
      SELECT f.oid, f.name FROM functions AS f JOIN reading AS r ON f.oid <> r.oid AND strpos(f.body, r.name || '(') > 0
    )
    SELECT DISTINCT r.name FROM reading AS r JOIN pg_catalog.pg_proc AS p ON p.oid = r.oid
    WHERE p.prosecdef AND pg_catalog.has_function_privilege('nortfox_app', p.oid, 'EXECUTE') AND r.name <> $1
    ORDER BY 1`,
    [THE_FUNCTION],
  );
  const policies = await client.query<{ relation: string; name: string; command: string; using: string | null; check: string | null }>(
    `SELECT c.oid::pg_catalog.regclass::text AS relation, p.polname AS name, p.polcmd::text AS command,
       pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS using, pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check
     FROM pg_catalog.pg_policy AS p JOIN pg_catalog.pg_class AS c ON c.oid = p.polrelid
     WHERE c.oid::pg_catalog.regclass::text = ANY ($1) AND (0 = ANY (p.polroles) OR 'nortfox_app'::pg_catalog.regrole = ANY (p.polroles))
     ORDER BY 1, 2`,
    [GUARDED_TABLES],
  );
  const problems = readers.rows.map(
    (row) => `${row.name}: the app may run it, it runs as the owner, and it reads ${GUARDED_TABLES.join(" or ")}, which only ${THE_FUNCTION} may.`,
  );
  for (const table of GUARDED_TABLES) {
    const own = policies.rows.filter((row) => row.relation === table);
    if (!own.some((row) => row.command === "*" && row.using === COMPANY_CHECK && row.check === COMPANY_CHECK)) {
      problems.push(`${table}: the app has no company policy.`);
    }
    for (const row of own.filter((found) => !(found.command === "*" && found.using === COMPANY_CHECK && found.check === COMPANY_CHECK))) {
      problems.push(`${table}: the app has the policy ${row.name}, beside the company policy.`);
    }
  }
  return problems;
}

describe("the one membership function", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let person: string;
  let alfa: Company;
  let beta: Company;
  let gamma: Company;
  let inBeta: string;
  let inGamma: string;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    person = await addIdentity(owner, { name: "Tove Ek" });
    // The person made Alfa, so owns it; is an active member of Beta, and an
    // inactive one of Gamma; was removed from Delta, left Epsilon, and is
    // invited to Zeta, as an address, with no identity yet.
    const made = await addCompanyWithOwner(app, { actor: person, kind: "user" }, { name: "Testbolaget Alfa AB", organizationNumber: "556000-0167" });
    alfa = { ...made, id: made.row.company_id, asOwner: { actor: person, kind: "user" } };
    beta = await aCompany(app, "Testbolaget Beta AB");
    inBeta = await addMembership(app, owner, beta, { user: person, idle: 30 });
    gamma = await aCompany(app, "Testbolaget Gamma AB");
    inGamma = await addMembership(app, owner, gamma, { user: person, adminLevel: "admin" });
    await changeMembership(app, gamma, inGamma, "status = 'inactive'");
    const delta = await aCompany(app, "Testbolaget Delta AB");
    await changeMembership(app, delta, await addMembership(app, owner, delta, { user: person }), "status = 'removed'");
    const epsilon = await aCompany(app, "Testbolaget Epsilon AB");
    await changeMembership(app, epsilon, await addMembership(app, owner, epsilon, { user: person }), "status = 'left'", [], { actor: person, kind: "user" });
    const zeta = await aCompany(app, "Testbolaget Zeta AB");
    await addMembership(app, owner, zeta, { status: "invited" });
  });

  afterAll(async () => {
    await db.close();
  });

  /** The one function's rows, called as the app with `settings`. */
  async function activeMemberships(settings: Settings, args = ""): Promise<ActiveMembership[]> {
    return inTransaction(app, settings, async () => (await app.query<ActiveMembership>(`SELECT * FROM ${THE_FUNCTION}(${args})`)).rows);
  }

  /** The settings of a transaction that acts as `who`, of `kind`, with `company` set if given. */
  function as(who: string, kind = "user", company?: string): Settings {
    return { actor: who, kind, ...(company === undefined ? {} : { company }) };
  }

  it("gives the person's active memberships in every company, with their companies, and never an inactive, removed, left or invited one", async () => {
    expect(await activeMemberships(as(person))).toEqual([
      {
        membership_id: alfa.membership,
        company_id: alfa.id,
        status: "active",
        admin_level: "owner",
        idle_timeout_minutes: 120,
        company_name: "Testbolaget Alfa AB",
        organization_number: "556000-0167",
        database_number: alfa.row.database_number,
      },
      {
        membership_id: inBeta,
        company_id: beta.id,
        status: "active",
        admin_level: null,
        idle_timeout_minutes: 30,
        company_name: "Testbolaget Beta AB",
        organization_number: "556000-0167",
        database_number: beta.row.database_number,
      },
    ]);
  });

  it("gives one company's when asked, and nothing for a company where the person is no active member, or that does not exist", async () => {
    expect((await activeMemberships(as(person), `'${beta.id}'`)).map((row) => row.membership_id)).toEqual([inBeta]);
    expect(await activeMemberships(as(person), `'${gamma.id}'`)).toEqual([]);
    expect(await activeMemberships(as(person), "'00000000-0000-4000-8000-000000000000'")).toEqual([]);
  });

  it("gives the inactive ones too when asked, which only an identity's deletion asks for", async () => {
    expect((await activeMemberships(as(person), "include_inactive => true")).map((row) => [row.company_name, row.status, row.admin_level])).toEqual([
      ["Testbolaget Alfa AB", "active", "owner"],
      ["Testbolaget Beta AB", "active", null],
      ["Testbolaget Gamma AB", "inactive", "admin"],
    ]);
    expect((await activeMemberships(as(person), `'${gamma.id}', true`)).map((row) => row.membership_id)).toEqual([inGamma]);
  });

  it("reads the person from the actor setting: nothing with no person or for the system user, and an integration's person's own", async () => {
    expect(await activeMemberships({})).toEqual([]);
    expect(await activeMemberships({ company: alfa.id })).toEqual([]);
    expect(await activeMemberships(as(person, "system"))).toEqual([]);
    expect((await activeMemberships(as(person, "integration"))).map((row) => row.company_id)).toEqual([alfa.id, beta.id]);
    // Another person gets that person's own: Beta's owner owns Beta only.
    expect((await activeMemberships(as(beta.owner))).map((row) => row.company_id)).toEqual([beta.id]);
  });

  it("gives the same whatever company the transaction set", async () => {
    expect((await activeMemberships(as(person, "user", gamma.id))).map((row) => row.company_id)).toEqual([alfa.id, beta.id]);
  });

  it("gives nothing for an identity that is not active", async () => {
    const company = await aCompany(app, "Testbolaget Eta AB");
    expect((await activeMemberships(as(company.owner))).map((row) => row.company_id)).toEqual([company.id]);
    await deleteIdentity(app, company.owner);
    expect(await activeMemberships(as(company.owner))).toEqual([]);
    expect(await activeMemberships(as(company.owner), "include_inactive => true")).toEqual([]);
  });

  it("is the app's only way past its company: with the person set and another company set, the app reads only that company's memberships and company", async () => {
    const seen = await inTransaction(app, as(person, "user", beta.id), async () => ({
      memberships: (await app.query<{ company_id: string }>("SELECT DISTINCT company_id FROM access.memberships")).rows,
      companies: (await app.query<{ company_id: string }>("SELECT company_id FROM ledger.companies")).rows,
    }));
    expect(seen).toEqual({ memberships: [{ company_id: beta.id }], companies: [{ company_id: beta.id }] });
  });

  it("takes the company and the flag, and no person, and runs as the owner", async () => {
    const found = await owner.query<{ args: string; definer: boolean; volatility: string }>(
      `SELECT pg_catalog.pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef AS definer, p.provolatile AS volatility
       FROM pg_catalog.pg_proc AS p WHERE p.oid = 'access.active_membership'::pg_catalog.regproc`,
    );
    expect(found.rows).toEqual([{ args: "company uuid, include_inactive boolean", definer: true, volatility: "s" }]);
  });

  describe("the catalog's check", () => {
    /** The check's problems after `setup`, run as the owner in a transaction that is then rolled back. */
    async function problemsAfter(setup: string): Promise<string[]> {
      await owner.query("BEGIN");
      try {
        await owner.query(setup);
        return await oneFunctionProblems(owner);
      } finally {
        await owner.query("ROLLBACK");
      }
    }

    it("finds nothing in the migrated database", async () => {
      expect(await oneFunctionProblems(owner)).toEqual([]);
    });

    it("finds a second function that the app may run and that reads the memberships or the companies as the owner", async () => {
      const reads = `the app may run it, it runs as the owner, and it reads access.memberships or ledger.companies, which only ${THE_FUNCTION} may.`;
      expect(
        await problemsAfter(`
          CREATE FUNCTION access.peek_memberships() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
            RETURN (SELECT count(*) FROM access.memberships);
          GRANT EXECUTE ON FUNCTION access.peek_memberships() TO nortfox_app;
          CREATE FUNCTION access.peek_companies() RETURNS SETOF text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
            AS $peek$ BEGIN RETURN QUERY SELECT c.name FROM ledger.companies AS c; END $peek$;
          GRANT EXECUTE ON FUNCTION access.peek_companies() TO nortfox_app;`),
      ).toEqual([`access.peek_companies: ${reads}`, `access.peek_memberships: ${reads}`]);
      // Through another function, which the app may not run itself.
      expect(
        await problemsAfter(`
          CREATE FUNCTION access.count_members() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
            RETURN (SELECT count(*) FROM access.memberships);
          CREATE FUNCTION access.members_through() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
            RETURN access.count_members();
          GRANT EXECUTE ON FUNCTION access.members_through() TO nortfox_app;`),
      ).toEqual([`access.members_through: ${reads}`]);
      // A function that runs as the app reads only through the app's policies, and one the app may not run is the owner's.
      expect(
        await problemsAfter(`
          CREATE FUNCTION access.as_caller() RETURNS bigint LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp
            RETURN (SELECT count(*) FROM access.memberships);
          GRANT EXECUTE ON FUNCTION access.as_caller() TO nortfox_app;
          CREATE FUNCTION access.owners_own() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
            RETURN (SELECT count(*) FROM access.memberships);`),
      ).toEqual([]);
    });

    it("finds an app policy by person, or any policy of the app beside the company policy, on either table", async () => {
      expect(
        await problemsAfter(`
          CREATE POLICY person_app ON access.memberships FOR SELECT TO nortfox_app USING (live_user_id = access.current_person_id());
          CREATE POLICY person_app ON ledger.companies FOR SELECT TO nortfox_app
            USING (EXISTS (SELECT FROM access.memberships AS m WHERE m.company_id = companies.company_id AND m.live_user_id = access.current_person_id()));
          CREATE POLICY everyone ON ledger.companies FOR SELECT USING (true);`),
      ).toEqual([
        "access.memberships: the app has the policy person_app, beside the company policy.",
        "ledger.companies: the app has the policy everyone, beside the company policy.",
        "ledger.companies: the app has the policy person_app, beside the company policy.",
      ]);
      expect(await problemsAfter("DROP POLICY company_app ON access.memberships")).toEqual(["access.memberships: the app has no company policy."]);
    });
  });
});
