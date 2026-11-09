// SPDX-License-Identifier: AGPL-3.0-only

// The Node types guard: @types/node keeps the major of the Node that runs the
// code, and a copy of the files with the types or the runtime on another
// major fails.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVER_IMAGE } from "./deploy.ts";
import { LOCKFILE, MANIFEST, NVMRC, WORKSPACE, catalogVersion, nodeTypesProblems } from "./node-types.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DIGEST = "5c4783a8cc3f0074912164f94dfa1be4e043438f0f707cf968d7af9a0d31a2c8";
const WHY = "The Node types keep the runtime's major, so the type check knows the APIs that the runtime has and no others.";

function read(path: string): string | undefined {
  try {
    return readFileSync(`${ROOT}/${path}`, "utf8");
  } catch {
    return undefined;
  }
}

const WORKSPACE_TEXT = [
  "# SPDX-License-Identifier: AGPL-3.0-only",
  "",
  "packages:",
  "  - apps/*",
  "",
  "catalog:",
  '  "@types/pg": 8.23.1',
  "# a comment at the start of a line does not end the catalog",
  '  "@types/node": 24.19.2 # the runtime\'s major',
  "  vitest: 5.0.5",
  "",
  "catalogs:",
  "  ts-api:",
  "    typescript: npm:@typescript/typescript6@6.0.2",
  "",
].join("\n");

const LOCKFILE_TEXT = [
  "lockfileVersion: '9.0'",
  "",
  "importers:",
  "",
  "  .:",
  "    devDependencies:",
  "      '@types/node':",
  "        specifier: 'catalog:'",
  "        version: 24.19.2",
  "      vite:",
  "        specifier: 'catalog:'",
  "        version: 8.3.5(@types/node@24.19.2)",
  "",
  "packages:",
  "",
  "  '@types/node@24.19.2':",
  "    engines: {node: '>=18'}",
  "",
].join("\n");

const SERVER_IMAGE_TEXT = [
  "# SPDX-License-Identifier: AGPL-3.0-only",
  `FROM node:24-bookworm-slim@sha256:${DIGEST} AS source`,
  "FROM source AS build",
  `FROM node:24-bookworm-slim@sha256:${DIGEST}`,
  'CMD ["node", "apps/server/dist/main.js"]',
  "",
].join("\n");

const GOOD: Readonly<Record<string, string>> = {
  [WORKSPACE]: WORKSPACE_TEXT,
  [NVMRC]: "24\n",
  [MANIFEST]: JSON.stringify({ name: "nortfox", engines: { node: ">=24.7 <25" } }, null, 2),
  [SERVER_IMAGE]: SERVER_IMAGE_TEXT,
  [LOCKFILE]: LOCKFILE_TEXT,
};

/** The text with one part replaced; the part must be there. */
function changed(text: string, from: string | RegExp, to: string): string {
  const result = text.replace(from, to);
  expect(result).not.toBe(text);
  return result;
}

/** The guard's problems with some files changed and the others as GOOD has them. */
function problemsWith(changes: Readonly<Record<string, string | undefined>>): string[] {
  const files: Record<string, string | undefined> = { ...GOOD, ...changes };
  return nodeTypesProblems((path) => files[path]);
}

/** The catalog and the lockfile with another version of @types/node, as a Dependabot update writes them. */
function typesAt(version: string): Record<string, string> {
  return {
    [WORKSPACE]: changed(WORKSPACE_TEXT, '"@types/node": 24.19.2', `"@types/node": ${version}`),
    [LOCKFILE]: LOCKFILE_TEXT.replaceAll("@types/node@24.19.2", `@types/node@${version}`).replace("version: 24.19.2", `version: ${version}`),
  };
}

function engines(range: unknown): string {
  return JSON.stringify({ name: "nortfox", engines: range === undefined ? {} : { node: range } });
}

describe("the repository", () => {
  it("keeps @types/node on the major of .nvmrc, the engines range and the server image", () => {
    expect(nodeTypesProblems(read)).toEqual([]);
    expect(catalogVersion(read(WORKSPACE) ?? "", "@types/node")).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("fails main's files with the catalog's @types/node on another major", () => {
    const workspace = changed(read(WORKSPACE) ?? "", /("@types\/node":\s*)\d+/, "$199");
    const problems = nodeTypesProblems((path) => (path === WORKSPACE ? workspace : read(path)));
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^pnpm-workspace\.yaml gives @types\/node 99\.\d+\.\d+, the types of Node 99, but \.nvmrc names Node \d+\./),
        expect.stringMatching(/, but the engines range in package\.json, "[^"]+", allows Node \d+\./),
        expect.stringMatching(/, but deploy\/server\/Dockerfile:\d+ runs node:\d+[^,]*, Node \d+\./),
      ]),
    );
  });
});

