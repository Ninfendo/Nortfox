// SPDX-License-Identifier: AGPL-3.0-only

// Writes the committed API description, packages/client/openapi.json, from
// the registry. Run it through `pnpm openapi`, which also regenerates the
// client.

import { REGISTRY } from "@nortfox/contract";
import { writeFileSync } from "node:fs";
import { renderOpenApi } from "../src/openapi.ts";
import { OPENAPI_FILE } from "../src/openapi-file.ts";
import { readServerVersion } from "../src/version.ts";

writeFileSync(OPENAPI_FILE, renderOpenApi(REGISTRY, readServerVersion()));
console.log("Wrote packages/client/openapi.json");
