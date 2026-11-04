// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { defineOperation } from "../operation.ts";
import { User } from "./me.ts";

export const Session = z
  .strictObject({
    user: User,
  })
  .meta({ id: "Session", description: "The browser's session: the person it signed in. A session works in no company until one is chosen." });

export type Session = z.infer<typeof Session>;

/** The browser's session: who it signed in. It serves the browser, so its MCP tool refuses every call. */
export const getSession = defineOperation({
  id: "getSession",
  method: "get",
  path: "/v1/session",
  tags: ["session"],
  summary: "Read the session",
  description: "Gives the browser's session: the person it signed in.",
  output: Session,
  permission: "signed-in",
  session: "flow",
  tool: "Reads the browser's session. It serves the browser's sign-in, so this tool refuses every call: an MCP client signs in through OAuth.",
  writes: false,
});
