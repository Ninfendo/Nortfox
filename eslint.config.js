// SPDX-License-Identifier: AGPL-3.0-only

import js from "@eslint/js";
import { builtinModules } from "node:module";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

// The rules that guard the architecture are four core rules:
// no-restricted-imports, no-restricted-syntax, no-restricted-globals and
// no-restricted-properties. In a flat config, a later block that sets one of
// them replaces its options; it does not add to them. So every block below
// that sets them sets all four, with every restriction that holds for its
// files (see guards()), and the blocks go from broad to narrow.

/** The names of the global object. A global reached through one is still that global. */
const globalObjects = ["globalThis", "window", "self", "global"];

/**
 * A module name pattern is written once, as the source of a regular
 * expression. An esquery selector cannot hold a slash, so there each slash
 * becomes \x2F.
 */
function selectorRegex(pattern) {
  return `/${pattern.replaceAll("/", String.raw`\x2F`)}/i`;
}

/** Selectors for the ways to load a module that no-restricted-imports does not see. */
function dynamicImportsOf(pattern, message) {
  const name = selectorRegex(pattern);
  return [
    `ImportExpression[source.value=${name}]`,
    `CallExpression[callee.name="require"][arguments.0.value=${name}]`,
    `TSExternalModuleReference[expression.value=${name}]`,
    `TSImportType[argument.literal.value=${name}]`,
  ].map((selector) => ({ selector, message }));
}

/** Selectors for every way to load a module, re-exports included. */
function everyImportOf(pattern, message) {
  const name = selectorRegex(pattern);
  return [
    ...["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].map((node) => ({
      selector: `${node}[source.value=${name}]`,
      message,
    })),
    ...dynamicImportsOf(pattern, message),
  ];
}

/** import() and require() take a plain string, so the rules above can read it. */
const fixedModuleNames = [
  { selector: 'ImportExpression[source.type!="Literal"]', message: "Name the module in import() as a plain string." },
  {
    selector: 'CallExpression[callee.name="require"][arguments.0.type!="Literal"]',
    message: "Name the module in require() as a plain string.",
  },
];

/** Who may import whom (docs/plan.md, section 3). */
const workspacePackages = ["@nortfox/client", "@nortfox/engine", "@nortfox/server", "@nortfox/web"];

function onlyImports(allowed, why) {
  const forbidden = workspacePackages.filter((name) => !allowed.includes(name)).map((name) => name.slice("@nortfox/".length));
  const rules = [
    // The package itself and any path inside it: "@nortfox/client/openapi.json" too.
    { pattern: `^@nortfox/(${forbidden.join("|")})(/|$)`, message: why },
    {
      pattern: String.raw`^(\.\./)+(apps|packages|scripts)/`,
      message: "Import another part of the repository by its package name, never by a path.",
    },
  ];
  return {
    imports: rules.map(({ pattern, message }) => ({ regex: pattern, message })),
    syntax: [...rules.flatMap(({ pattern, message }) => dynamicImportsOf(pattern, message)), ...fixedModuleNames],
  };
}

const callServerMessage = "Call the server through @nortfox/client. Only packages/client may use fetch.";
const networkGlobals = ["fetch", "XMLHttpRequest", "EventSource", "WebSocket"];

/** Only the client calls the server. */
const callsNoServer = {
  globals: networkGlobals.map((name) => ({ name, message: callServerMessage })),
  properties: [
    ...globalObjects.flatMap((object) =>
      networkGlobals.map((property) => ({ object, property, message: callServerMessage })),
    ),
    { object: "navigator", property: "sendBeacon", message: callServerMessage },
  ],
  syntax: [
    {
      // sendBeacon on anything but the bare navigator, which the line above
      // covers: globalThis.navigator.sendBeacon, or navigator under another name.
      selector:
        'MemberExpression:matches([property.name="sendBeacon"], [property.value="sendBeacon"]):not([object.name="navigator"])',
      message: callServerMessage,
    },
  ],
};

const nodeModuleNames = builtinModules.filter((name) => !name.includes("/") && !name.includes(":"));
const pureMessage = "The engine is pure: pass the time, the data and the settings in.";

/** The engine is pure: no I/O, no clock, no environment, no randomness. */
const engineIsPure = {
  globals: [
    ...[
      "process",
      "Date",
      "performance",
      "setTimeout",
      "setInterval",
      "setImmediate",
      "queueMicrotask",
      "crypto",
      "console",
      // Intl reads the host's locale and time zone, and format() with no date reads the clock.
      "Intl",
    ].map((name) => ({ name, message: pureMessage })),
    ...globalObjects.map((name) => ({ name, message: "The engine is pure: it reaches no global through the global object." })),
  ],
  properties: [
    { object: "Math", property: "random", message: "The engine is pure: pass randomness in." },
    { object: "Temporal", property: "Now", message: pureMessage },
  ],
  // "node:fs", "fs" and "fs/promises", but not an npm package such as "fsevents".
  syntax: everyImportOf(`^(node:|(${nodeModuleNames.join("|")})(/|$))`, "The engine is pure: it imports no Node module."),
};

/** The four rules, each with every restriction from `parts`. */
function guards(...parts) {
  const all = (key) => parts.flatMap((part) => part[key] ?? []);
  return {
    "no-restricted-imports": ["error", { patterns: all("imports") }],
    "no-restricted-syntax": ["error", ...all("syntax")],
    "no-restricted-globals": ["error", ...all("globals")],
    "no-restricted-properties": ["error", ...all("properties")],
  };
}

const engineImports = onlyImports([], "The engine imports nothing from the repository.");

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

  // The guards, from broad to narrow. Each block sets all four rules.
  {
    ignores: ["packages/client/**"],
    rules: guards(callsNoServer),
  },
  {
    files: ["packages/client/**"],
    rules: guards(onlyImports([], "The client is generated from openapi.json and imports nothing from the repository.")),
  },
  {
    files: ["packages/engine/**"],
    rules: guards(callsNoServer, engineImports),
  },
  {
    files: ["packages/engine/src/**"],
    ignores: ["**/*.test.ts"],
    rules: guards(callsNoServer, engineImports, engineIsPure),
  },
  {
    files: ["apps/server/**"],
    rules: guards(callsNoServer, onlyImports(["@nortfox/engine"], "The server may import the engine, the contract and i18n.")),
  },
  {
    files: ["apps/web/**"],
    rules: guards(
      callsNoServer,
      onlyImports(["@nortfox/client", "@nortfox/engine"], "The web app may import the client, ui, i18n and the engine."),
    ),
  },
  {
    files: ["scripts/**"],
    rules: guards(callsNoServer, onlyImports(["@nortfox/engine"], "The repository's own checks may import the engine and the contract.")),
  },

  {
    files: ["apps/web/src/**"],
    languageOptions: { globals: globals.browser },
  },
);
