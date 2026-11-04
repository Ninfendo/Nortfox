// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The registry guard reads each entry as data and names what is wrong with
 * it. The registry's test runs it on the registry. It fails an entry with no
 * permission or no MCP tool text, a write without a required
 * Idempotency-Key header, a mark it does not know, and every other entry
 * that REST and MCP could not serve the same way.
 */

import { z } from "zod";
import { IDEMPOTENCY_KEY_ARGUMENT, IDEMPOTENCY_KEY_HEADER } from "./idempotency-key.ts";
import { COMPANY_SOURCES, METHODS, NONE, OPEN_PERMISSIONS, PUBLIC, SIGNED_IN } from "./operation.ts";
import { jsonSchemaOf, type JsonSchema } from "./tool-schema.ts";

const ID = /^[a-z][A-Za-z0-9]{0,63}$/;
const WORD = "[a-z0-9]+(-[a-z0-9]+)*";
const PARAMETER = String.raw`\{[a-z][A-Za-z0-9]*\}`;
/** /v1, a word, and then words or {parameter} segments. */
const PATH = new RegExp(`^/v1/${WORD}(/(${WORD}|${PARAMETER}))*$`);

/** The marks of x-nortfox, in the order they are read. */
const MARKS = ["permission", "tool", "assistant", "writes", "list", "session", "company"];

/** The success statuses, and what each answers. */
const JSON_SUCCESSES = ["200", "201", "303"];
const NO_BODY_SUCCESSES = ["202", "204"];

/** Keys whose values are data, not schemas, so the strictness walk skips them. */
const DATA_KEYS = new Set(["default", "examples", "const", "enum"]);

type Entry = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Entry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A value as a problem shows it: as JSON, and a missing value as undefined. */
function shown(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value);
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

/** Whether a strict object's fields are all required strings, as path parameters are. */
function requiredStrings(json: JsonSchema): boolean {
  const required = field(json, "required");
  const names = fieldNames(json);
  return names.every((name) => field(json, "properties", name, "type") === "string" && Array.isArray(required) && required.includes(name));
}

/** The idempotency key header of an entry: "required", "optional", or undefined when it declares none. */
function keyHeader(headers: unknown): "required" | "optional" | undefined {
  if (!(headers instanceof z.ZodObject) || !(IDEMPOTENCY_KEY_HEADER in headers.shape)) {
    return undefined;
  }
  const required = field(jsonSchemaOf(headers, "input"), "required");
  return Array.isArray(required) && required.includes(IDEMPOTENCY_KEY_HEADER) ? "required" : "optional";
}

/** What is wrong with the values of x-nortfox, each one by itself. */
function markProblems(name: string, meta: Entry, permissions: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const { permission, tool, writes, assistant, list, session, company } = meta;
  for (const mark of Object.keys(meta).filter((key) => !MARKS.includes(key))) {
    problems.push(`${name} has the mark ${JSON.stringify(mark)} in x-nortfox, which the registry does not know.`);
  }
  if (typeof permission !== "string" || permission.trim() === "") {
    problems.push(`${name} has no permission. An operation that reads no data says "public".`);
  } else if (!(OPEN_PERMISSIONS as readonly string[]).includes(permission) && !permissions.has(permission)) {
    problems.push(`${name} needs the permission ${JSON.stringify(permission)}, which is not on the list.`);
  }
  if (typeof tool !== "string" || tool.trim() === "") {
    problems.push(`${name} has no MCP tool text.`);
  }
  if (typeof writes !== "boolean" || typeof assistant !== "boolean" || typeof list !== "boolean") {
    problems.push(`${name} must say whether it writes, whether it is a list and whether the assistant may call it, each true or false.`);
  }
  if (session !== "flow" && session !== null) {
    problems.push(`${name} has the session mark ${shown(session)}. It is "flow" or null.`);
  }
  if (!(COMPANY_SOURCES as readonly unknown[]).includes(company)) {
    problems.push(`${name} has the company source ${shown(company)}. It is "none" or "credential".`);
  }
  return problems;
}

/** What is wrong with how the marks of a well-formed x-nortfox go together. */
function pairingProblems(name: string, meta: Entry): string[] {
  const { permission, writes, session, company } = meta;
  const problems: string[] = [];
  if (permission === PUBLIC && writes === true) {
    problems.push(`${name} is public and writes. A public operation reads and writes no data.`);
  }
  if (permission === NONE && session !== "flow") {
    problems.push(`${name} runs before sign-in, so it serves the browser's session: its session mark must be "flow".`);
  }
  if (session === "flow" && permission !== NONE && permission !== SIGNED_IN) {
    problems.push(`${name} serves the browser's session, so its permission is "none" or "signed-in", not ${JSON.stringify(permission)}.`);
  }
  const open = (OPEN_PERMISSIONS as readonly unknown[]).includes(permission);
  if (company === "credential" && open) {
    problems.push(`${name} takes its company from the credential, which only an operation that needs a permission does.`);
  }
  if (company === "none" && !open) {
    problems.push(`${name} needs the permission ${JSON.stringify(permission)}, so it takes its company from the credential, not "none".`);
  }
  return problems;
}

