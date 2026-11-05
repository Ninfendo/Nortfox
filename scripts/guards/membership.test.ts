// SPDX-License-Identifier: AGPL-3.0-only

// Every access check goes through the one membership function (issue 12,
// "Companies and members": a guard shows it). This is the guard's half that
// reads the code the server runs: its source and the workspace packages it
// may import. The probes show that it fails on each way around the
// function: a file that calls the function elsewhere, a handler that reads
// the memberships, a principal or a company access built by hand, the token
// that only resolve.ts holds, a file that sets the transaction's company or
// actor itself, also with a name over several lines, a second caller of the
// deletion's form, and code that imports a test. The catalog's half is
// apps/server/src/modules/memberships/one-function.db.test.ts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gitText, nulList } from "../names/git.ts";
import { DATABASE, DELETE_ME, MEMBERSHIPS_MODULE, RESOLVE, SETTING_EXCEPTIONS, TABLE_EXCEPTIONS, membershipProblems, scansFile, type SourceFile } from "./membership.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const tracked = nulList(gitText(ROOT, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));

/** The files the guard reads, as they are in the repository. */
function serverSource(): SourceFile[] {
  return tracked.filter((path) => scansFile(path)).map((path) => ({ path, text: readFileSync(`${ROOT}/${path}`, "utf8") }));
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

const SETS_SETTINGS = `sets the transaction's company, actor or channel itself (set_config, SET LOCAL, SET SESSION, pg_settings, or nortfox.company_id, nortfox.actor_id, nortfox.actor_kind or nortfox.channel). Only ${DATABASE} sets them: a company comes from the one function's answer, as a company access or through tx.enter.`;

const SECOND_DELETION_CALLER = `calls liveForDeletion, which only ${DELETE_ME} calls.`;

function importsTest(specifier: string): string {
  return `imports a test or a test helper (${specifier}). The guard does not read the tests, so code that the server runs never imports one.`;
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
    ["apps/server/src/later/page.test.tsx", false],
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
      ["by its bare name", "SET search_path = access; SELECT * FROM active_membership($1)"],
      ["in a comment", "// The resolver asks access.active_membership itself."],
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
      ["through the people of the company", "SELECT * FROM access.company_people($1)", "access.company_people"],
      ["through the people of the company, by its bare name", "SELECT * FROM company_people($1)", "access.company_people"],
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
      ["through pg_settings", "await tx.query('UPDATE pg_catalog.pg_settings SET setting = $2 WHERE name = $1', [setting, companyId]);"],
    ])("fails it %s", (_case, line) => {
      expect(problemsWith(HANDLER, "const ok = 1;", line)).toEqual([`${HANDLER}:2: ${SETS_SETTINGS}`]);
    });

    it.each([
      ["SET LOCAL with a line break after the dot", ["await tx.query(`SET LOCAL nortfox.", "    company_id = '${companyId}'`);"]],
      ["a line break before the dot", ["await tx.query(`SELECT set_value FROM x WHERE n = 'nortfox", "  .company_id'`);"]],
      ["quoted, with line breaks on both sides of the dot", ['const name = `"nortfox"', "  .", '  "actor_id"`;']],
    ])("fails it with the name over several lines: %s", (_case, lines) => {
      expect(problemsWith(HANDLER, "const ok = 1;", ...lines)).toEqual([`${HANDLER}:2: ${SETS_SETTINGS}`]);
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
  });

  describe("code that imports a test", () => {
    it.each([
      ["a test file", 'import { workIn } from "./work-in.test.ts";', "./work-in.test.ts"],
      ["a database test, by a path with no extension", 'export { workIn } from "../companies/peek.db.test";', "../companies/peek.db.test"],
      ["a .tsx test", "import { page } from './page.test.tsx';", "./page.test.tsx"],
      ["a test helper", 'import { asMember } from "../../../test/memberships.ts";', "../../../test/memberships.ts"],
      ["by a dynamic import", 'const helper = await import("../../test/database.ts");', "../../test/database.ts"],
      ["for its side effects", 'import "./setup.test.js";', "./setup.test.js"],
      ["with the import over two lines", 'import { asMember } from\n  "../../../test/memberships.ts";', "../../../test/memberships.ts"],
    ])("fails %s", (_case, line, specifier) => {
      expect(problemsWith(HANDLER, line)).toEqual([`${HANDLER}:1: ${importsTest(specifier)}`]);
    });

    it("fails it in a workspace package too", () => {
      expect(problemsWith("packages/contract/src/work-in.ts", 'export * from "./work-in.test.ts";')).toEqual([`packages/contract/src/work-in.ts:1: ${importsTest("./work-in.test.ts")}`]);
    });

    it("does not take another module for a test", () => {
      expect(
        problemsWith(
          HANDLER,
          'import { test } from "node:test";',
          'import { latest } from "./latest/index.ts";',
          'import { contest } from "../contest/rules.ts";',
          'import { attest } from "./attest.ts";',
          'import { testing } from "./testing.ts";',
          "// The test of this file is apps/server/test/memberships.ts.",
        ),
      ).toEqual([]);
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
});
