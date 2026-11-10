// SPDX-License-Identifier: AGPL-3.0-only

import type { Handler } from "../../api/operation.ts";
import { createApiTokenHandler, listApiTokensHandler, revokeApiTokenHandler } from "./api-tokens.ts";

/** The handlers of the API tokens. */
export const tokenHandlers: readonly Handler[] = [createApiTokenHandler, listApiTokensHandler, revokeApiTokenHandler];
