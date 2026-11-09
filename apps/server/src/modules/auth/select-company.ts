// SPDX-License-Identifier: AGPL-3.0-only

// selectCompany, "Byt företag" (issue 12, Companies 4; Behandlingshistorik
// 1): the browser's session works in another company from the next request,
// without a new sign-in. The runner has asked the one membership function
// for the company that the input names, and entered it: a company where the
// person is no active member, also one that does not exist, is refused with
// one answer before this runs. In one transaction as the person, in that
// company:
//
// 1. The membership is held until the commit (holdActive): its row is locked
//    and read again. A membership that stopped being active since the runner
//    read it, such as by a deactivation that committed meanwhile, gets the
//    runner's refusal, and nothing is chosen. A deactivation that comes
//    later waits for the commit, and then ends the session. So the session
//    never keeps a membership that is not active.
// 2. The session stores the company, the membership and the person's
//    effective permissions there now (access.choose_company), and is seen
//    now, under the membership's idle time. The admin level and the idle
//    time are the held row's; the permissions also come from the
//    membership's program grants and the programs it administers, each
//    right with the end of the grant that gives it, or none. The resolver
//    checks the membership on every request, and drops a right whose grant
//    has ended, so a Revisor grant's end holds in the session too. The rest
//    of the permissions hold until the session chooses a company again, and
//    so do the programs a program administrator administers, which the
//    session stores beside them: a change of the grants, of the admin level
//    or of the programs administered reaches the session then (issue 12,
//    "Roles, admin levels, programs and permissions" 12). A session that has ended since
//    the resolver read it, such as by a logout at once, chooses nothing, and
//    the call is answered as one with no actor (401).
// 3. The person's recent companies get the choice.
// 4. The company's behandlingshistorik gets the sign-in (choice 8: at each
//    choice, also when switching), with the method, the second step, when
//    the person identified, the personnummer when the method gives one, the
//    application and the IP address of the request.
//
// It answers the session as getSession does. The answer names the person, so
// its idempotency key is kept outside every company table.

import { effectivePermissions, selectCompany } from "@nortfox/contract";
import { companyNotAvailable, credentialEnded, handlePerson, inputMembership, ok } from "../../api/operation.ts";
import { permissionSnapshot } from "../../auth/resolver.ts";
import { addEntry, signInEntryDetails } from "../audit/entries.ts";
import { readCompany } from "../companies/get-company.ts";
import { holdActive } from "../memberships/membership.ts";
import { memberAccess, readPrograms } from "../memberships/programs.ts";
import { readMe } from "../users/identity.ts";

export const selectCompanyHandler = handlePerson(selectCompany, async ({ context, tx, company, request, now }) => {
  const membership = inputMembership(company);
  const held = await holdActive(tx, membership.membershipId, membership.personId);
  if (held === undefined) {
    return companyNotAvailable(selectCompany);
  }
  const at = now();
  const { credential } = context;
  const programs = await readPrograms(tx, membership.membershipId);
  const permissions = permissionSnapshot(effectivePermissions(memberAccess(held.adminLevel, programs), at), programs.administered);
  const chosen = await tx.query<{ chosen: boolean }>("SELECT access.choose_company($1, $2, $3, $4, $5, $6) AS chosen", [
    credential.sessionId,
    membership.companyId,
    membership.membershipId,
    permissions,
    held.idleTimeoutMinutes,
    at,
  ]);
  // A SELECT of one function call gives one row. A session that ended since the resolver read it, such as by a logout at once,
  // chooses nothing: it names no actor any more, and the call is answered as one with none.
  if (!(chosen.rows as [{ readonly chosen: boolean }])[0].chosen) {
    return credentialEnded();
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
    details: signInEntryDetails({
      method: credential.method,
      secondStep: credential.secondStep,
      identifiedAt: credential.identifiedAt,
      personalIdentityNumber,
      request,
      outcome: "succeeded",
    }),
    at,
  });
  return ok({ user: me.user, company: await readCompany(tx) });
});
