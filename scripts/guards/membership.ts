// SPDX-License-Identifier: AGPL-3.0-only

// Every access check goes through the one membership function (issue 12,
// "Companies and members"; db/README.md, the schema access). This is the
// guard's half that reads as text the code the server runs: its own source
// and that of the workspace packages it may import, packages/contract and
// packages/engine, in every code file's extension, outside their tests. In
// that code:
//
// - Only modules/memberships/resolve.ts names access.active_membership, the
//   one function, by any spelling.
// - Only the files of modules/memberships/ name the memberships table or the
//   people of a company (access.company_people); every other module imports
//   their functions. The table guard names the table for its reason.
// - Only resolve.ts builds a ResolvedMembership, a LiveMembership or a
//   CompanyAccess, gets one from a prototype, or names the token that its
//   constructors take. No file casts a plain object to one of them, to a
//   Principal or to a request's context.
// - Only modules/users/delete-me.ts calls liveForDeletion, the deletion's
//   form of the function, which gives inactive memberships too.
// - Only db/database.ts sets the transaction's company, actor, actor's kind
//   or channel: no other file names them (nortfox.company_id and the rest,
//   quoted or not, in any case, with any space or line break around the dot),
//   or names a way to set a setting whose name comes from elsewhere:
//   set_config by any spelling, SET LOCAL, SET SESSION or pg_settings. The
//   migration runner pins its own search path with set_config, for its
//   reason. A transaction in a company takes its company only as a company
//   access (db/database.ts), which only resolve.ts makes.
// - No file imports a test or a test helper (a *.test.* file, or a file in a
//   test/ folder): the guard reads neither.
//
// Each rule reads the whole file, so a name over several lines is caught,
// and a problem names the line where its match starts. The text cannot see
// everything, such as a name joined from pieces at run time, so two more
// halves hold the rest: modules/memberships/one-function.db.test.ts reads the
// catalog (no other function the app may run reads the memberships across
// companies, by any spelling, or runs dynamic SQL), and authorize, tx.enter
// and a transaction in a company refuse at run time an object that
// resolve.ts did not make. A test file is not read: the tests read and write
// the table and set the settings by hand to prove the database's rules, and
// build their principals through resolve.ts.

/** The one file that calls the one function and makes its objects. */
export const RESOLVE = "apps/server/src/modules/memberships/resolve.ts";

/** The files that may read the memberships. */
export const MEMBERSHIPS_MODULE = "apps/server/src/modules/memberships/";

/** The one file that sets the transaction's settings. */
export const DATABASE = "apps/server/src/db/database.ts";

/** The files beside db/database.ts that may call set_config, each with its reason. None may name the transaction's settings. */
export const SETTING_EXCEPTIONS: Readonly<Record<string, string>> = {
  "apps/server/src/db/migrate.ts":
    "The migration runner pins the search path of its own connection as the owner, for each migration it runs. It sets no company, actor or channel, and the app's requests never run there.",
};

/** The one file that may call the deletion's form. */
export const DELETE_ME = "apps/server/src/modules/users/delete-me.ts";

/** The code the server runs: its own source, and the workspace packages it may import. */
const SCANNED = ["apps/server/src/", "packages/contract/src/", "packages/engine/src/"] as const;

/** A file of code, and not a test. */
const CODE = /\.[cm]?[jt]sx?$/;
const TEST = /\.test\.[cm]?[jt]sx?$/;

/** A file outside the memberships module that may name a table, which tables, and why. */
export interface TableException {
  readonly names: readonly string[];
  readonly why: string;
}

/** The files outside the memberships module that may name a table, each with its reason. */
export const TABLE_EXCEPTIONS: Readonly<Record<string, TableException>> = {
  "apps/server/src/db/table-guard.ts": {
    names: ["access.memberships"],
    why: "The table guard pins the policies of each company table as the catalog prints them, and the owner's policy by person on the companies names the memberships. It reads the catalog, never a row.",
  },
};

