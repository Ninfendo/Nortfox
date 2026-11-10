// SPDX-License-Identifier: AGPL-3.0-only

// The table guard (docs/decisions/0009). It reads the catalog and lists every
// table and view, in every schema but PostgreSQL's own and outside every
// extension, and says what each one lacks. The migration runner runs it
// inside each migration's transaction and rolls the migration back on any
// problem, so a table without its protection never commits.
//
// What every company table must have:
// - row level security, enabled and forced;
// - exactly the three company policies below, as permissive policies, and no
//   other permissive policy (a restrictive one only narrows the rows);
// - a primary key of one uuid column, and the audit_history trigger that
//   writes the behandlingshistorik with it;
// - the refuse_truncate trigger;
// - company_id in every foreign key to another company table, because a
//   foreign key check skips row level security;
// - company_id as a key column of every unique index, and compared with = in
//   every exclusion constraint, because their checks skip row level security
//   too: one company could learn from the error whether another company holds
//   a value. A primary key of one uuid column, and the pinned KEY_EXCEPTIONS,
//   leave it out;
// - no planner statistics of its values: a statistics target of 0 on every
//   column and on every expression column of its indexes, and no extended
//   statistics. The planner reads statistics for a leakproof operator also
//   under row level security, and EXPLAIN shows its estimates to every role
//   that reads the table, so they would tell a reader another company's
//   values. meta.hide_statistics sets the targets;
// - no partial index: ANALYZE keeps the count of the rows that meet its
//   condition, of every company together, in pg_class, which every role
//   reads. A whole unique index keeps the same rule with a NULL in the rows
//   it does not bind;
// - nortfox_owner as its owner.
// And every table and view: privileges only for the app (never TRUNCATE,
// REFERENCES or TRIGGER) and for the readers (only SELECT). A view reads with
// the caller's rights (security_invoker). A materialized view is refused.
//
// An install-wide table holds what belongs to no company, such as a login
// identity (db/README.md, the schema access). Each is on INSTALL_TABLES with
// its class and a reason, and must have:
// - its place in the schema access, and no column named company_id, which
//   would make it a company table;
// - row level security, enabled and forced;
// - exactly the owner's one policy over every row, which the lookup
//   functions read and write through, and the app policies of its class,
//   and no other permissive policy: a person table's compare the person's
//   column with access.current_person_id(), a company table's compare its
//   company column with ledger.current_company_id(), each for the commands
//   it lists; a public table's let the app read every row; a secret table has
//   none;
// - the refuse_truncate trigger;
// - a company column paired with company_id in every foreign key to a
//   company table but ledger.companies, so a row can never name company A and
//   a row of company B: the table's own company column, or for another class
//   a column whose name ends in _company_id;
// - nortfox_owner as its owner;
// - no privilege for a reader, and none for the app on a secret table.
// No reader reads such a table, so its statistics and partial indexes show
// no reader anything, and both are allowed. A table in the schema access
// that is neither a company table nor on the list fails.
//
// The expected policy texts are written with ledger. in front, so the guard
// can never pass a policy that calls a function of the same name in another
// schema. With ledger on the search path, pg_get_expr leaves the schema out
// and the guard fails instead; the runner sets search_path to pg_catalog.

import type { ClientBase } from "pg";

const OWNER = "nortfox_owner";
const APP = "nortfox_app";
const READER = "nortfox_reader";

/** The schema of the install-wide tables. */
const INSTALL_SCHEMA = "access";

const COMPANY_CHECK = "(company_id = ledger.current_company_id())";

// A reader's policy reads its company, and its role's oid, once for the
// query, before any row (db/migrations/0001_foundation.sql says how).
const READER_COMPANY = "(company_id = ( SELECT ledger.reader_company_id() AS reader_company_id))";
const READER_CHECK = `(${READER_COMPANY} AND ${READER_COMPANY})`;
const READER_ROLE = "(role_oid = ( SELECT ledger.current_role_oid() AS current_role_oid))";
const OWN_BINDING = `(${READER_ROLE} AND ${READER_ROLE} AND (role_name = CURRENT_USER))`;

interface Policy {
  readonly role: string;
  readonly command: string;
  readonly using: string | null;
  readonly check: string | null;
}

const OWNER_POLICY: Policy = { role: OWNER, command: "ALL", using: COMPANY_CHECK, check: COMPANY_CHECK };

/** The policies of a company table. */
const COMPANY_POLICIES: readonly Policy[] = [
  { role: APP, command: "ALL", using: COMPANY_CHECK, check: COMPANY_CHECK },
  OWNER_POLICY,
  { role: READER, command: "SELECT", using: READER_CHECK, check: null },
];

