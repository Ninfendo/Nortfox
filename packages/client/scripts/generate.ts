// SPDX-License-Identifier: MIT

// Writes src/generated.ts from openapi.json. Run it through `pnpm openapi`.

import { readFileSync, writeFileSync } from "node:fs";
import { GENERATED_TS, OPENAPI_JSON } from "./files.ts";
import { generateClient } from "./generator.ts";

const document: unknown = JSON.parse(readFileSync(OPENAPI_JSON, "utf8"));
writeFileSync(GENERATED_TS, generateClient(document));
console.log("Wrote packages/client/src/generated.ts");
