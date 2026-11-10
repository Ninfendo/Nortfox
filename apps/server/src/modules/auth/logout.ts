// SPDX-License-Identifier: AGPL-3.0-only

// logout: ends the browser's session, so its cookie is refused from the next
// request, clears the cookie, and writes the logout to the person's
// Kontoaktivitet, in one transaction as the person. Its idempotency key is
// kept for the person, as every signed-in write's is.

import { logout } from "@nortfox/contract";
import { sessionOf } from "../../api/context.ts";
import { handlePerson, ok } from "../../api/operation.ts";
import { addAccountEvent } from "./account-events.ts";

export const logoutHandler = handlePerson(logout, async ({ context, tx, now }) => {
  await tx.query("SELECT access.end_session($1, 'logout', $2)", [sessionOf(logout.operationId, context.credential).sessionId, now()]);
  await addAccountEvent(tx, context.personId, { kind: "logout", details: {} });
  return ok({}, [{ kind: "clear-session" }]);
});
