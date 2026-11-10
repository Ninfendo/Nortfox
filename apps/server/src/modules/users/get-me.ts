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
// again. A token's are its person's in its company now (auth/api-token.ts).
// Through a token, getMe gives the token's company, and no personnummer and
// no mobile number (issue 12, "Who acts" 4): a program gets only what it
// needs to know whom it acts for.

import { getMe } from "@nortfox/contract";
import { isToken } from "../../api/context.ts";
import { handlePerson, ok } from "../../api/operation.ts";
import { readCompany } from "../companies/get-company.ts";
import { readMembership } from "../memberships/membership.ts";
import { readMe, type MyIdentity } from "./identity.ts";

/** The identity as a token's call gives it: without the personnummer and the mobile number. */
function forToken(identity: MyIdentity): MyIdentity {
  return { user: identity.user, twoStep: identity.twoStep };
}

export const getMeHandler = handlePerson(getMe, async ({ context, tx, company, now }) => {
  const identity = await readMe(tx, context.personId);
  const me = isToken(context.credential) ? forToken(identity) : identity;
  if (company.kind !== "current") {
    return ok({ ...me, permissions: [] });
  }
  const { access } = company;
  return ok({ ...me, company: await readCompany(tx), membership: await readMembership(tx, access.membershipId, now()), permissions: [...access.permissions] });
});
