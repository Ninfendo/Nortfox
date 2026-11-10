// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { personal, secret } from "./fields.ts";
import { IDEMPOTENCY_KEY_HEADER } from "./idempotency-key.ts";
import { Money } from "./money.ts";
import {
  NoBody,
  Redirect,
  bodySchema,
  challengeOf,
  defineListOperation,
  defineOperation,
  isCompanyInput,
  outputSchema,
  paramsSchema,
  querySchema,
  securityOf,
  successStatus,
  takesIdempotencyKey,
  type Shape,
} from "./operation.ts";
import { Limit, Cursor } from "./paging.ts";
import { Problem } from "./problem.ts";
import { CHALLENGES, SECURITY_SCHEMES, SESSION_COOKIE, bearerChallenge } from "./security.ts";

const Item = z.strictObject({ id: z.uuid() });

const publicRead = defineOperation({
  id: "getPing",
  method: "get",
  path: "/v1/ping",
  tags: ["status"],
  summary: "Ping",
  description: "Answers a ping.",
  output: z.strictObject({ ok: z.boolean() }),
  permission: "public",
  tool: "Answers a ping.",
  writes: false,
});

const read = defineOperation({
  id: "getItem",
  method: "get",
  path: "/v1/item",
  tags: ["items"],
  summary: "Read the item",
  description: "Reads the item.",
  query: z.strictObject({ name: z.string().optional() }),
  output: Item,
  permission: "test:read",
  tool: "Reads the item.",
  assistant: true,
  writes: false,
});

const Body = z.strictObject({ amount: Money });

const write = defineOperation({
  id: "bookItem",
  method: "post",
  path: "/v1/items",
  tags: ["items"],
  summary: "Book an item",
  description: "Books an item.",
  body: Body,
  output: Item,
  status: 201,
  permission: "test:write",
  tool: "Books an item.",
  writes: true,
});

const list = defineListOperation({
  id: "listItems",
  method: "get",
  path: "/v1/items",
  tags: ["items"],
  summary: "List the items",
  description: "Lists the items.",
  query: z.strictObject({ name: z.string().optional() }),
  item: Item,
  permission: "test:read",
  tool: "Lists the items.",
});

/** The statuses of an entry's answers, sorted. */
function statuses(entry: { readonly responses: object }): string[] {
  return Object.keys(entry.responses).sort();
}

