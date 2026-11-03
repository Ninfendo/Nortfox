// SPDX-License-Identifier: AGPL-3.0-only

// The deploy guard: the files of an install keep the backup settings and the
// migrate step, and a copy with any of them changed fails.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BACKUP_TEST_COMPOSE,
  COMPOSE,
  DOCKERIGNORE,
  PGBACKREST_CONF,
  POSTGRES_HEALTHCHECK,
  POSTGRES_IMAGE,
  SERVER_IMAGE,
  STANZA_SCRIPT,
  backupTestProblems,
  composeProblems,
  deployProblems,
  dockerignoreProblems,
  pgbackrestProblems,
  postgresImageProblems,
  serverImageProblems,
  stanzaScriptProblems,
} from "./deploy.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function read(path: string): string | undefined {
  try {
    return readFileSync(`${ROOT}/${path}`, "utf8");
  } catch {
    return undefined;
  }
}

function file(path: string): string {
  const text = read(path);
  if (text === undefined) {
    throw new Error(`${path} is missing.`);
  }
  return text;
}

const compose = file(COMPOSE);
const backupTest = file(BACKUP_TEST_COMPOSE);
const conf = file(PGBACKREST_CONF);
const postgresImage = file(POSTGRES_IMAGE);
const serverImage = file(SERVER_IMAGE);
const packageJson = file("package.json");
const dockerignore = file(DOCKERIGNORE);
const stanzaScript = file(STANZA_SCRIPT);

/** The text with one part replaced; the part must be there exactly once. */
function changed(text: string, from: string, to: string): string {
  expect(text.split(from).length - 1).toBe(1);
  return text.replace(from, to);
}

describe("the repository", () => {
  it("keeps the backup settings and the migrate step in the files of an install", () => {
    expect(deployProblems(read)).toEqual([]);
  });

  it("reports a file of an install that is missing", () => {
    expect(deployProblems((path) => (path === PGBACKREST_CONF ? undefined : read(path)))).toEqual([
      "deploy/postgres/pgbackrest.conf is missing.",
    ]);
  });
});

