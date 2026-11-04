// SPDX-License-Identifier: MIT

// Turns openapi.json into src/generated.ts: one TypeScript type per schema and
// one method per operation. It knows the parts of OpenAPI 3.1 that the API
// uses so far, and refuses anything else by name, so a new kind of operation
// fails here instead of turning into a wrong type or a missing method. Each
// key of the document, of a path item and of an operation is one it reads,
// one that only documents, or one it refuses.
//
// A method takes the operation's flat input as one object: the path
// parameters, the query's fields and the body's fields. A write that takes an
// idempotency key requires it as a call option. A method gives the JSON
// answer, nothing for 202 and 204, and the location of a 303, which a program
// reads and a browser follows itself. An operation's credential is a cookie,
// which the browser sends by itself, so a method takes no option for it; its
// doc comment names the cookie.

export class GeneratorError extends Error {
  override readonly name = "GeneratorError";
}

type Json = Readonly<Record<string, unknown>>;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** The methods the generator writes, in the order it writes those of one path. */
const SUPPORTED_METHODS = ["get", "put", "post", "delete", "patch"] as const;
/** Every HTTP method a path item can hold. */
const METHODS = new Set([...SUPPORTED_METHODS, "options", "head", "trace", "query"]);

/** The keys the generator reads or that only document. Any other key is refused. */
const DOCUMENT_KEYS = new Set(["openapi", "info", "components", "paths", "webhooks", "tags", "externalDocs"]);
const PATH_ITEM_KEYS = new Set([...SUPPORTED_METHODS, "summary", "description"]);
const PARAMETER_KEYS = new Set(["name", "in", "required", "schema", "description"]);
const REQUEST_BODY_KEYS = new Set(["required", "content", "description"]);

/** The types a query field may have: those a query string carries, and /v1 reads. */
const QUERY_TYPES: ReadonlySet<unknown> = new Set(["string", "integer", "number"]);

/** The one header an operation may take: a write's key. */
const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
const OPERATION_KEYS = new Set([
  "operationId",
  "summary",
  "description",
  "tags",
  "externalDocs",
  "parameters",
  "requestBody",
  "responses",
  "security",
  "x-nortfox",
]);

/** The keys of a security scheme: an API key in a cookie, the one kind the API uses so far. */
const SECURITY_SCHEME_KEYS = new Set(["type", "in", "name", "description"]);

/**
 * The keys of x-nortfox, NortFox's own parts of an operation. The generator
 * reads the permission, the session mark and the company source for the doc
 * comment, and refuses a value of the last two that it does not know; the
 * others only document, for the server and MCP.
 */
const NORTFOX_KEYS = new Set(["permission", "tool", "assistant", "writes", "list", "session", "company"]);
const SESSION_MARKS = [null, "flow"] as const;
const COMPANY_SOURCES = ["none", "credential"] as const;

/** The permission of an operation that reads no data. */
const PUBLIC = "public";
/** The permission of an operation that runs before sign-in. */
const NONE = "none";
/** The permission of an operation that needs a signed-in person. */
const SIGNED_IN = "signed-in";

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
      return item.includes(" ") ? `readonly (${item})[]` : `readonly ${item}[]`;
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

/** NortFox's own parts of an operation that the doc comment tells. */
interface Meta {
  readonly permission?: string;
  readonly session?: "flow" | null;
  readonly company?: "none" | "credential";
}

/** One field of an operation's input that is not in its body: a path parameter or a query field. */
interface Field {
  readonly name: string;
  readonly required: boolean;
  readonly schema: Json;
}

/** What a success answers: JSON, nothing (202 and 204), or a redirect (303) with its location as JSON. */
type AnswerKind = "json" | "none" | "redirect";

