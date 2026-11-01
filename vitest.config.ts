// SPDX-License-Identifier: AGPL-3.0-only

import { defaultClientConditions, defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// Every suite runs from this one file, as one project per package. Coverage
// floors only go up (docs/decisions/0010-quality-gates.md).

export default defineConfig({
  resolve: {
    conditions: ["@nortfox/source", ...defaultClientConditions],
  },
  ssr: {
    resolve: {
      conditions: ["@nortfox/source", ...defaultServerConditions],
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "engine", include: ["packages/engine/src/**/*.test.ts"] },
      },
      {
        extends: true,
        test: { name: "client", include: ["packages/client/{src,scripts}/**/*.test.ts"] },
      },
      {
        extends: true,
        test: { name: "server", include: ["apps/server/src/**/*.test.ts"] },
      },
      {
        extends: true,
        test: { name: "web", include: ["apps/web/src/**/*.test.{ts,tsx}"] },
      },
      {
        extends: true,
        test: { name: "scripts", include: ["scripts/**/*.test.ts"], testTimeout: 60_000 },
      },
    ],
    coverage: {
      provider: "v8",
      include: [
        "packages/*/src/**/*.{ts,tsx}",
        "packages/*/scripts/**/*.ts",
        "apps/*/src/**/*.{ts,tsx}",
        "scripts/**/*.ts",
      ],
      exclude: [
        "**/*.test.{ts,tsx}",
        // Entry points: each only wires the tested parts together and starts
        // them. The tests start the same parts directly.
        "apps/server/src/main.ts",
        "apps/web/src/main.tsx",
        "packages/client/scripts/generate.ts",
        "scripts/turbo.ts",
        // Test support: fakes and fixtures, used only by the tests.
        "scripts/testing/**",
      ],
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        "packages/engine/src/**": { 100: true },
        "packages/client/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "apps/server/src/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "apps/web/src/**": { statements: 95, branches: 100, functions: 85, lines: 100 },
        "scripts/**": { statements: 96, branches: 92, functions: 92, lines: 96 },
      },
    },
  },
});
