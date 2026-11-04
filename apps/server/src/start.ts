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
 * listener, waits for the open requests, and then for the work queued for
 * after their answers, such as the entries of a failed sign-in, so a stop
 * that ends the database pool next loses none of it.
 */
export function startServer(options: { readonly app: ServerApp; readonly port: number }): Promise<RunningServer> {
  return new Promise((resolve) => {
    // A throw here rejects the promise, before anything listens.
    assertV1Routes(options.app);
    const { hono } = options.app;
    const server = serve({ fetch: hono.fetch, port: options.port }, (info: AddressInfo) => {
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
