// SPDX-License-Identifier: AGPL-3.0-only

import type { Handler } from "../../api/operation.ts";
import { updateMyMembershipHandler } from "../memberships/update-my-membership.ts";
import { createCompanyHandler } from "./create-company.ts";
import { getCompanyHandler } from "./get-company.ts";
import { listCompaniesHandler } from "./list-companies.ts";
import { listRecentCompaniesHandler } from "./list-recent-companies.ts";
import { updateCompanyHandler } from "./update-company.ts";

/** The handlers of the companies and of the person's own memberships. */
export const companyHandlers: readonly Handler[] = [
  getCompanyHandler,
  createCompanyHandler,
  listCompaniesHandler,
  listRecentCompaniesHandler,
  updateMyMembershipHandler,
  updateCompanyHandler,
];
