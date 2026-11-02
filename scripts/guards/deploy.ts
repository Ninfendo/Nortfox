// SPDX-License-Identifier: AGPL-3.0-only

// Keeps the backup settings and the migrate step of an install
// (docs/decisions/0007-self-hosting-and-backups.md) in the files that set
// them: the compose file, pgBackRest's config and the two images. The
// point-in-time restore test, deploy/backup-test/pitr.sh, checks the same
// settings on a running stack. This guard makes a changed copy of a file fail
// without one. It also keeps the restore test's own compose file from changing
// a setting, so the test runs the install's own settings.
//
// The guard reads the compose files line by line. So they keep to plain block
// YAML: one key to a line, and no anchor, alias or merge key.

import { imagesIn, isPostgres } from "./images.ts";

export const COMPOSE = "deploy/compose.yaml";
export const BACKUP_TEST_COMPOSE = "deploy/backup-test/compose.yaml";
export const PGBACKREST_CONF = "deploy/postgres/pgbackrest.conf";
export const POSTGRES_IMAGE = "deploy/postgres/Dockerfile";
export const SERVER_IMAGE = "deploy/server/Dockerfile";

/** The postgres service's command: WAL archiving through pgBackRest, and a closed segment after at most 60 seconds. */
export const POSTGRES_COMMAND = [
  "postgres",
  "-c",
  "wal_level=replica",
  "-c",
  "archive_mode=on",
  "-c",
  "archive_command=pgbackrest --stanza=nortfox archive-push %p",
  "-c",
  "archive_timeout=60",
];

/**
 * The postgres service's health check: the file that the first start writes
 * as its last step (deploy/postgres/initdb/20-stanza.sh), in the data folder,
 * and then pg_isready over TCP.
 */
export const POSTGRES_HEALTHCHECK =
  '["CMD-SHELL", "test -f /var/lib/postgresql/18/docker/nortfox-first-start-done && pg_isready --host 127.0.0.1 --username postgres --dbname nortfox"]';

/** The settings that only the postgres service's command sets. */
const ARCHIVE_SETTING = /\b(wal_level|archive_mode|archive_command|archive_timeout)\b/;

interface Line {
  readonly number: number;
  readonly text: string;
}

interface Entry {
  readonly line: number;
  /** The text after the key's colon. */
  readonly value: string;
  /** The lines under the key. */
  readonly block: readonly Line[];
}

const indentOf = (text: string): number => text.length - text.trimStart().length;