describe("defineOperation", () => {
  it("builds a createRoute object with the id, the method, the /v1 path and the texts", () => {
    expect(read).toMatchObject({
      operationId: "getItem",
      method: "get",
      path: "/v1/item",
      tags: ["items"],
      summary: "Read the item",
      description: "Reads the item.",
    });
    expect(read.getRoutingPath()).toBe("/v1/item");
  });

  it("carries NortFox's own parts in x-nortfox, closed to the assistant unless it says so", () => {
    expect(read["x-nortfox"]).toEqual({
      permission: "test:read",
      scope: null,
      tool: "Reads the item.",
      assistant: true,
      writes: false,
      list: false,
      session: null,
      company: "credential",
      personalOutput: [],
      secretOutput: [],
    });
    expect(write["x-nortfox"]).toEqual({
      permission: "test:write",
      scope: null,
      tool: "Books an item.",
      assistant: false,
      writes: true,
      list: false,
      session: null,
      company: "credential",
      personalOutput: [],
      secretOutput: [],
    });
  });

  it("lists the personal fields of its output, and none for an answer with no body", () => {
    const Person = z.strictObject({ id: z.uuid(), name: personal(z.string()), email: personal(z.string()).optional() });
    const readSelf = defineOperation({
      id: "readSelf",
      method: "get",
      path: "/v1/selves",
      tags: ["items"],
      summary: "Read yourself",
      description: "Reads the person.",
      output: z.strictObject({ person: Person, others: z.array(Person) }),
      permission: "signed-in",
      tool: "Reads the person.",
      writes: false,
    });
    expect(readSelf["x-nortfox"].personalOutput).toEqual(["/person/name", "/person/email", "/others/*/name", "/others/*/email"]);
    const ended = defineOperation({
      id: "endSelf",
      method: "post",
      path: "/v1/selves",
      tags: ["items"],
      summary: "End",
      description: "Ends.",
      output: NoBody,
      status: 204,
      permission: "signed-in",
      tool: "Ends.",
      writes: true,
    });
    expect(ended["x-nortfox"].personalOutput).toEqual([]);
  });

  it.each([
    ["current", "current" as const],
    ["new", "new" as const],
    ["the input", { input: "companyId" }],
  ])("takes a signed-in person's company from %s, and refuses by a rule only an input's company it may not enter", (_what, company) => {
    const inCompany = defineOperation({
      id: "readOwnCompany",
      method: "get",
      path: "/v1/own-companies",
      tags: ["items"],
      summary: "Read",
      description: "Reads.",
      query: z.strictObject({ companyId: z.uuid() }),
      output: Item,
      permission: "signed-in",
      company,
      tool: "Reads.",
      writes: false,
    });
    expect(inCompany["x-nortfox"].company).toEqual(company);
    expect(statuses(inCompany)).toEqual(typeof company === "object" ? ["200", "400", "401", "422", "500"] : ["200", "400", "401", "500"]);
    expect(isCompanyInput(company)).toBe(typeof company === "object");
  });

  it("takes the company from the credential for an operation with a permission, and from nowhere for one without", () => {
    expect(publicRead["x-nortfox"]).toMatchObject({ session: null, company: "none" });
    expect(read["x-nortfox"].company).toBe("credential");
  });

  it("answers a public read with its output, 400 and 500", () => {
    expect(statuses(publicRead)).toEqual(["200", "400", "500"]);
    expect(publicRead.request).toEqual({});
  });

  it("describes the success answer by its output, or plainly when the output says nothing", () => {
    expect(list.responses[200]?.description).toBe("A page of the list.");
    expect(publicRead.responses[200]?.description).toBe("The answer.");
  });

  it("answers a read of data with its output, 400, 401, 403 and 500", () => {
    expect(statuses(read)).toEqual(["200", "400", "401", "403", "500"]);
  });

  it("answers a write with a body with its output, and 409, 413, 415 and 422 too", () => {
    expect(statuses(write)).toEqual(["201", "400", "401", "403", "409", "413", "415", "422", "500"]);
  });

  it("gives every refusal as problem details", () => {
    for (const [status, response] of Object.entries(write.responses)) {
      if (status === "201") {
        continue;
      }
      expect(response.description).not.toBe("");
      expect(response.content).toEqual({ "application/problem+json": { schema: Problem } });
    }
  });

  it("documents the challenge of a 401: the one that names the credential the operation takes", () => {
    expect(read.responses[401]).toMatchObject({
      headers: { "WWW-Authenticate": { description: expect.stringContaining(`Cookie realm="NortFox", cookie-name="__Host-nortfox-session"`) as unknown, schema: { type: "string" } } },
    });
    expect(read.responses[401]?.headers).not.toMatchObject({ "WWW-Authenticate": { description: expect.stringContaining("Bearer") as unknown } });
  });

  it("gives the challenge of each credential an operation takes, and none for an operation that needs no actor", () => {
    expect(challengeOf(read)).toBe(`Cookie realm="NortFox", cookie-name="__Host-nortfox-session"`);
    expect(challengeOf(write)).toBe(challengeOf(read));
    expect(() => challengeOf(publicRead)).toThrow("An operation that needs no actor answers no 401, so it has no challenge.");
  });

  it("names the causes of a 403 that the operation can give: its permission and its company, and another site for a write", () => {
    expect(read.responses[403]?.description).toBe(
      "The request may not call the operation: the credential names no company (company-required), or the actor lacks the operation's permission (permission-missing).",
    );
    expect(write.responses[403]?.description).toBe(
      "The request may not call the operation: the credential names no company (company-required), or the actor lacks the operation's permission (permission-missing); or it carries the session cookie without the install's own Origin, as a page of another site sends it (origin-not-allowed).",
    );
  });

  it("takes the body as JSON and a required Idempotency-Key on a write", () => {
    expect(write.request.body).toEqual({ required: true, content: { "application/json": { schema: Body } } });
    const headers = write.request.headers;
    expect(headers?.shape[IDEMPOTENCY_KEY_HEADER]).toBeDefined();
    expect(headers?.safeParse({}).success).toBe(false);
    expect(headers?.safeParse({ [IDEMPOTENCY_KEY_HEADER]: "8e03978e", "content-type": "application/json" }).success).toBe(true);
    expect(read.request.headers).toBeUndefined();
  });

  it("reads its parts back", () => {
    expect(querySchema(read)).toBe(read.request.query);
    expect(querySchema<Shape | undefined>(write)).toBeUndefined();
    expect(bodySchema(write)).toBe(Body);
    expect(bodySchema<Shape | undefined>(read)).toBeUndefined();
    expect(paramsSchema<Shape | undefined>(read)).toBeUndefined();
    expect(outputSchema(read)).toBe(Item);
    expect(outputSchema(write)).toBe(Item);
    expect(successStatus(read)).toBe(200);
    expect(successStatus(write)).toBe(201);
    expect(takesIdempotencyKey(write)).toBe(true);
    expect(takesIdempotencyKey(read)).toBe(false);
  });

  it("throws for an entry with no success answer, which the registry guard refuses", () => {
    expect(() => successStatus({ ...read, responses: { 400: { description: "Refused." } } })).toThrow("getItem has no success answer.");
  });
});

