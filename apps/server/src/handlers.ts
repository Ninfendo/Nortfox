// SPDX-License-Identifier: AGPL-3.0-only

import type { Handler } from "./api/operation.ts";
import { authHandlers } from "./modules/auth/handlers.ts";
import { companyHandlers } from "./modules/companies/handlers.ts";
import { healthHandler } from "./modules/status/health.ts";
import { tokenHandlers } from "./modules/tokens/handlers.ts";
import { userHandlers } from "./modules/users/handlers.ts";

/** The handler of every operation in the registry. */
export function serverHandlers(version: string): Handler[] {
  return [healthHandler(version), ...companyHandlers, ...authHandlers, ...userHandlers, ...tokenHandlers];
}
