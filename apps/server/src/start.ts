// SPDX-License-Identifier: AGPL-3.0-only

import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { assertV1Routes } from "./api/route-guard.ts";
import type { ServerApp } from "./app.ts";

export const DEFAULT_PORT = 4100;

/** Reads PORT. Unset or empty means the default, 4100. */
export function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }
  if (!/^[0-9]{1,5}$/.test(value) || Number(value) > 65535) {
    throw new Error(`PORT must be a whole number from 0 to 65535, not "${value}".`);
  }
  return Number(value);
}

export interface RunningServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Serves a built app. Port 0 picks a free port. It first checks the app's
 * routes: a route under /v1 that is not in the registry, added anywhere after
 * createApp, stops the server before it listens. Its close stops the
 * listener, waits for the open connections, and then for every request that
 * still runs and the work queued for after the answers, such as the entries
 * of a failed sign-in, so a stop that ends the database pool next loses none
 * of it. A request whose client has left has no connection to wait for, but
 * its handler still runs: each request holds a batch of the after-answer
 * queue from its start to its answer, so the queue waits for it.
 */
export function startServer(options: { readonly app: ServerApp; readonly port: number }): Promise<RunningServer> {
  return new Promise((resolve) => {
    // A throw here rejects the promise, before anything listens.
    assertV1Routes(options.app);
    const { hono, afterAnswer } = options.app;
    const fetch = async (request: Request, env: unknown): Promise<Response> => {
      const running = afterAnswer.batch();
      try {
        return await hono.fetch(request, env);
      } finally {
        running.release();
      }
    };
    const server = serve({ fetch, port: options.port }, (info: AddressInfo) => {
      resolve({
        port: info.port,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => {
              if (error) {
                fail(error);
              } else {
                done();
              }
            });
          }).then(() => options.app.afterAnswer.idle()),
      });
    });
  });
}
