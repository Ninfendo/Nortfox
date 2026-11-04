// SPDX-License-Identifier: AGPL-3.0-only

// Test-only operations of each shape that the registry takes from slice 2c
// on, with their handlers, and a database that runs a handler's work without
// PostgreSQL. They live here, outside src, so no build holds them and
// openapi.json never shows them. A test that needs them builds its app with
// SHAPES_REGISTRY and shapeHandlers().
//
// - testGetThing: path parameters and a query, in the credential's company.
// - testRemoveThing: a write in a company that answers 204 with no body.
// - testSignIn: runs before sign-in, serves the browser's session, takes no
//   key, and sets the session and device cookies.
// - testSendLetter: runs before sign-in, answers 202, and does its work
//   after the answer.
// - testStartRedirect: a GET that runs before sign-in, writes, and answers
//   303 with the login cookie.
// - testGetPerson: a signed-in person's read, in no company.
// - testEndSession: a signed-in person's write in no company, keeps its key
//   per person, answers 204 and clears the session cookie.

import { NoBody, Redirect, defineOperation, type Operation } from "@nortfox/contract";
import type { QueryResult, QueryResultRow } from "pg";
import { z } from "zod";
import type { Principal } from "../src/api/context.ts";
import { handleData, handleNone, handlePerson, ok, refused, type Handler, type RequestFacts } from "../src/api/operation.ts";
import type { Database, Ending, Queryable, TransactionSettings, Work } from "../src/db/database.ts";
import { TEST_REGISTRY, testHandlers, type Gate } from "./api.ts";

const ThingId = z.strictObject({ thingId: z.uuid().meta({ description: "The thing's id." }) });

export const TestThing = z.strictObject({
  id: z.uuid().meta({ description: "The thing's id." }),
  view: z.enum(["short", "long"]).meta({ description: "How much of the thing the answer shows." }),
  companyId: z.uuid().meta({ description: "The company the request worked in." }),
});

export const testGetThing = defineOperation({
  id: "testGetThing",
  method: "get",
  path: "/v1/test-things/{thingId}",
  tags: ["test"],
  summary: "Read a thing",
  description: "Reads a thing by its id. Only the tests serve it.",
  params: ThingId,
  query: z.strictObject({ view: z.enum(["short", "long"]).optional().meta({ description: "How much to show." }) }),
  output: TestThing,
  permission: "test:read",
  tool: "Reads a thing by its id. Only the tests serve it.",
  writes: false,
});

export const testRemoveThing = defineOperation({
  id: "testRemoveThing",
  method: "delete",
  path: "/v1/test-things/{thingId}",
  tags: ["test"],
  summary: "Remove a thing",
  description: "Removes a thing. Only the tests serve it.",
  params: ThingId,
  output: NoBody,
  status: 204,
  permission: "test:write",
  tool: "Removes a thing. Only the tests serve it.",
  writes: true,
});

export const testSignIn = defineOperation({
  id: "testSignIn",
  method: "post",
  path: "/v1/test-sign-ins",
  tags: ["test"],
  summary: "Sign in",
  description: "Signs in with an e-mail address alone. Only the tests serve it.",
  body: z.strictObject({ email: z.string().min(1).meta({ description: "The e-mail address." }) }),
  output: z.strictObject({
    email: z.string().meta({ description: "The e-mail address." }),
    signedIn: z.boolean().meta({ description: "Whether the request came with a session already." }),
  }),
  permission: "none",
  session: "flow",
  tool: "Signs in. Only the tests serve it.",
  writes: true,
});

export const testSendLetter = defineOperation({
  id: "testSendLetter",
  method: "post",
  path: "/v1/test-letters",
  tags: ["test"],
  summary: "Send a letter",
  description: "Sends a letter after the answer. Only the tests serve it.",
  body: z.strictObject({ email: z.string().min(1).meta({ description: "Where the letter goes." }) }),
  output: NoBody,
  status: 202,
  permission: "none",
  session: "flow",
  tool: "Sends a letter. Only the tests serve it.",
  writes: true,
});

export const testStartRedirect = defineOperation({
  id: "testStartRedirect",
  method: "get",
  path: "/v1/test-redirects",
  tags: ["test"],
  summary: "Start a sign-in elsewhere",
  description: "Sends the browser to an identity provider. Only the tests serve it.",
  query: z.strictObject({ provider: z.enum(["alfa", "beta"]).meta({ description: "The provider." }) }),
  output: Redirect,
  status: 303,
  permission: "none",
  session: "flow",
  tool: "Starts a sign-in elsewhere. Only the tests serve it.",
  writes: true,
});

export const testGetPerson = defineOperation({
  id: "testGetPerson",
  method: "get",
  path: "/v1/test-person",
  tags: ["test"],
  summary: "Read the person",
  description: "Gives the signed-in person's id. Only the tests serve it.",
  output: z.strictObject({ personId: z.uuid().meta({ description: "The person's id." }) }),
  permission: "signed-in",
  tool: "Gives the signed-in person's id. Only the tests serve it.",
  writes: false,
});

export const testEndSession = defineOperation({
  id: "testEndSession",
  method: "post",
  path: "/v1/test-session-ends",
  tags: ["test"],
  summary: "End the session",
  description: "Ends the session. Only the tests serve it.",
  output: NoBody,
  status: 204,
  permission: "signed-in",
  session: "flow",
  tool: "Ends the session. Only the tests serve it.",
  writes: true,
});