describe("the compose file", () => {
  it("passes as it is, also with Windows line ends", () => {
    expect(composeProblems(compose)).toEqual([]);
    expect(composeProblems(compose.replaceAll("\n", "\r\n"))).toEqual([]);
  });

  const COMMAND =
    "deploy/compose.yaml: services.postgres.command must be exactly postgres -c wal_level=replica -c archive_mode=on " +
    "-c archive_command=pgbackrest --stanza=nortfox archive-push %p -c archive_timeout=60, one item to a line. " +
    "PostgreSQL archives each WAL segment through pgBackRest to both repositories, and closes a segment after at most 60 seconds.";
  const REPO2_TYPE =
    "deploy/compose.yaml: services.postgres.environment.PGBACKREST_REPO2_TYPE must be the required variable ${NORTFOX_REPO2_TYPE:?...}, " +
    "so the stack does not start without the off-site repository.";
  const REPO2_PATH =
    "deploy/compose.yaml: services.postgres.environment.PGBACKREST_REPO2_PATH must be the required variable ${NORTFOX_REPO2_PATH:?...}, " +
    "so the stack does not start without the off-site repository.";
  const HEALTHCHECK =
    `deploy/compose.yaml: services.postgres.healthcheck.test must be ${POSTGRES_HEALTHCHECK}: the mark that the first start finished, no mark that its first backups are still to come, ` +
    "then pg_isready over TCP, on 127.0.0.1. A first start that failed, or stopped during its first backups, is then never healthy, " +
    "and the first start's setup server listens on its socket only, so the migrations wait until the setup is done.";
  const VOLUMES =
    "deploy/compose.yaml: services.postgres.volumes must mount the volume data at /var/lib/postgresql, and the volume backups, " +
    "the local repository, at /var/lib/pgbackrest.";

  it.each([
    ["archive_mode off", "      - archive_mode=on\n", "      - archive_mode=off\n", [COMMAND]],
    ["a longer archive_timeout", "      - archive_timeout=60\n", "      - archive_timeout=300\n", [COMMAND]],
    [
      "another archive_command",
      "archive_command=pgbackrest --stanza=nortfox archive-push %p",
      "archive_command=/bin/true",
      [COMMAND],
    ],
    ["wal_level minimal", "      - wal_level=replica\n", "      - wal_level=minimal\n", [COMMAND]],
    ["a setting dropped", "      - -c\n      - archive_timeout=60\n", "", [COMMAND]],
    ["a setting added", "      - archive_timeout=60\n", "      - archive_timeout=60\n      - -c\n      - archive_mode=off\n", [COMMAND]],
    [
      "the command as one string",
      "    command:\n      - postgres\n      - -c\n      - wal_level=replica\n      - -c\n      - archive_mode=on\n      - -c\n" +
        "      - archive_command=pgbackrest --stanza=nortfox archive-push %p\n      - -c\n      - archive_timeout=60\n",
      "    command: postgres -c wal_level=replica -c archive_mode=on -c archive_timeout=60\n",
      [COMMAND],
    ],
    ["a default for the off-site type", "${NORTFOX_REPO2_TYPE:?", "${NORTFOX_REPO2_TYPE:-posix", [REPO2_TYPE]],
    ["no off-site path", "      PGBACKREST_REPO2_PATH: ${NORTFOX_REPO2_PATH:?", "      REPO2_PATH: ${NORTFOX_REPO2_PATH:?", [REPO2_PATH]],
    ["a fixed off-site type", "${NORTFOX_REPO2_TYPE:?Set NORTFOX_REPO2_TYPE to the type of the off-site repository, as deploy/README.md says.}", "posix", [
      REPO2_TYPE,
    ]],
    [
      "the local repository on another path",
      "      - backups:/var/lib/pgbackrest\n",
      "      - backups:/var/lib/elsewhere\n",
      [VOLUMES],
    ],
    ["the data on no volume", "      - data:/var/lib/postgresql\n", "", [VOLUMES]],
  ])("fails %s", (_case, from, to, problems) => {
    expect(composeProblems(changed(compose, from, to))).toEqual(problems);
  });

  it.each([
    ["PGBACKREST_REPO1_PATH: /tmp", "PGBACKREST_REPO1_PATH"],
    ["PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX: 1MB", "PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX"],
  ])("fails another pgBackRest option in the environment: %s", (line, option) => {
    const text = changed(compose, "      POSTGRES_PASSWORD_FILE:", `      ${line}\n      POSTGRES_PASSWORD_FILE:`);
    expect(composeProblems(text)).toEqual([
      `deploy/compose.yaml: services.postgres.environment sets ${option}. pgBackRest's options are in deploy/postgres/pgbackrest.conf ` +
        "and the repo2-options secret; only the off-site repository's type and path come from the environment.",
    ]);
  });

  it.each([["env_file"], ["entrypoint"]])("fails a postgres service with its own %s", (key) => {
    const text = changed(compose, "    stop_grace_period: 2m\n", `    ${key}: ./elsewhere\n    stop_grace_period: 2m\n`);
    expect(composeProblems(text)).toEqual([
      `deploy/compose.yaml: services.postgres sets ${key}. The service runs the image's own entrypoint, with its first-start scripts, ` +
        "and takes its environment from the compose file alone, where the guard reads it.",
    ]);
  });

  it("fails an archive setting outside the postgres command", () => {
    const text = changed(compose, "    restart: \"no\"\n", "    restart: \"no\"\n    labels:\n      archive_timeout: \"600\"\n");
    const line = text.split("\n").findIndex((found) => found.includes('archive_timeout: "600"')) + 1;
    expect(composeProblems(text)).toEqual([
      `deploy/compose.yaml:${String(line)} names archive_timeout outside services.postgres.command, where the archive settings are set.`,
    ]);
  });

  it.each([
    [
      "the image without pgBackRest",
      "      dockerfile: deploy/postgres/Dockerfile\n",
      "      dockerfile: Dockerfile\n",
      "deploy/compose.yaml: services.postgres.build must be the context .. and the dockerfile deploy/postgres/Dockerfile: PostgreSQL with pgBackRest.",
    ],
    [
      "the off-site options elsewhere",
      "        target: /etc/pgbackrest/conf.d/repo2.conf\n",
      "        target: /tmp/repo2.conf\n",
      "deploy/compose.yaml: services.postgres.secrets must mount repo2-options at /etc/pgbackrest/conf.d/repo2.conf: the off-site repository's other options.",
    ],
    [
      "a health check on the socket",
      "pg_isready --host 127.0.0.1 --username",
      "pg_isready --username",
      HEALTHCHECK,
    ],
    [
      "a health check that a failed first start passes",
      "test -f /var/lib/postgresql/18/docker/nortfox-first-start-done && ",
      "",
      HEALTHCHECK,
    ],
    [
      "a health check that reads the mark elsewhere",
      "/var/lib/postgresql/18/docker/nortfox-first-start-done",
      "/tmp/nortfox-first-start-done",
      HEALTHCHECK,
    ],
    [
      "a health check that passes without the mark",
      "nortfox-first-start-done && test",
      "nortfox-first-start-done || test",
      HEALTHCHECK,
    ],
    [
      "a health check that a first start killed during its first backups passes",
      "test ! -e /var/lib/postgresql/nortfox-first-backups-pending && ",
      "",
      HEALTHCHECK,
    ],
    [
      "a health check that reads the mark of the first backups in the data folder, where a restore would bring it back",
      "test ! -e /var/lib/postgresql/nortfox-first-backups-pending",
      "test ! -e /var/lib/postgresql/18/docker/nortfox-first-backups-pending",
      HEALTHCHECK,
    ],
    [
      "no volume for the local repository",
      "  backups:\n",
      "  other:\n",
      "deploy/compose.yaml: volumes must declare data and backups, so the data and the local repository are volumes of their own.",
    ],
    [
      "the migrate step from another image",
      "      dockerfile: deploy/server/Dockerfile\n",
      "      dockerfile: deploy/other/Dockerfile\n",
      "deploy/compose.yaml: services.migrate.build must be the context .. and the dockerfile deploy/server/Dockerfile: the server's image.",
    ],
    [
      "the migrate step running something else",
      'command: ["node", "apps/server/dist/db/migrate-main.js"]',
      'command: ["node", "apps/server/dist/main.js"]',
      'deploy/compose.yaml: services.migrate.command must be ["node", "apps/server/dist/db/migrate-main.js"]: the migration runner.',
    ],
    [
      "the migrations as the app role",
      "postgres://nortfox_owner@postgres:5432/nortfox",
      "postgres://nortfox_app@postgres:5432/nortfox",
      "deploy/compose.yaml: services.migrate.environment.NORTFOX_DATABASE_URL must be postgres://nortfox_owner@postgres:5432/nortfox: " +
        "the migrations run as the owner role.",
    ],
    [
      "another password for the migrations",
      "      NORTFOX_DATABASE_PASSWORD_FILE: /run/secrets/owner-password\n",
      "      NORTFOX_DATABASE_PASSWORD_FILE: /run/secrets/app-password\n",
      "deploy/compose.yaml: services.migrate.environment.NORTFOX_DATABASE_PASSWORD_FILE must be /run/secrets/owner-password, the owner role's password.",
    ],
    [
      "a migrate step that restarts",
      '    restart: "no"\n',
      "    restart: on-failure\n",
      'deploy/compose.yaml: services.migrate.restart must be "no": the migrate step runs once.',
    ],
    [
      "a migrate step that does not wait for the setup",
      "        condition: service_healthy\n",
      "        condition: service_started\n",
      "deploy/compose.yaml: services.migrate.depends_on must be postgres with the condition service_healthy, " +
        "so the migrations run once PostgreSQL is set up.",
    ],
  ])("fails %s", (_case, from, to, problem) => {
    expect(composeProblems(changed(compose, from, to))).toEqual([problem]);
  });

  it("fails a compose file without its services", () => {
    expect(composeProblems("name: nortfox\n")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("services.postgres.command must be exactly"),
        expect.stringContaining("services.migrate.restart must be"),
      ]),
    );
  });

  it("fails a key given twice, at any level, but not the same key under two parents", () => {
    const twice = changed(compose, '    restart: "no"\n', '    restart: "no"\n    restart: always\n');
    const line = twice.split("\n").indexOf("    restart: always") + 1;
    expect(composeProblems(twice)).toEqual([
      `deploy/compose.yaml:${String(line)} gives the key restart a second time. The guard reads the first, and Compose the last.`,
    ]);
    const item = changed(compose, "        target: /etc/pgbackrest/conf.d/repo2.conf\n", "        target: /etc/pgbackrest/conf.d/repo2.conf\n        target: /tmp/x\n");
    expect(composeProblems(item)).toEqual([
      `deploy/compose.yaml:${String(item.split("\n").indexOf("        target: /tmp/x") + 1)} gives the key target a second time. The guard reads the first, and Compose the last.`,
    ]);
  });

  it.each([
    ["an anchor", "\n  postgres:\n", "\n  postgres: &db\n"],
    ["an alias", '    restart: "no"\n', '    restart: "no"\n    labels: *db\n'],
    ["a merge key", '    restart: "no"\n', '    restart: "no"\n    <<: {}\n'],
  ])("fails %s, which the guard cannot follow", (_case, from, to) => {
    const text = changed(compose, from, to);
    const line = text.split("\n").indexOf(to.split("\n").filter((part) => part !== "").at(-1) ?? "") + 1;
    expect(composeProblems(text)).toContain(
      `deploy/compose.yaml:${String(line)} uses a YAML anchor, alias or merge key. The guard reads the file line by line, so the file holds none.`,
    );
  });
});

