// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The registry guard reads each entry as data and names what is wrong with
 * it. The registry's test runs it on the registry. It fails an entry with no
 * permission or no MCP tool text, a write without a required
 * Idempotency-Key header, and every other entry that REST and MCP could not
 * serve the same way.
 */

import { z } from "zod";
import { IDEMPOTENCY_KEY_ARGUMENT, IDEMPOTENCY_KEY_HEADER } from "./idempotency-key.ts";
import { METHODS, PUBLIC } from "./operation.ts";
import { jsonSchemaOf, type JsonSchema } from "./tool-schema.ts";

const ID = /^[a-z][A-Za-z0-9]{0,63}$/;
const PATH = /^\/v1(\/[a-z0-9]+(-[a-z0-9]+)*)+$/;

/** Keys whose values are data, not schemas, so the strictness walk skips them. */
const DATA_KEYS = new Set(["default", "examples", "const", "enum"]);

type Entry = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Entry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, ...path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    current = isRecord(current) ? current[key] : undefined;
  }
  return current;
}

/** Whether every object in a JSON Schema refuses unknown fields. */
function everyObjectStrict(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.every(everyObjectStrict);
  }
  if (!isRecord(node)) {
    return true;
  }
  if (node["type"] === "object" && node["additionalProperties"] !== false) {
    return false;
  }
  return Object.entries(node).every(([key, value]) => {
    if (key === "properties" && isRecord(value)) {
      // A map from field names to schemas: a field may be named "default".
      return Object.values(value).every(everyObjectStrict);
    }
    return DATA_KEYS.has(key) || everyObjectStrict(value);
  });
}

/**
 * The JSON Schema of a strict object schema, or undefined when the schema is
 * not one. It reads what the schema takes, not what it gives: zod writes
 * additionalProperties false for the output of any object, since it drops
 * unknown fields there, but only a strict object refuses them.
 */
function strictObject(schema: unknown): JsonSchema | undefined {
  if (!(schema instanceof z.ZodObject)) {
    return undefined;
  }
  const json = jsonSchemaOf(schema, "input");
  return everyObjectStrict(json) ? json : undefined;
}

/** The names of an object JSON Schema's fields. */
function fieldNames(json: JsonSchema | undefined): string[] {
  return Object.keys(field(json, "properties") ?? {});
}

/** The success answer's schema: 200's or 201's, in application/json. */
function successSchema(entry: Entry): unknown {
  for (const status of ["200", "201"]) {
    const schema = field(entry, "responses", status, "content", "application/json", "schema");
    if (schema !== undefined) {
      return schema;
    }
  }
  return undefined;
}

function hasRequiredKey(headers: unknown): boolean {
  if (!(headers instanceof z.ZodObject)) {
    return false;
  }
  const required = field(jsonSchemaOf(headers, "input"), "required");
  return Array.isArray(required) && required.includes(IDEMPOTENCY_KEY_HEADER);
}

/** What is wrong with x-nortfox, which the other checks read. */
function metaProblems(name: string, meta: Entry, permissions: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const { permission, tool, writes, assistant, list } = meta;
  if (typeof permission !== "string" || permission.trim() === "") {
    problems.push(`${name} has no permission. An operation that reads no data says "public".`);
  } else if (permission !== PUBLIC && !permissions.has(permission)) {
    problems.push(`${name} needs the permission ${JSON.stringify(permission)}, which is not on the list.`);
  }
  if (typeof tool !== "string" || tool.trim() === "") {
    problems.push(`${name} has no MCP tool text.`);
  }
  if (typeof writes !== "boolean" || typeof assistant !== "boolean" || typeof list !== "boolean") {
    problems.push(`${name} must say whether it writes, whether it is a list and whether the assistant may call it, each true or false.`);
  }
  if (permission === PUBLIC && writes === true) {
    problems.push(`${name} is public and writes. A public operation reads and writes no data.`);
  }
  return problems;
}

