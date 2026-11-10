// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The marks of an output's fields that the server must know of.
 *
 * personal() marks a person's contact data: a person's name, an e-mail
 * address, a phone or mobile number, a personnummer. The registry derives
 * each operation's list of them from its output schema, personalOutput in
 * x-nortfox, so a marked field can never be left off its list: a mark that
 * no pointer reaches stops the operation's definition. The runner
 * keeps the idempotency key of a write whose answer holds one out of every
 * company table, so no person's contact data reaches the stored answer of a
 * company table, and with it the append-only history (docs/api.md).
 *
 * secret() marks a value that works as a credential: a token, a code, an
 * otpauth URI, a URL that carries a code or a state. The registry derives
 * secretOutput the same way. The runner keeps the answer of a write's key
 * without its secret fields, so no secret is stored, and a repeat of the
 * key gets answer-shown-once. The registry guard refuses a secret field in
 * the output of an operation that a token may call, so no token and no MCP
 * client ever gets a credential in an answer.
 *
 * A mark sits on the schema object itself. A method such as meta() or max()
 * makes a copy, which has no mark, so a field is marked last: optional() and
 * nullable() may follow, since they wrap the marked schema.
 */

import type { z } from "zod";
import { jsonSchemaOf, type JsonSchema } from "./json-schema.ts";

/** One kind of mark: the schemas it marks, its key in the JSON Schema that the pointers are read from, and its names in the texts. */
interface Mark {
  readonly marked: WeakSet<object>;
  /** The key that marks a field in the JSON Schema that the walk reads. It never reaches openapi.json. */
  readonly key: string;
  readonly helper: string;
  readonly reader: string;
}

const PERSONAL: Mark = { marked: new WeakSet<object>(), key: "x-nortfox-personal", helper: "personal()", reader: "personalPointers" };
const SECRET: Mark = { marked: new WeakSet<object>(), key: "x-nortfox-secret", helper: "secret()", reader: "secretPointers" };

/** Marks a field of an output as a person's contact data, and gives the same schema back. */
export function personal<T extends z.ZodType>(schema: T): T {
  PERSONAL.marked.add(schema);
  return schema;
}

/** Whether personal() marked the schema. */
export function isPersonal(schema: z.ZodType): boolean {
  return PERSONAL.marked.has(schema);
}

/** Marks a field of an output as a secret that works as a credential, and gives the same schema back. */
export function secret<T extends z.ZodType>(schema: T): T {
  SECRET.marked.add(schema);
  return schema;
}

/** Whether secret() marked the schema. */
export function isSecret(schema: z.ZodType): boolean {
  return SECRET.marked.has(schema);
}

function isObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A field's name as a segment of a JSON Pointer (RFC 6901). */
function segment(name: string): string {
  return `/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

/** The keys whose schemas each describe the same field as the node: the branches of a union (a nullable field is one of the value and null) and the parts of an intersection. */
const SAME_FIELD = ["anyOf", "oneOf", "allOf"] as const;

/** Each node under `node` that has the mark's key, by its pointer: the fields of an object by name, the items of a list or a tuple and the values of a record as *. */
function walk(node: unknown, key: string, pointer: string, found: string[]): void {
  if (!isObject(node)) {
    return;
  }
  if (node[key] === true) {
    found.push(pointer);
  }
  for (const same of SAME_FIELD) {
    const branches = node[same];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        walk(branch, key, pointer, found);
      }
    }
  }
  const properties = node["properties"];
  if (isObject(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      walk(child, key, `${pointer}${segment(name)}`, found);
    }
  }
  walk(node["items"], key, `${pointer}/*`, found);
  const prefixItems = node["prefixItems"];
  if (Array.isArray(prefixItems)) {
    for (const item of prefixItems) {
      walk(item, key, `${pointer}/*`, found);
    }
  }
  walk(node["additionalProperties"], key, `${pointer}/*`, found);
}

/** How many marks `node` holds anywhere, whatever key they sit under. */
function marksIn(node: unknown, key: string): number {
  if (Array.isArray(node)) {
    return node.reduce<number>((sum, item) => sum + marksIn(item, key), 0);
  }
  if (!isObject(node)) {
    return 0;
  }
  // A field may have the mark's name: its schema is read like any other.
  return Object.entries(node).reduce((sum, [name, value]) => sum + (name === key && value === true ? 1 : marksIn(value, key)), 0);
}

/** The JSON Pointers of the fields of an output that `mark` marks, or a throw for a mark that no pointer reaches. */
function pointersOf(schema: z.ZodType, mark: Mark): string[] {
  const json = jsonSchemaOf(schema, "output", ({ zodSchema, jsonSchema }) => {
    if (typeof zodSchema === "object" && zodSchema !== null && mark.marked.has(zodSchema)) {
      jsonSchema[mark.key] = true;
    }
  });
  const found: string[] = [];
  walk(json, mark.key, "", found);
  const missed = marksIn(json, mark.key) - found.length;
  if (missed > 0) {
    throw new Error(
      `The output holds ${mark.helper} marks that no JSON Pointer reaches (${String(missed)}), under a key that ${mark.reader} does not follow. Mark the field that holds each one.`,
    );
  }
  return [...new Set(found)];
}

/**
 * The JSON Pointers of the personal fields of an output, in the order of its
 * fields: "/user/email" for a field of a field, and the segment "*" for every
 * item of a list or a tuple and every value of a record, so the e-mail of
 * each item of a page is "/items", "*" and "/email" in a row. Each branch of
 * a union and each part of an intersection is the same field. The output's
 * own pointer is "". A mark that no pointer reaches, such as on the keys of
 * a record, throws: the field that holds it is marked instead, so a marked
 * field is never left off its list.
 */
export function personalPointers(schema: z.ZodType): string[] {
  return pointersOf(schema, PERSONAL);
}

/** The JSON Pointers of the secret fields of an output, read as personalPointers reads the personal ones. */
export function secretPointers(schema: z.ZodType): string[] {
  return pointersOf(schema, SECRET);
}