describe("the backup test's compose file", () => {
  it("passes as it is", () => {
    expect(backupTestProblems(backupTest)).toEqual([]);
  });

  it("fails another project name, or none", () => {
    const problem =
      "deploy/backup-test/compose.yaml: name must be nortfox-backup-test, a project of its own, so the test never touches an install's containers or volumes.";
    expect(backupTestProblems(changed(backupTest, "name: nortfox-backup-test\n", "name: nortfox\n"))).toEqual([problem]);
    expect(backupTestProblems(changed(backupTest, "name: nortfox-backup-test\n", ""))).toEqual([problem]);
  });

  it.each([
    ["a command", "    volumes:\n", "    command: postgres -c archive_mode=off\n    volumes:\n", "services.postgres.command"],
    ["an environment", "    volumes:\n", "    environment:\n      PGBACKREST_REPO1_PATH: /tmp\n    volumes:\n", "services.postgres.environment"],
    ["another image", "    volumes:\n", "    image: postgres:18\n    volumes:\n", "services.postgres.image"],
    ["another service", "\nsecrets:\n", "  migrate:\n    restart: always\n\nsecrets:\n", "services.migrate"],
    ["a top-level key", "\nvolumes:\n", "\nnetworks:\n  default:\n\nvolumes:\n", "networks"],
    ["a secret from the environment", "  owner-password:\n", "  owner-password:\n    environment: OWNER\n", "secrets.owner-password.environment"],
  ])("fails %s", (_case, from, to, path) => {
    const text = changed(backupTest, from, to);
    const key = path.split(".").at(-1) ?? "";
    const line = text.split("\n").findIndex((found) => found.trimStart().startsWith(`${key}:`)) + 1;
    expect(backupTestProblems(text)).toEqual([
      `deploy/backup-test/compose.yaml:${String(line)} sets ${path}. On top of deploy/compose.yaml the test sets only its project name, ` +
        "its secrets' files and the off-site volume, so it runs the install's own settings.",
    ]);
  });

  it("fails another volume on the postgres service", () => {
    const text = changed(backupTest, "      - offsite:/var/lib/pgbackrest-offsite\n", "      - offsite:/var/lib/pgbackrest\n");
    expect(backupTestProblems(text)).toEqual([
      "deploy/backup-test/compose.yaml: services.postgres.volumes must be offsite at /var/lib/pgbackrest-offsite alone, the stand-in for the off-site repository.",
    ]);
  });
});

