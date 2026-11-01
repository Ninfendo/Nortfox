// SPDX-License-Identifier: MIT

import { createOperations, type Operations } from "./generated.ts";
import { createSend, type ClientOptions } from "./runtime.ts";

export type { Health, Operations } from "./generated.ts";
export { ApiError } from "./runtime.ts";
export type { CallOptions, ClientOptions, FetchFunction } from "./runtime.ts";

/** A client for the NortFox API: one method per operation. */
export function createClient(options: ClientOptions): Operations {
  return createOperations(createSend(options));
}
