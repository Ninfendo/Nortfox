// SPDX-License-Identifier: AGPL-3.0-only

// Starts the server: its settings, the database pool as nortfox_app, the
// key check, the app, and the listener. A setting that is missing or wrong
// stops the start (config.ts). The key check needs the database, so the
// server connects at start: the first start of an install stores the check
// value of its install secret, and each later start refuses a key that does
// not open it (auth/install-key.ts). The install's public origin is the one
// browser origin that /v1 and /mcp allow. Until the sessions of slice 2c are
// built, the resolver knows no actor, so every data operation answers 401 on
// /v1 and on /mcp. A list's cursors are signed with a key made at start, so a
// cursor lasts as long as the process. Every error is logged through the
// safe report (api/report.ts), a failed start too, which exits with 1.

import { randomBytes } from "node:crypto";
import { resolveNoActor } from "./api/context.ts";
import { errorReport } from "./api/report.ts";
import { createApp } from "./app.ts";
import { checkInstallKey } from "./auth/install-key.ts";
import { serverConfig } from "./config.ts";
import { configFromEnvironment } from "./db/connect.ts";
import { createDatabase, type Database } from "./db/database.ts";
import { parsePort, startServer, type RunningServer } from "./start.ts";
import { readServerVersion } from "./version.ts";

async function start(database: Database, config: ReturnType<typeof serverConfig>): Promise<RunningServer> {
  await checkInstallKey(database, config.installKey);
  const app = createApp({
    version: readServerVersion(),
    resolve: resolveNoActor,
    database,
    cursorKey: randomBytes(32),
    installKey: config.installKey,
    allowedOrigins: [config.publicOrigin],
  });
  return startServer({ app, port: parsePort(process.env["PORT"]) });
}

let database: Database | undefined;
try {
  const config = serverConfig(process.env);
  database = createDatabase(configFromEnvironment(process.env), {
    max: 10,
    onConnectionError: (error) => {
      console.error(`A database connection failed: ${errorReport(error)}`);
    },
  });
  const server = await start(database, config);
  console.log(`NortFox server listening on http://localhost:${String(server.port)}`);
  const running = database;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void server.close().finally(() => running.end());
    });
  }
} catch (error) {
  console.error(`The server did not start: ${errorReport(error)}`);
  await database?.end();
  process.exitCode = 1;
}
