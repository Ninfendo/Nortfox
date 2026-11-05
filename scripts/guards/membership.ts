// SPDX-License-Identifier: AGPL-3.0-only

// Every access check goes through the one membership function (issue 12,
// "Companies and members"; db/README.md, the schema access). This is the
// guard's half that reads as text the code the server runs: its own source
// and that of the workspace packages it may import, packages/contract and
// packages/engine, in every code file's extension, outside their tests:
// the *.test.ts files, which vitest runs and each package's build leaves
// out. A file of another extension named like a test ships, so it is read.
// In that code:
//
// - Only modules/memberships/resolve.ts names access.active_membership, the
//   one function, by its bare name, so a schema or quotes do not hide it.
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
//   or channel: no other file names them (nortfox.company_id and the rest),
//   or names a way to set a setting whose name comes from elsewhere:
//   set_config, a SET or RESET statement (SET LOCAL and SET SESSION
//   anywhere, and a plain SET or RESET where it starts a statement: after a
//   quote or a semicolon), pg_settings, or a DO block, which runs statements
//   that a text cannot read. SET CONSTRAINTS and SET TRANSACTION set no
//   setting. The migration runner pins its own search path with set_config,
//   for its reason. A transaction in a company takes its company only as a
//   company access (db/database.ts), which only resolve.ts makes.
// - No file writes a name or a text in SQL's Unicode escapes (U&"…" or
//   U&'…'), which the server never needs.
// - No file names the path of a test or a test helper (a *.test.* file, or a
//   file in a test/ folder), in any string, for any import or loader, also
//   by its bare name with a code extension: the guard reads neither. The
//   packages' manifests map no imports (#…), point their exports only into
//   src/ and its build in dist/, and name no test either (manifestProblems).
//
// A name counts quoted or not (also with its quotes escaped in a JS string),
// in any case, with a schema in front, and with any space, line break or SQL
// comment around its dot. Each rule reads the whole file with its JS escapes
// read as JS reads them in a string: \t, \n and the other escapes of one
// letter as their control characters, \u and \x as their characters, a
// backslash before any other character as that character, and a line
// continuation as nothing. An escaped line feed or carriage return ends a
// SQL line comment, as PostgreSQL ends one. So a name over several lines,
// behind an escape or right after one, or after a line comment that an
// escape ends, is caught, and a problem names the line where its match
// starts. The text cannot see a name or a statement joined from
// pieces at run time, or other code written to hide what it runs. Two more
// halves hold part of that: modules/memberships/one-function.db.test.ts
// reads the catalog (no other routine the app may run reads the memberships
// across companies, by any spelling, and none sets a setting, runs dynamic
// SQL or writes a name in SQL's Unicode escapes), and authorize, tx.enter
// and a transaction in a company refuse at run time an object that
// resolve.ts did not make. A statement joined at run time in the server's
// code that sets a setting is caught by neither: a change from outside is
// read in full before it merges (AGENTS.md). A test file is not read: the
// tests read and write the table and set the settings by hand to prove the
// database's rules, and build their principals through resolve.ts.

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
export const SCANNED = ["apps/server/src/", "packages/contract/src/", "packages/engine/src/"] as const;

/** The manifests of those packages, which say what a name of the package or a # import loads. */
export const MANIFESTS = SCANNED.map((root) => root.replace(/src\/$/, "package.json"));

/**
 * A file of code; and a test, a *.test.ts file, which vitest runs and each
 * package's tsconfig.build.json leaves out, so it never ships. A file of
 * another extension named like a test is no test: it ships, and the guard
 * reads it.
 */
const CODE = /\.[cm]?[jt]sx?$/;
const TEST = ".test.ts";

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

/** Whether the guard reads `path`: code that the server runs, not a test that the build leaves out. */
export function scansFile(path: string): boolean {
  return SCANNED.some((root) => path.startsWith(root)) && CODE.test(path) && !path.endsWith(TEST);
}

// Every pattern is global, for matchAll over a whole file, and \s takes a line break too.
const NOT_AN_IDENTIFIER_BEFORE = "(?<![\\w$])";
const NOT_AN_IDENTIFIER_AFTER = "(?![\\w$])";

/** A double quote of a SQL name, or none, also escaped in a JS string. */
const QUOTE = '(?:\\\\?")?';

/** SQL's space between two words: white space, a line break, or a comment of either kind. A line comment ends at a line feed or a carriage return, as PostgreSQL ends it. */
const SQL_SPACE = "(?:\\s|/\\*[\\s\\S]*?\\*/|--[^\\n\\r]*(?:[\\n\\r]|$))";