// The owner's reads by the transaction's person, which only the one
// membership function makes (db/migrations/0007_companies_memberships.sql):
// the person's live memberships, and the companies that hold one.
const PERSON_MEMBERSHIPS = "(live_user_id = access.current_person_id())";
const PERSON_COMPANIES =
  "(EXISTS ( SELECT\n   FROM access.memberships m\n  WHERE ((m.company_id = companies.company_id) AND (m.live_user_id = access.current_person_id()))))";

/** How the guard holds a table that is an exception, and why. */
export type GuardException =
  /** Only its owner and its privileges are checked. */
  | { readonly kind: "not a company table"; readonly why: string }
  /** Every check but the history trigger. */
  | { readonly kind: "no history trigger"; readonly why: string }
  /**
   * Every check, with these policies in place of the company policies. The
   * guard runs after each migration, so a table that a later migration gives
   * a policy of its own names the policies it had before: `earlier` holds
   * them, until its table `until` exists, which the same migration made.
   */
  | {
      readonly kind: "own policies";
      readonly why: string;
      readonly policies: readonly Policy[];
      readonly earlier?: { readonly until: string; readonly policies: readonly Policy[] };
    };

/** The tables the guard holds to other rules. A test pins the list. */
export const GUARD_EXCEPTIONS: ReadonlyMap<string, GuardException> = new Map<string, GuardException>([
  ["meta.schema_migrations", { kind: "not a company table", why: "It holds no company data: it is the runner's list of applied migrations." }],
  [
    "ledger.transaction_actors",
    {
      kind: "not a company table",
      why: "It holds no company data: it keeps the actor of each backend's writing transaction, so the transaction keeps one actor. Only the owner reads and writes it.",
    },
  ],
  ["audit.history", { kind: "no history trigger", why: "It is the behandlingshistorik itself." }],
  [
    "ledger.reader_roles",
    {
      kind: "own policies",
      why: "It binds each reader role to its company, so a reader sees its own binding by its role's oid and name. The app has no access.",
      policies: [
        OWNER_POLICY,
        { role: READER, command: "SELECT", using: OWN_BINDING, check: null },
      ],
    },
  ],
  [
    "access.memberships",
    {
      kind: "own policies",
      why: "The company policies, and the owner reads the live memberships of the transaction's person in every company, which only the one membership function does. The app reads only its company's.",
      policies: [...COMPANY_POLICIES, { role: OWNER, command: "SELECT", using: PERSON_MEMBERSHIPS, check: null }],
    },
  ],
  [
    "ledger.companies",
    {
      kind: "own policies",
      why: "The company policies, and the owner reads the companies where the transaction's person has a live membership, which only the one membership function does. The app reads only its company.",
      policies: [...COMPANY_POLICIES, { role: OWNER, command: "SELECT", using: PERSON_COMPANIES, check: null }],
      earlier: { until: "access.memberships", policies: COMPANY_POLICIES },
    },
  ],
]);

/** A command an app policy of an install-wide table is for. */
export type AppCommand = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

/** An install-wide table's class, and why it is on the list. */
export type InstallTable =
  | { readonly class: "person"; readonly column: string; readonly commands: readonly AppCommand[]; readonly why: string }
  | { readonly class: "company"; readonly column: string; readonly commands: readonly AppCommand[]; readonly why: string }
  | { readonly class: "public"; readonly why: string }
  | { readonly class: "secret"; readonly why: string };