/** The test-only operations of the new shapes, in the order tools/list gives them. */
export const SHAPE_OPERATIONS: readonly Operation[] = [testGetThing, testRemoveThing, testSignIn, testSendLetter, testStartRedirect, testGetPerson, testEndSession];

/** The test registry with the shapes. */
export const SHAPES_REGISTRY: readonly Operation[] = [...TEST_REGISTRY, ...SHAPE_OPERATIONS];

/** The cookies the test-only operations set. They are no real tokens. */
export const TEST_TOKENS = { session: "test-session-token", device: "test-device-token", login: "test-login-binding" } as const;

/** The e-mail address for which the letter's work fails after the answer. */
export const FAILING_LETTER = "failing@example.com";

/** What the shape handlers were called with, and what their work after the answer did. */
export interface ShapeLog {
  /** Each call: the operation, the principal it saw, and the request's facts for an operation that runs before sign-in. */
  readonly calls: { readonly operationId: string; readonly principal: Principal | undefined; readonly request?: RequestFacts; readonly now?: Date }[];
  /** The letters sent after the answer. */
  readonly letters: string[];
  /** Holds the next letter's work until the test opens it. */
  gate: Gate | undefined;
}

export function shapeLog(): ShapeLog {
  return { calls: [], letters: [], gate: undefined };
}

/** The handlers of the shapes, which write what they see to `log`. */
export function shapeHandlers(log: ShapeLog): Handler[] {
  return [
    handleData(testGetThing, ({ context }, { params, query }) => {
      log.calls.push({ operationId: "testGetThing", principal: context });
      return Promise.resolve(ok({ id: params.thingId, view: query.view ?? "short", companyId: context.company.companyId }));
    }),
    handleData(testRemoveThing, ({ context }) => {
      log.calls.push({ operationId: "testRemoveThing", principal: context });
      return Promise.resolve(ok({}));
    }),
    handleNone(testSignIn, ({ principal, request, now }, { body }) => {
      log.calls.push({ operationId: "testSignIn", principal, request, now: now() });
      if (body.email === "nobody@example.com") {
        return Promise.resolve(refused({ code: "test-sign-in-refused", detail: "The test refused the sign-in.", pointer: "/email" }));
      }
      return Promise.resolve(
        ok({ email: body.email, signedIn: principal !== undefined }, [
          { kind: "set-session", token: TEST_TOKENS.session },
          { kind: "set-device", token: TEST_TOKENS.device },
        ]),
      );
    }),
    handleNone(testSendLetter, ({ principal, later }, { body }) => {
      log.calls.push({ operationId: "testSendLetter", principal });
      later(async () => {
        const held = log.gate;
        log.gate = undefined;
        await held?.pass();
        if (body.email === FAILING_LETTER) {
          throw new Error("The test made the letter fail after the answer.");
        }
        log.letters.push(body.email);
      });
      return Promise.resolve(ok({}));
    }),
    handleNone(testStartRedirect, ({ principal }, { query }) => {
      log.calls.push({ operationId: "testStartRedirect", principal });
      return Promise.resolve(ok({ location: `https://${query.provider}.example.com/authorize?state=test-state` }, [{ kind: "set-login", token: TEST_TOKENS.login }]));
    }),
    handlePerson(testGetPerson, ({ context, now }) => {
      log.calls.push({ operationId: "testGetPerson", principal: context, now: now() });
      return Promise.resolve(ok({ personId: context.personId }));
    }),
    handlePerson(testEndSession, ({ context }) => {
      log.calls.push({ operationId: "testEndSession", principal: context });
      return Promise.resolve(ok({}, [{ kind: "clear-session" }]));
    }),
  ];
}

/** The handlers of the test registry with the shapes. */
export function shapesHandlers(log: ShapeLog): Handler[] {
  return [...testHandlers(), ...shapeHandlers(log)];
}

/** A database that runs a handler's work on a fake transaction, and records each transaction and each query. */
export interface FakeDatabase extends Database {
  readonly transactions: { readonly mode: "read" | "write"; readonly settings: TransactionSettings; ended?: "commit" | "rollback" | "throw" }[];
  readonly queries: { readonly text: string; readonly values: readonly unknown[] }[];
}

/**
 * The fake transaction answers the lookup of an idempotency key with no row,
 * and its insert with one, so a write with a key runs. It refuses every
 * other query.
 */
export function fakeDatabase(): FakeDatabase {
  const transactions: FakeDatabase["transactions"] = [];
  const queries: FakeDatabase["queries"] = [];
  const run =
    (mode: "read" | "write") =>
    async <T>(settings: TransactionSettings, work: Work<T>): Promise<T> => {
      const transaction: FakeDatabase["transactions"][number] = { mode, settings };
      transactions.push(transaction);
      const tx: Queryable = {
        query: <Row extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
          queries.push({ text, values });
          if (/^SELECT\b[\s\S]*\.idempotency_keys\b/.test(text)) {
            return Promise.resolve({ rows: [] } as unknown as QueryResult<Row>);
          }
          if (/^INSERT INTO \w+\.idempotency_keys\b/.test(text)) {
            return Promise.resolve({ rows: [{ id: "f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f" }] } as unknown as QueryResult<Row>);
          }
          return Promise.reject(new Error(`The fake database runs no query but an idempotency key's: ${text}`));
        },
      };
      let ending: Ending<T>;
      try {
        ending = await work(tx);
      } catch (error) {
        transaction.ended = "throw";
        throw error;
      }
      transaction.ended = ending.commit ? "commit" : "rollback";
      return ending.value;
    };
  return { transactions, queries, read: run("read"), write: run("write"), end: () => Promise.resolve() };
}