/** A name with a dot: its two parts, quoted or not, with any space, line break or comment around the dot. */
function dotted(schema: string, name: string): string {
  return `${NOT_AN_IDENTIFIER_BEFORE}${QUOTE}${schema}${QUOTE}${SQL_SPACE}*\\.${SQL_SPACE}*${QUOTE}${name}${QUOTE}${NOT_AN_IDENTIFIER_AFTER}`;
}

/**
 * A JS escape: \u{…}, \uNNNN or \xNN; a backslash before a line break, a
 * line continuation; or a backslash before any other character, also
 * another backslash, read from left to right.
 */
const JS_ESCAPE = /\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g;

/** The escapes of one letter that JS reads as a control character, each as that character. */
const CONTROL_ESCAPES: Readonly<Record<string, string>> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "0": "\0" };

/**
 * A file's text as the rules read it; where in it a line continuation took
 * out a line break of the file; and where an escape put in a line feed that
 * the file does not hold.
 */
interface ReadText {
  readonly text: string;
  readonly joins: readonly number[];
  readonly breaks: readonly number[];
}

/** The line breaks that a backslash before them makes a line continuation: CR LF, LF, CR, and the line and paragraph separators. */
const CONTINUED: ReadonlySet<string> = new Set(["\r\n", "\n", "\r", String.fromCodePoint(0x2028), String.fromCodePoint(0x2029)]);

/** One JS escape as its character: a code point that names no character as a space; a line continuation as nothing. */
function escapedCharacter(escape: string): string {
  const rest = escape.slice(1);
  if (/^(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2})$/.test(rest)) {
    const point = Number.parseInt(rest.slice(1).replace(/[{}]/g, ""), 16);
    return point > 0x10ffff ? " " : String.fromCodePoint(point);
  }
  if (CONTINUED.has(rest)) {
    return "";
  }
  return CONTROL_ESCAPES[rest] ?? rest;
}

/**
 * A file's text with each JS escape read as JS reads it in a string, from
 * left to right: \t, \n and the other escapes of one letter as their
 * control characters, \u and \x as their characters, a backslash before any
 * other character as that character, and a line continuation as nothing, so
 * a name over two lines that it joins is one name. An escaped line feed or
 * carriage return is one, so a SQL line comment ends there, as PostgreSQL
 * ends it. Each line keeps its number: the place of each line feed that an
 * escape put in is kept, and of each line that a continuation joins to the
 * next.
 */
function unescaped(source: string): ReadText {
  const joins: number[] = [];
  const breaks: number[] = [];
  let shorter = 0;
  const text = source.replace(JS_ESCAPE, (escape: string, offset: number) => {
    const read = escapedCharacter(escape);
    if (escape === "\\\n" || escape === "\\\r\n") {
      joins.push(offset - shorter);
    }
    if (read === "\n") {
      breaks.push(offset - shorter);
    }
    shorter += escape.length - read.length;
    return read;
  });
  return { text, joins, breaks };
}

/** The one function, by its bare name, in any case: a schema in front, quoted or not, does not hide it. */
const THE_FUNCTION = new RegExp(`${NOT_AN_IDENTIFIER_BEFORE}active_membership${NOT_AN_IDENTIFIER_AFTER}`, "gi");

/** The memberships by their schema's name, in any case; the people of a company by its bare name, in any case. */
const TABLES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "access.memberships", pattern: new RegExp(dotted("access", "memberships"), "gi") },
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
 * The transaction's settings, in any case; and the ways to set a setting by
 * a name from elsewhere, in any case: SET LOCAL and SET SESSION anywhere; a
 * SET or a RESET that starts a statement, after a semicolon or a string's
 * opening quote, but not SET CONSTRAINTS, SET TRANSACTION, or a JS setter or
 * variable named set; pg_settings; and a DO block, with its body
 * dollar-quoted or a string. A double quote after a letter, a digit or a
 * backslash closes a SQL name, as in UPDATE "access"."x" SET, so it starts
 * no statement.
 */
const SETTINGS: readonly RegExp[] = [
  new RegExp(dotted("nortfox", "(?:company_id|actor_id|actor_kind|channel)"), "gi"),
  new RegExp(`${NOT_AN_IDENTIFIER_BEFORE}set${SQL_SPACE}+(?:local|session)${NOT_AN_IDENTIFIER_AFTER}`, "gi"),
  new RegExp(
    `(?<=(?:[;'\`]|(?<![\\w$\\\\])")${SQL_SPACE}*)(?:re)?set(?=${SQL_SPACE})(?!${SQL_SPACE}*(?:[=(]|(?:constraints|transaction)${NOT_AN_IDENTIFIER_AFTER}|[\\w$#]+\\s*\\())`,
    "gi",
  ),
  new RegExp(`${NOT_AN_IDENTIFIER_BEFORE}pg_settings${NOT_AN_IDENTIFIER_AFTER}`, "gi"),
  new RegExp(`${NOT_AN_IDENTIFIER_BEFORE}do${SQL_SPACE}+(?:language${SQL_SPACE}+\\S+${SQL_SPACE}+)?(?:\\$|e?')`, "gi"),
];

