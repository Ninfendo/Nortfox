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
// A lower idle time holds at once for each session that works with the
// membership: the database lowers their idle times in the same transaction,
// so a session that went past it does not come back when the idle time is
// raised later. A higher one holds for a session once it is seen under it.
// The request's own session is seen now under the new idle time, when it
// still works with this membership at the write: the database checks that,
// so a session that chose another company meanwhile keeps that company's
// idle time.

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
  if (body.idleTimeout !== undefined) {
    await seeSession(tx, context.credential.sessionId, now(), changed.idleTimeout, membership.membershipId);
  }
  return ok(changed);
});
