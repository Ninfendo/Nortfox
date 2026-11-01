// SPDX-License-Identifier: AGPL-3.0-only

import type { Operations } from "@nortfox/client";
import { useEffect, useState } from "react";
import { HealthStatus } from "./health-status.tsx";
import { watchHealth, type HealthState } from "./health.ts";

export function App({ client }: { readonly client: Pick<Operations, "getHealth"> }) {
  const [health, setHealth] = useState<HealthState>({ kind: "checking" });

  useEffect(() => watchHealth(client, setHealth), [client]);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-4">
      <h1 className="text-4xl font-semibold tracking-tight">NortFox</h1>
      <HealthStatus state={health} />
    </main>
  );
}