/** The install-wide tables, each with its class and why it belongs to no company. A test pins the list. */
export const INSTALL_TABLES: ReadonlyMap<string, InstallTable> = new Map<string, InstallTable>([
  [
    "access.identities",
    {
      class: "person",
      column: "id",
      commands: ["SELECT", "UPDATE"],
      why: "A login identity is one person's, for every company. The app reads and changes only the person's own, and only the database's own functions make one.",
    },
  ],
  [
    "access.account_events",
    {
      class: "person",
      column: "identity_id",
      commands: ["SELECT", "INSERT"],
      why: "Kontoaktivitet is the person's own events, across companies. The app reads and adds only the person's own.",
    },
  ],
  [
    "access.idempotency_keys",
    {
      class: "person",
      column: "actor_id",
      commands: ["SELECT", "INSERT"],
      why: "The keys of a person's own writes keep no company's answer in a company table. The app reads and adds only the person's own.",
    },
  ],
  [
    "access.recent_companies",
    {
      class: "person",
      column: "identity_id",
      commands: ["SELECT", "INSERT", "UPDATE"],
      why: "The companies a person chose last, across companies. The app reads and records only the person's own.",
    },
  ],
  [
    "access.membership_contacts",
    {
      class: "company",
      column: "contact_company_id",
      commands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
      why: "A member's work e-mail and phone in one company are profile data, which an identity's deletion erases, so they keep no history. The app reads and writes only its company's.",
    },
  ],
  [
    "access.api_tokens",
    {
      class: "company",
      column: "token_company_id",
      commands: ["SELECT", "INSERT", "UPDATE"],
      why: "A member's API token is bound to one company and kept only as its hash. Its trigger writes its entries in the company's behandlingshistorik, so the table keeps no history of its own. The app reads, adds and revokes only its company's, and the resolver finds one by its hash through a lookup function.",
    },
  ],
  [
    "access.consents",
    {
      class: "company",
      column: "consent_company_id",
      commands: ["SELECT", "INSERT", "UPDATE"],
      why: "A person's consent for an MCP client is bound to one company. Its trigger writes its entries in the company's behandlingshistorik, so the table keeps no history of its own. The app reads, gives and revokes only its company's.",
    },
  ],
  [
    "access.oauth_clients",
    {
      class: "public",
      why: "An MCP client registers itself for the whole install, and any company's member may approve it. Its client id is public. The app reads every client, and only the registration function adds one.",
    },
  ],
  [
    "access.catalogue_programs",
    { class: "public", why: "The programs of the permission catalogue are the same for every company. The app reads them, and only a migration writes them." },
  ],
  [
    "access.catalogue_groups",
    { class: "public", why: "The groups of the permission catalogue are the same for every company. The app reads them, and only a migration writes them." },
  ],
  [
    "access.catalogue_permissions",
    { class: "public", why: "The permissions of the catalogue are the same for every company. The app reads them, and only a migration writes them." },
  ],
  [
    "access.catalogue_program_permissions",
    { class: "public", why: "Each program's set of permissions is the same for every company. The app reads it, and only a migration writes it." },
  ],
  ["access.password_credentials", { class: "secret", why: "It holds each identity's password hash. Only the lookup functions read it." }],
  ["access.totp_secrets", { class: "secret", why: "It holds each identity's sealed TOTP secrets. Only the lookup functions read it." }],
  ["access.known_devices", { class: "secret", why: "It holds the hashes of the device cookies. Only the lookup functions read it." }],
  ["access.sessions", { class: "secret", why: "It holds the hashes of the session cookies. Only the lookup functions read it." }],
  ["access.login_challenges", { class: "secret", why: "It holds the hashes of the login challenges. Only the lookup functions read it." }],
  ["access.setup_tokens", { class: "secret", why: "It holds the hashes of the setup links. Only the lookup functions read it." }],
  ["access.attempt_counters", { class: "secret", why: "It counts each account's failed guesses. Only the lookup functions read it." }],
  ["access.install_keys", { class: "secret", why: "It holds the install key's check value of each key id. Only the lookup functions read it." }],
  [
    "access.invitation_links",
    { class: "secret", why: "It holds the hashes of the invitation links, with what a link's page shows before anyone accepts. Only the lookup functions read it." },
  ],
  [
    "access.oauth_requests",
    { class: "secret", why: "It holds the hashes of the MCP clients' authorization requests and of the login cookies they are bound to. Only the lookup functions read it." },
  ],
  ["access.oauth_codes", { class: "secret", why: "It holds the hashes of the OAuth codes. Only the lookup functions read it." }],
  ["access.oauth_access_tokens", { class: "secret", why: "It holds the hashes of the MCP access tokens. Only the lookup functions read it." }],
  ["access.oauth_refresh_tokens", { class: "secret", why: "It holds the hashes of the MCP refresh tokens. Only the lookup functions read it." }],
]);

/** The owner's one policy on every install-wide table: every row, which the lookup functions read and write through. */
const INSTALL_OWNER_POLICY: Policy = { role: OWNER, command: "ALL", using: "true", check: "true" };

/** The policies an install-wide table of its class must have. */
function installPolicies(entry: InstallTable): Policy[] {
  if (entry.class === "secret") {
    return [INSTALL_OWNER_POLICY];
  }
  if (entry.class === "public") {
    return [INSTALL_OWNER_POLICY, { role: APP, command: "SELECT", using: "true", check: null }];
  }
  const rule = entry.class === "person" ? `(${entry.column} = access.current_person_id())` : `(${entry.column} = ledger.current_company_id())`;
  return [
    INSTALL_OWNER_POLICY,
    ...entry.commands.map((command) => ({
      role: APP,
      command,
      using: command === "INSERT" ? null : rule,
      check: command === "INSERT" || command === "UPDATE" ? rule : null,
    })),
  ];
}

