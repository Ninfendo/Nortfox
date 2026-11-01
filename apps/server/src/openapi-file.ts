// SPDX-License-Identifier: AGPL-3.0-only

/** Where the committed API description lives: beside the MIT client. */
export const OPENAPI_FILE = new URL("../../../packages/client/openapi.json", import.meta.url);

/** Says what to do when the committed file is not what the routes give. */
export function openApiDrift(committed: string, current: string): string | undefined {
  if (committed.replaceAll("\r\n", "\n") === current) {
    return undefined;
  }
  return "packages/client/openapi.json is out of date. Run `pnpm openapi` and commit the result.";
}