describe("path parameters", () => {
  const Params = z.strictObject({ itemId: z.uuid().meta({ description: "The item's id." }) });
  const getOne = defineOperation({
    id: "getOneItem",
    method: "get",
    path: "/v1/items/{itemId}",
    tags: ["items"],
    summary: "Read one item",
    description: "Reads one item.",
    params: Params,
    output: Item,
    permission: "test:read",
    tool: "Reads one item.",
    writes: false,
  });

  it("takes them as the request's params, and routes them as Hono names them", () => {
    expect(getOne.request).toEqual({ params: Params });
    expect(paramsSchema(getOne)).toBe(Params);
    expect(getOne.path).toBe("/v1/items/{itemId}");
    expect(getOne.getRoutingPath()).toBe("/v1/items/:itemId");
  });
});

describe("the answers without a body, and the redirect", () => {
  const texts = { tags: ["items"], summary: "S", description: "D.", tool: "T." } as const;

  const ended = defineOperation({
    ...texts,
    id: "endItem",
    method: "delete",
    path: "/v1/items",
    output: NoBody,
    status: 204,
    permission: "test:write",
    writes: true,
  });

  const accepted = defineOperation({
    ...texts,
    id: "sendItem",
    method: "post",
    path: "/v1/item-letters",
    body: Body,
    output: NoBody,
    status: 202,
    permission: "none",
    session: "flow",
    writes: true,
  });

  const redirect = defineOperation({
    ...texts,
    id: "startItem",
    method: "get",
    path: "/v1/item-starts",
    output: Redirect,
    status: 303,
    permission: "none",
    session: "flow",
    writes: true,
  });

  it("answers 204 with no body: its output is the empty object", () => {
    expect(ended.responses[204]).toEqual({ description: "Done. The answer has no body." });
    expect(successStatus(ended)).toBe(204);
    expect(outputSchema(ended)).toBe(NoBody);
    expect(NoBody.parse({})).toEqual({});
    expect(NoBody.safeParse({ x: 1 }).success).toBe(false);
  });

  it("answers 202 with no body: the work goes on after the answer", () => {
    expect(accepted.responses[202]).toEqual({ description: "Accepted. The work goes on after the answer, which has no body." });
    expect(successStatus(accepted)).toBe(202);
    expect(outputSchema(accepted)).toBe(NoBody);
  });

  it("answers 303 with the Location header and the same location as JSON", () => {
    expect(redirect.responses[303]).toEqual({
      description: "See Other: the browser goes on to the location.",
      headers: { Location: { description: "The URL the browser goes to next.", schema: { type: "string" } } },
      content: { "application/json": { schema: Redirect } },
    });
    expect(successStatus(redirect)).toBe(303);
    expect(outputSchema(redirect)).toBe(Redirect);
    expect(Redirect.parse({ location: "https://idp.example.com/authorize" })).toEqual({ location: "https://idp.example.com/authorize" });
  });

  it("refuses another output for an answer without a body, and for a redirect", () => {
    expect(() => defineOperation({ ...texts, id: "badEnd", method: "delete", path: "/v1/items", output: Item, status: 204, permission: "test:write", writes: true })).toThrow(
      "badEnd answers 204, which has no body, so its output is NoBody.",
    );
    expect(() => defineOperation({ ...texts, id: "badSend", method: "post", path: "/v1/items", output: z.strictObject({}), status: 202, permission: "none", writes: true })).toThrow(
      "badSend answers 202, which has no body, so its output is NoBody.",
    );
    expect(() => defineOperation({ ...texts, id: "badStart", method: "get", path: "/v1/items", output: Item, status: 303, permission: "none", writes: true })).toThrow(
      "badStart answers 303, so its output is Redirect.",
    );
    expect(() => defineOperation({ ...texts, id: "badRead", method: "get", path: "/v1/items", output: NoBody, permission: "test:read", writes: false })).toThrow(
      "badRead answers 200 with JSON, so its output is not NoBody.",
    );
  });
});

