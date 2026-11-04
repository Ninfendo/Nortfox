// SPDX-License-Identifier: AGPL-3.0-only

import { getSession } from "@nortfox/contract";
import { handlePerson, ok } from "../../api/operation.ts";
import { readMe } from "../users/identity.ts";

/** Serves getSession: the person the browser's session signed in. A session has no company yet. */
export const getSessionHandler = handlePerson(getSession, async ({ context, tx }) => ok({ user: (await readMe(tx, context.personId)).user }));
