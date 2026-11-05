// SPDX-License-Identifier: AGPL-3.0-only

import { completeSetup, loginWithPassword, logout, verifyTotp } from "./operations/auth.ts";
import { createCompany, getCompany, listCompanies, listRecentCompanies, updateMyMembership } from "./operations/companies.ts";
import { getMe } from "./operations/me.ts";
import { getSession, selectCompany } from "./operations/session.ts";
import { getHealth } from "./operations/status.ts";

/**
 * Every operation of the API. The server mounts /v1 and /mcp from this list
 * only, and openapi.json is generated from it.
 */
export const REGISTRY = [
  getHealth,
  getCompany,
  completeSetup,
  loginWithPassword,
  verifyTotp,
  logout,
  getSession,
  getMe,
  createCompany,
  listCompanies,
  listRecentCompanies,
  selectCompany,
  updateMyMembership,
] as const;