/**
 * The unique indexes of company tables that may leave company_id out, by
 * schema-qualified name, and why their checks tell no company anything about
 * another. A test pins the list.
 */
export const KEY_EXCEPTIONS: ReadonlyMap<string, string> = new Map<string, string>([
  ["audit.history_pkey", "The history's own id is an identity column that only the history trigger writes. No caller gives it."],
  ["ledger.companies_database_number_key", "The tenant id comes from one sequence for the install. No caller gives it or changes it."],
  ["ledger.reader_roles_role_oid_key", "A reader role, by its oid, is bound to one company. Only the owner writes the bindings, and the app has no access."],
]);

const COMMANDS: Readonly<Record<string, string>> = { "*": "ALL", r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE" };

/** pg_trigger.tgtype bits: FOR EACH ROW, BEFORE, INSERT, DELETE, UPDATE, TRUNCATE. */
const ROW = 1;
const BEFORE = 2;
const INSERT = 4;
const DELETE = 8;
const UPDATE = 16;
const TRUNCATE = 32;
const HISTORY_TYPE = ROW | INSERT | DELETE | UPDATE;
const TRUNCATE_TYPE = BEFORE | TRUNCATE;

const NO_HISTORY =
  "has no audit_history trigger: AFTER INSERT OR UPDATE OR DELETE, FOR EACH ROW, enabled, with no WHEN and no column list, calling audit.write_history with the primary key column.";
const NO_TRUNCATE = "has no refuse_truncate trigger: BEFORE TRUNCATE, FOR EACH STATEMENT, enabled, calling ledger.refuse_truncate().";

const KINDS: Readonly<Record<string, string>> = {
  m: "is a materialized view, which row level security does not cover.",
  f: "is a foreign table, which row level security does not cover.",
};

const SECURITY_INVOKER = /^security_invoker=(?:true|on|yes|1)$/i;

/** The relations the guard reads: every table and view outside PostgreSQL's own schemas and the extensions. */
const RELATIONS = `
  SELECT c.oid, n.nspname || '.' || c.relname AS relation, n.nspname AS schema
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\\_toast%'
    AND n.nspname NOT LIKE 'pg\\_temp\\_%'
    AND NOT EXISTS (
      SELECT FROM pg_catalog.pg_depend AS d
      WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid = c.oid AND d.deptype = 'e'
    )
`;

interface RelationRow {
  readonly relation: string;
  readonly schema: string;
  readonly kind: string;
  readonly owner: string;
  readonly rls: boolean;
  readonly forced: boolean;
  readonly options: string[];
  readonly company: boolean;
  readonly key: string | null;
}

interface PolicyRow {
  readonly relation: string;
  readonly name: string;
  readonly command: string;
  readonly permissive: boolean;
  readonly roles: string[];
  readonly using: string | null;
  readonly check: string | null;
}

interface TriggerRow {
  readonly relation: string;
  readonly function: string;
  readonly type: number;
  readonly enabled: string;
  readonly args: string;
  readonly conditional: boolean;
}

interface ForeignKeyRow {
  readonly relation: string;
  readonly name: string;
  readonly referenced: string;
  readonly columns: string[];
  readonly referencedColumns: string[];
}

interface PrivilegeRow {
  readonly relation: string;
  readonly grantee: string;
  readonly privilege: string;
  readonly column: string | null;
}

interface UniqueRow {
  readonly relation: string;
  readonly name: string;
  readonly qualified: string;
  readonly exclusion: boolean;
  readonly uuidKey: boolean;
  readonly company: boolean;
}

interface StatisticsRow {
  readonly relation: string;
  /** What keeps statistics: a column, or an expression column of an index. */
  readonly what: string;
}

interface ExtendedStatisticsRow {
  readonly relation: string;
  readonly name: string;
}

interface PartialIndexRow {
  readonly relation: string;
  readonly name: string;
}

const COUNTS_BY_VALUE =
  "ANALYZE keeps its row count in pg_class, which every role reads, and that count is of the rows of every company that meet its condition.";

const KEEPS_VALUES = "which hold values of every company's rows: EXPLAIN shows estimates from them to every role that reads the table.";

/** Every table and view the guard reads, by name. */
export async function guardedRelations(client: ClientBase): Promise<string[]> {
  const found = await client.query<{ relation: string }>(`SELECT r.relation FROM (${RELATIONS}) AS r ORDER BY 1`);
  return found.rows.map((row) => row.relation);
}

async function read(client: ClientBase) {
  const relations = await client.query<RelationRow>(`
    SELECT r.relation, r.schema, c.relkind AS kind, pg_catalog.pg_get_userbyid(c.relowner) AS owner,
      c.relrowsecurity AS rls, c.relforcerowsecurity AS forced, COALESCE(c.reloptions, '{}') AS options,
      EXISTS (
        SELECT FROM pg_catalog.pg_attribute AS a
        WHERE a.attrelid = c.oid AND a.attname = 'company_id' AND a.attnum > 0 AND NOT a.attisdropped
      ) AS company,
      (
        SELECT a.attname
        FROM pg_catalog.pg_constraint AS k
        JOIN pg_catalog.pg_attribute AS a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
        WHERE k.conrelid = c.oid AND k.contype = 'p' AND pg_catalog.cardinality(k.conkey) = 1
          AND a.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype
      ) AS key
    FROM (${RELATIONS}) AS r JOIN pg_catalog.pg_class AS c ON c.oid = r.oid
    ORDER BY 1`);
  const policies = await client.query<PolicyRow>(`
    SELECT r.relation, p.polname AS name, p.polcmd AS command, p.polpermissive AS permissive,
      ARRAY(
        SELECT CASE WHEN role = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(role)::text END
        FROM pg_catalog.unnest(p.polroles) AS role ORDER BY 1
      ) AS roles,
      pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS using,
      pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check
    FROM (${RELATIONS}) AS r JOIN pg_catalog.pg_policy AS p ON p.polrelid = r.oid
    ORDER BY 1, 2`);
  const triggers = await client.query<TriggerRow>(`
    SELECT r.relation, fn.nspname || '.' || f.proname AS function, t.tgtype::integer AS type, t.tgenabled AS enabled,
      pg_catalog.encode(t.tgargs, 'escape') AS args,
      (t.tgqual IS NOT NULL OR t.tgattr::text <> '') AS conditional
    FROM (${RELATIONS}) AS r
    JOIN pg_catalog.pg_trigger AS t ON t.tgrelid = r.oid AND NOT t.tgisinternal
    JOIN pg_catalog.pg_proc AS f ON f.oid = t.tgfoid
    JOIN pg_catalog.pg_namespace AS fn ON fn.oid = f.pronamespace
    ORDER BY 1, t.tgname`);
  const keys = await client.query<ForeignKeyRow>(`
    SELECT r.relation, k.conname AS name, fn.nspname || '.' || f.relname AS referenced,
      ARRAY(
        SELECT a.attname::text FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY AS u (attnum, place)
        JOIN pg_catalog.pg_attribute AS a ON a.attrelid = k.conrelid AND a.attnum = u.attnum ORDER BY u.place
      ) AS columns,
      ARRAY(
        SELECT a.attname::text FROM pg_catalog.unnest(k.confkey) WITH ORDINALITY AS u (attnum, place)
        JOIN pg_catalog.pg_attribute AS a ON a.attrelid = k.confrelid AND a.attnum = u.attnum ORDER BY u.place
      ) AS "referencedColumns"
    FROM (${RELATIONS}) AS r
    JOIN pg_catalog.pg_constraint AS k ON k.conrelid = r.oid AND k.contype = 'f'
    JOIN pg_catalog.pg_class AS f ON f.oid = k.confrelid
    JOIN pg_catalog.pg_namespace AS fn ON fn.oid = f.relnamespace
    ORDER BY 1, 2`);
  const privileges = await client.query<PrivilegeRow>(`
    SELECT r.relation, CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(g.grantee) END AS grantee,
      g.privilege_type AS privilege, NULL AS column
    FROM (${RELATIONS}) AS r JOIN pg_catalog.pg_class AS c ON c.oid = r.oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) AS g
    WHERE g.grantee <> c.relowner
    UNION ALL
    SELECT r.relation, CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(g.grantee) END,
      g.privilege_type, a.attname::text
    FROM (${RELATIONS}) AS r JOIN pg_catalog.pg_class AS c ON c.oid = r.oid
    JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
    CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) AS g
    WHERE g.grantee <> c.relowner
    ORDER BY 1, 2, 3, 4`);
  // Every unique index and every exclusion constraint: whether it is a
  // primary key of one uuid column, and whether company_id is one of its key
  // columns, compared with = in an exclusion constraint.
  const uniques = await client.query<UniqueRow>(`
    SELECT r.relation, i.relname AS name, n.nspname || '.' || i.relname AS qualified,
      k.contype IS NOT DISTINCT FROM 'x' AS exclusion,
      (x.indisprimary AND x.indnkeyatts = 1 AND EXISTS (
        SELECT FROM pg_catalog.pg_attribute AS a
        WHERE a.attrelid = x.indrelid AND a.attnum = x.indkey[0] AND a.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype
      )) AS "uuidKey",
      EXISTS (
        SELECT FROM pg_catalog.generate_series(0, x.indnkeyatts - 1) AS p (place)
        JOIN pg_catalog.pg_attribute AS a ON a.attrelid = x.indrelid AND a.attnum = x.indkey[p.place]
        WHERE a.attname = 'company_id'
          AND (
            k.contype IS DISTINCT FROM 'x'
            OR (SELECT o.oprname FROM pg_catalog.pg_operator AS o WHERE o.oid = k.conexclop[p.place + 1]) = '='
          )
      ) AS company
    FROM (${RELATIONS}) AS r
    JOIN pg_catalog.pg_index AS x ON x.indrelid = r.oid
    JOIN pg_catalog.pg_class AS i ON i.oid = x.indexrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = i.relnamespace
    LEFT JOIN pg_catalog.pg_constraint AS k ON k.conindid = x.indexrelid AND k.conrelid = x.indrelid AND k.contype IN ('p', 'u', 'x')
    WHERE x.indisunique OR k.contype = 'x'
    ORDER BY 1, 2`);
  // Every column, and every expression column of an index, whose statistics
  // target is not 0: ANALYZE keeps statistics of its values. NULL is the
  // default target.
  const statistics = await client.query<StatisticsRow>(`
    SELECT s.relation, s.what FROM (
      SELECT r.relation, 0 AS place, '' AS index, a.attnum AS number, 'the column ' || a.attname AS what
      FROM (${RELATIONS}) AS r
      JOIN pg_catalog.pg_attribute AS a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE a.attstattarget IS DISTINCT FROM 0
      UNION ALL
      SELECT r.relation, 1, i.relname, a.attnum, 'column ' || a.attnum::text || ' of the index ' || i.relname
      FROM (${RELATIONS}) AS r
      JOIN pg_catalog.pg_index AS x ON x.indrelid = r.oid
      JOIN pg_catalog.pg_class AS i ON i.oid = x.indexrelid
      JOIN pg_catalog.pg_attribute AS a ON a.attrelid = x.indexrelid AND a.attnum > 0
      WHERE x.indkey[a.attnum - 1] = 0 AND a.attstattarget IS DISTINCT FROM 0
    ) AS s
    ORDER BY s.relation, s.place, s.index, s.number`);
  const extendedStatistics = await client.query<ExtendedStatisticsRow>(`
    SELECT r.relation, s.stxname AS name
    FROM (${RELATIONS}) AS r JOIN pg_catalog.pg_statistic_ext AS s ON s.stxrelid = r.oid
    ORDER BY 1, 2`);
  // Every partial index: ANALYZE counts the rows that meet its condition.
  const partialIndexes = await client.query<PartialIndexRow>(`
    SELECT r.relation, i.relname AS name
    FROM (${RELATIONS}) AS r
    JOIN pg_catalog.pg_index AS x ON x.indrelid = r.oid
    JOIN pg_catalog.pg_class AS i ON i.oid = x.indexrelid
    WHERE x.indpred IS NOT NULL
    ORDER BY 1, 2`);
  return {
    relations: relations.rows,
    policies: policies.rows,
    triggers: triggers.rows,
    keys: keys.rows,
    privileges: privileges.rows,
    uniques: uniques.rows,
    statistics: statistics.rows,
    extendedStatistics: extendedStatistics.rows,
    partialIndexes: partialIndexes.rows,
  };
}

/** The problem of a unique index or an exclusion constraint of a company table, or undefined when it has none. */
function uniqueProblem(row: UniqueRow): string | undefined {
  if (row.company || row.uuidKey || KEY_EXCEPTIONS.has(row.qualified)) {
    return undefined;
  }
  return row.exclusion
    ? `the exclusion constraint ${row.name} does not compare company_id with =, so its check compares the rows of every company.`
    : `the unique index ${row.name} does not have company_id as a key column, so its check compares the rows of every company.`;
}

function describePolicy(policy: Policy): string {
  const parts = [...(policy.using === null ? [] : [`USING ${policy.using}`]), ...(policy.check === null ? [] : [`WITH CHECK ${policy.check}`])];
  return `has no permissive policy for ${policy.role} on ${policy.command} with ${parts.join(" and ")}.`;
}

function matches(found: PolicyRow, wanted: Policy): boolean {
  return (
    found.roles.length === 1 &&
    found.roles[0] === wanted.role &&
    COMMANDS[found.command] === wanted.command &&
    found.using === wanted.using &&
    found.check === wanted.check
  );
}

function policyProblems(wanted: readonly Policy[], found: readonly PolicyRow[]): string[] {
  const permissive = found.filter((policy) => policy.permissive);
  return [
    ...wanted.filter((policy) => !permissive.some((row) => matches(row, policy))).map(describePolicy),
    ...permissive
      .filter((row) => !wanted.some((policy) => matches(row, policy)))
      .map((row) => `has the permissive policy ${row.name}, which the guard does not expect.`),
  ];
}

function triggerProblems(needsHistory: boolean, key: string | null, found: readonly TriggerRow[]): string[] {
  const enabled = found.filter((trigger) => (trigger.enabled === "O" || trigger.enabled === "A") && !trigger.conditional);
  const history = enabled.some(
    (trigger) => trigger.function === "audit.write_history" && trigger.type === HISTORY_TYPE && key !== null && trigger.args === `${key}\\000`,
  );
  const truncate = enabled.some((trigger) => trigger.function === "ledger.refuse_truncate" && trigger.type === TRUNCATE_TYPE);
  return [...(history || !needsHistory ? [] : [NO_HISTORY]), ...(truncate ? [] : [NO_TRUNCATE])];
}

function privilegeProblem(row: PrivilegeRow): string | undefined {
  const what = row.column === null ? row.privilege : `${row.privilege} on ${row.column}`;
  if (row.grantee === APP) {
    return ["TRUNCATE", "REFERENCES", "TRIGGER"].includes(row.privilege)
      ? `${APP} has ${what}. The app never gets TRUNCATE, REFERENCES or TRIGGER.`
      : undefined;
  }
  if (row.grantee === READER) {
    return row.privilege === "SELECT" ? undefined : `${READER} has ${what}. A reader only gets SELECT.`;
  }
  return `${row.grantee} has ${what}. Only ${APP} and ${READER} get privileges on a table.`;
}

/** The problem of a privilege on an install-wide table, or undefined: a reader gets none, and the app none on a secret table. */
function installPrivilegeProblem(row: PrivilegeRow, entry: InstallTable): string | undefined {
  const what = row.column === null ? row.privilege : `${row.privilege} on ${row.column}`;
  if (row.grantee === READER) {
    return `${READER} has ${what}. A reader gets nothing on an install-wide table.`;
  }
  if (row.grantee === APP && entry.class === "secret") {
    return `${APP} has ${what}, but the app reaches a secret table only through the lookup functions.`;
  }
  return privilegeProblem(row);
}

type Catalog = Awaited<ReturnType<typeof read>>;

/** Whether a foreign key from an install-wide table pairs a company column with company_id: the table's own, or one whose name ends in _company_id. */
function pairsCompany(key: ForeignKeyRow, entry: InstallTable): boolean {
  return key.columns.some(
    (column, place) => key.referencedColumns[place] === "company_id" && (entry.class === "company" ? column === entry.column : column.endsWith("_company_id")),
  );
}

/** What an install-wide table lacks. */
function installTableProblems(row: RelationRow, entry: InstallTable, catalog: Catalog, isCompanyTable: ReadonlyMap<string, boolean>): string[] {
  const of = <T extends { relation: string }>(rows: readonly T[]): T[] => rows.filter((found) => found.relation === row.relation);
  const own: string[] = [];
  if (row.schema !== INSTALL_SCHEMA) {
    own.push(`is on the install-wide list, but is not in the schema ${INSTALL_SCHEMA}.`);
  }
  if (row.company) {
    own.push("is on the install-wide list, but has a company_id column, which makes a company table.");
  }
  if (!row.rls) {
    own.push("row level security is not enabled.");
  }
  if (!row.forced) {
    own.push("row level security is not forced.");
  }
  own.push(...policyProblems(installPolicies(entry), of(catalog.policies)));
  own.push(...triggerProblems(false, null, of(catalog.triggers)));
  for (const key of of(catalog.keys)) {
    if (isCompanyTable.get(key.referenced) === true && key.referenced !== "ledger.companies" && !pairsCompany(key, entry)) {
      own.push(`the foreign key ${key.name} to ${key.referenced} does not pair a company column with company_id.`);
    }
  }
  return own;
}

/** The policies of a table with policies of its own: its earlier ones until their table exists. `relations` holds every relation by name. */
function ownPolicies(exception: Extract<GuardException, { kind: "own policies" }>, relations: ReadonlyMap<string, boolean>): readonly Policy[] {
  return exception.earlier !== undefined && !relations.has(exception.earlier.until) ? exception.earlier.policies : exception.policies;
}

/** What a company table, or a table the guard excepts, lacks. */
function companyTableProblems(row: RelationRow, catalog: Catalog, isCompanyTable: ReadonlyMap<string, boolean>): string[] {
  const of = <T extends { relation: string }>(rows: readonly T[]): T[] => rows.filter((found) => found.relation === row.relation);
  const exception = GUARD_EXCEPTIONS.get(row.relation);
  const needsHistory = exception?.kind !== "no history trigger";
  const own: string[] = [];
  if (exception?.kind === "not a company table") {
    return own;
  }
  if (!row.company) {
    own.push(
      row.schema === INSTALL_SCHEMA
        ? `is in the schema ${INSTALL_SCHEMA}, but is neither a company table nor on the install-wide list.`
        : "has no company_id column.",
    );
    return own;
  }
  if (!row.rls) {
    own.push("row level security is not enabled.");
  }
  if (!row.forced) {
    own.push("row level security is not forced.");
  }
  own.push(...policyProblems(exception?.kind === "own policies" ? ownPolicies(exception, isCompanyTable) : COMPANY_POLICIES, of(catalog.policies)));
  if (row.key === null && needsHistory) {
    own.push("has no primary key of one uuid column, which the history needs as the row's id.");
  }
  own.push(...triggerProblems(needsHistory, row.key, of(catalog.triggers)));
  for (const key of of(catalog.keys)) {
    const paired = key.columns.some((column, place) => column === "company_id" && key.referencedColumns[place] === "company_id");
    if (isCompanyTable.get(key.referenced) === true && !paired) {
      own.push(`the foreign key ${key.name} to ${key.referenced} does not include company_id on both sides.`);
    }
  }
  for (const unique of of(catalog.uniques)) {
    const problem = uniqueProblem(unique);
    if (problem !== undefined) {
      own.push(problem);
    }
  }
  own.push(...of(catalog.partialIndexes).map((found) => `has the partial index ${found.name}: ${COUNTS_BY_VALUE}`));
  const kept = of(catalog.statistics).map((found) => found.what);
  if (kept.length > 0) {
    own.push(`keeps planner statistics of ${kept.join(", ")}, ${KEEPS_VALUES}`);
  }
  own.push(...of(catalog.extendedStatistics).map((found) => `has the extended statistics ${found.name}, ${KEEPS_VALUES}`));
  return own;
}

/**
 * What each table and view lacks, in plain words, as "schema.name: problem";
 * empty when nothing does. `install` is the list of install-wide tables,
 * which a test gives with probe tables of its own.
 */
export async function tableGuardProblems(client: ClientBase, install: ReadonlyMap<string, InstallTable> = INSTALL_TABLES): Promise<string[]> {
  const catalog = await read(client);
  const problems: string[] = [];
  const isCompanyTable = new Map(catalog.relations.map((row) => [row.relation, row.company]));
  for (const row of catalog.relations) {
    const of = <T extends { relation: string }>(rows: readonly T[]): T[] => rows.filter((found) => found.relation === row.relation);
    const entry = install.get(row.relation);
    const own: string[] = [];
    if (row.owner !== OWNER) {
      own.push(`is owned by ${row.owner}, not ${OWNER}.`);
    }
    const kind = KINDS[row.kind];
    if (kind !== undefined) {
      own.push(kind);
    } else if (row.kind === "v") {
      if (!row.options.some((option) => SECURITY_INVOKER.test(option))) {
        own.push("is a view without security_invoker = true, so it would read its tables with its owner's rights.");
      }
    } else if (entry !== undefined) {
      own.push(...installTableProblems(row, entry, catalog, isCompanyTable));
    } else {
      own.push(...companyTableProblems(row, catalog, isCompanyTable));
    }
    for (const privilege of of(catalog.privileges)) {
      const problem = entry === undefined ? privilegeProblem(privilege) : installPrivilegeProblem(privilege, entry);
      if (problem !== undefined) {
        own.push(problem);
      }
    }
    problems.push(...own.map((problem) => `${row.relation}: ${problem}`));
  }
  return problems;
}
