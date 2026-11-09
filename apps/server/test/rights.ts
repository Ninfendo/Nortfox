// SPDX-License-Identifier: AGPL-3.0-only

// Test-only reads that each need one permission of the catalogue. No
// operation of slice 2c needs a catalogue permission yet: the later slices
// attach theirs. So a test that must show whether a request holds such a
// permission, beside what getMe lists, calls one of these. Each reads
// nothing and answers its permission: authorize decides before it runs, so a
// request without the permission gets 403 permission-missing, which names
// it. They live outside src, so no build holds them and openapi.json never
// shows them.

import { defineOperation, type Operation } from "@nortfox/contract";
import { z } from "zod";
import { handleData, ok, type Handler } from "../src/api/operation.ts";
import type { AppOptions } from "../src/app.ts";
import { ALL_PERMISSIONS, TEST_REGISTRY, testHandlers } from "./api.ts";

/** What a right check answers: the permission it needs. */
const RightChecked = z.strictObject({ permission: z.string().meta({ description: "The permission the read needs." }) });

/** The path of the check of `permission`: its words in kebab-case, such as /v1/test-rights/vouchers-view. */
export function rightPath(permission: string): string {
  return `/v1/test-rights/${permission.replaceAll(/[.:]/g, "-")}`;
}

/** The operation id of the check of `permission`, in camelCase, such as testRightVouchersView. */
function rightId(permission: string): string {
  return `testRight${permission
    .split(/[.:-]/)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join("")}`;
}

/** A test-only read that needs `permission`, and its handler. */
export function rightCheck(permission: string): { readonly operation: Operation; readonly handler: Handler } {
  const operation = defineOperation({
    id: rightId(permission),
    method: "get",
    path: rightPath(permission),
    tags: ["test"],
    summary: "Check a permission",
    description: `Reads nothing, and needs the permission ${permission}. Only the tests serve it.`,
    output: RightChecked,
    permission,
    tool: `Reads nothing, and needs the permission ${permission}. Only the tests serve it.`,
    writes: false,
  });
  return { operation, handler: handleData(operation, () => Promise.resolve(ok({ permission }))) };
}

/** The test app's options with a check of each of `permissions` beside its registry and handlers. */
export function withRightChecks(permissions: readonly string[]): Partial<AppOptions> {
  const checks = permissions.map(rightCheck);
  return {
    registry: [...TEST_REGISTRY, ...checks.map((check) => check.operation)],
    handlers: [...testHandlers(), ...checks.map((check) => check.handler)],
    permissions: [...ALL_PERMISSIONS, ...permissions],
  };
}