/** What is wrong with x-nortfox, which the other checks read. */
function metaProblems(name: string, meta: Entry, permissions: ReadonlySet<string>): string[] {
  const problems = markProblems(name, meta, permissions);
  // How the marks go together is read only when each one is right by itself.
  return problems.length > 0 ? problems : pairingProblems(name, meta);
}

/** What is wrong with a write's key: a write takes one, unless it runs before sign-in, which takes none. */
function keyProblems(name: string, entry: Entry, meta: unknown): string[] {
  const header = keyHeader(field(entry, "request", "headers"));
  if (field(meta, "permission") === NONE) {
    return header === undefined ? [] : [`${name} runs before sign-in, so it takes no idempotency key, but it declares the ${IDEMPOTENCY_KEY_HEADER} header.`];
  }
  return field(meta, "writes") === true && header !== "required" ? [`${name} writes, but takes no required ${IDEMPOTENCY_KEY_HEADER} header.`] : [];
}

/** The names a path gives in {braces}, in their order. The group always matches, at least an empty name. */
function pathNames(path: string): string[] {
  return [...path.matchAll(/\{([^}]*)\}/g)].map((match) => String(match[1]));
}

/** What is wrong with the path, and with its parameters against the path. */
function pathProblems(name: string, path: unknown, paramsSchema: unknown): { readonly problems: string[]; readonly params: JsonSchema | undefined } {
  const problems: string[] = [];
  if (typeof path !== "string" || !PATH.test(path)) {
    problems.push(
      `${name} has the path ${shown(path)}. A path is /v1/ and a lower-case kebab-case word, then more such words or {parameter} segments, with no trailing slash.`,
    );
  }
  const params = paramsSchema === undefined ? undefined : strictObject(paramsSchema);
  if (paramsSchema !== undefined && (params === undefined || !requiredStrings(params))) {
    problems.push(`${name}: its path parameters must be a strict object of required strings.`);
    return { problems, params: undefined };
  }
  const named = typeof path === "string" ? pathNames(path) : [];
  const taken = fieldNames(params);
  for (const [index, parameter] of named.entries()) {
    if (named.indexOf(parameter) !== index) {
      problems.push(`${name}'s path names {${parameter}} twice.`);
    } else if (!taken.includes(parameter)) {
      problems.push(`${name}'s path names {${parameter}}, but it takes no parameter ${parameter}.`);
    }
  }
  for (const parameter of taken.filter((each) => !named.includes(each))) {
    problems.push(`${name} takes the parameter ${parameter}, which its path does not name.`);
  }
  return { problems, params };
}

/** The success answer of an entry, and what is wrong with it. */
interface Success {
  readonly status: string | undefined;
  readonly output: JsonSchema | undefined;
  readonly problems: readonly string[];
}

/** The success statuses an entry answers: each 2xx and 3xx of its responses. */
function successStatuses(entry: Entry): string[] {
  return Object.keys(field(entry, "responses") ?? {}).filter((status) => /^[23][0-9][0-9]$/.test(status));
}

/** The success answer: exactly one of 200, 201, 202, 204 and 303, with JSON or with no body as its status asks. */
function successOf(name: string, entry: Entry): Success {
  const statuses = successStatuses(entry);
  const [status, ...more] = statuses;
  if (status === undefined) {
    return { status, output: undefined, problems: [`${name} has no success answer: 200 or 201 with JSON, 202 or 204 with no body, or 303.`] };
  }
  if (more.length > 0) {
    return { status: undefined, output: undefined, problems: [`${name} has more than one success answer: ${statuses.join(", ")}.`] };
  }
  const response = field(entry, "responses", status);
  if (NO_BODY_SUCCESSES.includes(status)) {
    const problems = field(response, "content") === undefined ? [] : [`${name} answers ${status}, which has no body, but it declares one.`];
    return { status, output: undefined, problems };
  }
  if (!JSON_SUCCESSES.includes(status)) {
    return { status: undefined, output: undefined, problems: [`${name} answers ${status}. A success is 200 or 201 with JSON, 202 or 204 with no body, or 303.`] };
  }
  const schema = field(response, "content", "application/json", "schema");
  if (schema === undefined) {
    return { status, output: undefined, problems: [`${name} answers ${status} with no application/json schema.`] };
  }
  const output = strictObject(schema);
  return { status, output, problems: output === undefined ? [`${name}: its output must be a strict object, and so must every object in it.`] : [] };
}