describe("an operation that runs before sign-in", () => {
  const signIn = defineOperation({
    id: "signInItem",
    method: "post",
    path: "/v1/item-sign-ins",
    tags: ["items"],
    summary: "Sign in",
    description: "Signs in.",
    body: Body,
    output: Item,
    permission: "none",
    session: "flow",
    tool: "Signs in.",
    writes: true,
  });

  it("takes no idempotency key, has no company, and is refused only by its input, its rules and its limits", () => {
    expect(signIn.request.headers).toBeUndefined();
    expect(takesIdempotencyKey(signIn)).toBe(false);
    expect(signIn["x-nortfox"]).toMatchObject({ permission: "none", session: "flow", company: "none", writes: true });
    expect(statuses(signIn)).toEqual(["200", "400", "403", "413", "415", "422", "429", "500", "503"]);
  });

  it("can be refused for another site only: a page of another site may not start a sign-in, and a write with the session cookie needs the install's own Origin", () => {
    expect(signIn.responses[403]?.description).toBe(
      "The request may not call the operation: it carries the session cookie without the install's own Origin, as a page of another site sends it (origin-not-allowed); or its Origin is another site's, not the install's own (origin-not-allowed).",
    );
  });

  it("names Retry-After on its 429 and its 503, and on no other answer", () => {
    for (const status of ["429", "503"]) {
      expect(signIn.responses[status]?.headers).toEqual({
        "Retry-After": { description: "The whole seconds to wait before the next attempt.", schema: { type: "string" } },
      });
    }
    for (const status of ["200", "400", "422", "500"]) {
      expect(signIn.responses[status]?.headers).toBeUndefined();
    }
  });

  it("is refused by a rule also when it only reads, such as a link that has ended", () => {
    const readLink = defineOperation({
      id: "getItemLink",
      method: "get",
      path: "/v1/item-links",
      tags: ["items"],
      summary: "Read a link",
      description: "Reads a link.",
      output: Item,
      permission: "none",
      session: "flow",
      tool: "Reads a link.",
      writes: false,
    });
    expect(statuses(readLink)).toEqual(["200", "400", "403", "422", "429", "500", "503"]);
  });
});