describe("the Node types guard", () => {
  it("passes the Node types of the runtime's major, at any minor and patch", () => {
    expect(problemsWith({})).toEqual([]);
    expect(problemsWith(typesAt("24.0.0"))).toEqual([]);
    expect(problemsWith({ [NVMRC]: "v24.7.0\n" })).toEqual([]);
    expect(problemsWith({ [MANIFEST]: engines(">= 24.7.0 < 25.0.0") })).toEqual([]);
  });

  it("fails a catalog major above the runtime's: the update that Dependabot proposed", () => {
    expect(problemsWith(typesAt("26.6.6"))).toEqual([
      `pnpm-workspace.yaml gives @types/node 26.6.6, the types of Node 26, but .nvmrc names Node 24. ${WHY}`,
      `pnpm-workspace.yaml gives @types/node 26.6.6, the types of Node 26, but the engines range in package.json, ">=24.7 <25", allows Node 24. ${WHY}`,
      `pnpm-workspace.yaml gives @types/node 26.6.6, the types of Node 26, but deploy/server/Dockerfile:2 runs node:24-bookworm-slim, Node 24. ${WHY}`,
    ]);
  });

  it("fails a catalog major below the runtime's", () => {
    expect(problemsWith(typesAt("22.19.0"))).toEqual([
      `pnpm-workspace.yaml gives @types/node 22.19.0, the types of Node 22, but .nvmrc names Node 24. ${WHY}`,
      `pnpm-workspace.yaml gives @types/node 22.19.0, the types of Node 22, but the engines range in package.json, ">=24.7 <25", allows Node 24. ${WHY}`,
      `pnpm-workspace.yaml gives @types/node 22.19.0, the types of Node 22, but deploy/server/Dockerfile:2 runs node:24-bookworm-slim, Node 24. ${WHY}`,
    ]);
  });

  it.each(["26", "26.1.0", "v26.1.0"])("fails an .nvmrc that names another major: %s", (nvmrc) => {
    expect(problemsWith({ [NVMRC]: `${nvmrc}\n` })).toEqual([
      `pnpm-workspace.yaml gives @types/node 24.19.2, the types of Node 24, but .nvmrc names Node 26. ${WHY}`,
    ]);
  });

  it.each([">=26.0 <27", ">=22.12 <23"])("fails an engines range of another major: %s", (range) => {
    const major = /\d+/.exec(range)?.[0] ?? "";
    expect(problemsWith({ [MANIFEST]: engines(range) })).toEqual([
      `pnpm-workspace.yaml gives @types/node 24.19.2, the types of Node 24, but the engines range in package.json, "${range}", allows Node ${major}. ${WHY}`,
    ]);
  });

  it("fails a server image on another major, in any stage that runs node", () => {
    const image = changed(SERVER_IMAGE_TEXT, `FROM node:24-bookworm-slim@sha256:${DIGEST}\n`, `FROM docker.io/library/node:26.1-bookworm-slim@sha256:${DIGEST}\n`);
    expect(problemsWith({ [SERVER_IMAGE]: image })).toEqual([
      `pnpm-workspace.yaml gives @types/node 24.19.2, the types of Node 24, but deploy/server/Dockerfile:4 runs docker.io/library/node:26.1-bookworm-slim, Node 26. ${WHY}`,
    ]);
  });

  it("fails a lockfile that installs @types/node of another major beside the catalog's", () => {
    const lockfile = changed(LOCKFILE_TEXT, "  '@types/node@24.19.2':\n", "  '@types/node@26.6.6':\n    engines: {node: '>=18'}\n\n  '@types/node@24.19.2':\n");
    expect(problemsWith({ [LOCKFILE]: lockfile })).toEqual([
      "pnpm-lock.yaml installs @types/node 26.6.6, the types of Node 26, but pnpm-workspace.yaml gives 24.19.2. " +
        "Every @types/node in the install comes from the catalog: no package pins it, overrides it or takes it from a named catalog.",
    ]);
  });

  it("fails a catalog that does not give @types/node, or gives it no exact version", () => {
    const none = "Every package takes @types/node from the catalog in pnpm-workspace.yaml, so it names one version.";
    expect(problemsWith({ [WORKSPACE]: changed(WORKSPACE_TEXT, /^ {2}"@types\/node".*\n/m, "") })).toEqual([
      `pnpm-workspace.yaml gives no @types/node in its catalog. ${none}`,
    ]);
    const onlyNamed = changed(WORKSPACE_TEXT, /^ {2}"@types\/node".*\n/m, "").concat('    "@types/node": 24.19.2\n');
    expect(problemsWith({ [WORKSPACE]: onlyNamed })).toEqual([`pnpm-workspace.yaml gives no @types/node in its catalog. ${none}`]);
    expect(problemsWith({ [WORKSPACE]: "packages:\n  - apps/*\n" })).toEqual([`pnpm-workspace.yaml gives no @types/node in its catalog. ${none}`]);
    expect(problemsWith({ [WORKSPACE]: "catalog:\n  vitest: 5.0.5\n" })).toEqual([`pnpm-workspace.yaml gives no @types/node in its catalog. ${none}`]);
    expect(problemsWith({ [WORKSPACE]: changed(WORKSPACE_TEXT, '"@types/node": 24.19.2', "'@types/node': \"^24.19.2\"") })).toEqual([
      "pnpm-workspace.yaml gives @types/node ^24.19.2. Give it an exact version, as 24.19.2, so its major is the one that installs.",
    ]);
  });

  it.each(["lts/*", "node", "24.x", ""])("fails an .nvmrc whose major it cannot read: %j", (nvmrc) => {
    expect(problemsWith({ [NVMRC]: nvmrc })).toEqual([
      `.nvmrc names "${nvmrc}". It names one Node version, as 24 or 24.7.0, so the guard can read its major.`,
    ]);
  });

  it.each([">=24.7", ">=24.7 <26", ">=24.7 <25.1", "^24.7.0", "24.x", ">=24.7 <25 || >=26"])(
    "fails an engines range that allows more than one major, or that it cannot read: %s",
    (range) => {
      expect(problemsWith({ [MANIFEST]: engines(range) })).toEqual([
        `The engines range in package.json is ${JSON.stringify(range)}. Write it as ">=24.7 <25": one Node major, from its lowest version.`,
      ]);
    },
  );

  it("fails a package.json with no engines range for node", () => {
    expect(problemsWith({ [MANIFEST]: engines(undefined) })).toEqual([
      'The engines range in package.json is missing. Write it as ">=24.7 <25": one Node major, from its lowest version.',
    ]);
    expect(problemsWith({ [MANIFEST]: engines(24) })).toEqual([
      'The engines range in package.json is missing. Write it as ">=24.7 <25": one Node major, from its lowest version.',
    ]);
    expect(problemsWith({ [MANIFEST]: "[]" })).toEqual([
      'The engines range in package.json is missing. Write it as ">=24.7 <25": one Node major, from its lowest version.',
    ]);
  });

  it("fails a server image that runs no node image, or one without its major in the tag", () => {
    expect(problemsWith({ [SERVER_IMAGE]: `FROM debian:bookworm-slim@sha256:${DIGEST}\n` })).toEqual([
      "deploy/server/Dockerfile runs no node image, so the guard cannot read the server's Node major.",
    ]);
    const lts = changed(SERVER_IMAGE_TEXT, `FROM node:24-bookworm-slim@sha256:${DIGEST} AS source`, `FROM node:lts-bookworm-slim@sha256:${DIGEST} AS source`);
    expect(problemsWith({ [SERVER_IMAGE]: lts })).toEqual([
      "deploy/server/Dockerfile:2 runs node:lts-bookworm-slim, which names no Node major. Name it in the tag, as node:24-bookworm-slim.",
    ]);
    const untagged = changed(SERVER_IMAGE_TEXT, `FROM node:24-bookworm-slim@sha256:${DIGEST}\n`, `FROM node@sha256:${DIGEST}\n`);
    expect(problemsWith({ [SERVER_IMAGE]: untagged })).toEqual([
      "deploy/server/Dockerfile:4 runs node, which names no Node major. Name it in the tag, as node:24-bookworm-slim.",
    ]);
  });

  it("fails a lockfile that installs no @types/node", () => {
    expect(problemsWith({ [LOCKFILE]: "lockfileVersion: '9.0'\n" })).toEqual(["pnpm-lock.yaml installs no @types/node."]);
  });

  it.each([WORKSPACE, NVMRC, MANIFEST, SERVER_IMAGE, LOCKFILE])("fails when %s is missing", (path) => {
    expect(problemsWith({ [path]: undefined })).toEqual([`${path} is missing.`]);
  });
});
