// SPDX-License-Identifier: AGPL-3.0-only

import { getMe } from "@nortfox/contract";
import { handlePerson, ok } from "../../api/operation.ts";
import { readMe } from "./identity.ts";

/** Serves getMe: the signed-in person and their own login data, in no company. */
export const getMeHandler = handlePerson(getMe, async ({ context, tx }) => ok(await readMe(tx, context.personId)));