describe("a signed-in operation", () => {
  const endSession = defineOperation({
    id: "endItemSession",
    method: "post",
    path: "/v1/item-session-ends",
    tags: ["items"],
    summary: "End",
    description: "Ends.",
    output: NoBody,
    status: 204,
    permission: "signed-in",
    session: "flow",
    tool: "Ends.",
    writes: true,
  });

  it("takes an idempotency key when it writes, works in no company, and can be refused for its actor", () => {
    expect(takesIdempotencyKey(endSession)).toBe(true);
    expect(endSession.request.headers?.shape[IDEMPOTENCY_KEY_HEADER]).toBeDefined();
    expect(endSession["x-nortfox"]).toMatchObject({ permission: "signed-in", session: "flow", company: "none" });
    expect(statuses(endSession)).toEqual(["204", "400", "401", "403", "409", "422", "500"]);
    // A signed-in operation needs no permission: a token is refused one that serves the browser's session, and another site's page one that is no GET.
    expect(endSession.responses[403]?.description).toBe(
      "The request may not call the operation: the credential is a token, and the operation needs a browser session (session-required); or it carries the session cookie without the install's own Origin, as a page of another site sends it (origin-not-allowed).",
    );
    const readPerson = defineOperation({
      id: "getItemSessionPerson",
      method: "get",
      path: "/v1/item-session-people",
      tags: ["items"],
      summary: "Read",
      description: "Reads.",
      output: Item,
      permission: "signed-in",
      tool: "Reads.",
      writes: false,
    });
    expect(statuses(readPerson)).toEqual(["200", "400", "401", "500"]);
  });

  it("takes a company source of its own", () => {
    const inCompany = defineOperation({
      id: "readItemCompany",
      method: "get",
      path: "/v1/item-companies",
      tags: ["items"],
      summary: "Read",
      description: "Reads.",
      output: Item,
      permission: "test:read",
      company: "none",
      tool: "Reads.",
      writes: false,
    });
    expect(inCompany["x-nortfox"].company).toBe("none");
  });
});

