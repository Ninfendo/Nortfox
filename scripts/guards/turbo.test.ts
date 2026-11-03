// SPDX-License-Identifier: AGPL-3.0-only

// turbo replays a task from its cache when the task's key is unchanged, so the
// key must hold everything the task reads. Two guards:
//
// - A package's type check reads the source of the packages it depends on, so
//   turbo must count them in its cache key. Otherwise a type error in
//   packages/client replays an old success for apps/web.
// - A package's tsconfig extends tsconfig.base.json at the root, so every
//   task must be keyed on that file. Otherwise a change to it replays an old
//   type check and an old build, and pnpm check passes where CI fails.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const PACKAGES = ["apps/server", "apps/web", "packages/client", "packages/contract", "packages/engine"];

/**
 * Root files every task depends on that no tsconfig names: CI runs every task
 * on the Node version in .nvmrc.
 */
const ALWAYS_KEYED = [".nvmrc"];

interface Manifest {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

interface Task {
  readonly taskId: string;
  readonly directory: string;
  readonly dependencies: string[];
}

interface Plan {
  readonly globalCacheInputs: { readonly files: Record<string, string> };
  readonly tasks: Task[];
}

function manifest(folder: string): Manifest {
  return JSON.parse(readFileSync(`${root}/${folder}/package.json`, "utf8")) as Manifest;
}

/** The workspace packages a package depends on. */
function workspaceDependencies(found: Manifest): string[] {
  return Object.entries({ ...found.dependencies, ...found.devDependencies })
    .filter(([, version]) => version.startsWith("workspace:"))
    .map(([name]) => name);
}

/** turbo's plan for the tasks, without running them. */
function dryRun(tasks: readonly string[]): Plan {
  const result = spawnSync(process.execPath, ["scripts/turbo.ts", "run", ...tasks, "--dry=json"], {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Plan;
}

/** JSON with comments, as in a tsconfig file. A string that holds "//" stays whole. */
function parseJsonc(text: string): unknown {
  return JSON.parse(
    text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_comment, string: string | undefined) => string ?? ""),
  );
}

/** A file's text, or undefined when it does not exist. */
type ReadFile = (path: string) => string | undefined;

function readFromRoot(path: string): string | undefined {
  try {
    return readFileSync(`${root}/${path}`, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The files a tsconfig reads through "extends", one level after another, as
 * paths from the repository root. An "extends" that names a package is left
 * out: the lockfile is already in the key.
 */
function extendedFiles(config: string, read: ReadFile): string[] {
  const found: string[] = [];
  const visit = (path: string): void => {
    const text = read(path);
    if (text === undefined) {
      throw new Error(`${path} cannot be read. Write the "extends" path in full, with .json.`);
    }
    const parsed = parseJsonc(text) as { extends?: unknown };
    const targets: unknown[] = Array.isArray(parsed.extends) ? parsed.extends : [parsed.extends];
    for (const target of targets) {
      if (typeof target !== "string" || !target.startsWith(".")) {
        continue;
      }
      const next = posix.join(posix.dirname(path), target);
      if (!found.includes(next)) {
        found.push(next);
        visit(next);
      }
    }
  };
  visit(config);
  return found;
}

/** The files outside a package that its tsconfig files read, as paths from the repository root. */
function filesOutside(folder: string, configs: readonly string[], read: ReadFile): string[] {
  const outside = new Set<string>();
  for (const config of configs) {
    for (const file of extendedFiles(posix.join(folder, config), read)) {
      if (!file.startsWith(`${folder}/`)) {
        outside.add(file);
      }
    }
  }
  return [...outside].sort();
}

/** The tsconfig files in a package folder. */
function tsconfigsIn(folder: string): string[] {
  return readdirSync(`${root}/${folder}`).filter((name) => /^tsconfig.*\.json$/.test(name));
}

/** The files each task must be keyed on but is not, as "task: file". */
function missingFromKey(plan: Plan, required: (folder: string) => readonly string[]): string[] {
  const keyed = new Set(Object.keys(plan.globalCacheInputs.files));
  const missing: string[] = [];
  for (const task of plan.tasks) {
    const folder = task.directory.replaceAll("\\", "/");
    for (const file of required(folder)) {
      if (!keyed.has(file)) {
        missing.push(`${task.taskId}: ${file}`);
      }
    }
  }
  return missing;
}

describe("turbo's type check", () => {
  it("waits for, and is keyed on, the type check of every workspace package it depends on", () => {
    const plan = dryRun(["typecheck"]);
    const dependencies = new Map(plan.tasks.map((task) => [task.taskId, task.dependencies]));
    let checked = 0;
    for (const folder of PACKAGES) {
      const found = manifest(folder);
      for (const dependency of workspaceDependencies(found)) {
        expect(dependencies.get(`${found.name}#typecheck`)).toContain(`${dependency}#typecheck`);
        checked += 1;
      }
    }
    // apps/web uses the client, so at least that edge is checked.
    expect(checked).toBeGreaterThan(0);
  });
});

describe("turbo's cache key", () => {
  const turbo = parseJsonc(readFileSync(`${root}/turbo.json`, "utf8")) as { tasks: Record<string, unknown> };
  let cached: Plan | undefined;
  /** The plan for every task in turbo.json, taken once. */
  const everyTask = (): Plan => (cached ??= dryRun(Object.keys(turbo.tasks)));
  const rootFilesOf = (folder: string): string[] => [
    ...ALWAYS_KEYED,
    ...filesOutside(folder, tsconfigsIn(folder), readFromRoot),
  ];

  it("holds, for every task, each root file the task's package reads", () => {
    const plan = everyTask();
    expect(plan.tasks.length).toBeGreaterThan(0);
    for (const task of plan.tasks) {
      // Every package tsconfig extends the base.
      expect(rootFilesOf(task.directory.replaceAll("\\", "/"))).toContain("tsconfig.base.json");
    }
    expect(missingFromKey(plan, rootFilesOf)).toEqual([]);
  });

  it("fails the real plan once the root files are out of the key", () => {
    const plan = everyTask();
    const missing = missingFromKey({ ...plan, globalCacheInputs: { files: {} } }, rootFilesOf);
    for (const task of plan.tasks) {
      expect(missing).toContain(`${task.taskId}: tsconfig.base.json`);
      expect(missing).toContain(`${task.taskId}: .nvmrc`);
    }
  });

  it("finds each file a tsconfig extends, and fails a key that leaves one out", () => {
    const files = new Map([
      [
        "apps/zorbex/tsconfig.json",
        '{\n  // The app.\n  "$schema": "https://json.schemastore.org/tsconfig",\n  "extends": "../../tsconfig.base.json"\n}',
      ],
      ["apps/zorbex/tsconfig.build.json", '{ "extends": ["./tsconfig.json", "@kilvant/tsconfig"] }'],
      ["tsconfig.base.json", '/* The base. */ { "extends": "./tsconfig.kilvant.json" }'],
      ["tsconfig.kilvant.json", '{ "extends": "./tsconfig.base.json" }'],
    ]);
    const read: ReadFile = (path) => files.get(path);
    const required = (folder: string): string[] => filesOutside(folder, ["tsconfig.json", "tsconfig.build.json"], read);

    expect(required("apps/zorbex")).toEqual(["tsconfig.base.json", "tsconfig.kilvant.json"]);

    const plan = (keyed: string[]): Plan => ({
      globalCacheInputs: { files: Object.fromEntries(keyed.map((file) => [file, "0"])) },
      tasks: [{ taskId: "@nortfox/zorbex#build", directory: "apps\\zorbex", dependencies: [] }],
    });
    expect(missingFromKey(plan(["tsconfig.base.json", "tsconfig.kilvant.json"]), required)).toEqual([]);
    expect(missingFromKey(plan([".gitattributes", "tsconfig.base.json"]), required)).toEqual([
      "@nortfox/zorbex#build: tsconfig.kilvant.json",
    ]);
    expect(missingFromKey(plan([".gitattributes"]), required)).toEqual([
      "@nortfox/zorbex#build: tsconfig.base.json",
      "@nortfox/zorbex#build: tsconfig.kilvant.json",
    ]);
  });

  it("fails when a tsconfig extends a file that is not there", () => {
    const read: ReadFile = (path) =>
      path === "apps/zorbex/tsconfig.json" ? '{ "extends": "../../tsconfig.base" }' : undefined;
    expect(() => filesOutside("apps/zorbex", ["tsconfig.json"], read)).toThrow(
      'tsconfig.base cannot be read. Write the "extends" path in full, with .json.',
    );
  });
});