describe("pgbackrest.conf", () => {
  it("passes as it is, also with Windows line ends", () => {
    expect(pgbackrestProblems(conf)).toEqual([]);
    expect(pgbackrestProblems(conf.replaceAll("\n", "\r\n"))).toEqual([]);
  });

  const PG1 =
    "deploy/postgres/pgbackrest.conf must set pg1-path=/var/lib/postgresql/18/docker once, in [nortfox]: the data folder of the PostgreSQL 18 image.";
  const REPO1 = "deploy/postgres/pgbackrest.conf must set repo1-path=/var/lib/pgbackrest once, in [global]: the local repository, on its own volume.";
  const KEEP1 =
    "deploy/postgres/pgbackrest.conf must set repo1-retention-full=9999999 once, in [global]: the repository keeps every full backup, and removing one is the operator's step.";

  it.each([
    ["another data folder", "pg1-path=/var/lib/postgresql/18/docker", "pg1-path=/var/lib/postgresql/data", [PG1]],
    ["the data folder in [global]", "[nortfox]\npg1-path=/var/lib/postgresql/18/docker\n", "pg1-path=/var/lib/postgresql/18/docker\n[nortfox]\n", [PG1]],
    ["the local repository elsewhere", "repo1-path=/var/lib/pgbackrest\n", "repo1-path=/tmp/pgbackrest\n", [REPO1]],
    ["a shorter retention", "repo1-retention-full=9999999\n", "repo1-retention-full=2\n", [KEEP1]],
    ["the local repository twice", "pg1-path=/var/lib/postgresql/18/docker\n", "pg1-path=/var/lib/postgresql/18/docker\nrepo1-path=/var/lib/pgbackrest\n", [REPO1]],
  ])("fails %s", (_case, from, to, problems) => {
    expect(pgbackrestProblems(changed(conf, from, to))).toEqual(problems);
  });

  it("fails the off-site repository's retention lowered", () => {
    expect(pgbackrestProblems(changed(conf, "repo2-retention-full=9999999\n", "repo2-retention-full=7\n"))).toEqual([
      "deploy/postgres/pgbackrest.conf must set repo2-retention-full=9999999 once, in [global]: the repository keeps every full backup, and removing one is the operator's step.",
    ]);
  });

  it.each([
    ["repo2-type=posix", "repo2-type", "the off-site repository's type and path come from the compose file's required variables, so the stack does not start without them."],
    ["repo2-path=/var/lib/pgbackrest", "repo2-path", "the off-site repository's type and path come from the compose file's required variables, so the stack does not start without them."],
    ["repo1-type=s3", "repo1-type", "repo1 is the local repository, a folder on the backups volume."],
    ["archive-push-queue-max=1GB", "archive-push-queue-max", "it drops WAL when the queue is full, and a restore then cannot reach a point after it."],
  ])("fails %s", (line, option, why) => {
    expect(pgbackrestProblems(changed(conf, "start-fast=y\n", `start-fast=y\n${line}\n`))).toEqual([
      `deploy/postgres/pgbackrest.conf sets ${option}, which it must not: ${why}`,
    ]);
  });

  it("fails another section, an option before any section, a line it cannot read, and an option twice", () => {
    const lines = conf.split("\n");
    const at = (text: string, part: string): number => text.split("\n").indexOf(part) + 1;
    const section = changed(conf, "[nortfox]\n", "[nortfox:archive-push]\nprocess-max=4\n\n[nortfox]\n");
    expect(pgbackrestProblems(section)).toEqual([
      `deploy/postgres/pgbackrest.conf:${String(at(section, "[nortfox:archive-push]"))} opens the section [nortfox:archive-push]. ` +
        "The file holds [global] and [nortfox] alone, so no command's own section changes a setting.",
    ]);
    const before = `log-level-console=warn\n${conf}`;
    expect(pgbackrestProblems(before)).toEqual([
      "deploy/postgres/pgbackrest.conf:1 sets log-level-console before any section.",
    ]);
    const junk = changed(conf, "start-fast=y\n", "start-fast=y\nstart fast\n");
    expect(pgbackrestProblems(junk)).toEqual([
      `deploy/postgres/pgbackrest.conf:${String(at(junk, "start fast"))} is neither a [section] nor an option=value line.`,
    ]);
    const twice = changed(conf, "start-fast=y\n", "start-fast=y\nstart-fast=n\n");
    expect(pgbackrestProblems(twice)).toEqual([
      `deploy/postgres/pgbackrest.conf:${String(at(twice, "start-fast=n"))} sets start-fast a second time in [global].`,
    ]);
    expect(lines.length).toBeGreaterThan(10);
  });
});

