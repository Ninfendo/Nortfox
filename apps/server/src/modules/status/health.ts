// SPDX-License-Identifier: AGPL-3.0-only

import type { OpenAPIHono } from "@hono/zod-openapi";
import { getHealth, type Health } from "@nortfox/contract";

/** Serves the registry's getHealth entry. */
export function registerHealth(app: OpenAPIHono, version: string): void {
  app.openapi(getHealth, (c) => c.json({ status: "ok", version } satisfies Health, 200));
}
