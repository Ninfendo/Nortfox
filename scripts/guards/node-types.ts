// SPDX-License-Identifier: AGPL-3.0-only

// Keeps the Node types on the runtime's major
// (docs/decisions/0001-typescript-7-node-24-pnpm-turborepo.md). Node 24 is the
// only runtime: .nvmrc names it for CI and a contributor, the engines range in
// package.json for pnpm, and the server image's node base image for an
// install. The type check reads @types/node, which every package takes from
// the catalog in pnpm-workspace.yaml. With the types of a later major, code
// that calls an API only that major has passes the type check and fails on
// the server. With those of an earlier major, the type check misses the
// runtime's own APIs. So the catalog's @types/node, and every @types/node in
// pnpm-lock.yaml, keeps the major of each of the three.

import { SERVER_IMAGE } from "./deploy.ts";
import { imagesIn, yamlValue } from "./images.ts";

export const WORKSPACE = "pnpm-workspace.yaml";
export const NVMRC = ".nvmrc";
export const MANIFEST = "package.json";
export const LOCKFILE = "pnpm-lock.yaml";

const TYPES = "@types/node";
const WHY = "The Node types keep the runtime's major, so the type check knows the APIs that the runtime has and no others.";

/** A place that names the runtime's major, in words for a message. */
interface Runtime {
  readonly place: string;
  readonly major: number;
}

/** The key of a line in a YAML block, bare or quoted, up to its colon. */
const KEY = /^\s+(?:"([^"]*)"|'([^']*)'|([^\s"'#][^\s:]*))\s*:/;