describe("the PostgreSQL image", () => {
  it("passes as it is", () => {
    expect(postgresImageProblems(postgresImage)).toEqual([]);
  });

  const PIN = "deploy/postgres/Dockerfile must install pgbackrest with apt-get at a pinned version, as pgbackrest=<version>.";

  it.each([
    ["pgbackrest at whatever version", "pgbackrest=2.60.0-1.pgdg12+1", "pgbackrest"],
    ["pgbackrest at a wildcard", "pgbackrest=2.60.0-1.pgdg12+1", "pgbackrest=2.60*"],
    ["no pgbackrest", "pgbackrest=2.60.0-1.pgdg12+1", "barman"],
    ["a second, unpinned pgbackrest", "pgbackrest=2.60.0-1.pgdg12+1", "pgbackrest=2.60.0-1.pgdg12+1 pgbackrest"],
  ])("fails %s", (_case, from, to) => {
    expect(postgresImageProblems(changed(postgresImage, from, to))).toEqual([PIN]);
  });

  it("fails another base image", () => {
    const text = changed(postgresImage, "FROM postgres:18-bookworm@", "FROM timescale/timescaledb:18-bookworm@");
    expect(postgresImageProblems(text)).toEqual(["deploy/postgres/Dockerfile must build FROM the postgres image, and from nothing else."]);
  });

  it.each([
    [
      "COPY --chmod=0644 deploy/postgres/pgbackrest.conf /etc/pgbackrest/pgbackrest.conf",
      "pgBackRest's config, where pgBackRest reads it.",
    ],
    ["COPY --chmod=0644 db/roles.sql /usr/local/share/nortfox/roles.sql", "the cluster roles, which 10-roles.sh reads there."],
    [
      "COPY --chmod=0644 db/database.sql /usr/local/share/nortfox/database.sql",
      "what a superuser sets in the database nortfox, and in the cluster's other databases, which 10-roles.sh reads there.",
    ],
    [
      "COPY --chmod=0644 db/other-databases.sql /usr/local/share/nortfox/other-databases.sql",
      "what a superuser sets in the cluster's other databases, which 10-roles.sh reads there.",
    ],
    ["COPY --chmod=0755 deploy/postgres/initdb/ /docker-entrypoint-initdb.d/", "the first-start scripts, where the image's entrypoint runs them."],
  ])("fails without %s", (line, why) => {
    expect(postgresImageProblems(changed(postgresImage, `${line}\n`, ""))).toEqual([
      `deploy/postgres/Dockerfile must hold the line "${line}": ${why}`,
    ]);
  });
});