/** One file of the code the guard reads, by its path in the repository. */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/** Whether the guard reads `path`: code that the server runs, not a test. */
export function scansFile(path: string): boolean {
  return SCANNED.some((root) => path.startsWith(root)) && CODE.test(path) && !TEST.test(path);
}

// Every pattern is global, for matchAll over a whole file, and \s takes a line break too.
const NOT_AN_IDENTIFIER_BEFORE = "(?<![\\w$])";
const NOT_AN_IDENTIFIER_AFTER = "(?![\\w$])";

/** The one function, by its bare name, in any case: a schema in front, quoted or not, does not hide it. */
const THE_FUNCTION = new RegExp(`${NOT_AN_IDENTIFIER_BEFORE}active_membership${NOT_AN_IDENTIFIER_AFTER}`, "gi");

/** The memberships by their schema's name, quoted or not, in any case, with any space around the dot; the people of a company by any spelling. */
const TABLES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "access.memberships", pattern: new RegExp(`${NOT_AN_IDENTIFIER_BEFORE}"?access"?\\s*\\.\\s*"?memberships${NOT_AN_IDENTIFIER_AFTER}`, "gi") },
  { name: "access.company_people", pattern: new RegExp(`${NOT_AN_IDENTIFIER_BEFORE}company_people${NOT_AN_IDENTIFIER_AFTER}`, "gi") },
];

/** The objects that only resolve.ts makes. */
const MADE_IN_RESOLVE = "ResolvedMembership|LiveMembership|CompanyAccess";

/** The types that a cast must not give a plain object. */
const CAST_TARGETS = `${MADE_IN_RESOLVE}|Principal|RequestContext|CompanyContext`;

/** Building one by hand: its constructor, its prototype, or a cast with `as` or with angle brackets. The first group names it. */
const BY_HAND: readonly RegExp[] = [
  new RegExp(`\\bnew\\s+(${MADE_IN_RESOLVE})\\b`, "g"),
  new RegExp(`\\b(${MADE_IN_RESOLVE})\\s*\\.\\s*prototype\\b`, "g"),
  new RegExp(`\\bas\\s+(${CAST_TARGETS})\\b`, "g"),
  new RegExp(`(?<=(?:^|[=(,:?!&|{[;]|\\breturn|\\byield)\\s*)<\\s*(${CAST_TARGETS})\\s*>`, "gm"),
];

/** set_config by its bare name, in any case: a schema in front, or quotes, do not hide it. */
const SET_CONFIG = new RegExp(`${NOT_AN_IDENTIFIER_BEFORE}set_config${NOT_AN_IDENTIFIER_AFTER}`, "gi");

/**
 * The transaction's settings, quoted or not, in any case, with any space
 * around the dot; and the statements that set a setting by a name from
 * elsewhere, SET LOCAL, SET SESSION and pg_settings.
 */
const SETTINGS: readonly RegExp[] = [
  new RegExp(`${NOT_AN_IDENTIFIER_BEFORE}"?nortfox"?\\s*\\.\\s*"?(company_id|actor_id|actor_kind|channel)"?${NOT_AN_IDENTIFIER_AFTER}`, "gi"),
  new RegExp(`${NOT_AN_IDENTIFIER_BEFORE}set\\s+(local|session)${NOT_AN_IDENTIFIER_AFTER}`, "gi"),
  new RegExp(`${NOT_AN_IDENTIFIER_BEFORE}pg_settings${NOT_AN_IDENTIFIER_AFTER}`, "gi"),
];

const TOKEN = /\bMEMBERSHIP_TOKEN\b/g;
const DELETION = /\bliveForDeletion\b/g;

