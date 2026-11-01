// SPDX-License-Identifier: AGPL-3.0-only

import type { HealthState } from "./health.ts";

export function HealthStatus({ state }: { readonly state: HealthState }) {
  switch (state.kind) {
    case "checking":
      return <p className="text-neutral-500">Checking the server…</p>;
    case "up":
      return <p>The server is up. Version {state.version}.</p>;
    case "down":
      return (
        <p role="alert" className="text-red-700 dark:text-red-400">
          {state.reason}
        </p>
      );
  }
}
