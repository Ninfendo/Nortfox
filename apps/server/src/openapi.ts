// SPDX-License-Identifier: AGPL-3.0-only

// The API description, from the registry: what /openapi.json serves and what
// packages/client/openapi.json commits. Each operation shows its permission,
// its MCP tool text and its flags in x-nortfox, so a change of a permission
// shows in the file's diff (docs/decisions/0003-contract-first-rest-and-mcp.md).

import { OpenAPIHono } from "@hono/zod-openapi";
import { SECURITY_SCHEMES, type Operation } from "@nortfox/contract";

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

/**
 * The API description of the operations in `registry`, with the credentials
 * that an operation's security names (docs/api.md, Who acts).
 */
export function openApiDocument(registry: readonly Operation[], version: string): unknown {
  const describer = new OpenAPIHono();
  for (const [name, scheme] of Object.entries(SECURITY_SCHEMES)) {
    describer.openAPIRegistry.registerComponent("securitySchemes", name, { ...scheme });
  }
  for (const operation of registry) {
    describer.openAPIRegistry.registerPath(operation);
  }
  return describer.getOpenAPI31Document(documentConfig(version));
}

/**
 * A character that shows as nothing, as a space or as a control, such as
 * the line separator, a control of the text's direction or a zero-width
 * space, which the pattern of an address holds. The file writes each as a
 * JSON escape, so a reader of the file, and of its diff, sees it. The white
 * space of JSON between its tokens is a line feed or a space, and stays.
 */
const UNSEEN = /(?![\n ])[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}]/gu;

/** A character as JSON escapes, one for each UTF-16 code unit. */
function escaped(character: string): string {
  return Array.from({ length: character.length }, (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`).join("");
}

/** The API description as the committed file holds it: two-space JSON, with each character that shows as nothing as a JSON escape (UNSEEN). */
export function renderOpenApi(registry: readonly Operation[], version: string): string {
  return `${JSON.stringify(openApiDocument(registry, version), null, 2).replace(UNSEEN, escaped)}\n`;
}
