// SPDX-License-Identifier: AGPL-3.0-only

// updateMyMembership: Användaruppgifter, the person's own work e-mail
// address and phone number in a company, and "Utloggning efter
// inaktivitet" (issue 12, "Users in a company" 8 and 9). The runner has
// asked the one membership function for the company that the path names,
// and entered it: a company where the person is no active member is refused
// before this runs. A membership that stops being active while the call
// waits for its row gets the same refusal. The contract takes only the five
// idle times of the established screen, and the database holds the same.
// The answer holds the work contacts, which are personal data, so its
// idempotency key is kept outside every company table.
//
// A new idle time holds from the next request of each session that works
// with the membership: a lower one at once, a higher one once the session is
// seen under it. The request's own session, when it works with this
// membership, is seen now under the new idle time. Another session keeps the
// idle time of its own last request until its next one, so a session that
// went past its idle time does not come back.

import { updateMyMembership } from "@nortfox/contract";
import { companyNotAvailable, handlePerson, inputMembership, ok } from "../../api/operation.ts";
import { seeSession } from "../../auth/resolver.ts";
import { changeOwnMembership } from "./membership.ts";

export const updateMyMembershipHandler = handlePerson(updateMyMembership, async ({ context, tx, company, now }, { body }) => {
  const membership = inputMembership(company);
  const changed = await changeOwnMembership(tx, membership.membershipId, body);
  if (changed === undefined) {
    return companyNotAvailable(updateMyMembership);
  }
  if (body.idleTimeout !== undefined && context.company?.membershipId === membership.membershipId) {
    await seeSession(tx, context.credential.sessionId, now(), changed.idleTimeout);
  }
  return ok(changed);
});