describe("the scope, the session-only mark and the secret output", () => {
  const scoped = defineOperation({
    id: "getScopedItem",
    method: "get",
    path: "/v1/scoped-items",
    tags: ["items"],
    summary: "Read",
    description: "Reads.",
    output: Item,
    permission: "test:read",
    scope: "bookkeeping",
    tool: "Reads.",
    writes: false,
  });

  const scopedPerson = defineOperation({
    id: "getScopedPerson",
    method: "get",
    path: "/v1/scoped-people",
    tags: ["items"],
    summary: "Read",
    description: "Reads.",
    output: Item,
    permission: "signed-in",
    scope: "profile",
    tool: "Reads.",
    writes: false,
  });

  const recent = defineOperation({
    id: "getRecentItems",
    method: "get",
    path: "/v1/recent-items",
    tags: ["items"],
    summary: "Read",
    description: "Reads.",
    output: Item,
    permission: "signed-in",
    session: "only",
    tool: "Reads.",
    writes: false,
  });

  const makeToken = defineOperation({
    id: "makeItemToken",
    method: "post",
    path: "/v1/item-tokens",
    tags: ["items"],
    summary: "Make a token",
    description: "Makes a token, shown once.",
    body: z.strictObject({ name: z.string() }),
    output: z.strictObject({ id: z.uuid(), token: secret(z.string()) }),
    status: 201,
    permission: "test:write",
    session: "only",
    tool: "Makes a token.",
    writes: true,
  });

  const flowRead = defineOperation({
    id: "getItemSession",
    method: "get",
    path: "/v1/item-sessions",
    tags: ["items"],
    summary: "Read",
    description: "Reads.",
    output: Item,
    permission: "signed-in",
    session: "flow",
    tool: "Reads.",
    writes: false,
  });

  it("takes the scope it is given, and none by default", () => {
    expect(scoped["x-nortfox"].scope).toBe("bookkeeping");
    expect(scopedPerson["x-nortfox"].scope).toBe("profile");
    expect(recent["x-nortfox"]).toMatchObject({ scope: null, session: "only" });
    expect(read["x-nortfox"].scope).toBeNull();
  });

  it("names the causes of a 403 that a token gives: a scope it lacks, and an operation that needs a browser session", () => {
    expect(scoped.responses[403]?.description).toBe(
      "The request may not call the operation: the credential is a token that lacks the operation's scope (scope-missing); or the credential names no company (company-required), or the actor lacks the operation's permission (permission-missing).",
    );
    expect(statuses(scopedPerson)).toEqual(["200", "400", "401", "403", "500"]);
    expect(scopedPerson.responses[403]?.description).toBe("The request may not call the operation: the credential is a token that lacks the operation's scope (scope-missing).");
    for (const entry of [recent, flowRead]) {
      expect(statuses(entry), entry.operationId).toEqual(["200", "400", "401", "403", "500"]);
      expect(entry.responses[403]?.description, entry.operationId).toBe(
        "The request may not call the operation: the credential is a token, and the operation needs a browser session (session-required).",
      );
    }
    expect(makeToken.responses[403]?.description).toBe(
      "The request may not call the operation: the credential is a token, and the operation needs a browser session (session-required); or the credential names no company (company-required), or the actor lacks the operation's permission (permission-missing); or it carries the session cookie without the install's own Origin, as a page of another site sends it (origin-not-allowed).",
    );
  });

  it("lists the secret fields of its output, and none for an answer with no body", () => {
    expect(makeToken["x-nortfox"].secretOutput).toEqual(["/token"]);
    expect(scoped["x-nortfox"].secretOutput).toEqual([]);
    const ended = defineOperation({
      id: "endItemToken",
      method: "delete",
      path: "/v1/item-tokens",
      tags: ["items"],
      summary: "End",
      description: "Ends.",
      output: NoBody,
      status: 204,
      permission: "test:write",
      scope: "tokens",
      tool: "Ends.",
      writes: true,
    });
    expect(ended["x-nortfox"].secretOutput).toEqual([]);
  });

  it("names answer-shown-once on the 409 of a write whose answer holds a secret, which a repeat of its key gets", () => {
    expect(makeToken.responses[409]?.description).toBe(
      "A request with the same idempotency key is still running; or the same request came again with its key, and its first answer held a secret, which is shown only once (answer-shown-once).",
    );
    expect(write.responses[409]?.description).toBe("A request with the same idempotency key is still running.");
  });

  it("gives no 409 to a write that runs before sign-in, also when its answer holds a secret: it takes no key", () => {
    const setUp = defineOperation({
      id: "setUpItem",
      method: "post",
      path: "/v1/item-setups",
      tags: ["items"],
      summary: "Set up",
      description: "Sets up.",
      output: z.strictObject({ code: secret(z.string()) }),
      status: 201,
      permission: "none",
      session: "flow",
      tool: "Sets up.",
      writes: true,
    });
    expect(setUp["x-nortfox"].secretOutput).toEqual(["/code"]);
    expect(statuses(setUp)).not.toContain("409");
  });
});

