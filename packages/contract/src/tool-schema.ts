// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The JSON Schemas of an operation's MCP tool. A tool takes one object, the
 * operation's flat input: the query's fields, the body's fields and, for a
 * write, the idempotency key. A field problem's pointer points into the same
 * object, on REST too. The schemas come from z.toJSONSchema with every
 * reference inlined, so a client needs no $defs, and they leave out $schema:
 * MCP reads a tool schema as JSON Schema 2020-12 when it names none.
 */

import { z } from "zod";
import {
  IDEMPOTENCY_KEY_ARGUMENT,
  IDEMPOTENCY_KEY_DESCRIPTION,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
} from "./idempotency-key.ts";
import { bodySchema, outputSchema, querySchema, type Operation } from "./operation.ts";

export { IDEMPOTENCY_KEY_ARGUMENT, IDEMPOTENCY_KEY_PATTERN } from "./idempotency-key.ts";

/** A JSON Schema, as plain JSON. */
export type JsonSchema = Readonly<Record<string, unknown>>;

const DEFINITIONS = "#/$defs/";

function isObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object without some of its keys. */
function omit(node: JsonSchema, keys: readonly string[]): JsonSchema {
  return Object.fromEntries(Object.entries(node).filter(([key]) => !keys.includes(key)));
}

/** The schema with each reference to $defs replaced by its definition, and $defs left out. */
function inline(node: unknown, definitions: JsonSchema, within: readonly string[]): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => inline(item, definitions, within));
  }
  if (!isObject(node)) {
    return node;
  }
  const reference = node["$ref"];
  if (typeof reference === "string") {
    const name = reference.startsWith(DEFINITIONS) ? reference.slice(DEFINITIONS.length) : undefined;
    if (reference === "#" || (name !== undefined && within.includes(name))) {
      throw new Error("A tool schema cannot hold itself: there is no way to write it without a reference.");
    }
    if (name === undefined || !Object.hasOwn(definitions, name)) {
      throw new Error(`A tool schema refers to "${reference}", which it does not hold.`);
    }
    // A reference may carry keys of its own, such as a description; they win.
    const definition = inline(definitions[name], definitions, [...within, name]) as JsonSchema;
    const own = inline(omit(node, ["$ref"]), definitions, within) as JsonSchema;
    return { ...definition, ...own };
  }
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, inline(value, definitions, within)]));
}

/**
 * A zod schema as plain JSON Schema, with every reference inlined. "input"
 * describes what a caller sends, "output" what an answer holds.
 */
export function jsonSchemaOf(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const generated = z.toJSONSchema(schema, { io }) as JsonSchema;
  const definitions = generated["$defs"];
  return inline(omit(generated, ["$schema", "$defs"]), isObject(definitions) ? definitions : {}, []) as JsonSchema;
}

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

/** The tool's input: one strict object with the query's fields, the body's fields and, for a write, the key. */
export function toolInputSchema(operation: Operation): JsonSchema {
  const flat = z.strictObject({
    ...fieldsOf(querySchema(operation)),
    ...fieldsOf(bodySchema(operation)),
    ...(operation["x-nortfox"].writes ? { [IDEMPOTENCY_KEY_ARGUMENT]: IdempotencyKey } : {}),
  });
  return jsonSchemaOf(flat, "input");
}

/** The tool's output: the operation's success answer, the same JSON as the REST answer. */
export function toolOutputSchema(operation: Operation): JsonSchema {
  return jsonSchemaOf(outputSchema(operation), "output");
}
