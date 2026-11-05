// SPDX-License-Identifier: AGPL-3.0-only

// listRecentCompanies: the three companies the signed-in person chose last,
// the latest first, of those where the person is still an active member.
// selectCompany keeps each choice in access.recent_companies, the person's
// own rows; the one membership function says which are still the person's.

import { listRecentCompanies } from "@nortfox/contract";
import { handlePerson, ok } from "../../api/operation.ts";
import { activeMemberships } from "../memberships/resolve.ts";
import { choiceOf } from "./list-companies.ts";

/** How many companies the list holds. */
const RECENT = 3;

export const listRecentCompaniesHandler = handlePerson(listRecentCompanies, async ({ tx }) => {
  const chosen = await tx.query<{ chosen_company_id: string }>("SELECT chosen_company_id FROM access.recent_companies ORDER BY chosen_at DESC, chosen_company_id");
  const active = new Map((await activeMemberships(tx)).map((membership) => [membership.companyId, membership]));
  const companies = chosen.rows.flatMap((row) => {
    const membership = active.get(row.chosen_company_id);
    return membership === undefined ? [] : [choiceOf(membership)];
  });
  return ok({ companies: companies.slice(0, RECENT) });
});
