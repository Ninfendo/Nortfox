// SPDX-License-Identifier: AGPL-3.0-only

// Every access check goes through the one membership function (issue 12,
// "Companies and members": a guard shows it). This is the guard's half that
// reads the code the server runs: its source and the workspace packages it
// may import. The probes show that it fails on each way around the
// function: a file that calls the function elsewhere, a handler that reads
// the memberships, a principal or a company access built by hand, the token
// that only resolve.ts holds, a file that sets the transaction's company or
// actor itself, by name or by a SET, RESET or DO statement, also with a name
// over several lines or a line continuation, through a JS escape or right
// after one, or after a SQL line comment that an escaped line break ends, a
// name in SQL's Unicode escapes, a second caller of the deletion's form or
// of the invitation's entry, code that names a test's path, also by its bare
// name, and a manifest that maps imports, points outside the source or names
// a test. It reads a test-named file that the build ships. The catalog's
// half is apps/server/src/modules/memberships/one-function.db.test.ts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gitText, nulList } from "../names/git.ts";
import {
  DATABASE,
  DELETE_ME,
  INVITATION_LINK,
  MANIFESTS,
  MEMBERSHIPS_MODULE,
  RESOLVE,
  SCANNED,
  SETTING_EXCEPTIONS,
  TABLE_EXCEPTIONS,
  manifestProblems,
  membershipProblems,
  scansFile,
  type SourceFile,
} from "./membership.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const tracked = nulList(gitText(ROOT, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));

/** The files the guard reads, as they are in the repository. */
function serverSource(): SourceFile[] {
  return tracked.filter((path) => scansFile(path)).map((path) => ({ path, text: readFileSync(`${ROOT}/${path}`, "utf8") }));
}

/** The packages whose source the guard reads, each built from its src/ by its tsconfig.build.json. */
const BUILT_PACKAGES = SCANNED.map((root) => root.replace(/src\/$/, ""));

/** A glob of a tsconfig's exclude as a pattern: ** / for any folders, * for any part of a name. */
function globPattern(glob: string): RegExp {
  const parts = glob.split(/(\*\*\/|\*)/).map((part) => (part === "**/" ? "(?:[^/]+/)*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")));
  return new RegExp(`^${parts.join("")}$`);
}

/** What the build of the package at `root` leaves out of its source, as patterns of a path from the package's folder. */
function buildExclusions(root: string): RegExp[] {
  const text = readFileSync(`${ROOT}/${root}tsconfig.build.json`, "utf8").replace(/^\s*\/\/.*$/gm, "");
  const config = JSON.parse(text) as { readonly exclude?: readonly string[] };
  return (config.exclude ?? []).map(globPattern);
}

/** resolve.ts as the guard needs it to be: it calls the function. */
const RESOLVE_FILE: SourceFile = {
  path: RESOLVE,
  text: [
    "const MEMBERSHIP_TOKEN = Symbol('made by resolve.ts');",
    "export class CompanyAccess {}",
    "export class ResolvedMembership {}",
    "const found = await tx.query('SELECT * FROM access.active_membership($1)', [companyId]);",
    "return new ResolvedMembership(MEMBERSHIP_TOKEN, row, tx);",
    "return new CompanyAccess(MEMBERSHIP_TOKEN, this, permissions);",
    "Object.freeze(CompanyAccess.prototype);",
    "export function liveForDeletion(tx) {}",
  ].join("\n"),
};

/** The guard's problems with resolve.ts and one more file of `path` that holds `lines`. */
function problemsWith(path: string, ...lines: string[]): string[] {
  return membershipProblems([RESOLVE_FILE, { path, text: lines.join("\n") }]);
}

const HANDLER = "apps/server/src/modules/users/list-users.ts";

const FUNCTION_ELSEWHERE = `names the one membership function, access.active_membership. Only ${RESOLVE} calls it: use its functions.`;

function readsTable(name: string): string {
  return `names ${name}. Only the files in ${MEMBERSHIPS_MODULE} read the memberships: import their functions.`;
}

function builtByHand(name: string): string {
  return `builds or casts to ${name} by hand. Only ${RESOLVE} makes a membership or a company access, from the one function's answer.`;
}

const TOKEN_ELSEWHERE = `names MEMBERSHIP_TOKEN, which never leaves ${RESOLVE}.`;

const SETS_SETTINGS = `sets the transaction's company, actor or channel itself (set_config, a SET or RESET statement, pg_settings, a DO block, or nortfox.company_id, nortfox.actor_id, nortfox.actor_kind or nortfox.channel). Only ${DATABASE} sets them: a company comes from the one function's answer, as a company access or through tx.enter.`;

const UNICODE_ESCAPES = "writes a name or a text in SQL's Unicode escapes (U&), which hide a name from this guard. Write it as it is.";

const SECOND_DELETION_CALLER = `calls liveForDeletion, which only ${DELETE_ME} calls.`;

const SECOND_ENTRY_CALLER = `calls invitationEntry, which only ${INVITATION_LINK} calls, to accept an invitation.`;

function importsTest(specifier: string): string {
  return `names a test or a test helper (${specifier}). The guard does not read the tests, so code that the server runs never loads one.`;
}

describe("the server's source", () => {
  it("lets every access check go through the one membership function", () => {
    const files = serverSource();
    expect(files.map((file) => file.path)).toContain(RESOLVE);
    expect(files.length).toBeGreaterThan(40);
    expect(membershipProblems(files)).toEqual([]);
  });

  it("names a reason for each file that may name a table outside the memberships module", () => {
    for (const [path, exception] of Object.entries(TABLE_EXCEPTIONS)) {
      expect(tracked).toContain(path);
      expect(exception.why.length).toBeGreaterThan(40);
    }
  });
});

