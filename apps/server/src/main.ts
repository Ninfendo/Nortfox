// SPDX-License-Identifier: AGPL-3.0-only

// Starts the server: the database pool as nortfox_app, the app, and the
// listener. The pool connects when the first request comes, so the server
// starts without the database. Until slice 2c brings login, the resolver
// knows no actor, so every data operation answers 401 on /v1 and on /mcp,
// and /mcp allows no browser origin. A list's cursors are signed with a key
// made at start, so a cursor lasts as long as the process.

import { randomBytes } from "node:crypto";
import { resolveNoActor } from "./api/context.ts";
import { createApp } from "./app.ts";
import { configFromEnvironment } from "./db/connect.ts";
import { createDatabase } from "./db/database.ts";
import { parsePort, startServer } from "./start.ts";
import { readServerVersion } from "./version.ts";

const database = createDatabase(configFromEnvironment(process.env), {
  max: 10,
  onConnectionError: (error) => {
    console.error("A database connection failed:", error);
  },
});
const app = createApp({
  version: readServerVersion(),
  resolve: resolveNoActor,
  database,
  cursorKey: randomBytes(32),
  // Slice 2c puts the install's public origin here, behind Caddy.
  allowedOrigins: [],
});
const server = await startServer({ app, port: parsePort(process.env["PORT"]) });
console.log(`NortFox server listening on http://localhost:${String(server.port)}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().finally(() => database.end());
  });
}