describe("the server image", () => {
  it("passes as it is", () => {
    expect(serverImageProblems(serverImage, packageJson)).toEqual([]);
  });

  it("fails another pnpm than package.json names, or none", () => {
    expect(serverImageProblems(changed(serverImage, "pnpm@12.16.1", "pnpm@11.0.0"), packageJson)).toEqual([
      "deploy/server/Dockerfile installs pnpm@11.0.0, but package.json names pnpm@12.16.1. The image builds with the pnpm that the repository uses.",
    ]);
    expect(serverImageProblems(changed(serverImage, "pnpm@12.16.1", "pnpm"), packageJson)).toEqual([
      "deploy/server/Dockerfile must install pnpm@12.16.1, the version that package.json names.",
    ]);
    expect(serverImageProblems(serverImage, "{}")).toEqual(["package.json names no pnpm version in packageManager."]);
  });

  it("fails an install off the lockfile, or one that runs install scripts", () => {
    const problem =
      "deploy/server/Dockerfile runs pnpm install without --frozen-lockfile and --ignore-scripts. Each install keeps to pnpm-lock.yaml and runs no install script.";
    const offTheLockfile = changed(serverImage, "RUN pnpm install --frozen-lockfile --ignore-scripts --prod", "RUN pnpm install --ignore-scripts --prod");
    expect(serverImageProblems(offTheLockfile, packageJson)).toEqual([problem]);
    const withScripts = changed(serverImage, '--ignore-scripts --filter-prod "@nortfox/server..." \\', '--filter-prod "@nortfox/server..." \\');
    expect(serverImageProblems(withScripts, packageJson)).toEqual([problem]);
  });

  it("fails an image without the migrations of its own commit", () => {
    expect(serverImageProblems(changed(serverImage, "COPY db/migrations db/migrations\n", ""), packageJson)).toEqual([
      'deploy/server/Dockerfile must hold the line "COPY db/migrations db/migrations": the migrate step applies the migrations of the same commit.',
    ]);
  });
});

