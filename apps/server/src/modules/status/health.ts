// SPDX-License-Identifier: AGPL-3.0-only

import { getHealth } from "@nortfox/contract";
import { handlePublic, ok, type Handler } from "../../api/operation.ts";

/** Serves the registry's getHealth entry: the server is up, with its version. */
export function healthHandler(version: string): Handler {
  return handlePublic(getHealth, () => Promise.resolve(ok({ status: "ok", version })));
}
