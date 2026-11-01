// SPDX-License-Identifier: AGPL-3.0-only

import { parsePort, startServer } from "./start.ts";
import { readServerVersion } from "./version.ts";

const server = await startServer({
  port: parsePort(process.env["PORT"]),
  version: readServerVersion(),
});
console.log(`NortFox server listening on http://localhost:${String(server.port)}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close();
  });
}
