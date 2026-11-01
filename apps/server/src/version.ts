// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";

/** Reads the version field of a package.json. */
export function parseVersion(manifestText: string): string {
  const manifest: unknown = JSON.parse(manifestText);
  if (
    typeof manifest === "object" &&
    manifest !== null &&
    "version" in manifest &&
    typeof manifest.version === "string"
  ) {
    return manifest.version;
  }
  throw new Error("The package.json has no version.");
}

/**
 * The server's version, from apps/server/package.json. The file sits one
 * folder up from both src/ and dist/, so this works in development and in a
 * build.
 */
export function readServerVersion(): string {
  return parseVersion(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
}
