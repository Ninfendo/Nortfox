// SPDX-License-Identifier: AGPL-3.0-only

// The one membership function (issue 12, behaviour 10 of "Users in a
// company", and the catalog's half of the guard that every access check goes
// through it). access.active_membership gives the transaction's person's
// active memberships, with their companies, and with a flag the inactive ones
// too. It reads the person from the actor setting, never from a parameter,
// and gives nothing for an identity that is not active. It reads through the
// owner's two policies by person; the app has only the company policies on
// the memberships and the companies, so a request reads no membership and no
// company outside its company. Of the routines the app may run (functions,
// procedures and aggregates, in any schema), no other reads the memberships
// or the companies as the owner, and none sets a setting, runs dynamic SQL
// or writes a name in SQL's Unicode escapes. The probes show that the
// catalog check finds a second such function, also one that reads them
// through another function, a procedure, or an aggregate's function; a
// routine that sets the transaction's company, as the owner or as the app;
// and an app policy by person.

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

/** The catalog check's problems, after a routine's name. */
const READS = `the app may run it, it runs as the owner, and it reads ${GUARDED_TABLES.join(" or ")}, which only ${THE_FUNCTION} may.`;
const AGGREGATE_READS = `the app may run it, a function of the aggregate runs as the owner, and it reads ${GUARDED_TABLES.join(" or ")}, which only ${THE_FUNCTION} may.`;
const DYNAMIC = "the app may run it, and it runs dynamic SQL, whose reads and settings no check can see.";
const ESCAPES = "the app may run it, and it writes a name in SQL's Unicode escapes (U&), which no check can read.";
const SETS =
  "the app may run it, and it sets a setting itself (set_config, SET LOCAL or SET SESSION, a SET or RESET of a nortfox setting, RESET ALL, or pg_settings). Only the server's database layer sets the transaction's company, actor and channel.";

/** The start of a name in a function's body: nothing of an identifier just before it. */
const NAME_START = "(?:^|[^[:alnum:]_$])";

/** The end of a name in a function's body: nothing of an identifier just after it. */
const NAME_END = "(?:$|[^[:alnum:]_$])";

/** SQL's space between two words in a function's body: white space, or a comment of either kind. */
const SQL_SPACE = "(?:[[:space:]]|/[*](?:[^*]|[*]+[^*/])*[*]+/|--[^\\n]*)";

/**
 * A pattern that finds `schema`.`name` in a function's body as PostgreSQL
 * would read it there, with `~*`: in any case, each part quoted or not, with
 * any space or comment around the dot.
 */
function namePattern(schema: string, name: string): string {
  return `${NAME_START}"?${schema}"?${SQL_SPACE}*\\.${SQL_SPACE}*"?${name}"?${NAME_END}`;
}

/** A word in a function's body, quoted or not, in any case with `~*`. */
function wordPattern(word: string): string {
  return `${NAME_START}"?${word}"?${NAME_END}`;
}

/** Why a routine counts. */
type Why = "reads" | "dynamic" | "sets" | "escapes";

/**
 * What makes a routine's own text count, each with a word in small letters
 * that its text holds whenever the pattern matches it, so the pattern runs
 * only on the texts that hold the word.
 *
 * The ways a text sets a setting: set_config; SET LOCAL or SET SESSION, of
 * any setting; a SET or a RESET of a setting of ours, also in an ALTER ...
 * SET; RESET ALL; and pg_settings. An UPDATE's SET names a column, never a
 * setting of ours. A function's SET clause needs no pattern: the owner may
 * not give one a setting of ours (42501), and pg_get_functiondef prints it in
 * the text that the patterns read.
 */
