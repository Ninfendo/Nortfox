// SPDX-License-Identifier: AGPL-3.0-only

// Which programs the actor reaches in the user administration (issue 12,
// "Roles, admin levels, programs and permissions" 2 and 3): a system
// administrator every program; a program administrator only the programs
// they administer, which they alone see and grant. The request holds the
// system administrator's permissions as its credential took them (a
// session when it chose the company, R11), and users:admin is the one that
// only a system administrator holds. Which programs a program administrator
// administers is read in the request's own transaction, so a program taken
// from them is out of their reach at once.

import type { CompanyAccess } from "../../api/context.ts";
import type { Queryable } from "../../db/database.ts";
import type { Reach } from "../memberships/members.ts";
import { readPrograms } from "../memberships/programs.ts";

/** The programs that the actor of `access` reaches. */
export async function reachOf(tx: Queryable, access: CompanyAccess): Promise<Reach> {
  if (access.permissions.includes("users:admin")) {
    return { all: true };
  }
  return { all: false, programs: (await readPrograms(tx, access.membershipId)).administered };
}