describe("the files the guard reads", () => {
  it.each([
    ["apps/server/src/api/operation.ts", true],
    ["apps/server/src/modules/memberships/resolve.ts", true],
    ["apps/server/src/db/migrate-main.ts", true],
    ["apps/server/src/later/thing.mts", true],
    ["apps/server/src/later/thing.js", true],
    ["apps/server/src/later/page.tsx", true],
    ["apps/server/src/later/page.jsx", true],
    ["packages/contract/src/operation.ts", true],
    ["packages/contract/src/operations/companies.ts", true],
    ["packages/engine/src/money.ts", true],
    ["apps/server/src/api/operation.test.ts", false],
    ["apps/server/src/later/page.test.tsx", true],
    ["apps/server/src/modules/companies/enter-any.test.mts", true],
    ["apps/server/src/later/thing.test.cts", true],
    ["apps/server/src/later/thing.test.js", true],
    ["apps/server/src/later/thing.test.mjs", true],
    ["packages/contract/src/thing.test.mts", true],
    ["apps/server/src/modules/memberships/resolve.db.test.ts", false],
    ["packages/contract/src/operation.test.ts", false],
    ["packages/engine/src/money.property.test.ts", false],
    ["packages/client/src/generated.ts", false],
    ["apps/server/test/memberships.ts", false],
    ["apps/server/scripts/x.ts", false],
    ["db/migrations/0007_companies_memberships.sql", false],
    ["db/README.md", false],
    ["apps/server/src/README.md", false],
  ])("reads %s: %s", (path, read) => {
    expect(scansFile(path)).toBe(read);
  });

  it("skips only the files that the build leaves out, so every file it skips is a test that never ships", () => {
    const names = [
      "x.ts",
      "x.test.ts",
      "deep/er/x.db.test.ts",
      "x.property.test.ts",
      "x.test.mts",
      "x.test.cts",
      "x.test.tsx",
      "x.test.js",
      "x.test.mjs",
      "x.test.cjs",
      "x.test.jsx",
      "x.mts",
      "deep/x.test-plan.ts",
    ];
    for (const root of BUILT_PACKAGES) {
      const excluded = buildExclusions(root);
      expect(excluded.length, root).toBeGreaterThan(0);
      for (const name of names) {
        const path = `${root}src/${name}`;
        expect(scansFile(path), path).toBe(!excluded.some((pattern) => pattern.test(`src/${name}`)));
      }
      // Every file of the repository that the guard skips there is one the build leaves out.
      for (const path of tracked.filter((file) => file.startsWith(`${root}src/`) && /\.[cm]?[jt]sx?$/.test(file) && !scansFile(file))) {
        expect(
          excluded.some((pattern) => pattern.test(path.slice(root.length))),
          path,
        ).toBe(true);
      }
    }
  });

  it("reads a test-named file that is no test, and fails code that loads it by its bare name", () => {
    const hidden = "apps/server/src/modules/companies/enter-any.test.mts";
    expect(problemsWith(hidden, "export async function enterAny(tx, company) {", `  await tx.query("SELECT pg_catalog.set_config('nortfox.company_id', $1, true)", [company]);`, "}")).toEqual([
      `${hidden}:2: ${SETS_SETTINGS}`,
    ]);
    const loader = "apps/server/src/modules/companies/read-other.ts";
    expect(problemsWith(loader, "const load = createRequire(import.meta.url);", 'const { enterAny } = load(join(import.meta.dirname, "enter-any.test.mjs"));')).toEqual([
      `${loader}:2: ${importsTest("enter-any.test.mjs")}`,
    ]);
  });

  it("finds nothing in a test file or outside the code the server runs, whatever it names", () => {
    for (const path of ["apps/server/src/api/operation.test.ts", "apps/server/test/memberships.ts", "db/README.md", "packages/contract/src/operation.test.ts"]) {
      expect(problemsWith(path, "SELECT * FROM access.active_membership($1)", "SELECT * FROM access.memberships", "x as CompanyAccess")).toEqual([]);
    }
  });

  it("reads the workspace packages that the server may import, and a .tsx file of the server", () => {
    const helper = "packages/contract/src/work-in.ts";
    expect(problemsWith(helper, "export async function workIn(tx, companyId) {", `  await tx.query("SELECT pg_catalog.set_config('nortfox.company_id', $1, true)", [companyId]);`, "}")).toEqual([
      `${helper}:2: ${SETS_SETTINGS}`,
    ]);
    expect(problemsWith("packages/engine/src/members.ts", "SELECT * FROM access.memberships")).toEqual([`packages/engine/src/members.ts:1: ${readsTable("access.memberships")}`]);
    expect(problemsWith("apps/server/src/later/page.tsx", "const access = <CompanyAccess>plain;")).toEqual([`apps/server/src/later/page.tsx:1: ${builtByHand("CompanyAccess")}`]);
  });
});

