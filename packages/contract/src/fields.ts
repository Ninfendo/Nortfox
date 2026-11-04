// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The marks of an output's fields that the server must know of.
 *
 * personal() marks a person's contact data: a person's name, an e-mail
 * address, a phone or mobile number, a personnummer. The registry derives
 * each operation's list of them from its output schema, personalOutput in
 * x-nortfox, so a marked field can never be left off its list. The runner
 * keeps the idempotency key of a write whose answer holds one out of every
 * company table, so no person's contact data reaches the stored answer of a
 * company table, and with it the append-only history (docs/api.md).
 *
 * The mark sits on the schema object itself. A method such as meta() or
 * max() makes a copy, which has no mark, so a field is marked last: optional()
 * and nullable() may follow, since they wrap the marked schema.
 */

import type { z } from "zod";
import { jsonSchemaOf, type JsonSchema } from "./json-schema.ts";

const PERSONAL = new WeakSet<object>();

/** The key that marks a personal field in the JSON Schema that personalPointers reads. It never reaches openapi.json. */
const MARK = "x-nortfox-personal";

/** Marks a field of an output as a person's contact data, and gives the same schema back. */
export function personal<T extends z.ZodType>(schema: T): T {
  PERSONAL.add(schema);
  return schema;
}

/** Whether personal() marked the schema. */
export function isPersonal(schema: z.ZodType): boolean {
  return PERSONAL.has(schema);
}

function isObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A field's name as a segment of a JSON Pointer (RFC 6901). */
function segment(name: string): string {
  return `/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

/** Each marked node under `node`, by its pointer: the fields of an object by name, the items of a list as *. */
function walk(node: unknown, pointer: string, found: string[]): void {
  if (!isObject(node)) {
    return;
  }
  if (node[MARK] === true) {
    found.push(pointer);
  }
  // A nullable field's JSON Schema is a union of the value and null: each branch is the same field.
  const branches = node["anyOf"];
  if (Array.isArray(branches)) {
    for (const branch of branches) {
      walk(branch, pointer, found);
    }
  }
  const properties = node["properties"];
  if (isObject(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      walk(child, `${pointer}${segment(name)}`, found);
    }
  }
  walk(node["items"], `${pointer}/*`, found);
}

/**
 * The JSON Pointers of the personal fields of an output, in the order of its
 * fields: "/user/email" for a field of a field, and the segment "*" for every
 * item of a list, so the e-mail of each item of a page is "/items", "*" and
 * "/email" in a row. The output's own pointer is "".
 */
export function personalPointers(schema: z.ZodType): string[] {
  const json = jsonSchemaOf(schema, "output", ({ zodSchema, jsonSchema }) => {
    if (typeof zodSchema === "object" && zodSchema !== null && PERSONAL.has(zodSchema)) {
      jsonSchema[MARK] = true;
    }
  });
  const found: string[] = [];
  walk(json, "", found);
  return [...new Set(found)];
}
