// SPDX-License-Identifier: MIT

// Turns openapi.json into src/generated.ts: one TypeScript type per schema and
// one method per operation. It knows the parts of OpenAPI 3.1 that the API
// uses so far, and refuses anything else by name, so a new kind of operation
// fails here instead of turning into a wrong type or a missing method. Each
// key of the document, of a path item and of an operation is one it reads,
// one that only documents, or one it refuses.

export class GeneratorError extends Error {
  override readonly name = "GeneratorError";
}

type Json = Readonly<Record<string, unknown>>;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Every HTTP method a path item can hold. Only GET is supported yet. */
const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace", "query"]);

/** The keys the generator reads or that only document. Any other key is refused. */
const DOCUMENT_KEYS = new Set(["openapi", "info", "components", "paths", "webhooks", "tags", "externalDocs"]);
const PATH_ITEM_KEYS = new Set(["get", "summary", "description"]);
const OPERATION_KEYS = new Set([
  "operationId",
  "summary",
  "description",
  "tags",
  "externalDocs",
  "parameters",
  "requestBody",
  "responses",
  "x-nortfox",
]);

/**
 * The keys of x-nortfox, NortFox's own parts of an operation. The generator
 * reads the permission; the others only document, for the server and MCP.
 */
const NORTFOX_KEYS = new Set(["permission", "tool", "assistant", "writes", "list"]);

/** The permission of an operation that reads no data. */
const PUBLIC = "public";

/** Keys that would change a type, which the generator cannot express yet. */
const UNSUPPORTED_KEYS = [
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "prefixItems",
  "patternProperties",
  "$defs",
  "dependentSchemas",
] as const;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, where: string): Json {
  if (!isJson(value)) {
    throw new GeneratorError(`${where} must be an object.`);
  }
  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw new GeneratorError(`${where} must be a string.`);
  }
  return value;
}

function optionalText(value: unknown, where: string): string | undefined {
  return value === undefined ? undefined : text(value, where);
}

function refuseOtherKeys(value: Json, known: ReadonlySet<string>, where: string): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw new GeneratorError(`${where} uses "${key}", which the generator does not support yet.`);
    }
  }
}

function identifier(value: string, where: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new GeneratorError(`${where} "${value}" is not a TypeScript identifier.`);
  }
  return value;
}

function comment(lines: readonly string[], indent: string): string[] {
  const body = lines
    .join("\n")
    .replaceAll("*/", "*\\/")
    .split("\n")
    .map((line) => (line === "" ? `${indent} *` : `${indent} * ${line}`));
  return [`${indent}/**`, ...body, `${indent} */`];
}

function docLines(schema: Json, where: string): string[] {
  const description = optionalText(schema["description"], `${where}.description`);
  return description === undefined ? [] : [description];
}

function literal(value: unknown, where: string): string {
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  throw new GeneratorError(`${where} may only hold strings or booleans.`);
}

function union(parts: readonly string[]): string {
  return parts.join(" | ");
}

function typeOf(value: unknown, where: string, indent: string): string {
  const schema = record(value, where);
  for (const key of UNSUPPORTED_KEYS) {
    if (key in schema) {
      throw new GeneratorError(`${where} uses "${key}", which the generator does not support yet.`);
    }
  }
  if (schema["additionalProperties"] !== undefined && schema["additionalProperties"] !== false && !isFacts(schema)) {
    throw new GeneratorError(
      `${where} uses "additionalProperties", which the generator does not support yet.`,
    );
  }
  const ref = schema["$ref"];
  if (ref !== undefined) {
    const target = text(ref, `${where}.$ref`);
    const prefix = "#/components/schemas/";
    if (!target.startsWith(prefix)) {
      throw new GeneratorError(`${where}.$ref must point into ${prefix}.`);
    }
    return identifier(target.slice(prefix.length), `${where}.$ref`);
  }
  if ("const" in schema) {
    return literal(schema["const"], `${where}.const`);
  }
  const values = schema["enum"];
  if (values !== undefined) {
    if (!Array.isArray(values) || values.length === 0) {
      throw new GeneratorError(`${where}.enum must be a list with at least one value.`);
    }
    return union(values.map((item, index) => literal(item, `${where}.enum[${String(index)}]`)));
  }
  const type = schema["type"];
  const types: unknown[] = Array.isArray(type) ? type : [type];
  return union(types.map((name) => namedType(name, schema, where, indent)));
}

