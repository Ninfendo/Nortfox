// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A list takes `limit` and an opaque `cursor`, and answers its items,
 * `nextCursor` while more follow, and the total. `limit` follows the
 * established API: 1 to 500 with 100 by default, and any other whole number
 * gives 100. Only a value that is not a whole number is refused.
 */

import { z } from "zod";

export const LIMIT = { minimum: 1, maximum: 500, default: 100 } as const;

/** A whole number, also one past the safe integers or too long to read as anything but infinity. */
function isWholeNumber(value: unknown): value is number {
  return typeof value === "number" && (Number.isInteger(value) || value === Infinity || value === -Infinity);
}

/**
 * The limit a list uses for a value received: the value when it is a whole
 * number from 1 to 500, else 100 for no value or any other whole number. A
 * value that is not a whole number comes back as it is, for the schema to
 * refuse. The runner applies this before it checks the input, so the schema
 * never sees a whole number outside 1 to 500.
 */
export function effectiveLimit(value: unknown): unknown {
  if (value === undefined) {
    return LIMIT.default;
  }
  if (!isWholeNumber(value)) {
    return value;
  }
  return value >= LIMIT.minimum && value <= LIMIT.maximum ? value : LIMIT.default;
}

/**
 * The limit as the input holds it. It refuses only what is not a whole
 * number: zod's own int() takes safe integers only. Its JSON Schema says
 * integer, with no bounds, since any whole number is taken.
 */
export const Limit = z
  .number()
  .check(
    z.refine(isWholeNumber, {
      message: "must be a whole number.",
      params: { code: "not-an-integer", data: { expected: "integer" } },
    }),
  )
  .optional()
  .meta({
    type: "integer",
    default: LIMIT.default,
    description: "How many items a page holds: from 1 to 500. Any other whole number gives 100.",
  });

export const Cursor = z
  .string()
  .optional()
  .meta({ description: "Where the page starts: the nextCursor of the page before. Leave it out for the first page." });

/** A page of a list: its items, where the next page starts, and how many items the list holds. */
export function pageOf<Item extends z.ZodType>(item: Item) {
  return z
    .strictObject({
      items: z.array(item).meta({ description: "The items of this page, in the list's order." }),
      nextCursor: z.string().optional().meta({ description: "Where the next page starts. It is absent on the last page." }),
      total: z.int().min(0).meta({ description: "How many items the whole list holds." }),
    })
    .meta({ description: "A page of the list." });
}
