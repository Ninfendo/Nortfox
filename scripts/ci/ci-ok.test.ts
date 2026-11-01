// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "./ci-ok.ts";

function run(needs: string | undefined): { code: number; lines: string[] } {
  const lines: string[] = [];
  const code = main(needs === undefined ? {} : { NEEDS: needs }, (line) => lines.push(line));
  return { code, lines };
}

describe("the CI OK job", () => {
  it("passes when every job succeeded", () => {
    expect(run('{"build":{"result":"success","outputs":{}},"workflows":{"result":"success"}}')).toEqual({
      code: 0,
      lines: ["build: success", "workflows: success", "CI OK: Every CI job passed."],
    });
  });

  it.each(["failure", "cancelled", "skipped"])("fails when a job ended in %s", (result) => {
    const outcome = run(JSON.stringify({ build: { result: "success" }, workflows: { result } }));
    expect(outcome.code).toBe(1);
    expect(outcome.lines.at(-1)).toBe("CI OK: 1 CI job(s) did not succeed.");
  });

  it.each([[undefined], [""], ["not json"], ["{}"], ["[]"]])("fails on NEEDS=%j", (needs) => {
    expect(run(needs).code).toBe(1);
  });

  it("works as the workflow runs it", () => {
    const script = fileURLToPath(new URL("./ci-ok.ts", import.meta.url));
    const pass = spawnSync(process.execPath, [script], {
      env: { ...process.env, NEEDS: '{"build":{"result":"success"}}' },
      encoding: "utf8",
    });
    expect(pass.status).toBe(0);
    const fail = spawnSync(process.execPath, [script], {
      env: { ...process.env, NEEDS: '{"build":{"result":"skipped"}}' },
      encoding: "utf8",
    });
    expect(fail.status).toBe(1);
    expect(fail.stdout).toContain("build: skipped");
  });
});