interface Operation {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly summary: string | undefined;
  readonly description: string | undefined;
  readonly meta: Meta;
  readonly params: readonly Field[];
  readonly query: readonly Field[];
  /** The body's type, or undefined when the operation takes none. */
  readonly body: string | undefined;
  /** Whether a call needs an idempotency key. */
  readonly key: boolean;
  readonly answer: AnswerKind;
  readonly result: string;
  /** The credentials it takes, each as its doc comment names it; none for an operation that needs no actor. */
  readonly credentials: readonly string[];
}

/** Each security scheme of the description, by its name, as a doc comment names it. */
type Schemes = ReadonlyMap<string, string>;

/** The security schemes of components.securitySchemes: each an API key in a cookie. */
function securitySchemes(value: unknown): Schemes {
  const schemes = new Map<string, string>();
  for (const [name, item] of Object.entries(record(value ?? {}, "components.securitySchemes"))) {
    const where = `components.securitySchemes.${name}`;
    const scheme = record(item, where);
    if (scheme["type"] !== "apiKey" || scheme["in"] !== "cookie") {
      throw new GeneratorError(`${where} is not an apiKey in a cookie, the one kind of scheme the generator supports yet.`);
    }
    refuseOtherKeys(scheme, SECURITY_SCHEME_KEYS, where);
    schemes.set(name, `the cookie \`${text(scheme["name"], `${where}.name`)}\``);
  }
  return schemes;
}

/** The credentials an operation's security names, each as its doc comment names it. */
function credentialsOf(value: unknown, where: string, schemes: Schemes): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new GeneratorError(`${where}.security must be a list.`);
  }
  return value.map((item, index) => {
    const at = `${where}.security[${String(index)}]`;
    const names = Object.keys(record(item, at));
    const [name] = names;
    if (name === undefined || names.length > 1) {
      throw new GeneratorError(`${at} must name one security scheme.`);
    }
    const scheme = schemes.get(name);
    if (scheme === undefined) {
      throw new GeneratorError(`${at} names the security scheme "${name}", which components.securitySchemes does not hold.`);
    }
    const scopes: unknown = (item as Json)[name];
    if (!Array.isArray(scopes) || scopes.length > 0) {
      throw new GeneratorError(`${at}.${name} must be an empty list: a cookie takes no scopes.`);
    }
    return scheme;
  });
}

/** A value of x-nortfox that must be one of `known`, or absent. */
function oneOf<T>(value: unknown, known: readonly T[], where: string): T | undefined {
  if (value !== undefined && !known.includes(value as T)) {
    throw new GeneratorError(`${where} is ${JSON.stringify(value)}, which the generator does not support yet.`);
  }
  return value as T | undefined;
}

/** The parts of an operation's x-nortfox that its doc comment tells; none when it has no x-nortfox. */
function metaOf(value: unknown, where: string): Meta {
  if (value === undefined) {
    return {};
  }
  const meta = record(value, where);
  refuseOtherKeys(meta, NORTFOX_KEYS, where);
  const session = oneOf(meta["session"], SESSION_MARKS, `${where}.session`);
  const company = oneOf(meta["company"], COMPANY_SOURCES, `${where}.company`);
  return {
    permission: text(meta["permission"], `${where}.permission`),
    ...(session === undefined ? {} : { session }),
    ...(company === undefined ? {} : { company }),
  };
}

/** The names a path gives in {braces}. The group always matches, at least an empty name. */
function pathNames(path: string): string[] {
  return [...path.matchAll(/\{([^}]*)\}/g)].map((match) => String(match[1]));
}