describe("the images' build context", () => {
  it("passes as it is, also with Windows line ends", () => {
    expect(dockerignoreProblems(dockerignore)).toEqual([]);
    expect(dockerignoreProblems(dockerignore.replaceAll("\n", "\r\n"))).toEqual([]);
  });

  it.each([
    [".env at the root only", "**/.env\n", ".env\n", "**/.env", "an env file in any folder, such as deploy/.env, which the install's compose file reads."],
    [".env.* at the root only", "**/.env.*\n", ".env.*\n", "**/.env.*", "an env file in any folder, such as deploy/.env.local."],
    ["no deploy/secrets", "deploy/secrets\n", "", "deploy/secrets", "the install's secret files."],
  ])("fails %s", (_case, from, to, line, why) => {
    expect(dockerignoreProblems(changed(dockerignore, from, to))).toEqual([`.dockerignore must hold the line "${line}": ${why}`]);
  });

  it("fails a line that takes a file back in", () => {
    const text = `${dockerignore}!deploy/.env\n`;
    expect(dockerignoreProblems(text)).toEqual([
      `.dockerignore:${String(text.split("\n").indexOf("!deploy/.env") + 1)} takes files back into the build context with "!". The file only leaves files out.`,
    ]);
  });

  it("reports a .dockerignore that is missing", () => {
    expect(deployProblems((path) => (path === DOCKERIGNORE ? undefined : read(path)))).toEqual([".dockerignore is missing."]);
  });
});

