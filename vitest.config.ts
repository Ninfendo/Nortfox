// SPDX-License-Identifier: AGPL-3.0-only

import { defaultClientConditions, defaultServerConditions } from "vite";
import { configDefaults, defineConfig } from "vitest/config";

// Every suite runs from this one file, as one project per package. Coverage
// floors only go up (docs/decisions/0010-quality-gates.md).
//
// The database tests (*.db.test.ts) run against real PostgreSQL, as their own
// project. Its global setup needs a test cluster: `pnpm db:test` starts one,
// and NORTFOX_TEST_DATABASE_URL points elsewhere (apps/server/test/cluster.ts).
// Without one it fails; it never skips. They run at most three files at once,
// after the other projects, so their connections fit the test cluster's
// (scripts/guards/database-workers.test.ts).

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
        test: { name: "contract", include: ["packages/contract/src/**/*.test.ts"] },
      },
      {
        extends: true,
        test: { name: "client", include: ["packages/client/{src,scripts}/**/*.test.ts"] },
      },
      {
        extends: true,
        test: {
          name: "server",
          include: ["apps/server/src/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "apps/server/src/**/*.db.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "database",
          include: ["apps/server/src/**/*.db.test.ts"],
          globalSetup: ["apps/server/test/global-setup.ts"],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          maxWorkers: 3,
          sequence: { groupOrder: 1 },
        },
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
        "apps/server/src/setup-main.ts",
        "apps/server/src/db/migrate-main.ts",
        "apps/web/src/main.tsx",
        "packages/client/scripts/generate.ts",
        "scripts/turbo.ts",
        // Test support: fakes and fixtures, used only by the tests.
        "scripts/testing/**",
      ],
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        "packages/engine/src/**": { 100: true },
        "packages/contract/src/**": { 100: true },
        "packages/client/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "apps/server/src/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "apps/web/src/**": { statements: 95, branches: 100, functions: 85, lines: 100 },
        "scripts/**": { statements: 96, branches: 92, functions: 92, lines: 96 },
      },
    },
  },
});
