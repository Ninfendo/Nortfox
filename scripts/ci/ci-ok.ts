// SPDX-License-Identifier: AGPL-3.0-only

// The "CI OK" job: passes only when every job it needs succeeded. The
// workflow hands it `toJSON(needs)` in the NEEDS variable.

import { decideCiOk } from "../approvals/decide.ts";

export function main(env: Readonly<Record<string, string | undefined>>, out: (line: string) => void): number {
  let needs: unknown;
  try {
    needs = JSON.parse(env["NEEDS"] ?? "");
  } catch {
    out("CI OK: NEEDS is not JSON.");
    return 1;
  }
  const verdict = decideCiOk(needs);
  for (const line of verdict.lines) {
    out(line);
  }
  out(`CI OK: ${verdict.why}`);
  return verdict.pass ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = main(process.env, (line) => {
    console.log(line);
  });
}