/** The version that the catalog in pnpm-workspace.yaml gives a package; undefined when it gives none. */
export function catalogVersion(workspace: string, name: string): string | undefined {
  const lines = workspace.split(/\r?\n/);
  const start = lines.findIndex((line) => /^catalog:\s*(?:#.*)?$/.test(line));
  if (start < 0) {
    return undefined;
  }
  for (const line of lines.slice(start + 1)) {
    if (/^[^\s#]/.test(line)) {
      return undefined;
    }
    const key = KEY.exec(line);
    if (key !== null && (key[1] ?? key[2] ?? key[3]) === name) {
      return yamlValue(line.slice(key[0].length));
    }
  }
  return undefined;
}

/** The major of .nvmrc, or a problem. */
function nvmrcRuntime(text: string): Runtime | string {
  const version = text.trim();
  if (!/^v?\d+(?:\.\d+){0,2}$/.test(version)) {
    return `${NVMRC} names "${version}". It names one Node version, as 24 or 24.7.0, so the guard can read its major.`;
  }
  const major = parseInt(version.replace(/^v/, ""), 10);
  return { place: `${NVMRC} names Node ${String(major)}`, major };
}

/** The one major that the engines range in package.json allows, or a problem. */
function enginesRuntime(text: string): Runtime | string {
  const manifest: unknown = JSON.parse(text);
  const engines = typeof manifest === "object" && manifest !== null && "engines" in manifest ? manifest.engines : undefined;
  const range = typeof engines === "object" && engines !== null && "node" in engines ? engines.node : undefined;
  const write = 'Write it as ">=24.7 <25": one Node major, from its lowest version.';
  if (typeof range !== "string") {
    return `The engines range in ${MANIFEST} is missing. ${write}`;
  }
  const bounds = /^>=\s*v?(\d+)(?:\.\d+){0,2}\s+<\s*v?(\d+)(?:\.0){0,2}$/.exec(range.trim());
  if (bounds === null || Number(bounds[2]) !== Number(bounds[1]) + 1) {
    return `The engines range in ${MANIFEST} is ${JSON.stringify(range)}. ${write}`;
  }
  const major = Number(bounds[1]);
  return { place: `the engines range in ${MANIFEST}, ${JSON.stringify(range)}, allows Node ${String(major)}`, major };
}

/** The majors of the node images that the server image runs, the first place of each, or problems. */
function serverImageRuntimes(text: string): (Runtime | string)[] {
  const found: (Runtime | string)[] = [];
  const majors = new Set<number>();
  for (const use of imagesIn(SERVER_IMAGE, text)) {
    const reference = use.image.replace(/@.*$/, "");
    const colon = reference.indexOf(":", reference.lastIndexOf("/") + 1);
    const name = colon < 0 ? reference : reference.slice(0, colon);
    if (!/(?:^|\/)node$/.test(name)) {
      continue;
    }
    const tag = colon < 0 ? "" : reference.slice(colon + 1);
    const where = `${SERVER_IMAGE}:${String(use.line)}`;
    if (!/^\d+(?:[.-]|$)/.test(tag)) {
      found.push(`${where} runs ${reference}, which names no Node major. Name it in the tag, as node:24-bookworm-slim.`);
      continue;
    }
    const major = parseInt(tag, 10);
    if (!majors.has(major)) {
      majors.add(major);
      found.push({ place: `${where} runs ${reference}, Node ${String(major)}`, major });
    }
  }
  return found.length > 0 ? found : [`${SERVER_IMAGE} runs no node image, so the guard cannot read the server's Node major.`];
}

/** The catalog's @types/node with its major, or a problem. */
function catalogTypes(workspace: string): { readonly version: string; readonly major: number } | string {
  const version = catalogVersion(workspace, TYPES);
  if (version === undefined) {
    return `${WORKSPACE} gives no ${TYPES} in its catalog. Every package takes ${TYPES} from the catalog in ${WORKSPACE}, so it names one version.`;
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return `${WORKSPACE} gives ${TYPES} ${version}. Give it an exact version, as 24.19.2, so its major is the one that installs.`;
  }
  return { version, major: parseInt(version, 10) };
}

/**
 * Each version of @types/node that the lockfile installs, with its major: in
 * its packages and snapshots, and in the peers of a package that depends on it.
 */
function lockfileTypes(lockfile: string): Map<string, number> {
  const prefix = `${TYPES}@`;
  const versions = [...lockfile.matchAll(/@types\/node@\d+\.\d+\.\d+/g)].map((match) => match[0].slice(prefix.length));
  return new Map(versions.map((version) => [version, parseInt(version, 10)]));
}

/** What is wrong with the Node types; empty when nothing is. */
export function nodeTypesProblems(read: (path: string) => string | undefined): string[] {
  const paths = [WORKSPACE, NVMRC, MANIFEST, SERVER_IMAGE, LOCKFILE];
  const [workspace, nvmrc, manifest, serverImage, lockfile] = paths.map((path) => read(path));
  if (workspace === undefined || nvmrc === undefined || manifest === undefined || serverImage === undefined || lockfile === undefined) {
    return paths.filter((path) => read(path) === undefined).map((path) => `${path} is missing.`);
  }
  const found = [nvmrcRuntime(nvmrc), enginesRuntime(manifest), ...serverImageRuntimes(serverImage)];
  const problems = found.filter((item) => typeof item === "string");
  const runtimes = found.filter((item) => typeof item !== "string");

  const types = catalogTypes(workspace);
  const installed = lockfileTypes(lockfile);
  if (typeof types === "string") {
    problems.push(types);
  } else {
    for (const runtime of runtimes.filter((place) => place.major !== types.major)) {
      problems.push(`${WORKSPACE} gives ${TYPES} ${types.version}, the types of Node ${String(types.major)}, but ${runtime.place}. ${WHY}`);
    }
    for (const [version, major] of [...installed].filter(([, other]) => other !== types.major)) {
      problems.push(
        `${LOCKFILE} installs ${TYPES} ${version}, the types of Node ${String(major)}, but ${WORKSPACE} gives ${types.version}. ` +
          `Every ${TYPES} in the install comes from the catalog: no package pins it, overrides it or takes it from a named catalog.`,
      );
    }
  }
  if (installed.size === 0) {
    problems.push(`${LOCKFILE} installs no ${TYPES}.`);
  }
  return problems;
}