/** A name or a text in SQL's Unicode escapes, U&"…" or U&'…', in any case, its quote also escaped in a JS string. */
const UNICODE_ESCAPES = new RegExp(`${NOT_AN_IDENTIFIER_BEFORE}u&\\\\?["']`, "gi");

const TOKEN = /\bMEMBERSHIP_TOKEN\b/g;
const DELETION = /\bliveForDeletion\b/g;

/**
 * A path, in any string, of a *.test.* file or of a file in a test/ folder,
 * whatever import or loader takes it, with no space or colon: a path to a
 * test/ folder, also one that starts there; a path with a slash to a *.test
 * file, with a code extension or none; or the bare name of a *.test file
 * with a code extension, as a path joined to a folder takes it. A bare name
 * with no extension is a host's, as nortfox.test. The first group is the
 * path.
 */
const TEST_PATH = /["'`]((?:[^"'`\s:]*\/)?test\/[^"'`\s:]*|[^"'`\s:]*\/[^"'`\s:/]*\.test(?:\.[cm]?[jt]sx?)?|[^"'`\s:/]+\.test\.[cm]?[jt]sx?)["'`]/g;

/** The problem of a test's path that TEST_PATH found. */
function namesTest(found: RegExpExecArray): string {
  return `names a test or a test helper (${String(found[1])}). The guard does not read the tests, so code that the server runs never loads one.`;
}

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
      `sets the transaction's company, actor or channel itself (set_config, a SET or RESET statement, pg_settings, a DO block, or nortfox.company_id, nortfox.actor_id, nortfox.actor_kind or nortfox.channel). Only ${DATABASE} sets them: a company comes from the one function's answer, as a company access or through tx.enter.`,
  },
  {
    patterns: () => [UNICODE_ESCAPES],
    problem: () => "writes a name or a text in SQL's Unicode escapes (U&), which hide a name from this guard. Write it as it is.",
  },
  {
    patterns: (path) => (path === RESOLVE || path === DELETE_ME ? [] : [DELETION]),
    problem: () => `calls liveForDeletion, which only ${DELETE_ME} calls.`,
  },
  {
    patterns: () => [TEST_PATH],
    problem: (found) => namesTest(found),
  },
];

/** The line of the file that holds the character at `index` of its read text, counted from 1: the read text's line feeds before it but the ones that an escape put in, and the ones that a continuation took out. */
function lineAt(read: ReadText, index: number): number {
  let line = 1 + read.joins.filter((join) => join <= index).length - read.breaks.filter((put) => put < index).length;
  for (let end = read.text.indexOf("\n"); end !== -1 && end < index; end = read.text.indexOf("\n", end + 1)) {
    line += 1;
  }
  return line;
}

/** The problems of one file, as "<line>: <problem>": one for each line and rule, the first pattern's that matches there, by line and then in the order of the rules. */
function fileProblems(file: SourceFile): string[] {
  const found: { readonly line: number; readonly rule: number; readonly problem: string }[] = [];
  const read = unescaped(file.text);
  RULES.forEach((rule, index) => {
    for (const pattern of rule.patterns(file.path)) {
      for (const match of read.text.matchAll(pattern)) {
        const line = lineAt(read, match.index);
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

/** The fields of a manifest that name a file of the package that a name of the package loads: its exports and its entry points. */
const ENTRY_FIELDS = ["exports", "main", "module", "browser"] as const;

/** Every text in a manifest's value, at any depth. */
function textsOf(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(textsOf);
  }
  return [];
}

/**
 * What in the manifests of the packages the guard reads would let their
 * code load a file that the guard does not read, as "<path>: <problem>";
 * empty when nothing does: an imports field, whose # names the guard does
 * not follow; an export or an entry point outside src/ and its build in
 * dist/; and the path of a test or a test helper, in any string.
 */
export function manifestProblems(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const manifest = JSON.parse(file.text) as Readonly<Record<string, unknown>>;
    if (Object.hasOwn(manifest, "imports")) {
      problems.push(`${file.path}: maps imports (#…), whose files the guard does not follow. Import a file of the package by its path.`);
    }
    for (const target of ENTRY_FIELDS.flatMap((field) => textsOf(manifest[field]))) {
      if (!/^\.\/(?:src|dist)\//.test(target) || target.split("/").includes("..")) {
        problems.push(`${file.path}: points ${target} outside src/ and its build in dist/, where the guard does not read.`);
      }
    }
    for (const found of file.text.matchAll(TEST_PATH)) {
      problems.push(`${file.path}: ${namesTest(found)}`);
    }
  }
  return problems;
}
