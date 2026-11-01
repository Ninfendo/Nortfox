// SPDX-License-Identifier: AGPL-3.0-only

import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createApp } from "./app.ts";

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

/** Starts the server. Port 0 picks a free port. */
export function startServer(options: {
  readonly port: number;
  readonly version: string;
}): Promise<RunningServer> {
  const app = createApp({ version: options.version });
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: options.port }, (info: AddressInfo) => {
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
          }),
      });
    });
  });
}
