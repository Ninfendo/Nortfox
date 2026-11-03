// SPDX-License-Identifier: MIT

// Generated from openapi.json by scripts/generate.ts. Do not edit it by hand:
// change the API, then run `pnpm openapi`.

import type { CallOptions, Send } from "./runtime.ts";

/**
 * What is wrong with one field of a request.
 */
export interface FieldProblem {
  /**
   * What is wrong with the field, as a stable kebab-case code.
   */
  readonly code: string;
  /**
   * The same in an English sentence.
   */
  readonly detail: string;
  /**
   * A JSON Pointer to the field in the operation's input: the query parameters, the body's fields and, for a write, idempotencyKey. An empty pointer is the whole input.
   */
  readonly pointer: string;
  /**
   * The facts behind the code, such as expected, minimum, maximum or allowed. Absent when there are none.
   */
  readonly data?: Readonly<Record<string, unknown>>;
}

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

/**
 * Problem details (RFC 9457) with a stable code.
 */
export interface Problem {
  /**
   * A URI for the kind of problem. NortFox sends about:blank, and the code says what went wrong.
   */
  readonly type: string;
  /**
   * The status in words, such as Bad Request.
   */
  readonly title: string;
  /**
   * The HTTP status.
   */
  readonly status: number;
  /**
   * What went wrong, in an English sentence.
   */
  readonly detail: string;
  /**
   * What went wrong, as a stable kebab-case code. Clients rely on this.
   */
  readonly code: string;
  /**
   * For invalid-request: what is wrong with each field.
   */
  readonly errors?: readonly FieldProblem[];
  /**
   * For permission-missing: the permission the operation needs.
   */
  readonly permission?: string;
  /**
   * For a rule's refusal that concerns one field: that field's JSON Pointer.
   */
  readonly pointer?: string;
  /**
   * For a rule's refusal: the facts behind it.
   */
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface Operations {
  /**
   * Check that the server is up
   *
   * Answers as soon as the server runs. It reads no data.
   *
   * `GET /v1/health`
   *
   * Needs no permission: it reads no data.
   */
  getHealth(options?: CallOptions): Promise<Health>;
}

export function createOperations(send: Send): Operations {
  return {
    getHealth: async (options) => (await send({ method: "GET", path: "/v1/health" }, options)) as Health,
  };
}
