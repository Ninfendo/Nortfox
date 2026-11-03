// SPDX-License-Identifier: AGPL-3.0-only

import { getCompany } from "./operations/companies.ts";
import { getHealth } from "./operations/status.ts";

/**
 * Every operation of the API. The server mounts /v1 and /mcp from this list
 * only, and openapi.json is generated from it.
 */
export const REGISTRY = [getHealth, getCompany] as const;