/** An import, an export from, a dynamic import or a require of a *.test.* file or of a file in a test/ folder. The first group is the path. */
const TEST_IMPORT = /(?<![\w$.])(?:from|import|require)\s*\(?\s*["'`]((?:[^"'`\r\n]*\/)?(?:test\/[^"'`\r\n]*|[^"'`\r\n/]*\.test(?:\.[cm]?[jt]sx?)?))["'`]/g;

/** A rule of the guard: what breaks it in a file of `path`, none where it does not hold, and its problem. */
interface Rule {
  readonly patterns: (path: string) => readonly RegExp[];
  readonly problem: (found: RegExpExecArray) => string;
}

/** The rules, in the order a line's problems are named. */
const RULES: readonly Rule[] = [
  {
    patterns: (path) => (path === RESOLVE ? [] : [THE_FUNCTION]),
    problem: () => `names the one membership function, access.active_membership. Only ${RESOLVE} calls it: use its functions.`,
  },
  ...TABLES.map(
    (table): Rule => ({
      patterns: (path) => (path.startsWith(MEMBERSHIPS_MODULE) || (TABLE_EXCEPTIONS[path]?.names ?? []).includes(table.name) ? [] : [table.pattern]),
      problem: () => `names ${table.name}. Only the files in ${MEMBERSHIPS_MODULE} read the memberships: import their functions.`,
    }),
  ),
  {
    patterns: (path) => (path === RESOLVE ? [] : BY_HAND),
    problem: (found) => `builds or casts to ${String(found[1])} by hand. Only ${RESOLVE} makes a membership or a company access, from the one function's answer.`,
  },
  {
    patterns: (path) => (path === RESOLVE ? [] : [TOKEN]),
    problem: () => `names MEMBERSHIP_TOKEN, which never leaves ${RESOLVE}.`,
  },
  {
    patterns: (path) => (path === DATABASE ? [] : Object.hasOwn(SETTING_EXCEPTIONS, path) ? SETTINGS : [...SETTINGS, SET_CONFIG]),
    problem: () =>
      `sets the transaction's company, actor or channel itself (set_config, SET LOCAL, SET SESSION, pg_settings, or nortfox.company_id, nortfox.actor_id, nortfox.actor_kind or nortfox.channel). Only ${DATABASE} sets them: a company comes from the one function's answer, as a company access or through tx.enter.`,
  },
  {
    patterns: (path) => (path === RESOLVE || path === DELETE_ME ? [] : [DELETION]),
    problem: () => `calls liveForDeletion, which only ${DELETE_ME} calls.`,
  },
  {
    patterns: () => [TEST_IMPORT],
    problem: (found) => `imports a test or a test helper (${String(found[1])}). The guard does not read the tests, so code that the server runs never imports one.`,
  },
];

/** The line of `text` that holds the character at `index`, counted from 1. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let end = text.indexOf("\n"); end !== -1 && end < index; end = text.indexOf("\n", end + 1)) {
    line += 1;
  }
  return line;
}

/** The problems of one file, as "<line>: <problem>": one for each line and rule, the first pattern's that matches there, by line and then in the order of the rules. */
function fileProblems(file: SourceFile): string[] {
  const found: { readonly line: number; readonly rule: number; readonly problem: string }[] = [];
  RULES.forEach((rule, index) => {
    for (const pattern of rule.patterns(file.path)) {
      for (const match of file.text.matchAll(pattern)) {
        const line = lineAt(file.text, match.index);
        if (!found.some((seen) => seen.line === line && seen.rule === index)) {
          found.push({ line, rule: index, problem: rule.problem(match) });
        }
      }
    }
  });
  return found.sort((a, b) => a.line - b.line || a.rule - b.rule).map((problem) => `${String(problem.line)}: ${problem.problem}`);
}

/**
 * What keeps an access check from the one membership function, as
 * "<path>:<line>: <problem>", one for each line and rule; empty when
 * nothing does. Of `files` it reads those that scansFile takes. When
 * resolve.ts is missing, or no longer names the function, the guard has
 * nothing to hold the other files to, and says so.
 */
export function membershipProblems(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  const read = files.filter((file) => scansFile(file.path));
  const resolve = read.find((file) => file.path === RESOLVE);
  if (resolve === undefined || resolve.text.search(THE_FUNCTION) === -1) {
    problems.push(`${RESOLVE} is missing, or names no access.active_membership, so the guard has nothing to hold the other files to.`);
  }
  for (const file of read) {
    problems.push(...fileProblems(file).map((problem) => `${file.path}:${problem}`));
  }
  return problems;
}