describe("the first start's script for the backups", () => {
  const MARK = 'touch -- "$PGDATA/nortfox-first-start-done"';
  const UNMARK = 'rm -f -- "$PGDATA/nortfox-first-start-done"';
  const PENDING = "touch -- /var/lib/postgresql/nortfox-first-backups-pending";
  const DONE = "rm -f -- /var/lib/postgresql/nortfox-first-backups-pending";
  const MOUNTED = 'if ! mountpoint -q -- "${PGBACKREST_REPO2_PATH:-}"; then';
  const STANZA = "pgbackrest --stanza=nortfox stanza-create";
  const noPending =
    `${STANZA_SCRIPT} must write the mark that the first backups are still to come, once, before the mark of a finished first start: ${PENDING}. ` +
    "It is outside the data folder, so no backup holds it, and a first start killed during its first backups never becomes healthy.";
  const keepsPending = `${STANZA_SCRIPT} must remove the mark that the first backups are still to come, once, only after both backups: ${DONE}.`;
  const noMountCheck =
    `${STANZA_SCRIPT} must refuse an off-site repository of type posix or cifs whose path is no mount of its own, before it makes the stanza: ` +
    `posix | cifs) and ${MOUNTED} Its backups would otherwise stay in the container, on the same disk as the data.`;
  const backupOf = (repo: number): string => `pgbackrest --stanza=nortfox --repo=${String(repo)} --type=full backup`;
  const noBackup = (repo: number): string =>
    `${STANZA_SCRIPT} must take a full backup to repo${String(repo)} after it writes the mark of a finished first start: ${backupOf(repo)}. ` +
    "The WAL archive is of use only with a full backup to replay it onto, and the backup then holds the mark.";
  const noMark = `${STANZA_SCRIPT} must write the mark of a finished first start, once, before the first full backups: ${MARK}.`;
  const keepsMark = `${STANZA_SCRIPT} must remove the mark again, after the backups, when one of them fails: ${UNMARK}. A failed first start never becomes healthy.`;

  it("passes as it is, also with Windows line ends", () => {
    expect(stanzaScriptProblems(stanzaScript)).toEqual([]);
    expect(stanzaScriptProblems(stanzaScript.replaceAll("\n", "\r\n"))).toEqual([]);
  });

  it.each([1, 2])("fails a script that takes no full backup to repo%i", (repo) => {
    expect(stanzaScriptProblems(changed(stanzaScript, backupOf(repo), "true"))).toEqual([noBackup(repo)]);
    // A backup named only in a comment is none.
    const line = stanzaScript.split("\n").find((found) => found.includes(backupOf(repo))) ?? "";
    expect(stanzaScriptProblems(changed(stanzaScript, line, `# ${line}`))).toContain(noBackup(repo));
  });

  it("fails a script that takes the backups before it writes the mark, so that a restore would not bring the mark back", () => {
    expect(stanzaScriptProblems(`${changed(stanzaScript, `${MARK}\n`, "")}${MARK}\n`)).toEqual([noBackup(1), noBackup(2), keepsMark, keepsPending]);
  });

  it("fails a script that writes no mark, or keeps it when a backup fails", () => {
    expect(stanzaScriptProblems(changed(stanzaScript, `${MARK}\n`, ""))).toContain(noMark);
    expect(stanzaScriptProblems(changed(stanzaScript, UNMARK, "true"))).toEqual([keepsMark]);
  });

  it("fails a script that does not mark the first backups as still to come before the mark of a finished first start", () => {
    expect(stanzaScriptProblems(changed(stanzaScript, `${PENDING}\n`, ""))).toEqual([noPending]);
    expect(stanzaScriptProblems(changed(changed(stanzaScript, `${PENDING}\n`, ""), `${MARK}\n`, `${MARK}\n${PENDING}\n`))).toEqual([noPending]);
  });

  it("fails a script that removes the mark of the first backups before both are taken, or never", () => {
    expect(stanzaScriptProblems(changed(stanzaScript, DONE, "true"))).toEqual([keepsPending]);
    // Removed before the backups, as if they had been taken.
    const moved = changed(changed(stanzaScript, `${DONE}\n`, ""), `${MARK}\n`, `${MARK}\n${DONE}\n`);
    expect(stanzaScriptProblems(moved)).toEqual([keepsPending]);
  });

  it("fails a script that makes the stanza in an off-site folder that is no mount", () => {
    expect(stanzaScriptProblems(changed(stanzaScript, MOUNTED, "if false; then"))).toEqual([noMountCheck]);
    expect(stanzaScriptProblems(changed(stanzaScript, "  posix | cifs)", "  s3)"))).toEqual([noMountCheck]);
    // The check after the stanza is made: the stanza is then in the container already.
    const late = changed(changed(stanzaScript, `${STANZA}\n`, ""), "case ", `${STANZA}\ncase `);
    expect(stanzaScriptProblems(late)).toEqual([noMountCheck]);
  });

  it("reports a script that is missing", () => {
    expect(deployProblems((path) => (path === STANZA_SCRIPT ? undefined : read(path)))).toEqual([`${STANZA_SCRIPT} is missing.`]);
  });
});
