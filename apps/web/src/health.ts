// SPDX-License-Identifier: AGPL-3.0-only

import { ApiError, type Operations } from "@nortfox/client";

export type HealthState =
  | { readonly kind: "checking" }
  | { readonly kind: "up"; readonly version: string }
  | { readonly kind: "down"; readonly reason: string };

/** Asks the server how it is. It never throws: a failure is a "down" state. */
export async function loadHealth(
  client: Pick<Operations, "getHealth">,
  signal: AbortSignal,
): Promise<HealthState> {
  try {
    const health = await client.getHealth({ signal });
    return { kind: "up", version: health.version };
  } catch (error) {
    if (error instanceof ApiError) {
      return { kind: "down", reason: `The server answered with status ${String(error.status)}.` };
    }
    return { kind: "down", reason: "The server could not be reached." };
  }
}

/**
 * Loads the health once and hands it to `show`, unless the caller gave up
 * first. Returns the function that gives up, for a React effect's cleanup.
 */
export function watchHealth(
  client: Pick<Operations, "getHealth">,
  show: (state: HealthState) => void,
): () => void {
  const controller = new AbortController();
  void loadHealth(client, controller.signal).then((state) => {
    if (!controller.signal.aborted) {
      show(state);
    }
  });
  return () => {
    controller.abort();
  };
}
