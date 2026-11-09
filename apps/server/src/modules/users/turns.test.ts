// SPDX-License-Identifier: AGPL-3.0-only

// Each write that takes a turn of the database's, the company's turn of its
// invitations or of its administrators, says so to the runner, which waits
// for the same turn in this process before it asks the pool for a
// connection (api/turns.ts): inviteUser the invitations' turn; a disconnect
// the administrators' turn alone; a removal, a leave, and an update that
// demotes or deactivates, the administrators' turn with the others. An
// update that changes nothing else of an administrator takes none.

import { describe, expect, it } from "vitest";
import { leaveCompanyHandler } from "../memberships/leave-company.ts";
import { INVITATIONS_TURN } from "../memberships/invitations.ts";
import { ADMINISTRATORS_TURN } from "../memberships/members.ts";
import { disconnectUserIdentityHandler, inviteUserHandler, resendInvitationHandler } from "./invitations.ts";
import { removeUserHandler, updateUserHandler } from "./users.ts";

const MEMBER = "6f1d2c3b-4a59-4e8d-9c7b-0a1b2c3d4e5f";

/** An input of a call: its path parameters, no query, and its body. */
function input(body: unknown, params: Record<string, string> = { memberId: MEMBER }): { params: Record<string, string>; query: Record<string, never>; body: unknown } {
  return { params, query: {}, body };
}

describe("the turns that the user administration's writes take", () => {
  it("are the invitations' turn for an invitation, and the administrators' alone for a disconnect", () => {
    expect(inviteUserHandler.turn?.(input({ name: "Karin Lund", email: "karin.lund@example.com" }, {}))).toEqual(INVITATIONS_TURN);
    expect(INVITATIONS_TURN).toEqual({ name: "invitations", alone: true });
    expect(disconnectUserIdentityHandler.turn?.(input(undefined))).toEqual(ADMINISTRATORS_TURN.alone);
    expect(ADMINISTRATORS_TURN.alone).toEqual({ name: "administrators", alone: true });
    // A new invitation of an invited member takes away no administrator, and the member's row orders it.
    expect(resendInvitationHandler.turn).toBeUndefined();
  });

  it("are the administrators' turn with the others for a removal, a leave, a demotion and a deactivation", () => {
    expect(ADMINISTRATORS_TURN.shared).toEqual({ name: "administrators", alone: false });
    expect(removeUserHandler.turn?.(input(undefined))).toEqual(ADMINISTRATORS_TURN.shared);
    expect(leaveCompanyHandler.turn?.(input(undefined, { companyId: MEMBER }))).toEqual(ADMINISTRATORS_TURN.shared);
    expect(updateUserHandler.turn?.(input({ adminLevel: null }))).toEqual(ADMINISTRATORS_TURN.shared);
    expect(updateUserHandler.turn?.(input({ active: false }))).toEqual(ADMINISTRATORS_TURN.shared);
    expect(updateUserHandler.turn?.(input({ active: false, idleTimeout: 60 }))).toEqual(ADMINISTRATORS_TURN.shared);
  });

  it("are none for an update that takes no administrator away", () => {
    expect(updateUserHandler.turn?.(input({}))).toBeUndefined();
    expect(updateUserHandler.turn?.(input({ adminLevel: "admin", active: true }))).toBeUndefined();
    expect(updateUserHandler.turn?.(input({ idleTimeout: 60, workEmail: "karin.arbete@example.com" }))).toBeUndefined();
  });
});
