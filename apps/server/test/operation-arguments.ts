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
  /** A company that `person` owns, made as the app does. */
  readonly companyOf: (person: TestIdentity) => Promise<string>;
  /**
   * A member of the company that companyOf made last for `person`, another
   * person, made as the app does, holding `program` when one is given: the
   * member's id.
   */
  readonly memberOf: (person: TestIdentity, program?: string) => Promise<string>;
  /** An invited member of the company that companyOf made last for `person`, whom `person` invited: the member's id. */
  readonly invitedOf: (person: TestIdentity) => Promise<string>;
  /** The token of a live invitation link, of a new invitation to a company of another person. */
  readonly invitationToken: () => Promise<string>;
  /** A company where `person` is an active member beside its owner, made as the app does. */
  readonly joinedCompanyOf: (person: TestIdentity) => Promise<string>;
  /** A live API token of `person` in the company that companyOf made last for them, made as the app does: the token's id. */
  readonly tokenOf: (person: TestIdentity) => Promise<string>;
}

/** The arguments of an operation, from the fixture and, for a signed-in operation, the person whose session calls it. */
export type ArgumentsOf = (fixture: ArgumentsFixture, actor?: TestIdentity) => Promise<Readonly<Record<string, unknown>>>;

/** The person whose session calls a signed-in operation. */
function actorOf(actor: TestIdentity | undefined): TestIdentity {
  if (actor === undefined) {
    throw new Error("A signed-in operation's arguments need the person whose session calls it.");
  }
  return actor;
}

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
  createCompany: () => Promise.resolve({ name: "Testbolaget Lambda AB", organizationNumber: "556000-0167", idempotencyKey: "make-lambda" }),
  listCompanies: none,
  listRecentCompanies: none,
  selectCompany: async (fixture, actor) => ({ companyId: await fixture.companyOf(actorOf(actor)), idempotencyKey: "choose-the-company" }),
  updateMyMembership: async (fixture, actor) => ({ companyId: await fixture.companyOf(actorOf(actor)), idleTimeout: 60, idempotencyKey: "change-my-membership" }),
  updateCompany: () => Promise.resolve({ name: "Testbolaget Lambda AB", city: "Lund", idempotencyKey: "change-the-company" }),
  listPermissions: none,
  listUsers: none,
  getUser: async (fixture, actor) => ({ memberId: await fixture.memberOf(actorOf(actor)) }),
  updateUser: async (fixture, actor) => ({ memberId: await fixture.memberOf(actorOf(actor)), idleTimeout: 60, idempotencyKey: "change-the-user" }),
  removeUser: async (fixture, actor) => ({ memberId: await fixture.memberOf(actorOf(actor)), idempotencyKey: "remove-the-user" }),
  assignProgram: async (fixture, actor) => ({ memberId: await fixture.memberOf(actorOf(actor)), program: "read", full: true, idempotencyKey: "grant-the-program" }),
  removeProgram: async (fixture, actor) => ({ memberId: await fixture.memberOf(actorOf(actor), "read"), program: "read", idempotencyKey: "remove-the-program" }),
  moveProgram: async (fixture, actor) => ({
    memberId: await fixture.memberOf(actorOf(actor), "read"),
    program: "read",
    targetMemberId: await fixture.memberOf(actorOf(actor)),
    idempotencyKey: "move-the-program",
  }),
  updateUserRights: async (fixture, actor) => ({ memberId: await fixture.memberOf(actorOf(actor), "read"), permissions: ["reports.vat"], idempotencyKey: "set-the-rights" }),
  inviteUser: () => Promise.resolve({ name: "Klara Ny", email: "klara.ny@example.com", idempotencyKey: "invite-the-user" }),
  resendInvitation: async (fixture, actor) => ({ memberId: await fixture.invitedOf(actorOf(actor)), idempotencyKey: "invite-again" }),
  disconnectUserIdentity: async (fixture, actor) => ({ memberId: await fixture.memberOf(actorOf(actor)), idempotencyKey: "disconnect-the-user" }),
  getInvitation: async (fixture) => ({ token: await fixture.invitationToken() }),
  acceptInvitation: async (fixture) => ({ token: await fixture.invitationToken(), newIdentity: { name: "Sixten Ny", password: "sixtens-lösenord" } }),
  leaveCompany: async (fixture, actor) => ({ companyId: await fixture.joinedCompanyOf(actorOf(actor)), idempotencyKey: "leave-the-company" }),
  createApiToken: () => Promise.resolve({ name: "Bokföringsexport", scopes: ["bookkeeping"], idempotencyKey: "make-the-token" }),
  listApiTokens: none,
  revokeApiToken: async (fixture, actor) => ({ tokenId: await fixture.tokenOf(actorOf(actor)), idempotencyKey: "revoke-the-token" }),
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
