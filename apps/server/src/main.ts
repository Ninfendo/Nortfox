// SPDX-License-Identifier: AGPL-3.0-only

// Starts the server: its settings, the database pool as nortfox_app, the
// key check, the app, the purge timer, and the listener. A setting that is
// missing or wrong stops the start (config.ts). The key check needs the
// database, so the server connects at start: the first start of an install
// stores the check value of its install secret, and each later start refuses
// a key that does not open it (auth/install-key.ts). The install's public
// origin is the one browser origin that /v1 and /mcp allow. The resolver
// reads the browser's session cookie on /v1 (auth/resolver.ts), and the
// passwords are hashed at the production cost (auth/password.ts). Every 10
// minutes the server purges the login rows that have passed. A list's
// cursors are signed with a key made at start, so a cursor lasts as long as
// the process. Every error is logged through the safe report
// (api/report.ts), a failed start too, which exits with 1. A stop (SIGINT or
// SIGTERM) stops the purge timer, closes the server, which waits for the
// work queued for after the answers (start.ts), and only then ends the pool.

import { randomBytes } from "node:crypto";
import { errorReport, reportSafely } from "./api/report.ts";
import { createApp } from "./app.ts";
import { checkInstallKey } from "./auth/install-key.ts";
import { PasswordHasher } from "./auth/password.ts";
import { sessionResolver } from "./auth/resolver.ts";
import { serverConfig } from "./config.ts";
import { configFromEnvironment } from "./db/connect.ts";
import { createDatabase, type Database } from "./db/database.ts";
import { startPurgeTimer, type PurgeTimer } from "./modules/auth/purge.ts";
import { parsePort, startServer, type RunningServer } from "./start.ts";
import { readServerVersion } from "./version.ts";

function systemClock(): Date {
  return new Date();
}

async function start(database: Database, config: ReturnType<typeof serverConfig>): Promise<{ server: RunningServer; purge: PurgeTimer }> {
  await checkInstallKey(database, config.installKey);
  const app = createApp({
    version: readServerVersion(),
    resolve: sessionResolver({ database, now: systemClock }),
    database,
    cursorKey: randomBytes(32),
    installKey: config.installKey,
    allowedOrigins: [config.publicOrigin],
    passwordHasher: new PasswordHasher(),
    now: systemClock,
    report: reportSafely,
  });
  const server = await startServer({ app, port: parsePort(process.env["PORT"]) });
  return { server, purge: startPurgeTimer({ database, now: systemClock, report: reportSafely }) };
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
  const { server, purge } = await start(database, config);
  console.log(`NortFox server listening on http://localhost:${String(server.port)}`);
  const running = database;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void purge
        .stop()
        .then(() => server.close())
        .finally(() => running.end());
    });
  }
} catch (error) {
  console.error(`The server did not start: ${errorReport(error)}`);
  await database?.end();
  process.exitCode = 1;
}