/** What is wrong with a redirect, and with a GET that writes. */
function redirectProblems(name: string, entry: Entry, meta: unknown, success: Success): string[] {
  const problems: string[] = [];
  const get = entry["method"] === "get";
  if (success.status === "303") {
    if (!get || field(meta, "permission") !== NONE) {
      problems.push(`${name} answers 303, which only a GET operation that runs before sign-in may do.`);
    }
    const { output } = success;
    if (output !== undefined && (fieldNames(output).join() !== "location" || !requiredStrings(output))) {
      problems.push(`${name} answers 303, so its output is the location alone, a string.`);
    }
    if (field(entry, "responses", "303", "headers", "Location") === undefined) {
      problems.push(`${name} answers 303 without a Location header.`);
    }
  } else if (get && field(meta, "writes") === true) {
    problems.push(`${name} is a GET that writes. Only a GET that runs before sign-in and answers 303 may write.`);
  }
  return problems;
}

/** What is wrong with the flat input of an MCP tool: the path's, the query's and the body's fields share no name, and none is the key's. */
function flatInputProblems(name: string, parts: readonly (readonly [string, readonly string[]])[]): string[] {
  const problems: string[] = [];
  for (const [index, [part, names]] of parts.entries()) {
    for (const [other, otherNames] of parts.slice(index + 1)) {
      for (const shared of names.filter((fieldName) => otherNames.includes(fieldName))) {
        problems.push(`${name}: the ${part} and the ${other} both have a field ${JSON.stringify(shared)}.`);
      }
    }
  }
  if (parts.some(([, names]) => names.includes(IDEMPOTENCY_KEY_ARGUMENT))) {
    problems.push(`${name} has a field "${IDEMPOTENCY_KEY_ARGUMENT}", the name of a write's key on MCP.`);
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
    problems.push(
      `${name} declares no x-nortfox: its permission, MCP tool text, assistant flag, writes flag, list flag, session mark and company source.`,
    );
  } else {
    problems.push(...metaProblems(name, meta, permissions));
  }
  problems.push(...keyProblems(name, entry, meta));
  const path = pathProblems(name, entry["path"], field(entry, "request", "params"));
  problems.push(...path.problems);
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
  const success = successOf(name, entry);
  problems.push(...success.problems, ...redirectProblems(name, entry, meta, success));

  // An MCP tool takes the path's, the query's and the body's fields in one object, beside the key.
  const queryNames = fieldNames(query);
  problems.push(
    ...flatInputProblems(name, [
      ["path", fieldNames(path.params)],
      ["query", queryNames],
      ["body", fieldNames(body)],
    ]),
  );

  if (field(meta, "list") === true) {
    const page = fieldNames(success.output);
    const paged = ["limit", "cursor"].every((fieldName) => queryNames.includes(fieldName));
    if (!paged || !["items", "nextCursor", "total"].every((fieldName) => page.includes(fieldName))) {
      problems.push(`${name} is a list, but lacks limit, cursor or a page of items, nextCursor and total.`);
    }
  }
  return problems;
}

/** A route: its method, and its path cut into segments, each a word or a parameter. */
interface Route {
  readonly label: string;
  readonly method: string;
  readonly segments: readonly string[];
}

function routeOf(entry: Entry): Route {
  const method = String(entry["method"]).toUpperCase();
  const path = String(entry["path"]);
  return { label: `${method} ${path}`, method, segments: path.split("/") };
}

/** Whether two routes can answer the same request: one method, and each segment the same word or a parameter in either. */
function overlap(a: Route, b: Route): boolean {
  const isParameter = (segment: string): boolean => segment.startsWith("{");
  return (
    a.method === b.method &&
    a.segments.length === b.segments.length &&
    a.segments.every((segment, index) => {
      // The two have as many segments, so b has one at each index of a.
      const other = String(b.segments[index]);
      return segment === other || isParameter(segment) || isParameter(other);
    })
  );
}

/**
 * Every problem of a registry: each entry's own, then the ids and routes
 * that two entries share. `permissions` lists the permissions an entry may
 * need besides "public", "none" and "signed-in". An empty list means the
 * registry passes.
 */
export function registryProblems(operations: readonly unknown[], permissions: readonly string[]): string[] {
  const known = new Set(permissions);
  const problems: string[] = [];
  const ids = new Set<unknown>();
  const routes: Route[] = [];
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
    const route = routeOf(entry);
    const same = routes.find((other) => other.label === route.label);
    if (same !== undefined) {
      duplicates.push(`Two operations have the route ${route.label}.`);
    } else {
      for (const other of routes.filter((each) => overlap(each, route))) {
        duplicates.push(`Two operations can answer the same path: ${other.label} and ${route.label}.`);
      }
    }
    routes.push(route);
  }
  return [...problems, ...duplicates];
}
