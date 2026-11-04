// SPDX-License-Identifier: AGPL-3.0-only

// The setup command: prints the setup link of an empty install, then exits
// (setup.ts; deploy/README.md). It connects as nortfox_app, with the
// server's own settings: NORTFOX_DATABASE_URL, NORTFOX_DATABASE_PASSWORD_FILE
// and NORTFOX_PUBLIC_ORIGIN. It only wires the tested parts together, like
// main.ts. The link is printed to the operator, who keeps it to themselves.

import { publicOriginOf } from "./config.ts";
import { configFromEnvironment } from "./db/connect.ts";
import { createDatabase, type Database } from "./db/database.ts";
import { createSetupLink, setupLinkMessage } from "./setup.ts";

let database: Database | undefined;
try {
  const publicOrigin = publicOriginOf(process.env);
  database = createDatabase(configFromEnvironment(process.env), {
    max: 1,
    onConnectionError: (error) => {
      console.error(`setup: the database connection failed: ${error.message}`);
    },
  });
  console.log(setupLinkMessage(await createSetupLink(database, publicOrigin, new Date())));
} catch (error) {
  console.error(`setup: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await database?.end();
}