const RULES: readonly { readonly why: Why; readonly word: string; readonly pattern: string }[] = [
  { why: "reads", word: "memberships", pattern: namePattern("access", "memberships") },
  { why: "reads", word: "companies", pattern: namePattern("ledger", "companies") },
  { why: "dynamic", word: "execute", pattern: wordPattern("execute") },
  { why: "sets", word: "set_config", pattern: wordPattern("set_config") },
  { why: "sets", word: "pg_settings", pattern: wordPattern("pg_settings") },
  { why: "sets", word: "local", pattern: `${NAME_START}set${SQL_SPACE}+local${NAME_END}` },
  { why: "sets", word: "session", pattern: `${NAME_START}set${SQL_SPACE}+session${NAME_END}` },
  { why: "sets", word: "nortfox", pattern: `${NAME_START}(?:re)?set${SQL_SPACE}+"?nortfox"?${SQL_SPACE}*\\.` },
  { why: "sets", word: "reset", pattern: `${NAME_START}reset${SQL_SPACE}+all${NAME_END}` },
  { why: "escapes", word: "u&", pattern: `${NAME_START}u&["']` },
];

/**
 * What the catalog shows against the one function, as plain lines; empty when
 * nothing does. Every routine counts: a function, a procedure, a window
 * function and an aggregate, in every schema but PostgreSQL's own, outside
 * the extensions.
 *
 * - A routine that the app may run and that runs as the owner reads every
 *   company's memberships and companies that the owner's policies by person
 *   show: it must be the one function. It counts when it names one of the
 *   two tables, in any case, quoted or not, with any space or comment around
 *   the dot, or calls a routine that does (or CALLs a procedure), by its
 *   name, at any depth. An aggregate runs its functions (the step, the final
 *   function and the rest) with its owner's right to run them, so it counts
 *   when one of them reads as the owner, also one that the app may not run.
 * - A routine that the app may run and that sets a setting itself, as the
 *   owner or as the app, at any depth, would let a statement enter a company
 *   that the one function did not give: only the server's database layer
 *   sets them. Trigger functions are left out: no one calls one, and the
 *   last administrator's check sets the company for its own statements and
 *   puts it back.
 * - A routine that the app may run and that runs dynamic SQL (EXECUTE), or
 *   writes a name in SQL's Unicode escapes, at any depth, counts too, since
 *   no text match can see what it reads or sets.
 *
 * And the app's only policy on either table is the company policy.
 */
