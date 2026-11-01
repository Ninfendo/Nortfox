// SPDX-License-Identifier: MIT

// Generated from openapi.json by scripts/generate.ts. Do not edit it by hand:
// change the API, then run `pnpm openapi`.

import type { CallOptions, Send } from "./runtime.ts";

/**
 * Whether the server is up.
 */
export interface Health {
  /**
   * Always "ok" when the server answers.
   */
  readonly status: "ok";
  /**
   * The version of the server that answered.
   */
  readonly version: string;
}

export interface Operations {
  /**
   * Check that the server is up
   *
   * Answers as soon as the server runs. It reads no data.
   *
   * `GET /v1/health`
   */
  getHealth(options?: CallOptions): Promise<Health>;
}

export function createOperations(send: Send): Operations {
  return {
    getHealth: async (options) => (await send({ method: "GET", path: "/v1/health" }, options)) as Health,
  };
}
