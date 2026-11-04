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

/** The options of a write that takes an idempotency key. */
export interface WriteOptions extends CallOptions {
  /**
   * A key you choose for this write, 1 to 255 characters of visible ASCII
   * without " and \. Send the same key with the same input again, and you
   * get the first answer back instead of a second write.
   */
  readonly idempotencyKey: string;
}

/** The methods an operation uses. */
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * One operation as the client calls it. The input is the operation's flat
 * input: the path parameters and the query's fields by name, and every other
 * field goes to the JSON body.
 */
export interface OperationCall {
  readonly method: Method;
  /** The path, with each path parameter as {name}. */
  readonly path: string;
  /** The names of the path parameters. */
  readonly params?: readonly string[];
  /** The names of the query's fields. */
  readonly query?: readonly string[];
  /** Whether it takes a JSON body. */
  readonly body?: true;
  /** Whether it takes an idempotency key. */
  readonly key?: true;
  /** What a success answers: JSON (the default), nothing (202 and 204), or a redirect (303), which fetch is asked not to follow. */
  readonly answer?: "none" | "redirect";
}

/** Sends one call and gives back what the server answered: its JSON, or nothing for an answer without a body. */
export type Send = (call: OperationCall, input: Readonly<Record<string, unknown>> | undefined, options: CallOptions | WriteOptions | undefined) => Promise<unknown>;

/** The server answered with a status that is not the call's success. */
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

/** The URL of a call: the path with its parameters in it, encoded, and the query's fields that the input gives. */
function urlOf(baseUrl: string, call: OperationCall, input: Readonly<Record<string, unknown>>): string {
  let path = call.path;
  for (const name of call.params ?? []) {
    // The method's input type makes each path parameter a string.
    path = path.replace(`{${name}}`, encodeURIComponent(input[name] as string));
  }
  const search = new URLSearchParams();
  for (const name of call.query ?? []) {
    // The method's input type makes each query field a string or a number: the generator refuses any other type.
    const value = input[name] as string | number | undefined;
    if (value !== undefined) {
      search.append(name, String(value));
    }
  }
  const query = search.toString();
  return `${baseUrl}${path}${query === "" ? "" : `?${query}`}`;
}

/** The fields of the input that are neither a path parameter nor in the query: the body's. */
function bodyOf(call: OperationCall, input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const named = new Set([...(call.params ?? []), ...(call.query ?? [])]);
  return Object.fromEntries(Object.entries(input).filter(([name]) => !named.has(name)));
}

export function createSend(options: ClientOptions): Send {
  const callFetch: FetchFunction = options.fetch ?? ((input, init) => fetch(input, init));
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return async (call, input = {}, callOptions) => {
    const headers: Record<string, string> = { accept: "application/json" };
    const init: RequestInit = { method: call.method, headers };
    if (call.body === true) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(bodyOf(call, input));
    }
    if (call.key === true && callOptions !== undefined && "idempotencyKey" in callOptions) {
      headers["idempotency-key"] = callOptions.idempotencyKey;
    }
    if (call.answer === "redirect") {
      init.redirect = "manual";
    }
    if (callOptions?.signal !== undefined) {
      init.signal = callOptions.signal;
    }
    const response = await callFetch(urlOf(baseUrl, call, input), init);
    const succeeded = call.answer === "redirect" ? response.status === 303 : response.ok;
    if (!succeeded) {
      const problem = await problemOf(response);
      const answered = `${call.method} ${call.path} answered ${String(response.status)}`;
      if (problem === undefined) {
        throw new ApiError(response.status, `${answered}.`);
      }
      throw new ApiError(response.status, `${answered} ${problem.code}.`, problem);
    }
    if (call.answer === "none") {
      return undefined;
    }
    const body: unknown = await response.json();
    return body;
  };
}
