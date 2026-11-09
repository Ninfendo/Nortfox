// SPDX-License-Identifier: AGPL-3.0-only

import type { Handler } from "../../api/operation.ts";
import { getMeHandler } from "../users/get-me.ts";
import { completeSetupHandler } from "./complete-setup.ts";
import { getSessionHandler } from "./get-session.ts";
import { loginWithPasswordHandler } from "./login.ts";
import { logoutHandler } from "./logout.ts";
import { selectCompanyHandler } from "./select-company.ts";
import { verifyTotpHandler } from "./verify-totp.ts";

/** The handlers of the browser's sign-in and of the person's own operations. */
export const authHandlers: readonly Handler[] = [completeSetupHandler, loginWithPasswordHandler, verifyTotpHandler, logoutHandler, getSessionHandler, getMeHandler, selectCompanyHandler];
