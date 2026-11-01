// SPDX-License-Identifier: AGPL-3.0-only

// A stand-in for the GitHub API, for tests: it answers from a table of
// routes and records every request.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeAnswer {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export type Routes = Record<string, FakeAnswer | ((url: string) => FakeAnswer)>;

export interface FakeGitHub {
  readonly url: string;
  readonly requests: string[];
  close(): Promise<void>;
}

/**
 * Routes are keyed "METHOD /path?query". An unknown route answers 404. In a
 * header value, "{base}" stands for the server's own address.
 */
export async function startFakeGitHub(routes: Routes): Promise<FakeGitHub> {
  const requests: string[] = [];
  let base = "";
  const server: Server = createServer((request, response) => {
    const key = `${request.method ?? "GET"} ${request.url ?? "/"}`;
    requests.push(key);
    const route = routes[key];
    const answer: FakeAnswer =
      route === undefined ? { status: 404, body: { message: "Not Found" } } : typeof route === "function" ? route(key) : route;
    const headers: Record<string, string> = { "content-type": "application/json" };
    for (const [name, value] of Object.entries(answer.headers ?? {})) {
      headers[name] = value.replaceAll("{base}", base);
    }
    response.writeHead(answer.status ?? 200, headers);
    response.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${String(port)}`;
  return {
    url: base,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}
