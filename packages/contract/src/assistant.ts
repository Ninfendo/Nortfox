// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The operations the AI assistant may call, built from the registry. An
 * entry is closed to it unless the entry opens itself, because the assistant
 * reads text that outsiders wrote, such as supplier invoices
 * (docs/decisions/0003-contract-first-rest-and-mcp.md). The assistant itself
 * comes in slice 4i.
 */

import type { Operation } from "./operation.ts";

export function assistantOperations<Entry extends Operation>(registry: readonly Entry[]): Entry[] {
  return registry.filter((entry) => entry["x-nortfox"].assistant);
}
