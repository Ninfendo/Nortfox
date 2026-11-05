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
// or the companies as the owner. No routine at all, whoever may run it, sets
// a setting, runs dynamic SQL (by EXECUTE, or through one of PostgreSQL's
// functions that run SQL from a text or read a table, a schema or the
// database by name, such as query_to_xml) or writes a name in SQL's Unicode
// escapes, but the last system administrator's check and the migrations'
// helpers, while the app may not run them: PostgreSQL runs a trigger on a
// write with no right to run it. No SQL that the catalog keeps and runs on a
// statement does either: a view's query, a default, a generated column, a
// check constraint, an index's expression, a policy or a trigger's
// condition. And no table or view has a rule but a view's own query. The
// probes show that the catalog check finds a second such function, also one
// that reads them through another function, a procedure, or an aggregate's
// function; a routine that runs SQL through each of those functions of
// PostgreSQL's; a routine that sets the transaction's company, as the owner
// or as the app, also a trigger and one that the app may not run; such SQL
// in each place the catalog keeps it; a rule; and an app policy by person.

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

/** The catalog check's problems, after a routine's name, or after the place of SQL that the catalog keeps. */
const READS = `the app may run it, it runs as the owner, and it reads ${GUARDED_TABLES.join(" or ")}, which only ${THE_FUNCTION} may.`;
const AGGREGATE_READS = `the app may run it, a function of the aggregate runs as the owner, and it reads ${GUARDED_TABLES.join(" or ")}, which only ${THE_FUNCTION} may.`;
const DYNAMIC =
  "it runs dynamic SQL (EXECUTE, or one of PostgreSQL's functions that run SQL from a text or read a table, a schema or the database by name), whose reads and settings no check can see.";

/**
 * PostgreSQL's own functions that run SQL from a text (query_to_xml and its
 * forms, ts_stat and ts_rewrite), read a table by a regclass that may be
 * made at run time (table_to_xml and its forms), read whole schemas or the
 * database (schema_to_xml, database_to_xml and their forms), or read a
 * cursor that another statement opened (cursor_to_xml and its form).
 * PostgreSQL records no dependency on one of its own functions, so the
 * catalog's pg_depend does not show a call: the text does.
 */
const RUNS_SQL = [
  "query_to_xml",
  "query_to_xmlschema",
  "query_to_xml_and_xmlschema",
  "table_to_xml",
  "table_to_xmlschema",
  "table_to_xml_and_xmlschema",
  "schema_to_xml",
  "schema_to_xmlschema",
  "schema_to_xml_and_xmlschema",
  "database_to_xml",
  "database_to_xmlschema",
  "database_to_xml_and_xmlschema",
  "cursor_to_xml",
  "cursor_to_xmlschema",
  "ts_stat",
  "ts_rewrite",
] as const;
const ESCAPES = "it writes a name in SQL's Unicode escapes (U&), which no check can read.";
const SETS =
  "it sets a setting itself (set_config, SET LOCAL or SET SESSION, a SET or RESET of a nortfox setting, RESET ALL, or pg_settings). Only the server's database layer sets the transaction's company, actor and channel.";
/** The catalog check's problem of a rule, after its relation's name and the rule's. */
const RULE = "A rule runs statements of its own beside a statement on its table or view, which no check reads. Only a view's own query (_RETURN) may be a rule.";

/** A routine that may still do one thing that the check counts, and why. */
interface Allowed {
  /** Its schema, name and arguments, as the catalog prints them. */
  readonly routine: string;
  readonly why: Exclude<Why, "reads">;
  readonly reason: string;
}

/**
 * The routines that may still set a setting or run dynamic SQL, each by its
 * name and arguments and for one reason, while the app may not run it. A
 * test pins the list: with none allowed, the migrated database shows exactly
 * these.
 */
const ALLOWED: readonly Allowed[] = [
  {
    routine: "access.keep_system_administrator()",
    why: "sets",
    reason: "The last system administrator's check, a trigger. It sets the company for its own two statements and then puts the transaction's company back (last-admin.db.test.ts).",
  },
  { routine: "meta.hide_statistics(target regclass)", why: "dynamic", reason: "A migration's helper: it sets the statistics targets of a table. Only the owner runs it, in a migration." },
  {
    routine: "meta.protect_company_table(target regclass, key_column name)",
    why: "dynamic",
    reason: "A migration's helper: it gives a company table its row level security, policies and triggers. Only the owner runs it, in a migration.",
  },
  {
    routine: "meta.protect_install_table(target regclass)",
    why: "dynamic",
    reason: "A migration's helper: it gives an install-wide table its row level security, policy and trigger. Only the owner runs it, in a migration.",
  },
];

