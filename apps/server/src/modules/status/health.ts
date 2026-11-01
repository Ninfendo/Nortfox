// SPDX-License-Identifier: AGPL-3.0-only

import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";

export const Health = z
  .object({
    status: z.literal("ok").openapi({
      description: 'Always "ok" when the server answers.',
    }),
    version: z.string().openapi({
      description: "The version of the server that answered.",
      example: "0.0.0",
    }),
  })
  .openapi("Health", { description: "Whether the server is up." });

export type Health = z.infer<typeof Health>;

export const getHealth = createRoute({
  operationId: "getHealth",
  method: "get",
  path: "/v1/health",
  tags: ["status"],
  summary: "Check that the server is up",
  description: "Answers as soon as the server runs. It reads no data.",
  responses: {
    200: {
      description: "The server is up.",
      content: { "application/json": { schema: Health } },
    },
  },
});

export function registerHealth(app: OpenAPIHono, version: string): void {
  app.openapi(getHealth, (c) => c.json({ status: "ok" as const, version }, 200));
}
