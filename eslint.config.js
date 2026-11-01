// SPDX-License-Identifier: AGPL-3.0-only

import js from "@eslint/js";
import { builtinModules } from "node:module";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Who may import whom (docs/plan.md, section 3). */
const workspacePackages = ["@nortfox/client", "@nortfox/engine", "@nortfox/server", "@nortfox/web"];

function onlyImports(allowed, why) {
  return {
    "no-restricted-imports": [
      "error",
      {
        paths: workspacePackages
          .filter((name) => !allowed.includes(name))
          .map((name) => ({ name, message: why })),
        patterns: [
          {
            regex: "^(\\.\\./)+(apps|packages|scripts)/",
            message: "Import another part of the repository by its package name, never by a path.",
          },
        ],
      },
    ],
  };
}

// esquery regexes cannot hold a slash, so "fs/promises" is matched as "fs" plus
// a lookahead.
const nodeModuleNames = builtinModules.filter((name) => !name.includes("/"));
const nodeModule = `/^(node:|(${nodeModuleNames.join("|")})(?![A-Za-z0-9_-]))/`;

const callServerMessage = "Call the server through @nortfox/client. Only packages/client may use fetch.";

export default defineConfig(
  globalIgnores(["**/dist/", "**/coverage/", "**/.turbo/", "**/node_modules/"]),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
      reportUnusedInlineConfigs: "error",
    },
    rules: {
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
      eqeqeq: "error",
      "no-console": ["error", { allow: ["log", "error"] }],
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },

  // Only the client calls the server.
  {
    ignores: ["packages/client/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: callServerMessage },
        { name: "XMLHttpRequest", message: callServerMessage },
        { name: "EventSource", message: callServerMessage },
        { name: "WebSocket", message: callServerMessage },
      ],
      "no-restricted-properties": [
        "error",
        { object: "globalThis", property: "fetch", message: callServerMessage },
        { object: "window", property: "fetch", message: callServerMessage },
        { object: "self", property: "fetch", message: callServerMessage },
        { object: "navigator", property: "sendBeacon", message: callServerMessage },
      ],
    },
  },

  // The import rules.
  {
    files: ["packages/engine/**"],
    rules: onlyImports([], "The engine imports nothing from the repository."),
  },
  {
    files: ["packages/client/**"],
    rules: onlyImports([], "The client is generated from openapi.json and imports nothing from the repository."),
  },
  {
    files: ["apps/server/**"],
    rules: onlyImports(["@nortfox/engine"], "The server may import the engine, the contract and i18n."),
  },
  {
    files: ["apps/web/**"],
    rules: onlyImports(["@nortfox/client", "@nortfox/engine"], "The web app may import the client, ui, i18n and the engine."),
  },
  {
    files: ["scripts/**"],
    rules: onlyImports(["@nortfox/engine"], "The repository's own checks may import the engine and the contract."),
  },

  // The engine is pure: no I/O, no clock, no environment.
  {
    files: ["packages/engine/src/**"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...["process", "Date", "performance", "setTimeout", "setInterval", "queueMicrotask", "crypto", "console", "fetch"].map(
          (name) => ({ name, message: "The engine is pure: pass the time, the data and the settings in." }),
        ),
      ],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "The engine is pure: pass randomness in." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: `ImportDeclaration[source.value=${nodeModule}]`,
          message: "The engine is pure: it imports no Node module.",
        },
        {
          selector: `ImportExpression[source.value=${nodeModule}]`,
          message: "The engine is pure: it imports no Node module.",
        },
      ],
    },
  },

  {
    files: ["apps/web/src/**"],
    languageOptions: { globals: globals.browser },
  },
);