/** A line of one key: the key, and the text after its colon. */
function keyOf(text: string): { key: string; value: string } | undefined {
  const found = /^\s*([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(text);
  return found?.[1] === undefined ? undefined : { key: found[1], value: (found[2] ?? "").trim() };
}

/** The lines that hold YAML: no blank line, no comment line, and no comment after a value. */
function yamlLines(text: string): Line[] {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ number: index + 1, text: line.replace(/\s+#.*$/, "").trimEnd() }))
    .filter((line) => line.text.trim() !== "" && !line.text.trimStart().startsWith("#"));
}

/** The entry of `key` among the lines of a block: the key at the block's first indent, and the lines under it. */
function entryIn(lines: readonly Line[], key: string): Entry | undefined {
  const indent = indentOf(lines[0]?.text ?? "");
  const start = lines.findIndex((line) => indentOf(line.text) === indent && keyOf(line.text)?.key === key);
  const found = lines[start];
  if (found === undefined) {
    return undefined;
  }
  const end = lines.findIndex((line, index) => index > start && indentOf(line.text) <= indent);
  return { line: found.number, value: keyOf(found.text)?.value ?? "", block: lines.slice(start + 1, end === -1 ? undefined : end) };
}

/** The entry at a path of keys. */
function entryAt(lines: readonly Line[], path: readonly string[]): Entry | undefined {
  let entry: Entry | undefined = { line: 0, value: "", block: lines };
  for (const key of path) {
    entry = entryIn(entry.block, key);
    if (entry === undefined) {
      return undefined;
    }
  }
  return entry;
}

/** The keys right under a block, each with its entry. */
function keysIn(lines: readonly Line[]): Map<string, Entry> {
  const indent = indentOf(lines[0]?.text ?? "");
  const keys = new Map<string, Entry>();
  for (const line of lines) {
    const key = indentOf(line.text) === indent ? keyOf(line.text)?.key : undefined;
    const entry = key === undefined ? undefined : entryIn(lines, key);
    if (key !== undefined && entry !== undefined && !keys.has(key)) {
      keys.set(key, entry);
    }
  }
  return keys;
}

const trimmed = (entry: Entry | undefined): string[] => entry?.block.map((line) => line.text.trim()) ?? [];

/** Whether `lines` holds `wanted` in a row. */
function holdsInARow(lines: readonly string[], wanted: readonly string[]): boolean {
  return lines.some((_line, start) => wanted.every((line, offset) => lines[start + offset] === line));
}

const sameLines = (found: readonly string[], wanted: readonly string[]): boolean =>
  found.length === wanted.length && found.every((line, index) => line === wanted[index]);

/** A key given twice under one parent, and an anchor, alias or merge key: what the guard cannot read. */
function yamlFormProblems(path: string, lines: readonly Line[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (/(?:^|\s)[&*][A-Za-z0-9_-]+|<<\s*:/.test(line.text)) {
      problems.push(`${path}:${String(line.number)} uses a YAML anchor, alias or merge key. The guard reads the file line by line, so the file holds none.`);
    }
    // The key of a list item belongs to that item; any other key to the nearest line above it that sits further out.
    const item = /^\s*-\s+(.*)$/.exec(line.text)?.[1];
    const key = keyOf(item ?? line.text)?.key;
    const parent =
      item === undefined ? lines.slice(0, index).findLast((above) => indentOf(above.text) < indentOf(line.text))?.number ?? 0 : line.number;
    if (key !== undefined) {
      const id = `${String(parent)}:${key}`;
      if (seen.has(id)) {
        problems.push(`${path}:${String(line.number)} gives the key ${key} a second time. The guard reads the first, and Compose the last.`);
      }
      seen.add(id);
    }
  }
  return problems;
}

const OFFSITE = (variable: string): RegExp => new RegExp(`^\\$\\{${variable}:\\?[^}]+\\}$`);

/** What is wrong with deploy/compose.yaml; empty when nothing is. */
export function composeProblems(text: string): string[] {
  const lines = yamlLines(text);
  const problems = yamlFormProblems(COMPOSE, lines);
  const at = (...path: string[]): Entry | undefined => entryAt(lines, path);
  const need = (ok: boolean, problem: string): void => {
    if (!ok) {
      problems.push(`${COMPOSE}: ${problem}`);
    }
  };

  need(
    sameLines(trimmed(at("services", "postgres", "build")), ["context: ..", "dockerfile: deploy/postgres/Dockerfile"]),
    "services.postgres.build must be the context .. and the dockerfile deploy/postgres/Dockerfile: PostgreSQL with pgBackRest.",
  );
  const command = at("services", "postgres", "command");
  need(
    command?.value === "" &&
      sameLines(
        trimmed(command),
        POSTGRES_COMMAND.map((part) => `- ${part}`),
      ),
    `services.postgres.command must be exactly ${POSTGRES_COMMAND.join(" ")}, one item to a line. ` +
      "PostgreSQL archives each WAL segment through pgBackRest to both repositories, and closes a segment after at most 60 seconds.",
  );
  for (const [option, variable] of [
    ["PGBACKREST_REPO2_TYPE", "NORTFOX_REPO2_TYPE"],
    ["PGBACKREST_REPO2_PATH", "NORTFOX_REPO2_PATH"],
  ] as const) {
    need(
      OFFSITE(variable).test(at("services", "postgres", "environment", option)?.value ?? ""),
      `services.postgres.environment.${option} must be the required variable \${${variable}:?...}, so the stack does not start without the off-site repository.`,
    );
  }
  for (const line of trimmed(at("services", "postgres", "environment"))) {
    const option = /^(?:-\s+)?(PGBACKREST_[A-Z0-9_]*)\s*[:=]/.exec(line)?.[1];
    if (option !== undefined && option !== "PGBACKREST_REPO2_TYPE" && option !== "PGBACKREST_REPO2_PATH") {
      problems.push(
        `${COMPOSE}: services.postgres.environment sets ${option}. pgBackRest's options are in deploy/postgres/pgbackrest.conf ` +
          "and the repo2-options secret; only the off-site repository's type and path come from the environment.",
      );
    }
  }
  for (const key of ["env_file", "entrypoint"]) {
    need(
      at("services", "postgres", key) === undefined,
      `services.postgres sets ${key}. The service runs the image's own entrypoint, with its first-start scripts, ` +
        "and takes its environment from the compose file alone, where the guard reads it.",
    );
  }
  need(
    holdsInARow(trimmed(at("services", "postgres", "secrets")), ["- source: repo2-options", "target: /etc/pgbackrest/conf.d/repo2.conf"]),
    "services.postgres.secrets must mount repo2-options at /etc/pgbackrest/conf.d/repo2.conf: the off-site repository's other options.",
  );
  const volumes = trimmed(at("services", "postgres", "volumes"));
  need(
    volumes.includes("- data:/var/lib/postgresql") && volumes.includes("- backups:/var/lib/pgbackrest"),
    "services.postgres.volumes must mount the volume data at /var/lib/postgresql, and the volume backups, the local repository, at /var/lib/pgbackrest.",
  );
  need(
    at("volumes", "data") !== undefined && at("volumes", "backups") !== undefined,
    "volumes must declare data and backups, so the data and the local repository are volumes of their own.",
  );
  need(
    at("services", "postgres", "healthcheck", "test")?.value === POSTGRES_HEALTHCHECK,
    `services.postgres.healthcheck.test must be ${POSTGRES_HEALTHCHECK}: the mark that the first start finished, then pg_isready over TCP, on 127.0.0.1. ` +
      "A failed first start is then never healthy, and the first start's setup server listens on its socket only, so the migrations wait until the setup is done.",
  );

  need(
    sameLines(trimmed(at("services", "migrate", "build")), ["context: ..", "dockerfile: deploy/server/Dockerfile"]),
    "services.migrate.build must be the context .. and the dockerfile deploy/server/Dockerfile: the server's image.",
  );
  need(
    at("services", "migrate", "command")?.value === '["node", "apps/server/dist/db/migrate-main.js"]',
    'services.migrate.command must be ["node", "apps/server/dist/db/migrate-main.js"]: the migration runner.',
  );
  need(
    at("services", "migrate", "environment", "NORTFOX_DATABASE_URL")?.value === "postgres://nortfox_owner@postgres:5432/nortfox",
    "services.migrate.environment.NORTFOX_DATABASE_URL must be postgres://nortfox_owner@postgres:5432/nortfox: the migrations run as the owner role.",
  );
  need(
    at("services", "migrate", "environment", "NORTFOX_DATABASE_PASSWORD_FILE")?.value === "/run/secrets/owner-password",
    "services.migrate.environment.NORTFOX_DATABASE_PASSWORD_FILE must be /run/secrets/owner-password, the owner role's password.",
  );
  need(at("services", "migrate", "restart")?.value === '"no"', 'services.migrate.restart must be "no": the migrate step runs once.');
  need(
    sameLines(trimmed(at("services", "migrate", "depends_on")), ["postgres:", "condition: service_healthy"]),
    "services.migrate.depends_on must be postgres with the condition service_healthy, so the migrations run once PostgreSQL is set up.",
  );

  const inCommand = new Set([command?.line, ...(command?.block.map((line) => line.number) ?? [])]);
  for (const line of lines) {
    const setting = ARCHIVE_SETTING.exec(line.text)?.[1];
    if (setting !== undefined && !inCommand.has(line.number)) {
      problems.push(`${COMPOSE}:${String(line.number)} names ${setting} outside services.postgres.command, where the archive settings are set.`);
    }
  }
  return problems;
}

/** What may stand at each place in the backup test's compose file. */
const BACKUP_TEST_KEYS: ReadonlyMap<string, readonly string[] | "any"> = new Map<string, readonly string[] | "any">([
  ["", ["name", "services", "secrets", "volumes"]],
  ["services", ["postgres"]],
  ["services.postgres", ["volumes"]],
  ["secrets", "any"],
  ["secrets.*", ["file"]],
  ["volumes", "any"],
]);

/** What is wrong with deploy/backup-test/compose.yaml; empty when nothing is. */
export function backupTestProblems(text: string): string[] {
  const lines = yamlLines(text);
  const problems = yamlFormProblems(BACKUP_TEST_COMPOSE, lines);
  if (entryAt(lines, ["name"])?.value !== "nortfox-backup-test") {
    problems.push(
      `${BACKUP_TEST_COMPOSE}: name must be nortfox-backup-test, a project of its own, so the test never touches an install's containers or volumes.`,
    );
  }
  const walk = (block: readonly Line[], path: string, rule: string): void => {
    const allowed = BACKUP_TEST_KEYS.get(rule);
    for (const [key, entry] of keysIn(block)) {
      const where = path === "" ? key : `${path}.${key}`;
      if (allowed === "any") {
        walk(entry.block, where, `${rule}.*`);
      } else if (allowed?.includes(key) === true) {
        walk(entry.block, where, where);
      } else {
        problems.push(
          `${BACKUP_TEST_COMPOSE}:${String(entry.line)} sets ${where}. On top of deploy/compose.yaml the test sets only its project name, ` +
            "its secrets' files and the off-site volume, so it runs the install's own settings.",
        );
      }
    }
  };
  walk(lines, "", "");
  if (!sameLines(trimmed(entryAt(lines, ["services", "postgres", "volumes"])), ["- offsite:/var/lib/pgbackrest-offsite"])) {
    problems.push(
      `${BACKUP_TEST_COMPOSE}: services.postgres.volumes must be offsite at /var/lib/pgbackrest-offsite alone, the stand-in for the off-site repository.`,
    );
  }
  return problems;
}

interface Option {
  readonly line: number;
  readonly section: string;
  readonly key: string;
  readonly value: string;
}

const KEEP_EVERY_BACKUP = "the repository keeps every full backup, and removing one is the operator's step.";

/** The options that pgbackrest.conf sets, each once, in its section. */
const PGBACKREST_PINS: readonly (readonly [section: string, key: string, value: string, why: string])[] = [
  ["global", "repo1-path", "/var/lib/pgbackrest", "the local repository, on its own volume."],
  ["global", "repo1-retention-full", "9999999", KEEP_EVERY_BACKUP],
  ["global", "repo2-retention-full", "9999999", KEEP_EVERY_BACKUP],
  ["nortfox", "pg1-path", "/var/lib/postgresql/18/docker", "the data folder of the PostgreSQL 18 image."],
];

const FROM_VARIABLES =
  "the off-site repository's type and path come from the compose file's required variables, so the stack does not start without them.";

/** The options that pgbackrest.conf never sets. */
const PGBACKREST_FORBIDDEN: ReadonlyMap<string, string> = new Map([
  ["repo2-type", FROM_VARIABLES],
  ["repo2-path", FROM_VARIABLES],
  ["repo1-type", "repo1 is the local repository, a folder on the backups volume."],
  ["archive-push-queue-max", "it drops WAL when the queue is full, and a restore then cannot reach a point after it."],
]);

/** What is wrong with deploy/postgres/pgbackrest.conf; empty when nothing is. */
export function pgbackrestProblems(text: string): string[] {
  const problems: string[] = [];
  const options: Option[] = [];
  let section: string | undefined;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    const where = `${PGBACKREST_CONF}:${String(index + 1)}`;
    const opened = /^\[([^\]]+)\]$/.exec(line)?.[1];
    const option = /^([a-z0-9-]+)=(.*)$/.exec(line);
    if (line === "" || line.startsWith("#")) {
      continue;
    } else if (opened !== undefined) {
      section = opened;
      if (opened !== "global" && opened !== "nortfox") {
        problems.push(
          `${where} opens the section [${opened}]. The file holds [global] and [nortfox] alone, so no command's own section changes a setting.`,
        );
      }
    } else if (option?.[1] === undefined) {
      problems.push(`${where} is neither a [section] nor an option=value line.`);
    } else if (section === undefined) {
      problems.push(`${where} sets ${option[1]} before any section.`);
    } else {
      const key = option[1];
      if (options.some((found) => found.section === section && found.key === key)) {
        problems.push(`${where} sets ${key} a second time in [${section}].`);
      }
      options.push({ line: index + 1, section, key, value: option[2] ?? "" });
    }
  }
  for (const [pinSection, key, value, why] of PGBACKREST_PINS) {
    const set = options.filter((found) => found.key === key);
    if (set.length !== 1 || set[0]?.section !== pinSection || set[0].value !== value) {
      problems.push(`${PGBACKREST_CONF} must set ${key}=${value} once, in [${pinSection}]: ${why}`);
    }
  }
  for (const [key, why] of PGBACKREST_FORBIDDEN) {
    if (options.some((found) => found.key === key)) {
      problems.push(`${PGBACKREST_CONF} sets ${key}, which it must not: ${why}`);
    }
  }
  return problems;
}

/** A Dockerfile's instructions, each on one line: a backslash at a line's end continues it. */
function instructions(text: string): string[] {
  return text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** The words that each `apt-get install` in a Dockerfile installs, its options among them. */
function aptInstalls(text: string): string[] {
  return instructions(text)
    .filter((line) => line.startsWith("RUN "))
    .flatMap((line) => line.split(/&&|;|\|/))
    .map((command) => /\bapt-get install\b(.*)$/.exec(command.trim())?.[1])
    .filter((words) => words !== undefined)
    .flatMap((words) => words.trim().split(" "));
}

const POSTGRES_COPIES: readonly (readonly [line: string, why: string])[] = [
  ["COPY --chmod=0644 deploy/postgres/pgbackrest.conf /etc/pgbackrest/pgbackrest.conf", "pgBackRest's config, where pgBackRest reads it."],
  ["COPY --chmod=0644 db/roles.sql /usr/local/share/nortfox/roles.sql", "the cluster roles, which 10-roles.sh reads there."],
  ["COPY --chmod=0755 deploy/postgres/initdb/ /docker-entrypoint-initdb.d/", "the first-start scripts, where the image's entrypoint runs them."],
];

/** What is wrong with deploy/postgres/Dockerfile; empty when nothing is. Its digest is the image guard's to check. */
export function postgresImageProblems(text: string): string[] {
  const problems: string[] = [];
  const images = imagesIn(POSTGRES_IMAGE, text);
  if (images.length !== 1 || !images.every((use) => isPostgres(use.image))) {
    problems.push(`${POSTGRES_IMAGE} must build FROM the postgres image, and from nothing else.`);
  }
  const pgbackrest = aptInstalls(text).filter((word) => /^pgbackrest(?:$|=)/.test(word));
  if (pgbackrest.length === 0 || !pgbackrest.every((word) => /^pgbackrest=[0-9][0-9A-Za-z.+~:-]*$/.test(word))) {
    problems.push(`${POSTGRES_IMAGE} must install pgbackrest with apt-get at a pinned version, as pgbackrest=<version>.`);
  }
  const lines = instructions(text);
  for (const [line, why] of POSTGRES_COPIES) {
    if (!lines.includes(line)) {
      problems.push(`${POSTGRES_IMAGE} must hold the line "${line}": ${why}`);
    }
  }
  return problems;
}

/** What is wrong with deploy/server/Dockerfile, given the root package.json; empty when nothing is. */
export function serverImageProblems(text: string, packageJson: string): string[] {
  const manifest: unknown = JSON.parse(packageJson);
  const manager =
    typeof manifest === "object" && manifest !== null && "packageManager" in manifest ? String(manifest.packageManager) : "";
  const wanted = /^pnpm@(\S+)$/.exec(manager)?.[1];
  if (wanted === undefined) {
    return ["package.json names no pnpm version in packageManager."];
  }
  const problems: string[] = [];
  const lines = instructions(text);
  const installed = [...text.matchAll(/\bpnpm@(\S+)/g)].map((found) => found[1] ?? "");
  if (installed.length === 0) {
    problems.push(`${SERVER_IMAGE} must install pnpm@${wanted}, the version that package.json names.`);
  }
  for (const version of installed.filter((found) => found !== wanted)) {
    problems.push(`${SERVER_IMAGE} installs pnpm@${version}, but package.json names pnpm@${wanted}. The image builds with the pnpm that the repository uses.`);
  }
  const installs = lines.flatMap((line) => line.split("&&")).filter((command) => /\bpnpm install\b/.test(command));
  for (const command of installs) {
    if (!/\s--frozen-lockfile\b/.test(command) || !/\s--ignore-scripts\b/.test(command)) {
      problems.push(
        `${SERVER_IMAGE} runs pnpm install without --frozen-lockfile and --ignore-scripts. Each install keeps to pnpm-lock.yaml and runs no install script.`,
      );
    }
  }
  if (!lines.includes("COPY db/migrations db/migrations")) {
    problems.push(`${SERVER_IMAGE} must hold the line "COPY db/migrations db/migrations": the migrate step applies the migrations of the same commit.`);
  }
  return problems;
}

/** What is wrong with the files of an install; empty when nothing is. */
export function deployProblems(read: (path: string) => string | undefined): string[] {
  const files = [COMPOSE, BACKUP_TEST_COMPOSE, PGBACKREST_CONF, POSTGRES_IMAGE, SERVER_IMAGE, "package.json"].map(
    (path) => [path, read(path)] as const,
  );
  const missing = files.filter(([, text]) => text === undefined).map(([path]) => `${path} is missing.`);
  if (missing.length > 0) {
    return missing;
  }
  const text = (path: string): string => read(path) ?? "";
  return [
    ...composeProblems(text(COMPOSE)),
    ...backupTestProblems(text(BACKUP_TEST_COMPOSE)),
    ...pgbackrestProblems(text(PGBACKREST_CONF)),
    ...postgresImageProblems(text(POSTGRES_IMAGE)),
    ...serverImageProblems(text(SERVER_IMAGE), text("package.json")),
  ];
}