/**
 * The part of a trigger's definition that is its condition (WHEN). The rest
 * names the trigger's function, which counts as a routine.
 */
const TRIGGER_CONDITION = " WHEN \\((.*)\\) EXECUTE FUNCTION ";

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
 * SET, and also glued to the name's quote (SET"nortfox.company_id"); RESET
 * ALL; and pg_settings. An UPDATE's SET names a column, never a
 * setting of ours. A function's SET clause needs no pattern: the owner may
 * not give one a setting of ours (42501), and pg_get_functiondef prints it in
 * the text that the patterns read.
 */
const RULES: readonly { readonly why: Why; readonly word: string; readonly pattern: string }[] = [
  { why: "reads", word: "memberships", pattern: namePattern("access", "memberships") },
  { why: "reads", word: "companies", pattern: namePattern("ledger", "companies") },
  { why: "dynamic", word: "execute", pattern: wordPattern("execute") },
  ...RUNS_SQL.map((name) => ({ why: "dynamic" as const, word: name, pattern: wordPattern(name) })),
  { why: "sets", word: "set_config", pattern: wordPattern("set_config") },
  { why: "sets", word: "pg_settings", pattern: wordPattern("pg_settings") },
  { why: "sets", word: "local", pattern: `${NAME_START}set${SQL_SPACE}+local${NAME_END}` },
  { why: "sets", word: "session", pattern: `${NAME_START}set${SQL_SPACE}+session${NAME_END}` },
  { why: "sets", word: "nortfox", pattern: `${NAME_START}(?:re)?set(?:${SQL_SPACE}+"?|")nortfox"?${SQL_SPACE}*\\.` },
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
 *   A trigger function's reads are left out: the app cannot call one, and a
 *   trigger gives its statement no rows.
 * - A routine that sets a setting itself, as the owner or as the app, at any
 *   depth, would let a statement enter a company that the one function did
 *   not give: only the server's database layer sets them. So would a routine
 *   that runs dynamic SQL, by EXECUTE or through one of PostgreSQL's
 *   functions that run SQL from a text or read by name (RUNS_SQL), or that
 *   writes a name in SQL's Unicode escapes, since no text match can see what
 *   it reads or sets. Such a routine counts whoever may run it. PostgreSQL
 *   runs a trigger on each write of its table with no right to run it, and a
 *   default, a check or a trigger in a statement of a routine that runs as
 *   the owner calls a routine with the owner's right. `allowed` names the few
 *   that may, each for one reason, while the app may not run them.
 * - The SQL that the catalog keeps and runs on a statement counts the same
 *   way, when it does one of those things itself or calls a routine that
 *   does: a view's query, a column's default or generated expression, a
 *   check constraint of a table or a domain, a domain's default, an index's
 *   expressions and condition, a policy, and a trigger's condition.
 * - A rule runs statements of its own beside a statement on its table or
 *   view, which no check reads. So no table or view has a rule, but a view's
 *   own query, which PostgreSQL keeps as the rule _RETURN and reads the text
 *   of above. PostgreSQL gives that name to no other rule (42P17 on a table,
 *   and a view has only one).
 *
 * And the app's only policy on either table is the company policy.
 */
async function oneFunctionProblems(client: Client, allowed: readonly Allowed[] = ALLOWED): Promise<string[]> {
  // The recursive query's estimated cost makes PostgreSQL compile it with JIT,
  // which takes a second or more, while the query itself runs in milliseconds.
  await client.query("SET jit = off");
  const readers = await client.query<{ name: string; routine: string | null; why: Why; aggregate: boolean; app_runs: boolean }>(
    `
    WITH RECURSIVE texts AS (
      SELECT p.oid, p.proname::text AS proname, n.nspname || '.' || p.proname AS name,
        n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS routine,
        CASE WHEN p.prokind = 'a' THEN '' ELSE pg_catalog.pg_get_functiondef(p.oid) END AS body
      FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND NOT EXISTS (SELECT FROM pg_catalog.pg_depend AS d WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid = p.oid AND d.deptype = 'e')
    ), functions AS MATERIALIZED (
      SELECT t.*, pg_catalog.lower(t.body) AS small FROM texts AS t
    ), patterns AS (
      SELECT * FROM ROWS FROM (pg_catalog.unnest($2::text[]), pg_catalog.unnest($3::text[]), pg_catalog.unnest($4::text[])) AS u (why, word, pattern)
    ), support AS (
      SELECT a.aggfnoid::pg_catalog.oid AS aggregate, s.fn
      FROM pg_catalog.pg_aggregate AS a
      CROSS JOIN LATERAL (VALUES (a.aggtransfn::pg_catalog.oid), (a.aggfinalfn::pg_catalog.oid), (a.aggcombinefn::pg_catalog.oid), (a.aggserialfn::pg_catalog.oid),
        (a.aggdeserialfn::pg_catalog.oid), (a.aggmtransfn::pg_catalog.oid), (a.aggminvtransfn::pg_catalog.oid), (a.aggmfinalfn::pg_catalog.oid)) AS s (fn)
      WHERE s.fn <> 0
    ), reading AS (
      SELECT f.oid, f.proname, u.why FROM functions AS f JOIN patterns AS u
        ON CASE WHEN pg_catalog.strpos(f.small, u.word) = 0 THEN false ELSE f.body ~* u.pattern END
      UNION
      SELECT f.oid, f.proname, r.why FROM functions AS f JOIN reading AS r ON f.oid <> r.oid
        AND (EXISTS (SELECT FROM support AS s WHERE s.aggregate = f.oid AND s.fn = r.oid)
          OR CASE WHEN pg_catalog.strpos(f.small, pg_catalog.lower(r.proname)) = 0 THEN false
            ELSE f.body ~* ($5 || pg_catalog.regexp_replace(r.proname, '([^[:alnum:]_])', '[\\1]', 'g') || $6) END)
    ), relations AS (
      SELECT c.oid, c.relkind FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    ), kept AS (
      SELECT 'the view ' || c.oid::pg_catalog.regclass::text AS place, pg_catalog.pg_get_viewdef(c.oid) AS body
      FROM relations AS c WHERE c.relkind IN ('v', 'm')
      UNION ALL
      SELECT CASE WHEN a.attgenerated = '' THEN 'the default of ' ELSE 'the generated column ' END
          || d.adrelid::pg_catalog.regclass::text || '.' || pg_catalog.quote_ident(a.attname),
        pg_catalog.pg_get_expr(d.adbin, d.adrelid)
      FROM pg_catalog.pg_attrdef AS d JOIN relations AS c ON c.oid = d.adrelid
        JOIN pg_catalog.pg_attribute AS a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      UNION ALL
      SELECT 'the check constraint ' || pg_catalog.quote_ident(x.conname) || ' of '
          || CASE WHEN x.conrelid = 0 THEN 'the domain ' || x.contypid::pg_catalog.regtype::text ELSE x.conrelid::pg_catalog.regclass::text END,
        pg_catalog.pg_get_constraintdef(x.oid)
      FROM pg_catalog.pg_constraint AS x JOIN pg_catalog.pg_namespace AS n ON n.oid = x.connamespace
      WHERE x.contype = 'c' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      UNION ALL
      SELECT 'the default of the domain ' || t.oid::pg_catalog.regtype::text, pg_catalog.pg_get_expr(t.typdefaultbin, 0)
      FROM pg_catalog.pg_type AS t JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace
      WHERE t.typdefaultbin IS NOT NULL AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      UNION ALL
      SELECT 'the index ' || x.indexrelid::pg_catalog.regclass::text, pg_catalog.pg_get_indexdef(x.indexrelid)
      FROM pg_catalog.pg_index AS x JOIN relations AS c ON c.oid = x.indrelid
      WHERE x.indexprs IS NOT NULL OR x.indpred IS NOT NULL
      UNION ALL
      SELECT 'the policy ' || pg_catalog.quote_ident(p.polname) || ' of ' || p.polrelid::pg_catalog.regclass::text,
        pg_catalog.concat_ws(' ', pg_catalog.pg_get_expr(p.polqual, p.polrelid), pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid))
      FROM pg_catalog.pg_policy AS p JOIN relations AS c ON c.oid = p.polrelid
      UNION ALL
      SELECT 'the condition of the trigger ' || pg_catalog.quote_ident(t.tgname) || ' of ' || t.tgrelid::pg_catalog.regclass::text,
        COALESCE(pg_catalog.substring(pg_catalog.pg_get_triggerdef(t.oid), $7), pg_catalog.pg_get_triggerdef(t.oid))
      FROM pg_catalog.pg_trigger AS t JOIN relations AS c ON c.oid = t.tgrelid
      WHERE t.tgqual IS NOT NULL
    ), stored AS MATERIALIZED (
      SELECT k.place, k.body, pg_catalog.lower(k.body) AS small FROM kept AS k
    )
    SELECT DISTINCT 0 AS kind, f.name, f.routine, r.why, p.prokind = 'a' AS aggregate,
      pg_catalog.has_function_privilege('nortfox_app', p.oid, 'EXECUTE') AS app_runs
    FROM reading AS r JOIN functions AS f ON f.oid = r.oid JOIN pg_catalog.pg_proc AS p ON p.oid = r.oid
    WHERE r.why <> 'reads' OR (pg_catalog.has_function_privilege('nortfox_app', p.oid, 'EXECUTE')
      AND p.prorettype NOT IN ('pg_catalog.trigger'::pg_catalog.regtype, 'pg_catalog.event_trigger'::pg_catalog.regtype)
      AND f.name <> $1 AND (p.prosecdef OR EXISTS (
        SELECT FROM support AS s JOIN reading AS sr ON sr.oid = s.fn AND sr.why = 'reads' JOIN pg_catalog.pg_proc AS sp ON sp.oid = s.fn
        WHERE s.aggregate = r.oid AND sp.prosecdef)))
    UNION
    SELECT 1, s.place, NULL, u.why, false, false FROM stored AS s JOIN patterns AS u
      ON u.why <> 'reads' AND CASE WHEN pg_catalog.strpos(s.small, u.word) = 0 THEN false ELSE s.body ~* u.pattern END
    UNION
    SELECT 1, s.place, NULL, r.why, false, false FROM stored AS s JOIN reading AS r
      ON r.why <> 'reads' AND CASE WHEN pg_catalog.strpos(s.small, pg_catalog.lower(r.proname)) = 0 THEN false
        ELSE s.body ~* ($5 || pg_catalog.regexp_replace(r.proname, '([^[:alnum:]_])', '[\\1]', 'g') || $6) END
    ORDER BY 1, 2, 4`,
    [
      THE_FUNCTION,
      RULES.map((rule) => rule.why),
      RULES.map((rule) => rule.word),
      RULES.map((rule) => rule.pattern),
      `${NAME_START}"?`,
      `"?${SQL_SPACE}*\\(`,
      TRIGGER_CONDITION,
    ],
  );
  const rules = await client.query<{ relation: string; name: string }>(
    `SELECT r.ev_class::pg_catalog.regclass::text AS relation, r.rulename AS name
     FROM pg_catalog.pg_rewrite AS r JOIN pg_catalog.pg_class AS c ON c.oid = r.ev_class JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND r.rulename <> '_RETURN'
     ORDER BY 1, 2`,
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
  const counted = readers.rows.filter((row) => row.app_runs || !allowed.some((allowance) => allowance.routine === row.routine && allowance.why === row.why));
  const problems = [...new Set(counted.map((row) => `${row.name}: ${row.why === "reads" && row.aggregate ? AGGREGATE_READS : why[row.why]}`))];
  for (const rule of rules.rows) {
    problems.push(`${rule.relation}: it has the rule ${rule.name}. ${RULE}`);
  }
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

    describe("a function that the app may run and that runs SQL through one of PostgreSQL's own functions", () => {
      it.each([
        ["query_to_xml over a joined name", "RETURN pg_catalog.query_to_xml('SELECT company_id, live_user_id FROM access.' || 'member' || 'ships', true, false, '')::text"],
        ["query_to_xml over a query it is given", "RETURN pg_catalog.query_to_xml(a, true, false, '')::text"],
        ["query_to_xmlschema", "RETURN pg_catalog.query_to_xmlschema(a, true, false, '')::text"],
        ["query_to_xml_and_xmlschema", "RETURN pg_catalog.query_to_xml_and_xmlschema(a, true, false, '')::text"],
        ["table_to_xml with a table named at run time", "RETURN pg_catalog.table_to_xml(('access.' || a)::pg_catalog.regclass, true, false, '')::text"],
        ["table_to_xmlschema", "RETURN pg_catalog.table_to_xmlschema(a::pg_catalog.regclass, true, false, '')::text"],
        ["table_to_xml_and_xmlschema", "RETURN pg_catalog.table_to_xml_and_xmlschema(a::pg_catalog.regclass, true, false, '')::text"],
        ["schema_to_xml, with no name joined", "RETURN pg_catalog.schema_to_xml('access', true, false, '')::text"],
        ["schema_to_xmlschema", "RETURN pg_catalog.schema_to_xmlschema(a::name, true, false, '')::text"],
        ["schema_to_xml_and_xmlschema", "RETURN pg_catalog.schema_to_xml_and_xmlschema(a::name, true, false, '')::text"],
        ["database_to_xml", "RETURN pg_catalog.database_to_xml(true, false, '')::text"],
        ["database_to_xmlschema", "RETURN pg_catalog.database_to_xmlschema(true, false, a)::text"],
        ["database_to_xml_and_xmlschema", "RETURN pg_catalog.database_to_xml_and_xmlschema(true, false, a)::text"],
        ["cursor_to_xml", "RETURN pg_catalog.cursor_to_xml(a::pg_catalog.refcursor, 10, true, false, '')::text"],
        ["cursor_to_xmlschema", "RETURN pg_catalog.cursor_to_xmlschema(a::pg_catalog.refcursor, true, false, '')::text"],
        ["ts_stat", "RETURN (SELECT pg_catalog.count(*) FROM pg_catalog.ts_stat(a))::text"],
        ["ts_rewrite", "RETURN pg_catalog.ts_rewrite('x'::pg_catalog.tsquery, a)::text"],
        [
          "query_to_xml over a call of set_config that it formats, in capitals",
          `LANGUAGE plpgsql AS $peek$ BEGIN RETURN PG_CATALOG.QUERY_TO_XML(pg_catalog.format('SELECT pg_catalog.set_' || 'config(%L, %L, true)', 'nort' || 'fox.company_id', a), true, false, '')::text; END $peek$`,
        ],
      ])("%s", async (_case, body) => {
        const language = body.startsWith("LANGUAGE") ? "" : "LANGUAGE sql";
        expect(
          await problemsAfter(`
            CREATE FUNCTION ledger.peek_builtin(a text) RETURNS text ${language} SECURITY DEFINER SET search_path = pg_catalog, pg_temp ${body};
            GRANT EXECUTE ON FUNCTION ledger.peek_builtin(text) TO nortfox_app;`),
        ).toEqual([`ledger.peek_builtin: ${DYNAMIC}`]);
      });

      it("finds it as the app too, and through a function that the app may not run itself, which counts as well", async () => {
        expect(
          await problemsAfter(`
            CREATE FUNCTION ledger.export_table(s text, t text) RETURNS xml LANGUAGE sql SET search_path = pg_catalog, pg_temp
              RETURN pg_catalog.query_to_xml(pg_catalog.format('SELECT * FROM %I.%I', s, t), true, false, '');
            GRANT EXECUTE ON FUNCTION ledger.export_table(text, text) TO nortfox_app;
            CREATE FUNCTION access.dump_schema() RETURNS xml LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
              RETURN pg_catalog."schema_to_xml"('access', true, false, '');
            CREATE FUNCTION access.dump_through() RETURNS xml LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
              RETURN access.dump_schema();
            GRANT EXECUTE ON FUNCTION access.dump_through() TO nortfox_app;`),
        ).toEqual([`access.dump_schema: ${DYNAMIC}`, `access.dump_through: ${DYNAMIC}`, `ledger.export_table: ${DYNAMIC}`]);
      });

      it("does not take a longer name, or a word inside another, for one", async () => {
        expect(
          await problemsAfter(`
            CREATE FUNCTION ledger.query_to_xml_text(a text) RETURNS text LANGUAGE sql SET search_path = pg_catalog, pg_temp
              RETURN 'totp_secrets_state_known' || a;
            GRANT EXECUTE ON FUNCTION ledger.query_to_xml_text(text) TO nortfox_app;
            CREATE FUNCTION ledger.calls_it(a text) RETURNS text LANGUAGE sql SET search_path = pg_catalog, pg_temp
              RETURN ledger.query_to_xml_text(a);
            GRANT EXECUTE ON FUNCTION ledger.calls_it(text) TO nortfox_app;`),
        ).toEqual([]);
      });
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
        ["with a plain SET glued to its quoted name", `LANGUAGE plpgsql AS $work$ BEGIN SET"nortfox.company_id"TO'5d1e7c3a-9b2f-4e8d-a6c4-1f0e2d3c4b5a'; END $work$`],
        ["with RESET glued to its quoted name, in small letters", `LANGUAGE plpgsql AS $work$ BEGIN reset"nortfox"."actor_id"; END $work$`],
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

      it("finds it in any schema, as a procedure, and through a function that the app may not run itself, which counts as well", async () => {
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
        ).toEqual([`ledger.enter: ${SETS}`, `ledger.set_company: ${SETS}`, `ledger.work_through: ${SETS}`, `public.work_in: ${SETS}`]);
      });

      it("needs no look at a function's SET clause: the owner may not give one a setting of ours", async () => {
        await expect(
          problemsAfter(`
            CREATE FUNCTION ledger.work_in() RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp SET nortfox.company_id = '5d1e7c3a-9b2f-4e8d-a6c4-1f0e2d3c4b5a'
              RETURN (SELECT 'x');`),
        ).rejects.toMatchObject({ code: "42501", message: 'permission denied to set parameter "nortfox.company_id"' });
      });

      it("does not take a read of a setting, an UPDATE's SET or a SET clause of the search path for one", async () => {
        expect(
          await problemsAfter(`
            CREATE FUNCTION ledger.read_company() RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp
              AS $read$ BEGIN RETURN pg_catalog.current_setting('nortfox.company_id', true); END $read$;
            GRANT EXECUTE ON FUNCTION ledger.read_company() TO nortfox_app;
            CREATE FUNCTION ledger.rename_none() RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
              AS $rename$ BEGIN UPDATE ledger.companies SET name = name WHERE false; END $rename$;
            GRANT EXECUTE ON FUNCTION ledger.rename_none() TO nortfox_app;`),
        ).toEqual([]);
      });
    });

    describe("a routine that the app may not run, which PostgreSQL still runs on the app's statements: a trigger on a write of its table", () => {
      it("finds a trigger that sets the transaction's company, also one that the app may run", async () => {
        expect(
          await problemsAfter(`
            CREATE FUNCTION access.follow_company() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
              AS $f$ BEGIN IF NEW.details ? 'company' THEN PERFORM set_config('nortfox.company_id', NEW.details ->> 'company', true); END IF; RETURN NULL; END $f$;
            CREATE TRIGGER account_events_follow AFTER INSERT ON access.account_events FOR EACH ROW EXECUTE FUNCTION access.follow_company();
            CREATE FUNCTION ledger.set_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
              AS $set$ BEGIN PERFORM set_config('nortfox.company_id', NEW.company_id::text, true); RETURN NULL; END $set$;
            GRANT EXECUTE ON FUNCTION ledger.set_trigger() TO nortfox_app;`),
        ).toEqual([`access.follow_company: ${SETS}`, `ledger.set_trigger: ${SETS}`]);
      });

      it("finds a trigger that runs dynamic SQL as the app, one that writes a name in Unicode escapes, and one that calls a routine that sets the company", async () => {
        expect(
          await problemsAfter(String.raw`
            CREATE FUNCTION ledger.run_trigger() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
              AS $run$ BEGIN EXECUTE TG_ARGV[0]; RETURN NULL; END $run$;
            CREATE FUNCTION ledger.escaped_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
              AS $esc$ BEGIN PERFORM pg_catalog.u&"set\005Fconfig"('nortfox.company_id', NEW.company_id::text, true); RETURN NULL; END $esc$;
            CREATE FUNCTION ledger.set_company(company text) RETURNS text LANGUAGE sql SET search_path = pg_catalog, pg_temp
              RETURN pg_catalog.set_config('nortfox.company_id', company, true);
            CREATE FUNCTION ledger.calls_setter() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
              AS $calls$ BEGIN PERFORM ledger.set_company(NEW.company_id::text); RETURN NULL; END $calls$;`),
        ).toEqual([`ledger.calls_setter: ${SETS}`, `ledger.escaped_trigger: ${ESCAPES}`, `ledger.run_trigger: ${DYNAMIC}`, `ledger.set_company: ${SETS}`]);
      });

      it("does not take a trigger's read of the memberships as the owner for one: the app cannot call a trigger function, and a trigger gives its statement no rows", async () => {
        expect(
          await problemsAfter(`
            CREATE FUNCTION access.count_on_write() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
              AS $count$ BEGIN PERFORM count(*) FROM access.memberships; RETURN NULL; END $count$;
            GRANT EXECUTE ON FUNCTION access.count_on_write() TO nortfox_app;`),
        ).toEqual([]);
      });
    });

    describe("the routines that may set a setting or run dynamic SQL", () => {
      it("are only the last system administrator's check, which puts the company back, and the migrations' helpers", async () => {
        expect(await oneFunctionProblems(owner, [])).toEqual([
          `access.keep_system_administrator: ${SETS}`,
          `meta.hide_statistics: ${DYNAMIC}`,
          `meta.protect_company_table: ${DYNAMIC}`,
          `meta.protect_install_table: ${DYNAMIC}`,
        ]);
      });

      it("count again when the app may run one, when one does something else, and for another routine of the same name", async () => {
        expect(await problemsAfter("GRANT EXECUTE ON FUNCTION meta.hide_statistics(regclass) TO nortfox_app;")).toEqual([`meta.hide_statistics: ${DYNAMIC}`]);
        expect(
          await problemsAfter(`
            CREATE OR REPLACE FUNCTION access.keep_system_administrator() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
              AS $admin$ BEGIN EXECUTE 'SELECT 1'; RETURN NULL; END $admin$;`),
        ).toEqual([`access.keep_system_administrator: ${DYNAMIC}`]);
        expect(
          await problemsAfter(`
            CREATE FUNCTION access.keep_system_administrator(company uuid) RETURNS text LANGUAGE sql SET search_path = pg_catalog, pg_temp
              RETURN pg_catalog.set_config('nortfox.company_id', company::text, true);`),
        ).toEqual([`access.keep_system_administrator: ${SETS}`]);
      });
    });

    describe("SQL that the catalog keeps and runs on the app's statements", () => {
      const company = "'5d1e7c3a-9b2f-4e8d-a6c4-1f0e2d3c4b5a'";
      it.each([
        [
          "a view's query",
          "CREATE VIEW access.follow WITH (security_invoker = true) AS SELECT pg_catalog.set_config('nortfox.company_id', e.details ->> 'company', true) AS company FROM access.account_events AS e",
          "the view access.follow",
        ],
        ["a column's default", `CREATE TABLE access.follow (id uuid, company text DEFAULT pg_catalog.set_config('nortfox.company_id', ${company}, true))`, "the default of access.follow.company"],
        [
          "a table's check constraint",
          "ALTER TABLE access.account_events ADD CONSTRAINT follow CHECK (pg_catalog.set_config('nortfox.company_id', details ->> 'company', true) IS NOT NULL) NOT VALID",
          "the check constraint follow of access.account_events",
        ],
        [
          "a domain's check constraint",
          "CREATE DOMAIN access.follow AS text CONSTRAINT follow CHECK (pg_catalog.set_config('nortfox.company_id', VALUE, true) IS NOT NULL)",
          "the check constraint follow of the domain access.follow",
        ],
        ["a domain's default", `CREATE DOMAIN access.follow AS text DEFAULT pg_catalog.set_config('nortfox.company_id', ${company}, true)`, "the default of the domain access.follow"],
        [
          "a policy",
          "CREATE POLICY follow ON access.account_events AS RESTRICTIVE FOR INSERT TO nortfox_app WITH CHECK (pg_catalog.set_config('nortfox.company_id', details ->> 'company', true) IS NOT NULL)",
          "the policy follow of access.account_events",
        ],
        [
          "a trigger's condition",
          "CREATE TRIGGER follow AFTER INSERT ON access.account_events FOR EACH ROW WHEN (pg_catalog.set_config('nortfox.company_id', NEW.details ->> 'company', true) IS NOT NULL) EXECUTE FUNCTION ledger.refuse_truncate()",
          "the condition of the trigger follow of access.account_events",
        ],
      ])("finds one that sets a setting: %s", async (_case, setup, label) => {
        expect(await problemsAfter(`${setup};`)).toEqual([`${label}: ${SETS}`]);
      });

      it("finds a generated column and an index's expression that call a routine that sets one, which counts too", async () => {
        expect(
          await problemsAfter(`
            CREATE FUNCTION ledger.pin_company(company text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
              RETURN pg_catalog.set_config('nortfox.company_id', company, true);
            CREATE TABLE access.follow (company text, pinned text GENERATED ALWAYS AS (ledger.pin_company(company)) STORED);
            CREATE INDEX follow_pinned ON access.follow ((ledger.pin_company(company)));`),
        ).toEqual([`ledger.pin_company: ${SETS}`, `the generated column access.follow.pinned: ${SETS}`, `the index access.follow_pinned: ${SETS}`]);
      });

      it("finds a default that calls a setter that the app may not run, which runs in a statement of the owner's, and a view that runs dynamic SQL", async () => {
        expect(
          await problemsAfter(`
            CREATE FUNCTION ledger.set_company(company text) RETURNS text LANGUAGE sql SET search_path = pg_catalog, pg_temp
              RETURN pg_catalog.set_config('nortfox.company_id', company, true);
            CREATE TABLE access.follow (company text DEFAULT ledger.set_company(${company}));
            CREATE VIEW access.dump WITH (security_invoker = true) AS SELECT pg_catalog.query_to_xml('SELECT 1', true, false, '') AS x;`),
        ).toEqual([`ledger.set_company: ${SETS}`, `the default of access.follow.company: ${SETS}`, `the view access.dump: ${DYNAMIC}`]);
      });

      it("does not take a read of a setting, a plain check or a trigger's own function for one", async () => {
        expect(
          await problemsAfter(`
            CREATE TABLE access.follow (company text DEFAULT pg_catalog.current_setting('nortfox.company_id', true), note text CHECK (note ~ '^[a-z]+$'));
            CREATE VIEW access.follow_view WITH (security_invoker = true) AS SELECT pg_catalog.current_setting('nortfox.company_id', true) AS company;
            CREATE TRIGGER follow AFTER INSERT ON access.follow FOR EACH ROW WHEN (NEW.note IS NOT NULL) EXECUTE FUNCTION access.keep_system_administrator();`),
        ).toEqual([]);
      });
    });

    it("finds every rule but a view's own query: a rule runs statements of its own beside the app's", async () => {
      expect(
        await problemsAfter(`
          CREATE RULE account_events_follow AS ON INSERT TO access.account_events WHERE NEW.details ? 'company'
            DO ALSO SELECT pg_catalog.set_config('nortfox.company_id', NEW.details ->> 'company', true);
          CREATE RULE keep_events AS ON DELETE TO access.account_events DO INSTEAD NOTHING;
          CREATE VIEW access.recent_events WITH (security_invoker = true) AS SELECT e.id, e.kind FROM access.account_events AS e;
          CREATE RULE add_event AS ON INSERT TO access.recent_events DO INSTEAD NOTHING;`),
      ).toEqual([
        `access.account_events: it has the rule account_events_follow. ${RULE}`,
        `access.account_events: it has the rule keep_events. ${RULE}`,
        `access.recent_events: it has the rule add_event. ${RULE}`,
      ]);
      expect(await problemsAfter("CREATE VIEW access.recent_events WITH (security_invoker = true) AS SELECT e.id, e.kind FROM access.account_events AS e;")).toEqual([]);
      // PostgreSQL gives a view's own name to no other rule.
      await expect(problemsAfter(`CREATE RULE "_RETURN" AS ON INSERT TO access.account_events DO INSTEAD NOTHING;`)).rejects.toMatchObject({
        code: "42P17",
        message: 'non-view rule for "account_events" must not be named "_RETURN"',
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
