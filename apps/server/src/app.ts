// SPDX-License-Identifier: AGPL-3.0-only

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerHealth } from "./modules/status/health.ts";

export interface AppOptions {
  /** The version the server reports, from its package.json. */
  readonly version: string;
}

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

/** Builds the app with every route. It never listens; main.ts does that. */
export function createApp(options: AppOptions): OpenAPIHono {
  const app = new OpenAPIHono();
  registerHealth(app, options.version);
  app.doc31("/openapi.json", documentConfig(options.version));
  return app;
}

/** The API description, as the server serves it at /openapi.json. */
export function openApiDocument(options: AppOptions): unknown {
  return createApp(options).getOpenAPI31Document(documentConfig(options.version));
}

/** The API description as the committed file holds it: two-space JSON. */
export function renderOpenApi(options: AppOptions): string {
  return `${JSON.stringify(openApiDocument(options), null, 2)}\n`;
}