/** The parameters of an operation: its path parameters, its query's fields, and whether it takes the idempotency key. */
function parametersOf(value: unknown, path: string, where: string): Pick<Operation, "params" | "query" | "key"> {
  const params: Field[] = [];
  const query: Field[] = [];
  let key = false;
  if (value !== undefined && !Array.isArray(value)) {
    throw new GeneratorError(`${where}.parameters must be a list.`);
  }
  const named = pathNames(path);
  const seen = new Set<string>();
  for (const [index, item] of (value ?? []).entries()) {
    const at = `${where}.parameters[${String(index)}]`;
    const parameter = record(item, at);
    refuseOtherKeys(parameter, PARAMETER_KEYS, at);
    const name = text(parameter["name"], `${at}.name`);
    const location = text(parameter["in"], `${at}.in`);
    const required = parameter["required"] ?? false;
    if (typeof required !== "boolean") {
      throw new GeneratorError(`${at}.required must be true or false.`);
    }
    const schema = record(parameter["schema"], `${at}.schema`);
    const description = optionalText(parameter["description"], `${at}.description`);
    if (seen.has(name)) {
      throw new GeneratorError(`${at}: the name ${name} is given twice.`);
    }
    seen.add(name);
    const field: Field = { name, required, schema: description === undefined ? schema : { ...schema, description } };
    switch (location) {
      case "header":
        if (name !== IDEMPOTENCY_KEY_HEADER) {
          throw new GeneratorError(`${at} is the header "${name}", which the generator does not support yet.`);
        }
        if (!required) {
          throw new GeneratorError(`${at}: the ${IDEMPOTENCY_KEY_HEADER} header must be required.`);
        }
        key = true;
        break;
      case "path":
        if (!required) {
          throw new GeneratorError(`${at}: a path parameter must be required.`);
        }
        if (!named.includes(name)) {
          throw new GeneratorError(`${at}: the path parameter ${name} is not in the path.`);
        }
        params.push(field);
        break;
      case "query":
        // /v1 reads a query value as a number or as text, so a field of any other type would never arrive as typed.
        if (!QUERY_TYPES.has(schema["type"])) {
          const type = schema["type"] === undefined ? "no type" : `the type ${JSON.stringify(schema["type"])}`;
          throw new GeneratorError(`${at}: the query field ${name} has ${type}. A query field is a string, an integer or a number.`);
        }
        query.push(field);
        break;
      default:
        throw new GeneratorError(`${at} is in "${location}", which the generator does not support yet.`);
    }
  }
  for (const name of named.filter((each) => !params.some((field) => field.name === each))) {
    throw new GeneratorError(`${where}: the path names {${name}}, and no path parameter has that name.`);
  }
  return { params, query, key };
}

