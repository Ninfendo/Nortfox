// SPDX-License-Identifier: AGPL-3.0-only

// The API description, from the registry: what /openapi.json serves and what
// packages/client/openapi.json commits. Each operation shows its permission,
// its MCP tool text and its flags in x-nortfox, so a change of a permission
// shows in the file's diff (docs/decisions/0003-contract-first-rest-and-mcp.md).

import { OpenAPIHono } from "@hono/zod-openapi";
import type { Operation } from "@nortfox/contract";

function documentConfig(version: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "NortFox API",
      version,
      description:
        "The API of NortFox, an open-source Swedish accounting system. Amounts travel as decimal strings, never as JSON numbers.",
      license: { name: "MIT", identifier: "MIT" },
    },
  };
}

/** The API description of the operations in `registry`. */
export function openApiDocument(registry: readonly Operation[], version: string): unknown {
  const describer = new OpenAPIHono();
  for (const operation of registry) {
    describer.openAPIRegistry.registerPath(operation);
  }
  return describer.getOpenAPI31Document(documentConfig(version));
}

/** The API description as the committed file holds it: two-space JSON. */
export function renderOpenApi(registry: readonly Operation[], version: string): string {
  return `${JSON.stringify(openApiDocument(registry, version), null, 2)}\n`;
}