describe("the credential an operation takes", () => {
  it("is the browser's session cookie, which openapi.json names as the scheme sessionCookie, or an API token as the scheme bearer", () => {
    expect(SESSION_COOKIE).toBe("__Host-nortfox-session");
    expect(SECURITY_SCHEMES).toEqual({
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "__Host-nortfox-session",
        description: "The browser's session, which a sign-in sets: verifyTotp, or loginWithPassword on a known device. The browser sends it by itself.",
      },
      bearer: {
        type: "http",
        scheme: "bearer",
        description:
          "An API token, which createApiToken makes, sent as Authorization: Bearer <token>. It works in its one company, within its scopes, on /v1 only. A request with a bearer token ignores the session cookie.",
      },
    });
    expect(CHALLENGES).toEqual({ sessionCookie: `Cookie realm="NortFox", cookie-name="__Host-nortfox-session"`, bearer: `Bearer realm="NortFox"` });
  });

  it("is named on every operation that needs an actor: a read, a write and a list with a permission, and a signed-in one", () => {
    const signedIn = defineOperation({
      id: "getItemPerson",
      method: "get",
      path: "/v1/item-people",
      tags: ["items"],
      summary: "Read",
      description: "Reads.",
      output: Item,
      permission: "signed-in",
      tool: "Reads.",
      writes: false,
    });
    for (const entry of [read, write, list, signedIn]) {
      expect(entry.security, entry.operationId).toEqual([{ sessionCookie: [] }]);
    }
  });

  it("is named on no operation that needs no actor: a public one, and one that runs before sign-in", () => {
    const signIn = defineOperation({
      id: "signInItem",
      method: "post",
      path: "/v1/item-sign-ins",
      tags: ["items"],
      summary: "Sign in",
      description: "Signs in.",
      body: Body,
      output: Item,
      permission: "none",
      session: "flow",
      tool: "Signs in.",
      writes: true,
    });
    for (const entry of [publicRead, signIn]) {
      expect("security" in entry, entry.operationId).toBe(false);
    }
  });

  it("comes from the permission and the scope, a new list each time", () => {
    expect(securityOf("public", null)).toBeUndefined();
    expect(securityOf("none", null)).toBeUndefined();
    expect(securityOf("signed-in", null)).toEqual([{ sessionCookie: [] }]);
    expect(securityOf("company:read", null)).toEqual([{ sessionCookie: [] }]);
    expect(securityOf("signed-in", "profile")).toEqual([{ sessionCookie: [] }, { bearer: [] }]);
    expect(securityOf("company:read", "companyinformation")).toEqual([{ sessionCookie: [] }, { bearer: [] }]);
    expect(securityOf("signed-in", null)).not.toBe(securityOf("signed-in", null));
    expect(securityOf("company:read", "companyinformation")).not.toBe(securityOf("company:read", "companyinformation"));
  });

  it("is the session cookie and a bearer token for an operation that a token may call by its scope", () => {
    const scoped = defineOperation({
      id: "getScopedItem",
      method: "get",
      path: "/v1/scoped-items",
      tags: ["items"],
      summary: "Read",
      description: "Reads.",
      output: Item,
      permission: "test:read",
      scope: "bookkeeping",
      tool: "Reads.",
      writes: false,
    });
    expect(scoped.security).toEqual([{ sessionCookie: [] }, { bearer: [] }]);
    expect(challengeOf(scoped)).toBe(`Cookie realm="NortFox", cookie-name="__Host-nortfox-session", Bearer realm="NortFox"`);
    expect(scoped.responses[401]).toMatchObject({
      headers: {
        "WWW-Authenticate": {
          description:
            `The challenge, as RFC 9110 asks of every 401: Cookie realm="NortFox", cookie-name="__Host-nortfox-session", Bearer realm="NortFox". ` +
            `To a request whose bearer token names no actor, the Bearer challenge is Bearer realm="NortFox", error="invalid_token" (RFC 6750, 3.1).`,
          schema: { type: "string" },
        },
      },
    });
    expect(scoped.responses[403]).toMatchObject({
      headers: {
        "WWW-Authenticate": {
          description:
            `To a token: Bearer realm="NortFox", error="insufficient_scope", scope="bookkeeping" when the token lacks the scope (scope-missing), ` +
            `and Bearer realm="NortFox", error="insufficient_scope" when its person lacks the permission (permission-missing) (RFC 6750, 3.1). A session's 403 carries none.`,
          schema: { type: "string" },
        },
      },
    });
  });

  it("names RFC 6750's invalid_token in the bearer token's challenge of a 401 to a request whose token names no actor, and leaves the cookie's as it is", () => {
    const scoped = { "x-nortfox": { ...read["x-nortfox"], scope: "bookkeeping" as const } };
    expect(challengeOf(scoped, { invalidToken: true })).toBe(`Cookie realm="NortFox", cookie-name="__Host-nortfox-session", Bearer realm="NortFox", error="invalid_token"`);
    expect(challengeOf(scoped, { invalidToken: false })).toBe(challengeOf(scoped));
    // An operation that takes the cookie alone has no bearer challenge to name it in.
    expect(challengeOf(read, { invalidToken: true })).toBe(challengeOf(read));
  });

  it("gives RFC 6750's Bearer challenge with its error code, and the scope when one is lacked", () => {
    expect(bearerChallenge("invalid_token")).toBe(`Bearer realm="NortFox", error="invalid_token"`);
    expect(bearerChallenge("insufficient_scope")).toBe(`Bearer realm="NortFox", error="insufficient_scope"`);
    expect(bearerChallenge("insufficient_scope", "users")).toBe(`Bearer realm="NortFox", error="insufficient_scope", scope="users"`);
  });

  it("documents the challenge of a token's 403: insufficient_scope, with the scope only where a scope is what it lacks", () => {
    const signedIn = defineOperation({
      id: "getOwnThing",
      method: "get",
      path: "/v1/own-things",
      tags: ["items"],
      summary: "Read",
      description: "Reads.",
      output: Item,
      permission: "signed-in",
      scope: "profile",
      tool: "Reads.",
      writes: false,
    });
    expect(signedIn.responses[403]?.headers).toEqual({
      "WWW-Authenticate": {
        description: `To a token: Bearer realm="NortFox", error="insufficient_scope", scope="profile" when the token lacks the scope (scope-missing) (RFC 6750, 3.1). A session's 403 carries none.`,
        schema: { type: "string" },
      },
    });
    // An operation with no scope refuses every token with session-required.
    expect(read.responses[403]?.headers).toEqual({
      "WWW-Authenticate": {
        description: `To a token, which the operation refuses with session-required: Bearer realm="NortFox", error="insufficient_scope" (RFC 6750, 3.1). A session's 403 carries none.`,
        schema: { type: "string" },
      },
    });
    // An operation that needs no actor answers no token with a 403 of its own.
    expect(publicRead.responses[403]).toBeUndefined();
  });
});

