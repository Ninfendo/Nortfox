// SPDX-License-Identifier: AGPL-3.0-only

import type { Handler } from "../../api/operation.ts";
import { acceptInvitationHandler, getInvitationHandler } from "../memberships/invitation-link.ts";
import { leaveCompanyHandler } from "../memberships/leave-company.ts";
import { updateMyMembershipHandler } from "../memberships/update-my-membership.ts";
import { createCompanyHandler } from "./create-company.ts";
import { getCompanyHandler } from "./get-company.ts";
import { listCompaniesHandler } from "./list-companies.ts";
import { listRecentCompaniesHandler } from "./list-recent-companies.ts";
import { updateCompanyHandler } from "./update-company.ts";

/** The handlers of the companies, of the person's own memberships, and of an invitation's link. */
export const companyHandlers: readonly Handler[] = [
  getCompanyHandler,
  createCompanyHandler,
  listCompaniesHandler,
  listRecentCompaniesHandler,
  updateMyMembershipHandler,
  updateCompanyHandler,
  leaveCompanyHandler,
  getInvitationHandler,
  acceptInvitationHandler,
];
