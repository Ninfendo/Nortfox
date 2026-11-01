// SPDX-License-Identifier: MIT

/** The committed API description. */
export const OPENAPI_JSON = new URL("../openapi.json", import.meta.url);

/** The client source that the generator writes from it. */
export const GENERATED_TS = new URL("../src/generated.ts", import.meta.url);
