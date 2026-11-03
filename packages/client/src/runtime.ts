// SPDX-License-Identifier: MIT

import type { Problem } from "./generated.ts";

/** The fetch the client calls. The global fetch fits. */
export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /**
   * Where the server answers, for example "https://books.example.com". An
   * empty string means the origin of the page that runs the client.
   */
  readonly baseUrl: string;
  /** The fetch to use. The default is the global fetch. */
  readonly fetch?: FetchFunction;
}

export interface CallOptions {
  /** Cancels the call. */
  readonly signal?: AbortSignal;
}

export interface OperationCall {
  readonly method: "GET";
  readonly path: string;
}

/** Sends one call and gives back the JSON the server answered with. */
export type Send = (call: OperationCall, options: CallOptions | undefined) => Promise<unknown>;

/** The server answered with a status that is not 2xx. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  /** The problem details the server answered with, when it answered with them. */
  readonly problem: Problem | undefined;

  constructor(status: number, message: string, problem?: Problem) {
    super(message);
    this.status = status;
    this.problem = problem;
  }
}

/** The media type of problem details (RFC 9457), which every /v1 error has. */
const PROBLEM_MEDIA_TYPE = "application/problem+json";

function isProblem(value: unknown): value is Problem {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly code?: unknown }).code === "string" &&
    typeof (value as { readonly status?: unknown }).status === "number"
  );
}

/** The problem details of a refusal, or undefined when it holds none. */
async function problemOf(response: Response): Promise<Problem | undefined> {
  const mediaType = (response.headers.get("content-type") ?? "").replace(/;.*$/s, "").trim().toLowerCase();
  if (mediaType !== PROBLEM_MEDIA_TYPE) {
    return undefined;
  }
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return undefined;
  }
  return isProblem(body) ? body : undefined;
}

export function createSend(options: ClientOptions): Send {
  const callFetch: FetchFunction = options.fetch ?? ((input, init) => fetch(input, init));
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return async (call, callOptions) => {
    const init: RequestInit = {
      method: call.method,
      headers: { accept: "application/json" },
    };
    if (callOptions?.signal !== undefined) {
      init.signal = callOptions.signal;
    }
    const response = await callFetch(`${baseUrl}${call.path}`, init);
    if (!response.ok) {
      const problem = await problemOf(response);
      const answered = `${call.method} ${call.path} answered ${String(response.status)}`;
      if (problem === undefined) {
        throw new ApiError(response.status, `${answered}.`);
      }
      throw new ApiError(response.status, `${answered} ${problem.code}.`, problem);
    }
    const body: unknown = await response.json();
    return body;
  };
}