describe("defineListOperation", () => {
  it("is a list: limit and cursor beside its own query, and a page of its items", () => {
    expect(list["x-nortfox"]).toEqual({
      permission: "test:read",
      scope: null,
      tool: "Lists the items.",
      assistant: false,
      writes: false,
      list: true,
      session: null,
      company: "credential",
      personalOutput: [],
      secretOutput: [],
    });
    const query = querySchema(list);
    expect(Object.keys(query?.shape ?? {})).toEqual(["name", "limit", "cursor"]);
    expect(query?.shape.limit).toBe(Limit);
    expect(query?.shape.cursor).toBe(Cursor);
    const page = { items: [{ id: "0a6c8f4e-3b1d-4c2a-9e7f-5d8b6a4c2e1f" }], nextCursor: "abc", total: 3 };
    expect(outputSchema(list).parse(page)).toEqual(page);
    expect(statuses(list)).toEqual(["200", "400", "401", "403", "500"]);
  });

  it("takes limit and cursor alone when it has no query of its own", () => {
    const bare = defineListOperation({
      id: "listBare",
      method: "get",
      path: "/v1/bare",
      tags: ["items"],
      summary: "List",
      description: "Lists.",
      item: Item,
      permission: "test:read",
      tool: "Lists.",
      assistant: true,
    });
    expect(Object.keys(querySchema(bare)?.shape ?? {})).toEqual(["limit", "cursor"]);
    expect(bare["x-nortfox"].assistant).toBe(true);
  });
});
