// SPDX-License-Identifier: AGPL-3.0-only

// The architecture rules hold in every part of the repository at once. In a
// flat config, a later block that sets a rule replaces what an earlier block
// set, so these probes lint the same code in each part with the real config:
// the network ban still holds where the engine's purity rules also apply, the
// purity rules see re-exports and the global object, and the import rules see
// paths inside a package, import() and require().

import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({
  cwd: fileURLToPath(new URL("../..", import.meta.url)),
  // The probes are not files in a TypeScript project, so the type-aware rules
  // are off here; the rules under test need no types.
  overrideConfig: [tseslint.configs.disableTypeChecked],
});

interface Hit {
  readonly rule: string;
  readonly message: string;
}

async function hits(path: string, code: string): Promise<Hit[]> {
  const [result] = await eslint.lintText(code, { filePath: path });
  return (result?.messages ?? []).map((message) => ({ rule: message.ruleId ?? "", message: message.message }));
}

const CALL_SERVER = "Call the server through @nortfox/client.";
const PURE = "The engine is pure";

const networkCalls = [
  'void fetch("/v1/health");',
  'void globalThis.fetch("/v1/health");',
  'void window.fetch("/v1/health");',
  'void self.fetch("/v1/health");',
  'void global.fetch("/v1/health");',
  "export const x = new XMLHttpRequest();",
  "export const x = new globalThis.XMLHttpRequest();",
  'export const x = new EventSource("/v1");',
  'export const x = new window.EventSource("/v1");',
  'export const x = new WebSocket("wss://x.example");',
  'export const x = new self.WebSocket("wss://x.example");',
  'navigator.sendBeacon("/v1");',
  'navigator["sendBeacon"]("/v1");',
  'globalThis.navigator.sendBeacon("/v1");',
  'window.navigator["sendBeacon"]("/v1");',
  "export const { sendBeacon } = navigator;",
];

const outsideTheClient = [
  "packages/engine/src/probe.ts",
  "packages/engine/src/probe.test.ts",
  "packages/engine/scripts/probe.ts",
  "apps/server/src/probe.ts",
  "apps/server/scripts/probe.ts",
  "apps/web/src/probe.ts",
  "apps/web/src/probe.tsx",
  "apps/web/probe.config.ts",
  "scripts/probe.ts",
  "probe.config.ts",
];

describe("only the client calls the server, in every part of the repository", () => {
  it.each(outsideTheClient.flatMap((path) => networkCalls.map((code) => [path, code] as const)))(
    "refuses %s: %s",
    async (path, code) => {
      const found = await hits(path, code);
      expect(found.some((hit) => hit.message.includes(CALL_SERVER)), JSON.stringify(found)).toBe(true);
    },
  );

  it.each(["packages/client/src/probe.ts", "packages/client/scripts/probe.ts"].flatMap((path) => networkCalls.map((code) => [path, code] as const)))(
    "lets %s do it: %s",
    async (path, code) => {
      expect(await hits(path, code)).toEqual([]);
    },
  );

  it("lets a method that is only called fetch through", async () => {
    expect(await hits("apps/server/src/probe.ts", "const app = { fetch: () => 1 };\nexport const x = app.fetch();")).toEqual([]);
  });
});

describe("the engine is pure, also through re-exports and the global object", () => {
  it.each([
    'export { readFileSync } from "node:fs";',
    'export * from "fs";',
    'export * as fs from "node:fs";',
    'export { join } from "path/posix";',
    'export type { Stats } from "node:fs";',
    'export const fs = require("node:fs");',
    'import fs = require("fs");\nexport const x = fs;',
    'export type Fs = typeof import("node:fs");',
    "export const x = globalThis.process.env;",
    "export const now = globalThis.Date.now();",
    "export const d = new globalThis.Date();",
    'export const d = globalThis["Date"].now();',
    "export const r = globalThis.Math.random();",
    "export const u = globalThis.crypto.randomUUID();",
    "export const p = window.performance.now();",
    "export const e = self.process.env;",
    "export const e = global.process.env;",
    "const host = globalThis;\nexport const now = host.Date.now();",
    'export const t = new Intl.DateTimeFormat("sv").format();',
    "export const t = Temporal.Now.instant();",
    "export const i = setImmediate(() => undefined);",
  ])("refuses %j", async (code) => {
    const found = await hits("packages/engine/src/probe.ts", code);
    expect(found.some((hit) => hit.message.includes(PURE)), JSON.stringify(found)).toBe(true);
  });

  it.each([
    'export { formatSwedish } from "./money.ts";',
    'export * from "./money.ts";',
    'export * from "fsevents";',
    "export const x = Math.max(1, 2);",
  ])("lets %j through", async (code) => {
    expect(await hits("packages/engine/src/probe.ts", code)).toEqual([]);
  });

  it("lets the engine's tests use Node", async () => {
    expect(
      await hits("packages/engine/src/probe.test.ts", 'import { readFileSync } from "node:fs";\nexport const x = readFileSync;'),
    ).toEqual([]);
  });
});

