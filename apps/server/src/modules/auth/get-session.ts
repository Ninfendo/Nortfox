// SPDX-License-Identifier: AGPL-3.0-only

import { getSession } from "@nortfox/contract";
import { handlePerson, ok } from "../../api/operation.ts";
import { readCompany } from "../companies/get-company.ts";
import { readMe } from "../users/identity.ts";

/** Serves getSession: the person the browser's session signed in, and the company it works in once one is chosen. */
export const getSessionHandler = handlePerson(getSession, async ({ context, tx, company }) => {
  const { user } = await readMe(tx, context.personId);
  return ok(company.kind === "current" ? { user, company: await readCompany(tx) } : { user });
});
