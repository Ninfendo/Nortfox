// SPDX-License-Identifier: AGPL-3.0-only

// updateMyMembership: Användaruppgifter, the person's own work e-mail
// address and phone number in a company, and "Utloggning efter
// inaktivitet" (issue 12, "Users in a company" 8 and 9). The runner has
// asked the one membership function for the company that the path names,
// and entered it: a company where the person is no active member is refused
// before this runs. The contract takes only the five idle times of the
// established screen, and the database holds the same. The answer holds the
// work contacts, which are personal data, so its idempotency key is kept
// outside every company table.

import { updateMyMembership } from "@nortfox/contract";
import { handlePerson, inputMembership, ok } from "../../api/operation.ts";
import { changeOwnMembership } from "./membership.ts";

export const updateMyMembershipHandler = handlePerson(updateMyMembership, async ({ tx, company }, { body }) =>
  ok(await changeOwnMembership(tx, inputMembership(company).membershipId, body)),
);
