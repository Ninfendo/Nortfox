// SPDX-License-Identifier: AGPL-3.0-only

import type { Handler } from "./api/operation.ts";
import { getCompanyHandler } from "./modules/companies/get-company.ts";
import { healthHandler } from "./modules/status/health.ts";

/** The handler of every operation in the registry. */
export function serverHandlers(version: string): Handler[] {
  return [healthHandler(version), getCompanyHandler];
}
