// SPDX-License-Identifier: AGPL-3.0-only

// The one-shot migration step: applies db/migrations as the owner role, then
// exits. NORTFOX_DATABASE_URL names the database and the owner role, without a
// password; NORTFOX_DATABASE_PASSWORD_FILE names the file with the password.
// It only wires the tested parts in migrate.ts together, like main.ts.

import { migrateFromEnvironment } from "./migrate.ts";

try {
  const applied = await migrateFromEnvironment(process.env);
  console.log(applied.length === 0 ? "migrate: nothing to apply." : `migrate: applied ${applied.join(", ")}.`);
} catch (error) {
  console.error(`migrate: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
