// SPDX-License-Identifier: AGPL-3.0-only

// A package's type check reads the source of the packages it depends on, so
// turbo must count them in its cache key. Otherwise a type error in
// packages/client replays an old success for apps/web.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const PACKAGES = ["apps/server", "apps/web", "packages/client", "packages/engine"];

interface Manifest {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
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

describe("turbo's type check", () => {
  it("waits for, and is keyed on, the type check of every workspace package it depends on", () => {
    const result = spawnSync(process.execPath, ["scripts/turbo.ts", "run", "typecheck", "--dry=json"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout) as { tasks: { taskId: string; dependencies: string[] }[] };
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
