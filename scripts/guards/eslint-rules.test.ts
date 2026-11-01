// SPDX-License-Identifier: AGPL-3.0-only

// The lint rules that guard the architecture fail on a bad input: only the
// client calls the server, the engine stays pure, and each part imports only
// what docs/plan.md, section 3 allows.

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

async function rulesHit(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path });
  return (result?.messages ?? []).map((message) => message.ruleId ?? message.message);
}

describe("only the client calls the server", () => {
  it.each([
    ["apps/web/src/probe.ts", 'void fetch("/v1/health");'],
    ["apps/web/src/probe.ts", 'void globalThis.fetch("/v1/health");'],
    ["apps/web/src/probe.ts", 'void window.fetch("/v1/health");'],
    ["apps/web/src/probe.ts", "export const x = new XMLHttpRequest();"],
    ["apps/web/src/probe.ts", 'export const x = new EventSource("/v1");'],
    ["apps/web/src/probe.ts", 'navigator.sendBeacon("/v1");'],
    ["apps/server/src/probe.ts", 'void fetch("https://example.com");'],
    ["scripts/probe.ts", 'void fetch("https://example.com");'],
  ])("refuses %s: %s", async (path, code) => {
    const hits = await rulesHit(path, code);
    expect(hits.some((rule) => rule === "no-restricted-globals" || rule === "no-restricted-properties")).toBe(true);
  });

  it("lets packages/client call fetch", async () => {
    expect(await rulesHit("packages/client/src/probe.ts", 'void fetch("/v1/health");')).toEqual([]);
  });
});

describe("the engine is pure", () => {
  it.each([
    'import { readFileSync } from "node:fs";\nexport const x = readFileSync;',
    'import { join } from "path";\nexport const x = join;',
    'import { readFile } from "fs/promises";\nexport const x = readFile;',
    'export const x = import("node:os");',
    "export const now = Date.now();",
    "export const x = process.env;",
    "export const r = Math.random();",
    'export const t = setTimeout(() => undefined, 1);',
  ])("refuses %j", async (code) => {
    const hits = await rulesHit("packages/engine/src/probe.ts", code);
    expect(
      hits.some((rule) => ["no-restricted-syntax", "no-restricted-globals", "no-restricted-properties"].includes(rule)),
    ).toBe(true);
  });

  it("lets an npm package that only starts like a Node module through", async () => {
    expect(await rulesHit("packages/engine/src/probe.ts", 'import x from "fsevents";\nexport const y = x;')).toEqual([]);
  });
});

describe("who may import whom", () => {
  it.each([
    ["packages/engine/src/probe.ts", "@nortfox/client"],
    ["packages/client/src/probe.ts", "@nortfox/engine"],
    ["apps/server/src/probe.ts", "@nortfox/client"],
    ["apps/server/src/probe.ts", "@nortfox/web"],
    ["apps/web/src/probe.ts", "@nortfox/server"],
    ["scripts/probe.ts", "@nortfox/server"],
    ["apps/web/src/probe.ts", "../../../packages/engine/src/money.ts"],
  ])("refuses %s importing %s", async (path, from) => {
    const hits = await rulesHit(path, `import { x } from "${from}";\nexport const y = x;`);
    expect(hits).toContain("no-restricted-imports");
  });

  it.each([
    ["apps/web/src/probe.ts", "@nortfox/client"],
    ["apps/web/src/probe.ts", "@nortfox/engine"],
    ["apps/server/src/probe.ts", "@nortfox/engine"],
  ])("lets %s import %s", async (path, from) => {
    expect(await rulesHit(path, `import { x } from "${from}";\nexport const y = x;`)).toEqual([]);
  });
});