/** What is wrong with one entry, apart from the duplicates. */
function entryProblems(entry: Entry, name: string, permissions: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const id = entry["operationId"];
  if (typeof id !== "string" || !ID.test(id)) {
    problems.push(`The operation id ${JSON.stringify(id)} is not a camelCase tool name of at most 64 letters and digits.`);
  }
  const meta = entry["x-nortfox"];
  if (!isRecord(meta)) {
    problems.push(`${name} declares no x-nortfox: its permission, MCP tool text, assistant flag, writes flag and list flag.`);
  } else {
    problems.push(...metaProblems(name, meta, permissions));
  }
  const writes = field(meta, "writes") === true;
  if (writes && !hasRequiredKey(field(entry, "request", "headers"))) {
    problems.push(`${name} writes, but takes no required ${IDEMPOTENCY_KEY_HEADER} header.`);
  }
  const path = entry["path"];
  if (typeof path !== "string" || !PATH.test(path)) {
    problems.push(
      `${name} has the path ${JSON.stringify(path)}. A path is /v1/ and then lower-case kebab-case words, with no trailing slash and no {parameter} yet.`,
    );
  }
  const method = entry["method"];
  if (!(METHODS as readonly unknown[]).includes(method)) {
    problems.push(`${name} has the method ${JSON.stringify(method)}. An operation uses get, post, put, patch or delete.`);
  }

  const querySchema = field(entry, "request", "query");
  const query = querySchema === undefined ? undefined : strictObject(querySchema);
  if (querySchema !== undefined && query === undefined) {
    problems.push(`${name}: its query must be a strict object, and so must every object in it.`);
  }
  const bodyConfig = field(entry, "request", "body");
  const body = bodyConfig === undefined ? undefined : strictObject(field(bodyConfig, "content", "application/json", "schema"));
  if (bodyConfig !== undefined && body === undefined) {
    problems.push(`${name}: its body must be a strict object, and so must every object in it.`);
  }
  const outputSchema = successSchema(entry);
  const output = strictObject(outputSchema);
  if (outputSchema === undefined) {
    problems.push(`${name} has no 200 or 201 answer with an application/json schema.`);
  } else if (output === undefined) {
    problems.push(`${name}: its output must be a strict object, and so must every object in it.`);
  }

  // An MCP tool takes the query's and the body's fields in one object, beside the key.
  const queryNames = fieldNames(query);
  const bodyNames = fieldNames(body);
  for (const shared of queryNames.filter((fieldName) => bodyNames.includes(fieldName))) {
    problems.push(`${name}: the query and the body both have a field ${JSON.stringify(shared)}.`);
  }
  if ([...queryNames, ...bodyNames].includes(IDEMPOTENCY_KEY_ARGUMENT)) {
    problems.push(`${name} has a field "${IDEMPOTENCY_KEY_ARGUMENT}", the name of a write's key on MCP.`);
  }

  if (field(meta, "list") === true) {
    const page = fieldNames(output);
    const paged = ["limit", "cursor"].every((fieldName) => queryNames.includes(fieldName));
    if (!paged || !["items", "nextCursor", "total"].every((fieldName) => page.includes(fieldName))) {
      problems.push(`${name} is a list, but lacks limit, cursor or a page of items, nextCursor and total.`);
    }
  }
  return problems;
}

/**
 * Every problem of a registry: each entry's own, then the ids and routes
 * that two entries share. `permissions` lists the permissions an entry may
 * need besides "public". An empty list means the registry passes.
 */
export function registryProblems(operations: readonly unknown[], permissions: readonly string[]): string[] {
  const known = new Set(permissions);
  const problems: string[] = [];
  const ids = new Set<unknown>();
  const routes = new Set<string>();
  const duplicates: string[] = [];
  for (const [index, entry] of operations.entries()) {
    if (!isRecord(entry)) {
      problems.push(`entry ${String(index)} is not a route object.`);
      continue;
    }
    const id = entry["operationId"];
    problems.push(...entryProblems(entry, typeof id === "string" && id !== "" ? id : `entry ${String(index)}`, known));
    if (ids.has(id)) {
      duplicates.push(`Two operations have the id ${JSON.stringify(id)}.`);
    }
    ids.add(id);
    const route = `${String(entry["method"]).toUpperCase()} ${String(entry["path"])}`;
    if (routes.has(route)) {
      duplicates.push(`Two operations have the route ${route}.`);
    }
    routes.add(route);
  }
  return [...problems, ...duplicates];
}
