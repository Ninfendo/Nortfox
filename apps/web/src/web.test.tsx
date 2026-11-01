// SPDX-License-Identifier: AGPL-3.0-only

import { ApiError, type Health } from "@nortfox/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./app.tsx";
import { HealthStatus } from "./health-status.tsx";
import { loadHealth, watchHealth, type HealthState } from "./health.ts";

function client(answer: () => Promise<Health>) {
  return { getHealth: answer };
}

describe("loadHealth", () => {
  const signal = new AbortController().signal;

  it("reports the version of a server that is up", async () => {
    const up = client(() => Promise.resolve({ status: "ok", version: "1.2.3" }));
    await expect(loadHealth(up, signal)).resolves.toEqual({ kind: "up", version: "1.2.3" });
  });

  it("reports the status of a server that refuses", async () => {
    const refusing = client(() => Promise.reject(new ApiError(503, "GET /v1/health answered 503.")));
    await expect(loadHealth(refusing, signal)).resolves.toEqual({
      kind: "down",
      reason: "The server answered with status 503.",
    });
  });

  it("reports a server that cannot be reached", async () => {
    const gone = client(() => Promise.reject(new TypeError("fetch failed")));
    await expect(loadHealth(gone, signal)).resolves.toEqual({
      kind: "down",
      reason: "The server could not be reached.",
    });
  });
});

describe("watchHealth", () => {
  it("shows the health once it is loaded", async () => {
    const shown: HealthState[] = [];
    watchHealth(client(() => Promise.resolve({ status: "ok", version: "1.2.3" })), (state) => shown.push(state));
    await expect.poll(() => shown).toEqual([{ kind: "up", version: "1.2.3" }]);
  });

  it("shows nothing after the caller gave up, and cancels the call", async () => {
    const shown: HealthState[] = [];
    let seen: AbortSignal | undefined;
    let answer: (health: Health) => void = () => undefined;
    const slow = {
      getHealth: (options?: { signal?: AbortSignal }) => {
        seen = options?.signal;
        return new Promise<Health>((resolve) => {
          answer = resolve;
        });
      },
    };
    const stop = watchHealth(slow, (state) => shown.push(state));
    stop();
    answer({ status: "ok", version: "1.2.3" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen?.aborted).toBe(true);
    expect(shown).toEqual([]);
  });
});

describe("HealthStatus", () => {
  it("shows each state", () => {
    expect(renderToStaticMarkup(<HealthStatus state={{ kind: "checking" }} />)).toContain(
      "Checking the server…",
    );
    expect(renderToStaticMarkup(<HealthStatus state={{ kind: "up", version: "1.2.3" }} />)).toContain(
      "<p>The server is up. Version 1.2.3.</p>",
    );
    expect(
      renderToStaticMarkup(<HealthStatus state={{ kind: "down", reason: "It is down." }} />),
    ).toContain('role="alert"');
  });
});

describe("App", () => {
  it("shows the name and checks the server", () => {
    const html = renderToStaticMarkup(
      <App client={client(() => Promise.resolve({ status: "ok", version: "1.2.3" }))} />,
    );
    expect(html).toContain("NortFox");
    expect(html).toContain("Checking the server…");
  });
});
