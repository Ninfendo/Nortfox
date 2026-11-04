// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The JSON Schemas of an operation's MCP tool. A tool takes one object, the
 * operation's flat input: the path parameters, the query's fields, the body's
 * fields and, for a write that takes one, the idempotency key. A field
 * problem's pointer points into the same object, on REST too. The schemas
 * come from z.toJSONSchema with every reference inlined, so a client needs no
 * $defs, and they leave out $schema: MCP reads a tool schema as JSON Schema
 * 2020-12 when it names none (json-schema.ts).
 */

import { z } from "zod";
import {
  IDEMPOTENCY_KEY_ARGUMENT,
  IDEMPOTENCY_KEY_DESCRIPTION,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
} from "./idempotency-key.ts";
import { jsonSchemaOf, type JsonSchema } from "./json-schema.ts";
import { bodySchema, outputSchema, paramsSchema, querySchema, takesIdempotencyKey, type Operation } from "./operation.ts";

export { IDEMPOTENCY_KEY_ARGUMENT, IDEMPOTENCY_KEY_PATTERN } from "./idempotency-key.ts";
export { jsonSchemaOf } from "./json-schema.ts";
export type { JsonSchema } from "./json-schema.ts";

/** The fields of an object schema, or none. */
function fieldsOf(schema: z.ZodObject | undefined): z.ZodRawShape {
  return schema?.shape ?? {};
}

const IdempotencyKey = z
  .string()
  .min(1)
  .max(IDEMPOTENCY_KEY_MAX_LENGTH)
  .regex(new RegExp(IDEMPOTENCY_KEY_PATTERN))
  .meta({ description: IDEMPOTENCY_KEY_DESCRIPTION });

/** The tool's input: one strict object with the path parameters, the query's fields, the body's fields and, for a write that takes one, the key. */
export function toolInputSchema(operation: Operation): JsonSchema {
  const flat = z.strictObject({
    ...fieldsOf(paramsSchema(operation)),
    ...fieldsOf(querySchema(operation)),
    ...fieldsOf(bodySchema(operation)),
    ...(takesIdempotencyKey(operation) ? { [IDEMPOTENCY_KEY_ARGUMENT]: IdempotencyKey } : {}),
  });
  return jsonSchemaOf(flat, "input");
}

/** The tool's output: the operation's success answer, the same JSON as the REST answer. */
export function toolOutputSchema(operation: Operation): JsonSchema {
  return jsonSchemaOf(outputSchema(operation), "output");
}
