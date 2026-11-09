// SPDX-License-Identifier: AGPL-3.0-only

import type { Handler } from "../../api/operation.ts";
import { disconnectUserIdentityHandler, inviteUserHandler, resendInvitationHandler } from "./invitations.ts";
import { listPermissionsHandler } from "./list-permissions.ts";
import { assignProgramHandler, moveProgramHandler, removeProgramHandler, updateUserRightsHandler } from "./program-grants.ts";
import { getUserHandler, listUsersHandler, removeUserHandler, updateUserHandler } from "./users.ts";

/** The handlers of the catalogue, the company's users, their invitations and their programs. */
export const userHandlers: readonly Handler[] = [
  listPermissionsHandler,
  listUsersHandler,
  getUserHandler,
  updateUserHandler,
  removeUserHandler,
  assignProgramHandler,
  removeProgramHandler,
  moveProgramHandler,
  updateUserRightsHandler,
  inviteUserHandler,
  resendInvitationHandler,
  disconnectUserIdentityHandler,
];