/**
 * An object of any facts, such as a refusal's data: no properties of its
 * own, and any value under any name. Its type is a record of unknown values.
 */
function isFacts(schema: Json): boolean {
  const extra = schema["additionalProperties"];
  return isJson(extra) && Object.keys(extra).length === 0 && schema["properties"] === undefined;
}

function namedType(name: unknown, schema: Json, where: string, indent: string): string {
  switch (name) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const item = typeOf(schema["items"], `${where}.items`, indent);
      return item.includes(" ") ? `ReadonlyArray<${item}>` : `readonly ${item}[]`;
    }
    case "object":
      return isFacts(schema) ? "Readonly<Record<string, unknown>>" : objectType(schema, where, indent);
    default:
      throw new GeneratorError(`${where} needs a type, a $ref, a const or an enum.`);
  }
}

function propertyName(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function objectBody(schema: Json, where: string, indent: string): string[] {
  const properties = record(schema["properties"] ?? {}, `${where}.properties`);
  const requiredList: unknown = schema["required"] ?? [];
  if (!Array.isArray(requiredList)) {
    throw new GeneratorError(`${where}.required must be a list.`);
  }
  const required = new Set(requiredList.map((item, index) => text(item, `${where}.required[${String(index)}]`)));
  const inner = `${indent}  `;
  const lines: string[] = [];
  for (const [name, property] of Object.entries(properties)) {
    const at = `${where}.properties.${name}`;
    const docs = docLines(record(property, at), at);
    if (docs.length > 0) {
      lines.push(...comment(docs, inner));
    }
    const optional = required.has(name) ? "" : "?";
    lines.push(`${inner}readonly ${propertyName(name)}${optional}: ${typeOf(property, at, inner)};`);
  }
  return lines;
}

function objectType(schema: Json, where: string, indent: string): string {
  const body = objectBody(schema, where, indent);
  return body.length === 0 ? "Record<string, never>" : ["{", ...body, `${indent}}`].join("\n");
}

function declaration(name: string, schema: Json, where: string): string[] {
  const docs = docLines(schema, where);
  const head = docs.length > 0 ? comment(docs, "") : [];
  if (schema["type"] === "object" && schema["$ref"] === undefined) {
    typeOf(schema, where, "");
    return [...head, `export interface ${name} {`, ...objectBody(schema, where, ""), "}"];
  }
  return [...head, `export type ${name} = ${typeOf(schema, where, "")};`];
}

interface Operation {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly summary: string | undefined;
  readonly description: string | undefined;
  readonly permission: string | undefined;
  readonly result: string;
}

/** The permission in an operation's x-nortfox, or undefined when it has none. */
function permissionOf(value: unknown, where: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const meta = record(value, where);
  refuseOtherKeys(meta, NORTFOX_KEYS, where);
  return text(meta["permission"], `${where}.permission`);
}

function resultType(responses: Json, where: string): string {
  for (const status of ["200", "201"]) {
    const response = responses[status];
    if (response === undefined) {
      continue;
    }
    const content = record(record(response, `${where}.${status}`)["content"], `${where}.${status}.content`);
    const json = record(content["application/json"], `${where}.${status}.content["application/json"]`);
    return typeOf(json["schema"], `${where}.${status}.content["application/json"].schema`, "");
  }
  throw new GeneratorError(`${where} needs a 200 or 201 response with JSON.`);
}

function operation(path: string, value: unknown): Operation {
  const where = `paths["${path}"].get`;
  const entry = record(value, where);
  refuseOtherKeys(entry, OPERATION_KEYS, where);
  const parameters = entry["parameters"];
  const noParameters = parameters === undefined || (Array.isArray(parameters) && parameters.length === 0);
  if (path.includes("{") || !noParameters) {
    throw new GeneratorError(`${where}: parameters are not supported yet.`);
  }
  if (entry["requestBody"] !== undefined) {
    throw new GeneratorError(`${where}: a request body is not supported yet.`);
  }
  return {
    id: identifier(text(entry["operationId"], `${where}.operationId`), `${where}.operationId`),
    method: "GET",
    path,
    summary: optionalText(entry["summary"], `${where}.summary`),
    description: optionalText(entry["description"], `${where}.description`),
    permission: permissionOf(entry["x-nortfox"], `${where}.x-nortfox`),
    result: resultType(record(entry["responses"], `${where}.responses`), `${where}.responses`),
  };
}

function operations(document: Json): Operation[] {
  const paths = record(document["paths"], "paths");
  const found: Operation[] = [];
  for (const path of Object.keys(paths).sort()) {
    const where = `paths["${path}"]`;
    const item = record(paths[path], where);
    for (const key of Object.keys(item)) {
      if (METHODS.has(key) && key !== "get") {
        throw new GeneratorError(`${where}.${key}: only GET operations are supported yet.`);
      }
    }
    // Parameters, servers or a $ref on the path item would change every call under it.
    refuseOtherKeys(item, PATH_ITEM_KEYS, where);
    if (item["get"] !== undefined) {
      found.push(operation(path, item["get"]));
    }
  }
  return found;
}

function operationDocs(operation: Operation): string[] {
  const parts = [operation.summary, operation.description].filter(
    (part): part is string => part !== undefined,
  );
  const lines = [...parts.flatMap((part) => [part, ""]), `\`${operation.method} ${operation.path}\``];
  if (operation.permission === undefined) {
    return lines;
  }
  const permission =
    operation.permission === PUBLIC
      ? "Needs no permission: it reads no data."
      : `Needs the permission \`${operation.permission}\`.`;
  return [...lines, "", permission];
}

/** Writes the TypeScript source of src/generated.ts for an API description. */
export function generateClient(input: unknown): string {
  const document = record(input, "The API description");
  const openapi = text(document["openapi"], "openapi");
  if (!openapi.startsWith("3.1.")) {
    throw new GeneratorError(`openapi must be 3.1.x, not ${openapi}.`);
  }
  refuseOtherKeys(document, DOCUMENT_KEYS, "The API description");
  // A webhook is a call from the server, which this client does not type yet.
  if (Object.keys(record(document["webhooks"] ?? {}, "webhooks")).length > 0) {
    throw new GeneratorError('The API description uses "webhooks", which the generator does not support yet.');
  }
  const components = record(document["components"] ?? {}, "components");
  const schemas = record(components["schemas"] ?? {}, "components.schemas");
  const found = operations(document);

  const out: string[] = [
    "// SPDX-License-Identifier: MIT",
    "",
    "// Generated from openapi.json by scripts/generate.ts. Do not edit it by hand:",
    "// change the API, then run `pnpm openapi`.",
    "",
    'import type { CallOptions, Send } from "./runtime.ts";',
  ];
  for (const name of Object.keys(schemas).sort()) {
    const where = `components.schemas.${name}`;
    out.push("", ...declaration(identifier(name, where), record(schemas[name], where), where));
  }
  out.push("", "export interface Operations {");
  for (const [index, operation] of found.entries()) {
    if (index > 0) {
      out.push("");
    }
    out.push(...comment(operationDocs(operation), "  "));
    out.push(`  ${operation.id}(options?: CallOptions): Promise<${operation.result}>;`);
  }
  out.push("}", "", "export function createOperations(send: Send): Operations {", "  return {");
  for (const operation of found) {
    const call = `{ method: ${JSON.stringify(operation.method)}, path: ${JSON.stringify(operation.path)} }`;
    out.push(
      `    ${operation.id}: async (options) => (await send(${call}, options)) as ${operation.result},`,
    );
  }
  out.push("  };", "}", "");
  return out.join("\n");
}
