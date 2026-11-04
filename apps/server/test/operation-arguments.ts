// SPDX-License-Identifier: AGPL-3.0-only

// For every operation of the registry, arguments that succeed: the flat
// input of its MCP tool, as REST takes it too. The generated tests read
// them: api/mcp-session-tools.db.test.ts calls every operation that serves
// the browser's session with them, and later parts' generated tests call
// every operation a token can reach. Each part adds its own operations here,
// and the tests fail on an operation without its entry, so none goes
// unchecked.
//
// An entry asks the test's fixture for what must be live when it is used,
// such as a setup link or a login challenge, and the fixture makes it then.

import { bodySchema, paramsSchema, querySchema, takesIdempotencyKey, type Operation } from "@nortfox/contract";
import type { TestIdentity } from "./sign-in.ts";

/** What the arguments of an operation need from the test's install, made when they are asked for. */
export interface ArgumentsFixture {
  /** The token of a live setup link, on an install that has no identity yet. */
  readonly setupToken: () => Promise<string>;
  /** A person who can sign in. */
  readonly person: () => Promise<TestIdentity>;
  /** A live login challenge of a person, and that person's code at the server's time. */
  readonly challenge: () => Promise<{ readonly challenge: string; readonly code: string }>;
}

export type ArgumentsOf = (fixture: ArgumentsFixture) => Promise<Readonly<Record<string, unknown>>>;

const none: ArgumentsOf = () => Promise.resolve({});

/** Arguments that succeed, by operation id. A signed-in operation runs with a session that the test makes. */
export const OPERATION_ARGUMENTS: Readonly<Record<string, ArgumentsOf>> = {
  getHealth: none,
  getCompany: none,
  completeSetup: async (fixture) => ({ token: await fixture.setupToken(), name: "Signe Ek", email: "signe.ek@example.com", password: "signes-första-lösenord" }),
  loginWithPassword: async (fixture) => {
    const person = await fixture.person();
    return { identifier: person.email, password: person.password };
  },
  verifyTotp: async (fixture) => ({ ...(await fixture.challenge()) }),
  logout: () => Promise.resolve({ idempotencyKey: "logout-of-the-test" }),
  getSession: none,
  getMe: none,
};

/** A REST request of `operation` from its flat input: the path parameters in the path, the query, the body and the key. */
export function restRequestOf(operation: Operation, args: Readonly<Record<string, unknown>>): { readonly path: string; readonly init: RequestInit } {
  const params = new Set(Object.keys(paramsSchema(operation)?.shape ?? {}));
  const query = new Set(Object.keys(querySchema(operation)?.shape ?? {}));
  let path = operation.path;
  const search = new URLSearchParams();
  const body: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(args)) {
    if (params.has(name)) {
      path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
    } else if (query.has(name)) {
      search.set(name, String(value));
    } else if (name === "idempotencyKey" && takesIdempotencyKey(operation)) {
      headers["idempotency-key"] = String(value);
    } else {
      body[name] = value;
    }
  }
  const text = search.toString();
  const takesBody = bodySchema(operation) !== undefined;
  return {
    path: text === "" ? path : `${path}?${text}`,
    init: {
      method: operation.method.toUpperCase(),
      headers: { ...headers, ...(takesBody ? { "content-type": "application/json" } : {}) },
      ...(takesBody ? { body: JSON.stringify(body) } : {}),
    },
  };
}
