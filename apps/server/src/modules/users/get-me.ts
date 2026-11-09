// SPDX-License-Identifier: AGPL-3.0-only

// getMe: the signed-in person and their own login data; and, when the
// request works in a company (company source current), that company, the
// person's membership there and the permissions the request holds there,
// in alphabetical order (issue 12, "Roles, admin levels, programs and
// permissions" 11). The membership is as it is now: its admin level, its
// roles at the server's time, its program grants and the programs it
// administers. A session's permissions are its snapshot of when it chose the
// company, less a right whose grant has ended since (auth/resolver.ts), so
// a change of the grants reaches them when the session chooses the company
// again.

import { getMe } from "@nortfox/contract";
import { handlePerson, ok } from "../../api/operation.ts";
import { readCompany } from "../companies/get-company.ts";
import { readMembership } from "../memberships/membership.ts";
import { readMe } from "./identity.ts";

export const getMeHandler = handlePerson(getMe, async ({ context, tx, company, now }) => {
  const me = await readMe(tx, context.personId);
  if (company.kind !== "current") {
    return ok({ ...me, permissions: [] });
  }
  const { access } = company;
  return ok({ ...me, company: await readCompany(tx), membership: await readMembership(tx, access.membershipId, now()), permissions: [...access.permissions] });
});
