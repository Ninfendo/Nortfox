// SPDX-License-Identifier: MIT

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

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
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
      throw new ApiError(
        response.status,
        `${call.method} ${call.path} answered ${String(response.status)}.`,
      );
    }
    const body: unknown = await response.json();
    return body;
  };
}
