// SPDX-License-Identifier: AGPL-3.0-only

// Writes the committed API description, packages/client/openapi.json, from
// the server's routes. Run it through `pnpm openapi`, which also regenerates
// the client.

import { writeFileSync } from "node:fs";
import { renderOpenApi } from "../src/app.ts";
import { OPENAPI_FILE } from "../src/openapi-file.ts";
import { readServerVersion } from "../src/version.ts";

writeFileSync(OPENAPI_FILE, renderOpenApi({ version: readServerVersion() }));
console.log("Wrote packages/client/openapi.json");
