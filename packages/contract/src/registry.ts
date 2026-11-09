// SPDX-License-Identifier: AGPL-3.0-only

import { completeSetup, loginWithPassword, logout, verifyTotp } from "./operations/auth.ts";
import { createCompany, getCompany, leaveCompany, listCompanies, listRecentCompanies, updateCompany, updateMyMembership } from "./operations/companies.ts";
import { acceptInvitation, getInvitation } from "./operations/invitations.ts";
import { getMe } from "./operations/me.ts";
import { listPermissions } from "./operations/permissions.ts";
import { getSession, selectCompany } from "./operations/session.ts";
import { getHealth } from "./operations/status.ts";
import {
  assignProgram,
  disconnectUserIdentity,
  getUser,
  inviteUser,
  listUsers,
  moveProgram,
  removeProgram,
  removeUser,
  resendInvitation,
  updateUser,
  updateUserRights,
} from "./operations/users.ts";

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
  updateCompany,
  listPermissions,
  listUsers,
  getUser,
  updateUser,
  removeUser,
  assignProgram,
  removeProgram,
  moveProgram,
  updateUserRights,
  inviteUser,
  resendInvitation,
  disconnectUserIdentity,
  getInvitation,
  acceptInvitation,
  leaveCompany,
] as const;
