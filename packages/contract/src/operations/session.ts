// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { defineOperation } from "../operation.ts";
import { Company } from "./companies.ts";
import { User } from "./me.ts";

export const Session = z
  .strictObject({
    user: User,
    // The company the session works in: absent until one is chosen.
    company: Company.optional(),
  })
  .meta({ id: "Session", description: "The browser's session: the person it signed in, and the company it works in once one is chosen." });

export type Session = z.infer<typeof Session>;

/** The browser's session: who it signed in, and its company. It serves the browser, so its MCP tool refuses every call. */
export const getSession = defineOperation({
  id: "getSession",
  method: "get",
  path: "/v1/session",
  tags: ["session"],
  summary: "Read the session",
  description: "Gives the browser's session: the person it signed in, and the company it works in once one is chosen.",
  output: Session,
  permission: "signed-in",
  session: "flow",
  company: "current",
  tool: "Reads the browser's session. It serves the browser's sign-in, so this tool refuses every call: an MCP client signs in through OAuth.",
  writes: false,
});

/** Byt företag: the session works in another company, without a new sign-in. */
export const selectCompany = defineOperation({
  id: "selectCompany",
  method: "post",
  path: "/v1/session/company",
  tags: ["session"],
  summary: "Choose the company",
  description:
    "Makes the browser's session work in the company that companyId names, where the person must be an active member, without a new sign-in. " +
    "Any other company, also one that does not exist, gets the same refusal. The session takes the person's permissions there as they are now, " +
    "and the company's behandlingshistorik gets the sign-in.",
  body: z.strictObject({ companyId: z.uuid().meta({ description: "The id of the company to work in." }) }),
  output: Session,
  permission: "signed-in",
  session: "flow",
  company: { input: "companyId" },
  tool: "Chooses the browser session's company. It serves the browser's sign-in, so this tool refuses every call: an MCP client signs in through OAuth.",
  writes: true,
});