describe("the membership guard", () => {
  it("finds nothing in resolve.ts and the files of the memberships module", () => {
    expect(membershipProblems([RESOLVE_FILE])).toEqual([]);
    expect(problemsWith(`${MEMBERSHIPS_MODULE}contacts.ts`, "SELECT * FROM access.memberships WHERE id = $1", "SELECT * FROM access.company_people($1)")).toEqual([]);
  });

  describe("a file that calls the one function elsewhere", () => {
    it.each([
      ["the name as it is", "SELECT * FROM access.active_membership($1)"],
      ["in capitals", "select * from ACCESS.ACTIVE_MEMBERSHIP($1)"],
      ["quoted", 'SELECT * FROM "access"."active_membership"($1)'],
      ["with spaces around the dot", "SELECT * FROM access . active_membership($1)"],
      ["by its bare name", "SELECT * FROM active_membership($1)"],
      ["in a comment", "// The resolver asks access.active_membership itself."],
      ["through a JS escape", 'const sql = "SELECT * FROM access.active\\u005Fmembership($1)";'],
    ])("fails it %s", (_case, line) => {
      expect(problemsWith("apps/server/src/auth/resolver.ts", "const x = 1;", line)).toEqual([`apps/server/src/auth/resolver.ts:2: ${FUNCTION_ELSEWHERE}`]);
    });

    it("fails it in the memberships module too, beside resolve.ts, and in the table guard", () => {
      expect(problemsWith(`${MEMBERSHIPS_MODULE}list.ts`, "tx.query('SELECT * FROM access.active_membership()')")).toEqual([
        `${MEMBERSHIPS_MODULE}list.ts:1: ${FUNCTION_ELSEWHERE}`,
      ]);
      expect(problemsWith("apps/server/src/db/table-guard.ts", "const x = 'access.active_membership';")).toEqual([
        `apps/server/src/db/table-guard.ts:1: ${FUNCTION_ELSEWHERE}`,
      ]);
    });

    it("does not take a longer name for it", () => {
      expect(problemsWith(HANDLER, "SELECT * FROM access.active_memberships_of($1)", "const inactive_membership = 1;")).toEqual([]);
    });

    it("fails a resolve.ts that is missing, or that no longer calls the function", () => {
      const missing = `${RESOLVE} is missing, or names no access.active_membership, so the guard has nothing to hold the other files to.`;
      expect(membershipProblems([])).toEqual([missing]);
      expect(membershipProblems([{ path: RESOLVE, text: "export const nothing = 1;" }])).toEqual([missing]);
    });
  });

  describe("a handler that reads the memberships", () => {
    it.each([
      ["as it is", "SELECT * FROM access.memberships WHERE status = 'active'", "access.memberships"],
      ["in capitals", "SELECT * FROM ACCESS.MEMBERSHIPS", "access.memberships"],
      ["quoted", 'SELECT * FROM "access"."memberships"', "access.memberships"],
      ["half quoted", 'UPDATE access."memberships" SET status = $1', "access.memberships"],
      ["with spaces around the dot", "DELETE FROM access .\tmemberships", "access.memberships"],
      ["in a comment", "/* reads access.memberships */", "access.memberships"],
      ["quoted inside a JS string", 'await tx.query("SELECT * FROM \\"access\\".\\"memberships\\"");', "access.memberships"],
      ["with SQL comments around the dot", "SELECT * FROM access/* the schema */./**/memberships", "access.memberships"],
      ["with a line comment before the dot", "SELECT * FROM access -- the schema\n  .memberships", "access.memberships"],
      ["through a JS escape", 'const sql = "SELECT * FROM access\\x2Ememberships";', "access.memberships"],
      ["through the people of the company", "SELECT * FROM access.company_people($1)", "access.company_people"],
      ["through the people of the company, by its bare name", "SELECT * FROM company_people($1)", "access.company_people"],
      ["through the people of the company, in capitals", "SELECT * FROM ACCESS.COMPANY_PEOPLE($1)", "access.company_people"],
    ])("fails it %s", (_case, line, name) => {
      expect(problemsWith(HANDLER, line)).toEqual([`${HANDLER}:1: ${readsTable(name)}`]);
    });

    it("fails it with the table's name over two lines, at the line where the name starts", () => {
      expect(problemsWith(HANDLER, "const ok = 1;", "await tx.query(`SELECT * FROM access.", "  memberships WHERE id = $1`, [id]);")).toEqual([
        `${HANDLER}:2: ${readsTable("access.memberships")}`,
      ]);
      expect(problemsWith(HANDLER, 'await tx.query(`UPDATE "access"', '  . "memberships" SET status = $2`);')).toEqual([`${HANDLER}:1: ${readsTable("access.memberships")}`]);
    });

    it("does not take another table or word for it", () => {
      expect(
        problemsWith(
          HANDLER,
          "SELECT * FROM access.membership_contacts",
          "// the person's memberships, and 0007_companies_memberships.sql",
          "SELECT * FROM access.memberships_archive",
          "const company_people_count = 1;",
        ),
      ).toEqual([]);
    });

    it("lets the table guard name the memberships, and nothing more, for its reason", () => {
      expect(problemsWith("apps/server/src/db/table-guard.ts", "const t = 'access.memberships';")).toEqual([]);
      expect(problemsWith("apps/server/src/db/table-guard.ts", "const t = 'access.company_people';")).toEqual([
        `apps/server/src/db/table-guard.ts:1: ${readsTable("access.company_people")}`,
      ]);
      expect(Object.keys(TABLE_EXCEPTIONS)).toEqual(["apps/server/src/db/table-guard.ts"]);
    });
  });

  describe("a principal or a company access built by hand", () => {
    it.each([
      ["a plain object cast to a company access", "company: { companyId, membershipId, adminLevel: null, permissions } as CompanyAccess,", "CompanyAccess"],
      ["a plain object cast to a principal", "const p = { personId, actorKind, credential, company } as Principal;", "Principal"],
      ["through unknown", "const p = plain as unknown as Principal;", "Principal"],
      ["to a request's context", "const c = { ...plain, channel: 'rest' } as RequestContext;", "RequestContext"],
      ["to a company's context", "const c = plain as CompanyContext;", "CompanyContext"],
      ["to a membership", "const m = row as ResolvedMembership;", "ResolvedMembership"],
      ["to the deletion's membership", "const m = row as LiveMembership;", "LiveMembership"],
      ["with an angle cast", "const access = <CompanyAccess>{ companyId, permissions };", "CompanyAccess"],
      ["with an angle cast after a return", "return <Principal>plain;", "Principal"],
      ["with the constructor", "const access = new CompanyAccess(token, membership, permissions);", "CompanyAccess"],
      ["with the membership's constructor", "const m = new ResolvedMembership(token, row, tx);", "ResolvedMembership"],
      ["with the deletion's constructor", "const m = new LiveMembership(token, row, tx);", "LiveMembership"],
      ["to an invitation's entry", "const entry = row as InvitationEntry;", "InvitationEntry"],
      ["with the invitation's constructor", "const entry = new InvitationEntry(token, row, tx);", "InvitationEntry"],
      ["from the invitation's prototype", "const entry = Object.create(InvitationEntry.prototype);", "InvitationEntry"],
      ["from the prototype", "const access = Object.create(CompanyAccess.prototype);", "CompanyAccess"],
      ["by setting the prototype", "Object.setPrototypeOf(plain, ResolvedMembership . prototype);", "ResolvedMembership"],
    ])("fails %s", (_case, line, name) => {
      expect(problemsWith("apps/server/src/auth/resolver.ts", line)).toEqual([`apps/server/src/auth/resolver.ts:1: ${builtByHand(name)}`]);
    });

    it("fails the token that only resolve.ts holds, named anywhere else", () => {
      expect(problemsWith("apps/server/src/api/operation.ts", "import { MEMBERSHIP_TOKEN } from '../modules/memberships/resolve.ts';")).toEqual([
        `apps/server/src/api/operation.ts:1: ${TOKEN_ELSEWHERE}`,
      ]);
      expect(problemsWith(`${MEMBERSHIPS_MODULE}list.ts`, "export { MEMBERSHIP_TOKEN };")).toEqual([`${MEMBERSHIPS_MODULE}list.ts:1: ${TOKEN_ELSEWHERE}`]);
    });

    it("lets a file use the types, check an instance and spread a principal", () => {
      expect(
        problemsWith(
          "apps/server/src/api/operation.ts",
          "import type { CompanyAccess, Principal, RequestContext } from './context.ts';",
          "if (!(company instanceof CompanyAccess)) { throw new Error('x'); }",
          "const context: CompanyContext = { ...principal, channel, company };",
          "const all: ReadonlySet<CompanyAccess> = new Set<CompanyAccess>();",
          "function f(): Promise<Principal | undefined> { return resolve(request); }",
          "const access = membership.access(permissions);",
          "const kind = principal.credential.kind as 'session';",
          "// A session acts as its user.",
        ),
      ).toEqual([]);
    });

    it("names one problem for each line and rule, with the line's number", () => {
      expect(
        problemsWith(HANDLER, "const ok = 1;", "x as Principal; y as Principal; SELECT FROM access.memberships", "", "new CompanyAccess(MEMBERSHIP_TOKEN)"),
      ).toEqual([
        `${HANDLER}:2: ${readsTable("access.memberships")}`,
        `${HANDLER}:2: ${builtByHand("Principal")}`,
        `${HANDLER}:4: ${builtByHand("CompanyAccess")}`,
        `${HANDLER}:4: ${TOKEN_ELSEWHERE}`,
      ]);
    });

    it("reads a file with Windows line ends by the same lines", () => {
      expect(problemsWith(HANDLER, "const a = 1;\r", "x as CompanyAccess\r")).toEqual([`${HANDLER}:2: ${builtByHand("CompanyAccess")}`]);
    });
  });

  describe("a file that sets the transaction's company or actor itself", () => {
    it.each([
      ["the company by set_config", `await tx.query("SELECT pg_catalog.set_config('nortfox.company_id', $1, true)", [beta]);`],
      ["the actor by set_config", "SELECT set_config('nortfox.actor_id', $1, true)"],
      ["the actor's kind", "SELECT set_config('nortfox.actor_kind', 'user', true)"],
      ["the channel", "SELECT set_config('nortfox.channel', 'mcp', true)"],
      ["with SET LOCAL", "SET LOCAL nortfox.company_id = '5d1e7c3a-9b2f-4e8d-a6c4-1f0e2d3c4b5a'"],
      ["quoted, in capitals, with space around the dot", `SET LOCAL "NORTFOX" . "COMPANY_ID" TO DEFAULT`],
      ["by set_config with the name as a parameter", "await tx.query('SELECT set_config($1, $2, true)', [name, company]);"],
      ["by set_config in capitals and quoted", `SELECT pg_catalog."SET_CONFIG"($1, $2, true)`],
      ["in a comment", "// The handler sets nortfox.company_id for the company it reads."],
      ["with SET LOCAL and the name from elsewhere", "await tx.query(`SET LOCAL ${setting} = '${companyId}'`);"],
      ["with SET SESSION, in small letters", "await tx.query(`set session ${setting} to '${companyId}'`);"],
      ["with SET LOCAL inside a statement", "await tx.query(`${begin} SET LOCAL ${setting} = '${companyId}'`);"],
      ["with SET SESSION inside a statement, in small letters", "await tx.query(`${begin} set session ${setting} to '${companyId}'`);"],
      ["with a comment between SET and LOCAL", "await tx.query(`${begin} SET/**/LOCAL ${setting} = '${companyId}'`);"],
      ["through pg_settings", "await tx.query('UPDATE pg_catalog.pg_settings SET setting = $2 WHERE name = $1', [setting, companyId]);"],
      ["through pg_settings in capitals", "await tx.query('SELECT setting FROM PG_CATALOG.PG_SETTINGS WHERE name = $1', [setting]);"],
      ["a setting's name in capitals, and nothing else", "// The handler reads NORTFOX.COMPANY_ID itself."],
      ["a setting's name quoted inside a JS string", 'const name = "\\"nortfox\\".\\"actor_id\\"";'],
      ["a setting's name with SQL comments around the dot","await tx.query(`SELECT current_setting('x') FROM nortfox/**/./**/channel`);"],
      ["a setting's name through a JS escape", 'const name = "nortfox\\u{2E}company_id";'],
      ["by set_config through a JS escape", 'await tx.query("SELECT pg_catalog.set\\u005Fconfig($1, $2, true)", [setting, companyId]);'],
      ["with a plain SET and the name from elsewhere", "await tx.query(`SET ${setting} TO '${companyId}'`);"],
      ["with a plain SET and =", "await tx.query(`SET ${setting} = '${companyId}'`);"],
      ["with a plain SET after a statement, in small letters", "await tx.query(`SELECT 1; set ${setting} = '${companyId}'`);"],
      ["with a plain SET after a comment", "await tx.query(`/* the company */ SET ${setting} = '${companyId}'`);"],
      ["with a plain SET and a comment after it", "await tx.query(`SET/* the company */${setting} = '${companyId}'`);"],
      ["with a plain SET in a string", 'await tx.query("SET " + setting + " = $1", [companyId]);'],
      ["with a plain SET of the search path", "await tx.query('SET search_path = access, pg_catalog');"],
      ["with SET ROLE", "await tx.query('SET ROLE nortfox_owner');"],
      ["with RESET", "await tx.query(`RESET ${setting}`);"],
      ["with RESET in small letters, after a statement", "await tx.query(`SELECT 1; reset all`);"],
      ["through a DO block", "await tx.query(`DO $$ BEGIN EXECUTE ${statement}; END $$`);"],
      ["through a DO block in small letters, with a tag", "await tx.query(`do $body$ begin execute ${statement}; end $body$`);"],
      ["through a DO block with its language and a string", "await tx.query(\"DO LANGUAGE plpgsql 'BEGIN EXECUTE x; END'\");"],
      ["with a plain SET glued to its quoted name", "await tx.query(`SET\"${setting}\" = '${companyId}'`);"],
      ["with a plain SET glued to its quoted name, and TO glued to the value", "await tx.query(`SET\"${setting}\"TO'${companyId}'`);"],
      ["with a plain SET glued to its quoted name after a semicolon, in small letters", "await tx.query(`SELECT 1;set\"${setting}\"='${companyId}'`);"],
      ["with RESET glued to its quoted name", "await tx.query(`RESET\"${setting}\"`);"],
      ["through a DO block glued to its string", "await tx.query(`DO'BEGIN EXECUTE ${statement}; END'`);"],
      ["through a DO block whose language is glued to its string", "await tx.query(\"DO LANGUAGE plpgsql'BEGIN EXECUTE x; END'\");"],
      ["through a DO block whose language is quoted and glued on both sides", "await tx.query(`DO LANGUAGE\"plpgsql\"'BEGIN EXECUTE ${statement}; END'`);"],
      ["with a plain SET right after a template's interpolation", "await tx.query(`${prefix}SET ${setting} = '${companyId}'`);"],
      ["with a plain SET after a template's interpolation and a space", "await tx.query(`${prefix} SET ${setting} = '${companyId}'`);"],
      ["with RESET right after a template's interpolation", "await tx.query(`${prefix}RESET ${setting}`);"],
      ["with a plain SET glued to a template's interpolation", "await tx.query(`SET${quotedSetting} = '${companyId}'`);"],
      ["through a DO block glued to a template's interpolation", "await tx.query(`DO${body}`);"],
    ])("fails it %s", (_case, line) => {
      expect(problemsWith(HANDLER, "const ok = 1;", line)).toEqual([`${HANDLER}:2: ${SETS_SETTINGS}`]);
    });

    it.each([
      ["SET LOCAL with a line break after the dot", ["await tx.query(`SET LOCAL nortfox.", "    company_id = '${companyId}'`);"]],
      ["a line break before the dot", ["await tx.query(`SELECT set_value FROM x WHERE n = 'nortfox", "  .company_id'`);"]],
      ["quoted, with line breaks on both sides of the dot", ['const name = `"nortfox"', "  .", '  "actor_id"`;']],
      ["SET and LOCAL on two lines, with a line comment between", ["await tx.query(`${begin} SET -- the company", "  LOCAL ${setting} = '${companyId}'`);"]],
    ])("fails it with the name over several lines: %s", (_case, lines) => {
      expect(problemsWith(HANDLER, "const ok = 1;", ...lines)).toEqual([`${HANDLER}:2: ${SETS_SETTINGS}`]);
    });

    it("names the line of a SET that starts a statement, also when its quote or a line comment is on the line before", () => {
      expect(problemsWith(HANDLER, "const ok = 1;", "await tx.query(`", "  SET ${setting} = '${companyId}'`);")).toEqual([`${HANDLER}:3: ${SETS_SETTINGS}`]);
      expect(problemsWith(HANDLER, "const ok = 1;", "await tx.query(`-- the company", "  SET ${setting} = '${companyId}'`);")).toEqual([`${HANDLER}:3: ${SETS_SETTINGS}`]);
      expect(problemsWith(HANDLER, "const ok = 1;", "await tx.query(`${prefix}", "SET ${setting} = '${companyId}'`);")).toEqual([`${HANDLER}:3: ${SETS_SETTINGS}`]);
    });

    it("fails a SET of the search path, and not the bare name of the memberships that it then reads", () => {
      expect(problemsWith(HANDLER, "await tx.query('SET search_path = access, pg_catalog');", "await tx.query('SELECT user_id, status FROM memberships');")).toEqual([
        `${HANDLER}:1: ${SETS_SETTINGS}`,
      ]);
    });

    it("fails it in the memberships module and in resolve.ts too", () => {
      expect(problemsWith(`${MEMBERSHIPS_MODULE}list.ts`, "SELECT set_config('nortfox.company_id', $1, true)")).toEqual([`${MEMBERSHIPS_MODULE}list.ts:1: ${SETS_SETTINGS}`]);
      expect(membershipProblems([{ path: RESOLVE, text: `${RESOLVE_FILE.text}\nawait tx.query("SELECT set_config('nortfox.company_id', $1, true)");` }])).toEqual([
        `${RESOLVE}:9: ${SETS_SETTINGS}`,
      ]);
    });

    it("lets db/database.ts set them, and the migration runner pin its search path with set_config, for its reason", () => {
      expect(problemsWith(DATABASE, "const SET_COMPANY = \"SELECT pg_catalog.set_config('nortfox.company_id', $1, true)\";")).toEqual([]);
      expect(problemsWith("apps/server/src/db/migrate.ts", "await client.query(\"SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)\");")).toEqual([]);
      expect(problemsWith("apps/server/src/db/migrate.ts", "SELECT set_config('nortfox.actor_id', $1, true)")).toEqual([`apps/server/src/db/migrate.ts:1: ${SETS_SETTINGS}`]);
      expect(Object.keys(SETTING_EXCEPTIONS)).toEqual(["apps/server/src/db/migrate.ts"]);
      for (const [path, why] of Object.entries(SETTING_EXCEPTIONS)) {
        expect(tracked).toContain(path);
        expect(why.length).toBeGreaterThan(40);
      }
    });

    it("does not take another name for them", () => {
      expect(
        problemsWith(
          HANDLER,
          "SELECT ledger.current_company_id()",
          "const company_id = context.company.companyId;",
          "SELECT config_set FROM nortfox.companies_settings",
          "const nortfox = 1; const channel = 'rest';",
          "SELECT reset_config_value()",
        ),
      ).toEqual([]);
    });

    it("does not take an UPDATE's SET, a set of values, a setter or a word in a text for a SET statement, nor a loop for a DO block", () => {
      expect(
        problemsWith(
          HANDLER,
          "await tx.query('UPDATE ledger.companies SET name = $1 WHERE company_id = $2', [name, id]);",
          "await tx.query(`UPDATE ledger.companies",
          "   SET name = $1",
          "   WHERE company_id = $2`, [name, id]);",
          "await tx.query('INSERT INTO x (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET name = excluded.name');",
          "await tx.query('INSERT INTO x (id) VALUES ($1) ON CONFLICT DO NOTHING');",
          `await tx.query('UPDATE "ledger"."companies" SET name = $1 WHERE company_id = $2', [name, id]);`,
          'await tx.query("UPDATE \\"ledger\\".\\"companies\\" SET name = $1 WHERE company_id = $2", [name, id]);',
          "await tx.query('SET CONSTRAINTS ALL IMMEDIATE');",
          "await tx.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');",
          "const kinds = new Set(['set-session', 'set-device']);",
          'headers.append("Set-Cookie", value);',
          "#count = 0;",
          "  set count(value) { this.#count = value; }",
          "  get size() { return 1; } set size(value) { void value; }",
          "  }",
          "  set #size(value) {",
          'const methods = ["get", "set", \'reset\', `set`, "do"];',
          "const label = `${count} sets, ${count}settled`;",
          "const a = 1;",
          "set = a;",
          "do {",
          "  i += 1;",
          "} while (i < 3);",
          "// They do it once, and set it then.",
          'throw new Error("NORTFOX_PUBLIC_ORIGIN is not set. Set it to the origin.");',
        ),
      ).toEqual([]);
    });

    it("does not take DO glued to a dollar quote or to E' for a DO block: PostgreSQL reads each as one name", () => {
      expect(problemsWith(HANDLER, "const words = \"DO$$x$$, DOE'x'\";")).toEqual([]);
    });

    it("reads a JS escape as its character, keeps each line's number, and leaves an escape of no character", () => {
      expect(problemsWith(HANDLER, 'const a = "\\x0A\\u{110000}";', "const b = 'nortfox\\u002Ecompany_id';")).toEqual([`${HANDLER}:2: ${SETS_SETTINGS}`]);
    });

    it.each([
      ["SET LOCAL after a tab", "await tx.query(`\\tSET LOCAL\\tnortfox.company_id = '${companyId}'`);"],
      ["SET LOCAL after a line break, a return, a vertical tab, a form feed, a backspace and a NUL", "await tx.query(`\\n\\r\\v\\f\\b\\0SET LOCAL ${setting} = '${companyId}'`);"],
      ["SET SESSION with a line break between", "await tx.query(`SET\\nSESSION ${setting} TO '${companyId}'`);"],
      ["a plain SET after a line break", 'await tx.query("\\nSET " + setting + " = $1", [companyId]);'],
      ["a plain SET after a return and a line break", 'await tx.query("SELECT 1;\\r\\nset " + setting + " = $1", [companyId]);'],
      ["RESET after a tab", "await tx.query(`\\tRESET ${setting}`);"],
      ["set_config after a line break", 'await tx.query("SELECT\\nset_config($1, $2, true)", [name, companyId]);'],
      ["pg_settings after a tab", "await tx.query('SELECT setting FROM\\tpg_settings WHERE name = $1', [setting]);"],
      ["a DO block after a line break", 'await tx.query("\\nDO $$ BEGIN EXECUTE x; END $$");'],
      ["a setting's name after a tab", "const name = '\\tnortfox.company_id';"],
      ["SET LOCAL with an escape that JS reads as the letter", "await tx.query(`S\\ET L\\OCAL ${setting} = '${companyId}'`);"],
      ["set_config with an escape that JS reads as the letter", 'await tx.query("SELECT set_\\config($1, $2, true)", [setting, companyId]);'],
      ["a setting's name with escapes that JS reads as the letters", 'const name = "n\\ortfox\\.company\\_id";'],
    ])("fails it %s", (_case, line) => {
      expect(problemsWith(HANDLER, "const ok = 1;", line)).toEqual([`${HANDLER}:2: ${SETS_SETTINGS}`]);
    });

    it.each([
      ["after a tab", 'await tx.query("SELECT * FROM\\taccess.memberships");', readsTable("access.memberships")],
      ["with an escape that JS reads as the letter", 'await tx.query("SELECT * FROM access.member\\ships");', readsTable("access.memberships")],
      ["the people of the company after a line break", 'await tx.query("SELECT * FROM\\ncompany_people($1)");', readsTable("access.company_people")],
      ["the one function after a tab", 'await tx.query("SELECT * FROM\\tactive_membership($1)");', FUNCTION_ELSEWHERE],
      ["the one function with an escape that JS reads as the letter", 'await tx.query("SELECT * FROM access.active\\_membership($1)");', FUNCTION_ELSEWHERE],
    ])("fails a table or the one function %s", (_case, line, problem) => {
      expect(problemsWith(HANDLER, "const ok = 1;", line)).toEqual([`${HANDLER}:2: ${problem}`]);
    });

    it("joins a line that a JS line continuation ends to the next, and keeps the next lines' numbers", () => {
      expect(problemsWith(HANDLER, "const ok = 1;", 'const name = "nortfox.com\\', 'pany_id";', "x as CompanyAccess")).toEqual([
        `${HANDLER}:2: ${SETS_SETTINGS}`,
        `${HANDLER}:4: ${builtByHand("CompanyAccess")}`,
      ]);
      expect(problemsWith(HANDLER, "const ok = 1;\r", 'await tx.query("SELECT * FROM access.mem\\\r', 'berships");\r', "x as CompanyAccess\r")).toEqual([
        `${HANDLER}:2: ${readsTable("access.memberships")}`,
        `${HANDLER}:4: ${builtByHand("CompanyAccess")}`,
      ]);
      // A statement that starts the next line is on the next line.
      expect(problemsWith(HANDLER, "const ok = 1;", 'await tx.query("SELECT 1; \\', 'SET LOCAL nortfox.company_id = $1", [companyId]);')).toEqual([`${HANDLER}:3: ${SETS_SETTINGS}`]);
    });

    it.each([
      ["a plain SET after a line comment that a \\n escape ends", 'await tx.query("-- the company\\nSET " + name + " = $1", [companyId]);'],
      ["RESET after a line comment that a \\r escape ends", 'await tx.query("-- the company\\rRESET " + name);'],
      ["a plain SET after a line comment that a \\u000a escape ends", 'await tx.query("-- the company\\u000aSET " + name + " = $1", [companyId]);'],
      ["a plain SET after a line comment that a \\u000D escape ends", 'await tx.query("-- the company\\u000DSET " + name + " = $1", [companyId]);'],
      ["a plain SET after a line comment that a \\x0a escape ends", 'await tx.query("-- the company\\x0aSET " + name + " = $1", [companyId]);'],
      ["a plain SET after a line comment that a \\x0d escape ends", 'await tx.query("-- the company\\x0dSET " + name + " = $1", [companyId]);'],
      ["a plain SET after a line comment that a \\u{a} escape ends", 'await tx.query("-- the company\\u{a}SET " + name + " = $1", [companyId]);'],
      ["a setting's name with a line comment before its dot that a \\n escape ends", `await tx.query("-- the company\\nSELECT 1 FROM nortfox -- the schema\\n.company_id");`],
      ["a DO block with a line comment that a \\n escape ends", 'await tx.query("DO -- the block\\n$$ BEGIN EXECUTE x; END $$");'],
    ])("fails it %s, on its own line", (_case, line) => {
      expect(problemsWith(HANDLER, "const ok = 1;", line, "const after = 1;")).toEqual([`${HANDLER}:2: ${SETS_SETTINGS}`]);
    });

    it("fails the memberships with a line comment before the dot that a \\n escape ends, and keeps the next lines' numbers", () => {
      expect(problemsWith(HANDLER, "const ok = 1;", 'await tx.query("SELECT * FROM access -- the schema\\n.memberships WHERE id = $1", [id]);', "x as CompanyAccess")).toEqual([
        `${HANDLER}:2: ${readsTable("access.memberships")}`,
        `${HANDLER}:3: ${builtByHand("CompanyAccess")}`,
      ]);
      expect(problemsWith(HANDLER, 'const a = "x\\r\\ny\\n\\nz";', 'await tx.query("-- the company\\nSET " + name);', "x as CompanyAccess")).toEqual([
        `${HANDLER}:2: ${SETS_SETTINGS}`,
        `${HANDLER}:3: ${builtByHand("CompanyAccess")}`,
      ]);
    });

    it("does not take an UPDATE's SET after a line comment that a \\n escape ends for a SET statement", () => {
      expect(problemsWith(HANDLER, 'await tx.query("-- the company\\nUPDATE ledger.companies SET name = $1 WHERE company_id = $2", [name, id]);')).toEqual([]);
    });

    it("reads an escaped backslash as one, so the letter after it starts no escape", () => {
      expect(problemsWith(HANDLER, 'const words = "a\\\\nset_config b";')).toEqual([]);
    });
  });

  describe("a name in SQL's Unicode escapes", () => {
    it.each([
      ["set_config and the company's setting", String.raw`await tx.query("SELECT pg_catalog.U&\"set\005Fconfig\"(U&'\006Eortfox.company\005Fid', $1, true)", [beta]);`],
      ["the company's setting", String.raw`SET U&"\006Eortfox".U&"company\005Fid" = '5d1e7c3a-9b2f-4e8d-a6c4-1f0e2d3c4b5a'`],
      ["the one function", String.raw`SELECT * FROM access.U&"active\005Fmembership"()`],
      ["the memberships", String.raw`SELECT user_id FROM access.U&"\006Demberships"`],
      ["in small letters", String.raw`SELECT user_id FROM access.u&"\006Demberships"`],
      ["in a text", String.raw`SELECT pg_catalog.current_setting(U&'nortfox\002Ecompany_id')`],
      ["quoted inside a JS string", String.raw`await tx.query("SELECT user_id FROM access.U&\"\006Demberships\"");`],
    ])("fails %s", (_case, line) => {
      expect(problemsWith(HANDLER, line)).toEqual([`${HANDLER}:1: ${UNICODE_ESCAPES}`]);
    });

    it("fails them in resolve.ts and in db/database.ts too", () => {
      expect(problemsWith(DATABASE, String.raw`const SET_COMPANY = "SELECT pg_catalog.set_config(U&'nortfox.company\005Fid', $1, true)";`)).toEqual([`${DATABASE}:1: ${UNICODE_ESCAPES}`]);
      expect(membershipProblems([{ path: RESOLVE, text: `${RESOLVE_FILE.text}\n${String.raw`SELECT * FROM access.U&"\006Demberships"`}` }])).toEqual([`${RESOLVE}:9: ${UNICODE_ESCAPES}`]);
    });

    it("does not take an and or a name that ends in u for one", () => {
      expect(problemsWith(HANDLER, "const both = a && 'b';", "const menu = menu&'x';", "const flags = U & 0x1;")).toEqual([]);
    });
  });

  describe("code that names a test's path", () => {
    it.each([
      ["a test file", 'import { workIn } from "./work-in.test.ts";', "./work-in.test.ts"],
      ["a database test, by a path with no extension", 'export { workIn } from "../companies/peek.db.test";', "../companies/peek.db.test"],
      ["a .tsx test", "import { page } from './page.test.tsx';", "./page.test.tsx"],
      ["a test helper", 'import { asMember } from "../../../test/memberships.ts";', "../../../test/memberships.ts"],
      ["by a dynamic import", 'const helper = await import("../../test/database.ts");', "../../test/database.ts"],
      ["for its side effects", 'import "./setup.test.js";', "./setup.test.js"],
      ["by a require of another name", "const load = createRequire(import.meta.url); const helper = load('../../../test/memberships.ts');", "../../../test/memberships.ts"],
      ["in a URL", 'const helper = new URL("../../test/database.ts", import.meta.url);', "../../test/database.ts"],
      ["by a path built in a template", "const helper = await import(`../../test/${name}.ts`);", "../../test/${name}.ts"],
      ["from the root", "const helper = load('/app/apps/server/test/memberships.ts');", "/app/apps/server/test/memberships.ts"],
      ["by its bare name, joined to a folder", 'const helper = load(join(import.meta.dirname, "enter-any.test.mjs"));', "enter-any.test.mjs"],
      ["a database test by its bare name", "const helper = load(resolve(here, 'peek.db.test.ts'));", "peek.db.test.ts"],
      ["a .cjs test by its bare name, in a template", "const helper = load(`peek.test.cjs`);", "peek.test.cjs"],
      ["a test helper by a path that starts at its folder", 'const helper = load(join(root, "test/memberships.ts"));', "test/memberships.ts"],
    ])("fails %s", (_case, line, specifier) => {
      expect(problemsWith(HANDLER, line)).toEqual([`${HANDLER}:1: ${importsTest(specifier)}`]);
    });

    it("names the line of the path, with the import over two lines", () => {
      expect(problemsWith(HANDLER, "import { asMember } from", '  "../../../test/memberships.ts";')).toEqual([`${HANDLER}:2: ${importsTest("../../../test/memberships.ts")}`]);
    });

    it("fails it in a workspace package too", () => {
      expect(problemsWith("packages/contract/src/work-in.ts", 'export * from "./work-in.test.ts";')).toEqual([`packages/contract/src/work-in.ts:1: ${importsTest("./work-in.test.ts")}`]);
    });

    it("does not take another module, a host or a word in a text for a test", () => {
      expect(
        problemsWith(
          HANDLER,
          'import { test } from "node:test";',
          'import { latest } from "./latest/index.ts";',
          'import { contest } from "../contest/rules.ts";',
          'import { attest } from "./attest.ts";',
          'import { testing } from "./testing.ts";',
          "// The test of this file is apps/server/test/memberships.ts.",
          'const origin = "https://nortfox.test";',
          'const host = "nortfox.test";',
          'const api = "api.nortfox.test";',
          'const name = "latest.ts";',
          'const other = "contest.mjs";',
          'const notes = "notes.test-plan.ts";',
          'const words = "the test/ folder";',
          'const steps = "run it from the /test/folder";',
          'const route = "/v1/tests/x";',
          "const plan = './notes.test-plan.md';",
        ),
      ).toEqual([]);
    });
  });

  describe("the manifests of the code the server runs", () => {
    const MANIFEST = "packages/contract/package.json";

    /** A manifest of the contract package with `fields` beside its name. */
    function manifestWith(fields: Record<string, unknown>): SourceFile {
      return { path: MANIFEST, text: JSON.stringify({ name: "@nortfox/contract", ...fields }, null, 2) };
    }

    it("map no imports, point their exports only into src/ and dist/, and name no test", () => {
      expect(MANIFESTS).toEqual(BUILT_PACKAGES.map((root) => `${root}package.json`));
      expect(manifestProblems(MANIFESTS.map((path) => ({ path, text: readFileSync(`${ROOT}/${path}`, "utf8") })))).toEqual([]);
    });

    it("fails a manifest that maps imports, whose files the guard does not read", () => {
      expect(manifestProblems([manifestWith({ imports: { "#anywhere": "./src/companies/enter-any.ts" } })])).toEqual([
        `${MANIFEST}: maps imports (#…), whose files the guard does not follow. Import a file of the package by its path.`,
      ]);
    });

    it("fails an export or an entry point outside src/ and dist/", () => {
      expect(
        manifestProblems([
          manifestWith({
            main: "./lib/index.js",
            exports: {
              ".": { "@nortfox/source": "./src/index.ts", default: "./dist/index.js" },
              "./peek": { default: "./scripts/peek.ts" },
              "./back": "./src/../scripts/peek.ts",
            },
          }),
        ]),
      ).toEqual([
        `${MANIFEST}: points ./scripts/peek.ts outside src/ and its build in dist/, where the guard does not read.`,
        `${MANIFEST}: points ./src/../scripts/peek.ts outside src/ and its build in dist/, where the guard does not read.`,
        `${MANIFEST}: points ./lib/index.js outside src/ and its build in dist/, where the guard does not read.`,
      ]);
    });

    it("fails a manifest that names a test or a test helper", () => {
      expect(manifestProblems([manifestWith({ exports: { "./peek": "./src/peek.db.test.ts", "./helper": "./test/memberships.ts" } })])).toEqual([
        `${MANIFEST}: points ./test/memberships.ts outside src/ and its build in dist/, where the guard does not read.`,
        `${MANIFEST}: ${importsTest("./src/peek.db.test.ts")}`,
        `${MANIFEST}: ${importsTest("./test/memberships.ts")}`,
      ]);
    });
  });

  describe("a second caller of the deletion's form", () => {
    it("fails liveForDeletion anywhere but in deleteMe and resolve.ts", () => {
      expect(problemsWith(`${MEMBERSHIPS_MODULE}leave.ts`, "const live = await liveForDeletion(tx);")).toEqual([
        `${MEMBERSHIPS_MODULE}leave.ts:1: ${SECOND_DELETION_CALLER}`,
      ]);
      expect(problemsWith("apps/server/src/modules/users/delete-account.ts", "import { liveForDeletion } from '../memberships/resolve.ts';")).toEqual([
        `apps/server/src/modules/users/delete-account.ts:1: ${SECOND_DELETION_CALLER}`,
      ]);
    });

    it("lets deleteMe call it", () => {
      expect(problemsWith(DELETE_ME, "import { liveForDeletion } from '../memberships/resolve.ts';", "const live = await liveForDeletion(tx);")).toEqual([]);
    });
  });

  describe("a second caller of the invitation's entry", () => {
    it("fails invitationEntry anywhere but in the acceptance and resolve.ts, also in the memberships module", () => {
      const peek = "apps/server/src/modules/companies/peek.ts";
      expect(
        problemsWith(
          peek,
          "import { invitationEntry } from '../memberships/resolve.ts';",
          "const entry = await invitationEntry(tx, hash, at); await tx.enter(entry); return tx.query('SELECT * FROM ledger.vouchers');",
        ),
      ).toEqual([`${peek}:1: ${SECOND_ENTRY_CALLER}`, `${peek}:2: ${SECOND_ENTRY_CALLER}`]);
      expect(problemsWith(`${MEMBERSHIPS_MODULE}leave-company.ts`, "const entry = await invitationEntry(tx, hash, at);")).toEqual([
        `${MEMBERSHIPS_MODULE}leave-company.ts:1: ${SECOND_ENTRY_CALLER}`,
      ]);
    });

    it("lets the acceptance call it", () => {
      expect(problemsWith(INVITATION_LINK, "import { invitationEntry } from './resolve.ts';", "const entry = await invitationEntry(tx, linkHash, at);")).toEqual([]);
    });
  });
});