async function oneFunctionProblems(client: Client): Promise<string[]> {
  // The recursive query's estimated cost makes PostgreSQL compile it with JIT,
  // which takes a second or more, while the query itself runs in milliseconds.
  await client.query("SET jit = off");
  const readers = await client.query<{ name: string; why: Why; aggregate: boolean }>(
    `
    WITH RECURSIVE texts AS (
      SELECT p.oid, p.proname::text AS proname, n.nspname || '.' || p.proname AS name,
        CASE WHEN p.prokind = 'a' THEN '' ELSE pg_catalog.pg_get_functiondef(p.oid) END AS body
      FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND NOT EXISTS (SELECT FROM pg_catalog.pg_depend AS d WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid = p.oid AND d.deptype = 'e')
    ), functions AS MATERIALIZED (
      SELECT t.*, pg_catalog.lower(t.body) AS small FROM texts AS t
    ), rules AS (
      SELECT * FROM ROWS FROM (pg_catalog.unnest($2::text[]), pg_catalog.unnest($3::text[]), pg_catalog.unnest($4::text[])) AS u (why, word, pattern)
    ), support AS (
      SELECT a.aggfnoid::pg_catalog.oid AS aggregate, s.fn
      FROM pg_catalog.pg_aggregate AS a
      CROSS JOIN LATERAL (VALUES (a.aggtransfn::pg_catalog.oid), (a.aggfinalfn::pg_catalog.oid), (a.aggcombinefn::pg_catalog.oid), (a.aggserialfn::pg_catalog.oid),
        (a.aggdeserialfn::pg_catalog.oid), (a.aggmtransfn::pg_catalog.oid), (a.aggminvtransfn::pg_catalog.oid), (a.aggmfinalfn::pg_catalog.oid)) AS s (fn)
      WHERE s.fn <> 0
    ), reading AS (
      SELECT f.oid, f.proname, u.why FROM functions AS f JOIN rules AS u
        ON CASE WHEN pg_catalog.strpos(f.small, u.word) = 0 THEN false ELSE f.body ~* u.pattern END
      UNION
      SELECT f.oid, f.proname, r.why FROM functions AS f JOIN reading AS r ON f.oid <> r.oid
        AND (EXISTS (SELECT FROM support AS s WHERE s.aggregate = f.oid AND s.fn = r.oid)
          OR CASE WHEN pg_catalog.strpos(f.small, pg_catalog.lower(r.proname)) = 0 THEN false
            ELSE f.body ~* ($5 || pg_catalog.regexp_replace(r.proname, '([^[:alnum:]_])', '[\\1]', 'g') || $6) END)
    )
    SELECT DISTINCT f.name, r.why, p.prokind = 'a' AS aggregate
    FROM reading AS r JOIN functions AS f ON f.oid = r.oid JOIN pg_catalog.pg_proc AS p ON p.oid = r.oid
    WHERE pg_catalog.has_function_privilege('nortfox_app', p.oid, 'EXECUTE') AND p.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype
      AND (r.why <> 'reads' OR (f.name <> $1 AND (p.prosecdef OR EXISTS (
        SELECT FROM support AS s JOIN reading AS sr ON sr.oid = s.fn AND sr.why = 'reads' JOIN pg_catalog.pg_proc AS sp ON sp.oid = s.fn
        WHERE s.aggregate = r.oid AND sp.prosecdef))))
    ORDER BY 1, 2`,
    [
      THE_FUNCTION,
      RULES.map((rule) => rule.why),
      RULES.map((rule) => rule.word),
      RULES.map((rule) => rule.pattern),
      `${NAME_START}"?`,
      `"?${SQL_SPACE}*\\(`,
    ],
  );
  const policies = await client.query<{ relation: string; name: string; command: string; using: string | null; check: string | null }>(
    `SELECT c.oid::pg_catalog.regclass::text AS relation, p.polname AS name, p.polcmd::text AS command,
       pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS using, pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check
     FROM pg_catalog.pg_policy AS p JOIN pg_catalog.pg_class AS c ON c.oid = p.polrelid
     WHERE c.oid::pg_catalog.regclass::text = ANY ($1) AND (0 = ANY (p.polroles) OR 'nortfox_app'::pg_catalog.regrole = ANY (p.polroles))
     ORDER BY 1, 2`,
    [GUARDED_TABLES],
  );
  const why: Readonly<Record<Why, string>> = { reads: READS, dynamic: DYNAMIC, sets: SETS, escapes: ESCAPES };
  const problems = readers.rows.map((row) => `${row.name}: ${row.why === "reads" && row.aggregate ? AGGREGATE_READS : why[row.why]}`);
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

    it("finds such a function whatever the spelling of the table: quoted, in capitals, or with space or comments around the dot", async () => {
      const reads = `the app may run it, it runs as the owner, and it reads access.memberships or ledger.companies, which only ${THE_FUNCTION} may.`;
      const spellings = [
        '"access"."memberships"',
        "ACCESS.MEMBERSHIPS",
        "access . memberships",
        'Access."memberships"',
        '"ledger".companies',
        "LEDGER .COMPANIES",
        "access/* the schema */./**/memberships",
        "ledger -- the schema\n  .companies",
      ];
      for (const spelling of spellings) {
        expect(
          await problemsAfter(`
            CREATE FUNCTION access.peek_spelled() RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
              AS $peek$ BEGIN RETURN (SELECT count(*) FROM ${spelling}); END $peek$;
            GRANT EXECUTE ON FUNCTION access.peek_spelled() TO nortfox_app;`),
          spelling,
        ).toEqual([`access.peek_spelled: ${reads}`]);
      }
      // And through another function, called by another spelling, with space before its arguments.
      expect(
        await problemsAfter(`
          CREATE FUNCTION access.count_members() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
            RETURN (SELECT count(*) FROM access.memberships);
          CREATE FUNCTION access.members_through() RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
            AS $through$ BEGIN RETURN "access".COUNT_MEMBERS (); END $through$;
          GRANT EXECUTE ON FUNCTION access.members_through() TO nortfox_app;`),
      ).toEqual([`access.members_through: ${reads}`]);
      // A name with a dollar sign, which a pattern must not read as the end of the text.
      expect(
        await problemsAfter(`
          CREATE FUNCTION access.count$members() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
            RETURN (SELECT count(*) FROM access.memberships);
          CREATE FUNCTION access.members_through() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
            RETURN access.count$members();
          GRANT EXECUTE ON FUNCTION access.members_through() TO nortfox_app;`),
      ).toEqual([`access.members_through: ${reads}`]);
      // A longer name is another table.
      expect(
        await problemsAfter(`
          CREATE FUNCTION access.peek_other() RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
            AS $peek$ BEGIN RETURN (SELECT count(*) FROM access.memberships_archive) + (SELECT count(*) FROM access.membership_contacts); END $peek$;
          GRANT EXECUTE ON FUNCTION access.peek_other() TO nortfox_app;`),
      ).toEqual([]);
    });

    it("finds a function that the app may run and that runs dynamic SQL, as the owner or as the app, whose reads and settings no text match can see", async () => {
      expect(
        await problemsAfter(`
          CREATE FUNCTION access.peek_dynamic() RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
            AS $peek$ DECLARE n bigint; BEGIN EXECUTE 'SELECT count(*) FROM access.' || 'member' || 'ships' INTO n; RETURN n; END $peek$;
          GRANT EXECUTE ON FUNCTION access.peek_dynamic() TO nortfox_app;`),
      ).toEqual([`access.peek_dynamic: ${DYNAMIC}`]);
      // As the app, dynamic SQL may still set the transaction's company.
      expect(
        await problemsAfter(`
          CREATE FUNCTION ledger.run_statement(statement text) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
            AS $run$ BEGIN EXECUTE statement; END $run$;
          GRANT EXECUTE ON FUNCTION ledger.run_statement(text) TO nortfox_app;`),
      ).toEqual([`ledger.run_statement: ${DYNAMIC}`]);
    });

    it("finds such a function that writes a name in SQL's Unicode escapes, which no text match reads", async () => {
      expect(
        await problemsAfter(String.raw`
          CREATE FUNCTION access.peek_escaped() RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
            AS $peek$ BEGIN RETURN (SELECT count(*) FROM access.U&"\006Demberships"); END $peek$;
          GRANT EXECUTE ON FUNCTION access.peek_escaped() TO nortfox_app;
          CREATE FUNCTION ledger.work_escaped(company text) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
            AS $work$ BEGIN PERFORM pg_catalog.u&"set\005Fconfig"('nortfox.company_id', company, true); END $work$;
          GRANT EXECUTE ON FUNCTION ledger.work_escaped(text) TO nortfox_app;`),
      ).toEqual([`access.peek_escaped: ${ESCAPES}`, `ledger.work_escaped: ${ESCAPES}`]);
    });

    it("finds a procedure that the app may run and that reads the memberships as the owner, or runs dynamic SQL, and a function that calls such a procedure", async () => {
      expect(
        await problemsAfter(`
          CREATE PROCEDURE access.peek_procedure(INOUT companies text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
            AS $peek$ BEGIN SELECT string_agg(DISTINCT m.company_id::text, ',') INTO companies FROM access.memberships AS m; END $peek$;
          GRANT EXECUTE ON PROCEDURE access.peek_procedure(text) TO nortfox_app;`),
      ).toEqual([`access.peek_procedure: ${READS}`]);
      expect(
        await problemsAfter(`
          CREATE PROCEDURE access.peek_dynamic_procedure(INOUT n bigint) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
            AS $peek$ BEGIN EXECUTE 'SELECT count(*) FROM access.' || 'member' || 'ships' INTO n; END $peek$;
          GRANT EXECUTE ON PROCEDURE access.peek_dynamic_procedure(bigint) TO nortfox_app;`),
      ).toEqual([`access.peek_dynamic_procedure: ${DYNAMIC}`]);
      // Through a procedure that the app may not run itself.
      expect(
        await problemsAfter(`
          CREATE PROCEDURE access.count_members(INOUT n bigint) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
            AS $count$ BEGIN SELECT count(*) INTO n FROM access.memberships; END $count$;
          CREATE FUNCTION access.calls_procedure() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
            AS $calls$ DECLARE n bigint; BEGIN CALL access.count_members(n); RETURN n; END $calls$;
          GRANT EXECUTE ON FUNCTION access.calls_procedure() TO nortfox_app;`),
      ).toEqual([`access.calls_procedure: ${READS}`]);
      // A procedure that runs as the app reads only through the app's policies.
      expect(
        await problemsAfter(`
          CREATE PROCEDURE access.count_as_caller(INOUT n bigint) LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
            AS $count$ BEGIN SELECT count(*) INTO n FROM access.memberships; END $count$;
          GRANT EXECUTE ON PROCEDURE access.count_as_caller(bigint) TO nortfox_app;`),
      ).toEqual([]);
    });

    it("finds an aggregate that the app may run whose function reads the companies as the owner, also when the app may not run that function", async () => {
      const step = `
        CREATE FUNCTION access.peek_step(seen text, ignored integer) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
          AS $step$ BEGIN RETURN (SELECT string_agg(c.company_id::text, ',') FROM ledger.companies AS c); END $step$;`;
      expect(
        await problemsAfter(`${step}
          CREATE AGGREGATE access.peek_aggregate(integer) (SFUNC = access.peek_step, STYPE = text);
          GRANT EXECUTE ON ROUTINE access.peek_aggregate(integer) TO nortfox_app;`),
      ).toEqual([`access.peek_aggregate: ${AGGREGATE_READS}`]);
      // By its final function, and through a function that calls the aggregate.
      expect(
        await problemsAfter(`
          CREATE FUNCTION access.peek_final(seen bigint) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
            RETURN (SELECT count(*) FROM access.memberships);
          CREATE AGGREGATE access.peek_counted(integer) (SFUNC = pg_catalog.int8inc_any, STYPE = bigint, FINALFUNC = access.peek_final, INITCOND = '0');
          GRANT EXECUTE ON ROUTINE access.peek_counted(integer) TO nortfox_app;
          CREATE FUNCTION access.through_aggregate() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
            RETURN (SELECT access.peek_counted(1));
          GRANT EXECUTE ON FUNCTION access.through_aggregate() TO nortfox_app;`),
      ).toEqual([`access.peek_counted: ${AGGREGATE_READS}`, `access.through_aggregate: ${READS}`]);
      // An aggregate that the app may not run, and one whose function runs as the app.
      expect(
        await problemsAfter(`${step}
          CREATE AGGREGATE access.owners_aggregate(integer) (SFUNC = access.peek_step, STYPE = text);
          CREATE FUNCTION access.caller_step(seen text, ignored integer) RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp
            RETURN (SELECT string_agg(c.company_id::text, ',') FROM ledger.companies AS c);
          CREATE AGGREGATE access.caller_aggregate(integer) (SFUNC = access.caller_step, STYPE = text);
          GRANT EXECUTE ON ROUTINE access.caller_aggregate(integer) TO nortfox_app;`),
      ).toEqual([]);
    });

    describe("a function that the app may run and that sets a setting itself", () => {
      it.each([
        ["by set_config, as the app", "LANGUAGE sql BEGIN ATOMIC SELECT set_config('nortfox.company_id', company::text, true); END"],
        ["by set_config, as the owner", "LANGUAGE plpgsql SECURITY DEFINER AS $work$ BEGIN PERFORM pg_catalog.set_config('nortfox.company_id', company::text, true); END $work$"],
        ["by set_config, quoted and in capitals", `LANGUAGE plpgsql AS $work$ BEGIN PERFORM pg_catalog."SET_CONFIG"('nortfox.company_id', company::text, true); END $work$`],
        ["with SET LOCAL", "LANGUAGE plpgsql AS $work$ BEGIN SET LOCAL nortfox.company_id = '5d1e7c3a-9b2f-4e8d-a6c4-1f0e2d3c4b5a'; END $work$"],
        ["with SET SESSION of another setting, in small letters", "LANGUAGE plpgsql AS $work$ BEGIN set session search_path = access; END $work$"],
        ["with a plain SET, quoted and in capitals", `LANGUAGE plpgsql AS $work$ BEGIN SET "NORTFOX"."COMPANY_ID" TO '5d1e7c3a-9b2f-4e8d-a6c4-1f0e2d3c4b5a'; END $work$`],
        ["with a plain SET and comments", "LANGUAGE plpgsql AS $work$ BEGIN SET /* the company */ nortfox -- the setting\n .company_id = '5d1e7c3a-9b2f-4e8d-a6c4-1f0e2d3c4b5a'; END $work$"],
        ["with RESET", "LANGUAGE plpgsql AS $work$ BEGIN RESET nortfox.actor_id; END $work$"],
        ["with RESET ALL", "LANGUAGE plpgsql AS $work$ BEGIN reset all; END $work$"],
        ["through pg_settings", "LANGUAGE plpgsql AS $work$ BEGIN UPDATE pg_catalog.pg_settings SET setting = company::text WHERE name = 'nortfox.company_id'; END $work$"],
      ])("%s", async (_case, rest) => {
        expect(
          await problemsAfter(`
            CREATE FUNCTION ledger.work_in(company uuid) RETURNS text SET search_path = pg_catalog, pg_temp ${rest};
            GRANT EXECUTE ON FUNCTION ledger.work_in(uuid) TO nortfox_app;`),
        ).toEqual([`ledger.work_in: ${SETS}`]);
      });

      it("finds it in any schema, as a procedure, and through a function that the app may not run itself", async () => {
        expect(
          await problemsAfter(`
            CREATE FUNCTION public.work_in(company uuid) RETURNS text LANGUAGE sql SET search_path = pg_catalog, pg_temp
              BEGIN ATOMIC SELECT set_config('nortfox.company_id', company::text, true); END;
            GRANT EXECUTE ON FUNCTION public.work_in(uuid) TO nortfox_app;
            CREATE PROCEDURE ledger.enter(company uuid) LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
              AS $enter$ BEGIN PERFORM set_config('nortfox.company_id', company::text, true); END $enter$;
            GRANT EXECUTE ON PROCEDURE ledger.enter(uuid) TO nortfox_app;
            CREATE FUNCTION ledger.set_company(company uuid) RETURNS text LANGUAGE sql SET search_path = pg_catalog, pg_temp
              BEGIN ATOMIC SELECT set_config('nortfox.company_id', company::text, true); END;
            CREATE FUNCTION ledger.work_through(company uuid) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
              RETURN ledger.set_company(company);
            GRANT EXECUTE ON FUNCTION ledger.work_through(uuid) TO nortfox_app;`),
        ).toEqual([`ledger.enter: ${SETS}`, `ledger.work_through: ${SETS}`, `public.work_in: ${SETS}`]);
      });

      it("needs no look at a function's SET clause: the owner may not give one a setting of ours", async () => {
        await expect(
          problemsAfter(`
            CREATE FUNCTION ledger.work_in() RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp SET nortfox.company_id = '5d1e7c3a-9b2f-4e8d-a6c4-1f0e2d3c4b5a'
              RETURN (SELECT 'x');`),
        ).rejects.toMatchObject({ code: "42501", message: 'permission denied to set parameter "nortfox.company_id"' });
      });

      it("does not take a read of a setting, an UPDATE's SET, a SET clause of the search path, or a trigger for one", async () => {
        expect(
          await problemsAfter(`
            CREATE FUNCTION ledger.read_company() RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp
              AS $read$ BEGIN RETURN pg_catalog.current_setting('nortfox.company_id', true); END $read$;
            GRANT EXECUTE ON FUNCTION ledger.read_company() TO nortfox_app;
            CREATE FUNCTION ledger.rename_none() RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
              AS $rename$ BEGIN UPDATE ledger.companies SET name = name WHERE false; END $rename$;
            GRANT EXECUTE ON FUNCTION ledger.rename_none() TO nortfox_app;
            CREATE FUNCTION ledger.set_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
              AS $set$ BEGIN PERFORM set_config('nortfox.company_id', NEW.company_id::text, true); RETURN NULL; END $set$;
            GRANT EXECUTE ON FUNCTION ledger.set_trigger() TO nortfox_app;`),
        ).toEqual([]);
      });
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
