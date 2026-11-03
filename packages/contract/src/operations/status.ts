// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { defineOperation } from "../operation.ts";

export const Health = z
  .strictObject({
    status: z.literal("ok").meta({ description: 'Always "ok" when the server answers.' }),
    version: z.string().meta({ description: "The version of the server that answered.", examples: ["0.0.0"] }),
  })
  .meta({ id: "Health", description: "Whether the server is up." });

export type Health = z.infer<typeof Health>;

export const getHealth = defineOperation({
  id: "getHealth",
  method: "get",
  path: "/v1/health",
  tags: ["status"],
  summary: "Check that the server is up",
  description: "Answers as soon as the server runs. It reads no data.",
  output: Health,
  permission: "public",
  tool: "Checks that the NortFox server is up, and gives its version. It reads no data.",
  writes: false,
});
