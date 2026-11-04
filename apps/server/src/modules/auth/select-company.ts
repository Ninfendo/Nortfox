// SPDX-License-Identifier: AGPL-3.0-only

// selectCompany, "Byt företag" (issue 12, Companies 4; Behandlingshistorik
// 1): the browser's session works in another company from the next request,
// without a new sign-in. The runner has asked the one membership function
// for the company that the input names, and entered it: a company where the
// person is no active member, also one that does not exist, is refused with
// one answer before this runs. In one transaction as the person, in that
// company:
//
// 1. The session stores the company, the membership and the person's
//    permissions there now (access.choose_company). The resolver checks the
//    membership on every request, and the permissions hold until the session
//    chooses a company again.
// 2. The person's recent companies get the choice.
// 3. The company's behandlingshistorik gets the sign-in (choice 8: at each
//    choice, also when switching), with the method, the second step, the
//    personnummer when the method gives one, the application and the IP
//    address of the request.
//
// It answers the session as getSession does. The answer names the person, so
// its idempotency key is kept outside every company table.

import { platformPermissions, selectCompany } from "@nortfox/contract";
import { handlePerson, inputMembership, ok } from "../../api/operation.ts";
import { addEntry, signInEntryDetails } from "../audit/entries.ts";
import { readCompany } from "../companies/get-company.ts";
import { readMe } from "../users/identity.ts";

export const selectCompanyHandler = handlePerson(selectCompany, async ({ context, tx, company, request, now }) => {
  const membership = inputMembership(company);
  const at = now();
  const { credential } = context;
  const permissions = Object.fromEntries([...platformPermissions(membership.adminLevel)].map((permission) => [permission, null]));
  const chosen = await tx.query<{ chosen: boolean }>("SELECT access.choose_company($1, $2, $3, $4) AS chosen", [
    credential.sessionId,
    membership.companyId,
    membership.membershipId,
    permissions,
  ]);
  // A SELECT of one function call gives one row. A session that ended since the resolver read it, such as by a logout at once, chooses nothing.
  if (!(chosen.rows as [{ readonly chosen: boolean }])[0].chosen) {
    throw new Error("The session ended while it chose its company.");
  }
  await tx.query(
    `INSERT INTO access.recent_companies (identity_id, chosen_company_id, chosen_at) VALUES ($1, $2, $3)
     ON CONFLICT (identity_id, chosen_company_id) DO UPDATE SET chosen_at = excluded.chosen_at`,
    [context.personId, membership.companyId, at],
  );
  const me = await readMe(tx, context.personId);
  const personalIdentityNumber = credential.method === "password-personnummer" ? me.personalIdentityNumber : undefined;
  await addEntry(tx, {
    program: "users",
    heading: "sign-in",
    subjectId: context.personId,
    details: signInEntryDetails({ method: credential.method, secondStep: credential.secondStep, personalIdentityNumber, request, outcome: "succeeded" }),
    at,
  });
  return ok({ user: me.user, company: await readCompany(tx) });
});
