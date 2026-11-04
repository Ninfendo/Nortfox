// SPDX-License-Identifier: AGPL-3.0-only

// listCompanies (issue 12, Companies 4): the companies where the signed-in
// person is an active member, by name, with the person's system
// administrator's level in each, from the one membership function
// (modules/memberships/resolve.ts). query keeps those whose name, in any
// letter case, or organisation number holds it. A page's cursor holds the
// last company's name and id, and belongs to the person.

import { listCompanies, type CompanyChoice } from "@nortfox/contract";
import { handlePersonList, ok } from "../../api/operation.ts";
import { activeMembershipPage, type ResolvedMembership } from "../memberships/resolve.ts";

/** A membership as the company choice gives it. */
export function choiceOf(membership: ResolvedMembership): CompanyChoice {
  const { company } = membership;
  return {
    company: { id: membership.companyId, name: company.name, organizationNumber: company.organizationNumber, databaseNumber: company.databaseNumber },
    ...(membership.adminLevel === null ? {} : { adminLevel: membership.adminLevel }),
  };
}

export const listCompaniesHandler = handlePersonList(listCompanies, async ({ tx, page }, { query }) => {
  const found = await activeMembershipPage(tx, { ...(query.query === undefined ? {} : { query: query.query }), ...(page.after === undefined ? {} : { after: page.after }), limit: page.limit });
  const items = found.memberships.map(choiceOf);
  return ok(found.next === undefined ? { items, total: found.total } : { items, total: found.total, next: found.next });
});