/** Whether a schema is an object, or a $ref to a component that is one. */
function isObjectSchema(schema: Json, schemas: Json): boolean {
  const ref = schema["$ref"];
  const target = typeof ref === "string" ? schemas[ref.replace(/^#\/components\/schemas\//, "")] : schema;
  return isJson(target) && target["type"] === "object";
}

/** The type of an operation's JSON body, or undefined when it takes none. */
function bodyOf(value: unknown, where: string, schemas: Json): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const at = `${where}.requestBody`;
  const body = record(value, at);
  refuseOtherKeys(body, REQUEST_BODY_KEYS, at);
  const content = body["content"];
  if (body["required"] !== true || !isJson(content)) {
    throw new GeneratorError(`${at} must be required, with an application/json schema.`);
  }
  refuseOtherKeys(content, new Set(["application/json"]), at);
  const schema = field(content["application/json"], "schema");
  if (!isJson(schema)) {
    throw new GeneratorError(`${at} must be required, with an application/json schema.`);
  }
  if (!isObjectSchema(schema, schemas)) {
    throw new GeneratorError(`${at}'s schema must be an object or a $ref to one.`);
  }
  return typeOf(schema, `${at}.content["application/json"].schema`, "    ");
}

function field(value: unknown, key: string): unknown {
  return isJson(value) ? value[key] : undefined;
}

/** The success answer of an operation: what it answers, and the type its method gives. */
function successOf(responses: Json, where: string): Pick<Operation, "answer" | "result"> {
  const statuses = Object.keys(responses).filter((status) => /^[23]/.test(status));
  const [status, ...more] = statuses;
  if (status === undefined) {
    throw new GeneratorError(`${where} needs a success answer: 200 or 201 with JSON, 202 or 204, or 303 with JSON.`);
  }
  if (more.length > 0) {
    throw new GeneratorError(`${where} has more than one success answer: ${statuses.join(", ")}.`);
  }
  const response = record(responses[status], `${where}.${status}`);
  const json = (): string => {
    const content = record(response["content"], `${where}.${status}.content`);
    const body = record(content["application/json"], `${where}.${status}.content["application/json"]`);
    return typeOf(body["schema"], `${where}.${status}.content["application/json"].schema`, "");
  };
  switch (status) {
    case "200":
    case "201":
      return { answer: "json", result: json() };
    case "202":
    case "204":
      if (response["content"] !== undefined) {
        throw new GeneratorError(`${where}.${status} has content, but ${status} answers with no body.`);
      }
      return { answer: "none", result: "void" };
    case "303":
      return { answer: "redirect", result: json() };
    default:
      throw new GeneratorError(`${where} answers ${status}, which the generator does not support yet.`);
  }
}

function operation(path: string, method: string, value: unknown, schemas: Json, schemes: Schemes): Operation {
  const where = `paths["${path}"].${method}`;
  const entry = record(value, where);
  refuseOtherKeys(entry, OPERATION_KEYS, where);
  const id = identifier(text(entry["operationId"], `${where}.operationId`), `${where}.operationId`);
  const summary = optionalText(entry["summary"], `${where}.summary`);
  const description = optionalText(entry["description"], `${where}.description`);
  const meta = metaOf(entry["x-nortfox"], `${where}.x-nortfox`);
  const parameters = parametersOf(entry["parameters"], path, where);
  const body = bodyOf(entry["requestBody"], where, schemas);
  if (body !== undefined && method === "get") {
    throw new GeneratorError(`${where}.requestBody: a GET takes no body, which fetch cannot send.`);
  }
  return {
    id,
    method: method.toUpperCase(),
    path,
    summary,
    description,
    meta,
    ...parameters,
    body,
    ...successOf(record(entry["responses"], `${where}.responses`), `${where}.responses`),
    credentials: credentialsOf(entry["security"], where, schemes),
  };
}

function operations(document: Json, schemas: Json, schemes: Schemes): Operation[] {
  const paths = record(document["paths"], "paths");
  const found: Operation[] = [];
  for (const path of Object.keys(paths).sort()) {
    const where = `paths["${path}"]`;
    const item = record(paths[path], where);
    for (const key of Object.keys(item)) {
      if (METHODS.has(key) && !(SUPPORTED_METHODS as readonly string[]).includes(key)) {
        throw new GeneratorError(`${where}.${key}: only GET, PUT, POST, DELETE and PATCH operations are supported yet.`);
      }
    }
    // Parameters, servers or a $ref on the path item would change every call under it.
    refuseOtherKeys(item, PATH_ITEM_KEYS, where);
    for (const method of SUPPORTED_METHODS) {
      if (item[method] !== undefined) {
        found.push(operation(path, method, item[method], schemas, schemes));
      }
    }
  }
  return found;
}

/** The line of the doc comment that says who may call the operation. */
function permissionLine(meta: Meta): string | undefined {
  const { permission } = meta;
  switch (permission) {
    case undefined:
      return undefined;
    case PUBLIC:
      return "Needs no permission: it reads no data.";
    case NONE:
      return "Needs no actor: anyone may call it, before signing in.";
    case SIGNED_IN:
      return "Needs a signed-in person, and works in no company.";
    default:
      return meta.company === "credential"
        ? `Needs the permission \`${permission}\`, in the company that the credential names.`
        : `Needs the permission \`${permission}\`.`;
  }
}

function operationDocs(operation: Operation): string[] {
  const parts = [operation.summary, operation.description].filter(
    (part): part is string => part !== undefined,
  );
  const lines = [...parts.flatMap((part) => [part, ""]), `\`${operation.method} ${operation.path}\``];
  const session = operation.meta.session === "flow" ? "Serves the browser's session: its MCP tool refuses every call." : undefined;
  const credential = operation.credentials.length === 0 ? undefined : `Credential: ${operation.credentials.join(", or ")}.`;
  for (const line of [permissionLine(operation.meta), credential, session]) {
    if (line !== undefined) {
      lines.push("", line);
    }
  }
  return lines;
}

/** The type of an operation's input: its path parameters and query fields, and its body; or undefined when it takes none. */
function inputType(operation: Operation): string | undefined {
  const fields = [...operation.params, ...operation.query];
  const parts: string[] = [];
  if (fields.length > 0) {
    const schema = {
      type: "object",
      properties: Object.fromEntries(fields.map((each) => [each.name, each.schema])),
      required: fields.filter((each) => each.required).map((each) => each.name),
    };
    parts.push(typeOf(schema, `paths["${operation.path}"].${operation.method.toLowerCase()}.parameters`, "    "));
  }
  if (operation.body !== undefined) {
    parts.push(operation.body);
  }
  return parts.length === 0 ? undefined : parts.join(" & ");
}

/** Whether an operation's input may be left out: it has no required field, no body and no key. */
function inputIsOptional(operation: Operation): boolean {
  return operation.body === undefined && !operation.key && ![...operation.params, ...operation.query].some((each) => each.required);
}

/** The method's lines in the Operations interface. */
function signature(operation: Operation): string[] {
  const options = operation.key ? "options: WriteOptions" : "options?: CallOptions";
  const input = inputType(operation);
  const result = `Promise<${operation.result}>`;
  if (input === undefined) {
    return [`  ${operation.id}(${options}): ${result};`];
  }
  return [`  ${operation.id}(`, `    input${inputIsOptional(operation) ? "?" : ""}: ${input},`, `    ${options},`, `  ): ${result};`];
}

/** The call as the runtime takes it: the method, the path, and the parts that are not the default. */
function callOf(operation: Operation): string {
  const names = (fields: readonly Field[]): string => `[${fields.map((each) => JSON.stringify(each.name)).join(", ")}]`;
  const parts = [`method: ${JSON.stringify(operation.method)}`, `path: ${JSON.stringify(operation.path)}`];
  if (operation.params.length > 0) {
    parts.push(`params: ${names(operation.params)}`);
  }
  if (operation.query.length > 0) {
    parts.push(`query: ${names(operation.query)}`);
  }
  if (operation.body !== undefined) {
    parts.push("body: true");
  }
  if (operation.key) {
    parts.push("key: true");
  }
  if (operation.answer !== "json") {
    parts.push(`answer: ${JSON.stringify(operation.answer)}`);
  }
  return `{ ${parts.join(", ")} }`;
}

/** The method's line in createOperations. */
function implementation(operation: Operation): string {
  const takesInput = inputType(operation) !== undefined;
  const parameters = takesInput ? "input, options" : "options";
  const sent = `send(${callOf(operation)}, ${takesInput ? "input" : "undefined"}, options)`;
  if (operation.answer === "none") {
    return `    ${operation.id}: async (${parameters}) => { await ${sent}; },`;
  }
  return `    ${operation.id}: async (${parameters}) => (await ${sent}) as ${operation.result},`;
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
  const found = operations(document, schemas, securitySchemes(components["securitySchemes"]));

  // Each type the methods use, and no other: an unused import does not compile.
  const runtimeTypes = [
    ...(found.some((each) => !each.key) ? ["CallOptions"] : []),
    "Send",
    ...(found.some((each) => each.key) ? ["WriteOptions"] : []),
  ];
  const out: string[] = [
    "// SPDX-License-Identifier: MIT",
    "",
    "// Generated from openapi.json by scripts/generate.ts. Do not edit it by hand:",
    "// change the API, then run `pnpm openapi`.",
    "",
    `import type { ${runtimeTypes.join(", ")} } from "./runtime.ts";`,
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
    out.push(...signature(operation));
  }
  out.push("}", "", "export function createOperations(send: Send): Operations {", "  return {");
  for (const operation of found) {
    out.push(implementation(operation));
  }
  out.push("  };", "}", "");
  return out.join("\n");
}