describe("who may import whom, also by a path inside a package, import() or require()", () => {
  it.each([
    ["apps/server/src/probe.ts", 'import x from "@nortfox/client/openapi.json" with { type: "json" };\nexport const y = x;'],
    ["apps/server/src/probe.ts", 'export * from "@nortfox/client";'],
    ["apps/server/src/probe.ts", 'export { x } from "@nortfox/client/sub";'],
    ["apps/web/src/probe.ts", 'import { x } from "@nortfox/server/src/app.ts";\nexport const y = x;'],
    ["scripts/probe.ts", 'import { x } from "@nortfox/server/src/app.ts";\nexport const y = x;'],
    ["packages/engine/src/probe.ts", 'import x from "@nortfox/client/openapi.json" with { type: "json" };\nexport const y = x;'],
    ["packages/client/src/probe.ts", 'import { x } from "@nortfox/engine/money";\nexport const y = x;'],
  ])("refuses %s: %s", async (path, code) => {
    const found = await hits(path, code);
    expect(found.map((hit) => hit.rule)).toContain("no-restricted-imports");
  });

  it.each([
    ["apps/server/src/probe.ts", 'export const x = await import("@nortfox/client");'],
    ["apps/server/src/probe.ts", 'export const x = await import("@nortfox/client/openapi.json", { with: { type: "json" } });'],
    ["apps/server/src/probe.ts", 'export const x = require("@nortfox/client");'],
    ["apps/server/src/probe.ts", 'import x = require("@nortfox/client");\nexport const y = x;'],
    ["apps/web/src/probe.ts", 'export const x = await import("@nortfox/server");'],
    ["apps/web/src/probe.ts", 'export type App = import("@nortfox/server").App;'],
    ["apps/web/src/probe.ts", 'export const x = import("../../../packages/engine/src/money.ts");'],
    ["apps/web/src/probe.ts", 'const name = "@nortfox/server";\nexport const x = import(name);'],
    ["apps/web/src/probe.ts", "export const x = import(`@nortfox/server`);"],
    ["apps/web/src/probe.ts", 'const name = "@nortfox/server";\nexport const x = require(name);'],
    ["packages/engine/src/probe.ts", 'export const x = import("@nortfox/client");'],
    ["packages/engine/src/probe.test.ts", 'export const x = import("@nortfox/client");'],
    ["packages/client/src/probe.ts", 'export const x = import("@nortfox/engine");'],
    ["scripts/probe.ts", 'export const x = import("@nortfox/server/src/app.ts");'],
  ])("refuses %s: %s", async (path, code) => {
    const found = await hits(path, code);
    expect(found.map((hit) => hit.rule)).toContain("no-restricted-syntax");
  });

  it.each([
    ["apps/web/src/probe.ts", 'export const x = import("@nortfox/client");'],
    ["apps/web/src/probe.ts", 'import { x } from "@nortfox/engine/sub";\nexport const y = x;'],
    ["apps/web/src/probe.ts", 'export const x = import("./page.tsx");'],
    ["apps/server/src/probe.ts", 'export const x = await import("@nortfox/engine");'],
    ["apps/server/src/probe.ts", 'import { x } from "@nortfox/clientele";\nexport const y = x;'],
    ["apps/server/src/probe.ts", 'export const x = await import("node:fs");'],
  ])("lets %s: %s through", async (path, code) => {
    expect(await hits(path, code)).toEqual([]);
  });
});
