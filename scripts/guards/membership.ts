// SPDX-License-Identifier: AGPL-3.0-only

// Every access check goes through the one membership function (issue 12,
// "Companies and members"; db/README.md, the schema access). This is the
// guard's half that reads the server's source as text. In the server's own
// code, outside its tests:
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
//   quoted or not, in any case, with any space around the dot) or set_config,
//   by any spelling. The migration runner pins its own search path with
//   set_config, for its reason. A transaction in a company takes its company
//   only as a company access (db/database.ts), which only resolve.ts makes.
//
// The text cannot see everything, so two more halves hold the rest:
// modules/memberships/one-function.db.test.ts reads the catalog (no other
// function the app may run reads the memberships across companies, by any
// spelling, or runs dynamic SQL), and authorize, tx.enter and a transaction
// in a company refuse at run time an object that resolve.ts did not make. A
// test file is not read: the tests read and write the table and set the
// settings by hand to prove the database's rules, and build their
// principals through resolve.ts.

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

/** The server's own code. */
const SERVER_SOURCE = "apps/server/src/";

/** A file of code, and not a test. */
const CODE = /\.[cm]?[jt]s$/;
const TEST = /\.test\.[cm]?[jt]s$/;

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

/** One file of the server's source, by its path in the repository. */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/** Whether the guard reads `path`: the server's own code, not its tests. */
export function scansFile(path: string): boolean {
  return path.startsWith(SERVER_SOURCE) && CODE.test(path) && !TEST.test(path);
}

const NOT_AN_IDENTIFIER_BEFORE = "(?<![\\w$])";
const NOT_AN_IDENTIFIER_AFTER = "(?![\\w$])";

/** The one function, by its bare name, in any case: a schema in front, quoted or not, does not hide it. */
const THE_FUNCTION = new RegExp(`${NOT_AN_IDENTIFIER_BEFORE}active_membership${NOT_AN_IDENTIFIER_AFTER}`, "i");

/** The memberships by their schema's name, quoted or not, in any case, with any space around the dot; the people of a company by any spelling. */
const TABLES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "access.memberships", pattern: new RegExp(`${NOT_AN_IDENTIFIER_BEFORE}"?access"?\\s*\\.\\s*"?memberships${NOT_AN_IDENTIFIER_AFTER}`, "i") },
  { name: "access.company_people", pattern: new RegExp(`${NOT_AN_IDENTIFIER_BEFORE}company_people${NOT_AN_IDENTIFIER_AFTER}`, "i") },
];

/** The objects that only resolve.ts makes. */
const MADE_IN_RESOLVE = "ResolvedMembership|LiveMembership|CompanyAccess";

/** The types that a cast must not give a plain object. */
const CAST_TARGETS = `${MADE_IN_RESOLVE}|Principal|RequestContext|CompanyContext`;

/** Building one by hand: its constructor, its prototype, or a cast with `as` or with angle brackets. */
const BY_HAND: readonly RegExp[] = [
  new RegExp(`\\bnew\\s+(${MADE_IN_RESOLVE})\\b`),
  new RegExp(`\\b(${MADE_IN_RESOLVE})\\s*\\.\\s*prototype\\b`),
  new RegExp(`\\bas\\s+(${CAST_TARGETS})\\b`),
  new RegExp(`(?:^|[=(,:?!&|{[;]|\\breturn|\\byield)\\s*<\\s*(${CAST_TARGETS})\\s*>`),
];

/** set_config by its bare name, in any case: a schema in front, or quotes, do not hide it. */
const SET_CONFIG = new RegExp(`${NOT_AN_IDENTIFIER_BEFORE}set_config${NOT_AN_IDENTIFIER_AFTER}`, "i");

/** The transaction's settings, quoted or not, in any case, with any space around the dot. */
const SETTINGS = new RegExp(`${NOT_AN_IDENTIFIER_BEFORE}"?nortfox"?\\s*\\.\\s*"?(company_id|actor_id|actor_kind|channel)"?${NOT_AN_IDENTIFIER_AFTER}`, "i");

const TOKEN = /\bMEMBERSHIP_TOKEN\b/;
const DELETION = /\bliveForDeletion\b/;

/** The one problem of a line by hand, naming the first object it builds, or undefined. */
function builtByHand(line: string): string | undefined {
  for (const pattern of BY_HAND) {
    const found = pattern.exec(line);
    if (found?.[1] !== undefined) {
      return found[1];
    }
  }
  return undefined;
}

/** The problems of one line of `path`, in the order of the rules. */
function lineProblems(path: string, line: string): string[] {
  const problems: string[] = [];
  if (path !== RESOLVE && THE_FUNCTION.test(line)) {
    problems.push(`names the one membership function, access.active_membership. Only ${RESOLVE} calls it: use its functions.`);
  }
  if (!path.startsWith(MEMBERSHIPS_MODULE)) {
    const allowed = TABLE_EXCEPTIONS[path]?.names ?? [];
    for (const table of TABLES) {
      if (!allowed.includes(table.name) && table.pattern.test(line)) {
        problems.push(`names ${table.name}. Only the files in ${MEMBERSHIPS_MODULE} read the memberships: import their functions.`);
      }
    }
  }
  if (path !== RESOLVE) {
    const built = builtByHand(line);
    if (built !== undefined) {
      problems.push(`builds or casts to ${built} by hand. Only ${RESOLVE} makes a membership or a company access, from the one function's answer.`);
    }
    if (TOKEN.test(line)) {
      problems.push(`names MEMBERSHIP_TOKEN, which never leaves ${RESOLVE}.`);
    }
  }
  if (path !== DATABASE && (SETTINGS.test(line) || (SET_CONFIG.test(line) && !Object.hasOwn(SETTING_EXCEPTIONS, path)))) {
    problems.push(
      `sets the transaction's company, actor or channel itself (set_config, or nortfox.company_id, nortfox.actor_id, nortfox.actor_kind or nortfox.channel). Only ${DATABASE} sets them: a company comes from the one function's answer, as a company access or through tx.enter.`,
    );
  }
  if (path !== RESOLVE && path !== DELETE_ME && DELETION.test(line)) {
    problems.push(`calls liveForDeletion, which only ${DELETE_ME} calls.`);
  }
  return problems;
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
  if (resolve === undefined || !THE_FUNCTION.test(resolve.text)) {
    problems.push(`${RESOLVE} is missing, or names no access.active_membership, so the guard has nothing to hold the other files to.`);
  }
  for (const file of read) {
    file.text.split("\n").forEach((line, index) => {
      for (const problem of lineProblems(file.path, line)) {
        problems.push(`${file.path}:${String(index + 1)}: ${problem}`);
      }
    });
  }
  return problems;
}
