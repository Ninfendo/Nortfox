// SPDX-License-Identifier: AGPL-3.0-only

// Runs turbo with its telemetry off. turbo.json has no setting for that, and
// an environment variable in a package.json script does not work in every
// shell, so the root scripts call turbo through this file.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const turbo = createRequire(import.meta.url).resolve("turbo/bin/turbo");
const result = spawnSync(process.execPath, [turbo, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" },
});
process.exitCode = result.status ?? 1;
