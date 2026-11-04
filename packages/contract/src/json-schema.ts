// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A zod schema as plain JSON Schema, with every reference inlined, so a
 * reader needs no $defs, and without $schema: MCP reads a tool schema as JSON
 * Schema 2020-12 when it names none. The tool schemas (tool-schema.ts), the
 * registry guard and the personal fields (fields.ts) read it.
 */

import { z } from "zod";

/** A JSON Schema, as plain JSON. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** What a conversion may add to the JSON Schema of each zod schema, such as a mark of its own. */
export type JsonSchemaOverride = (context: { readonly zodSchema: unknown; readonly jsonSchema: Record<string, unknown> }) => void;

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
 * describes what a caller sends, "output" what an answer holds. `override`
 * may add keys to the JSON Schema of each zod schema, before the references
 * are inlined.
 */
export function jsonSchemaOf(schema: z.ZodType, io: "input" | "output", override?: JsonSchemaOverride): JsonSchema {
  const generated = z.toJSONSchema(schema, override === undefined ? { io } : { io, override }) as JsonSchema;
  const definitions = generated["$defs"];
  return inline(omit(generated, ["$schema", "$defs"]), isObject(definitions) ? definitions : {}, []) as JsonSchema;
}
