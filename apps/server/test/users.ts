// SPDX-License-Identifier: AGPL-3.0-only

// What the tests of the user administration share: a company that its owner
// made with createCompany and works in, members, sessions that have chosen
// the company, and the calls of the operations on /v1 as the web app sends
// them. A member is invited and accepts as the database holds it
// (acceptedMember): inviteUser and acceptInvitation come in the next step of
// slice 2c, part 3, which then makes these members through the operations.
// Every person is made up.

import type { Client } from "pg";
import { asMember, acceptedMember, type Company } from "./memberships.ts";
import { MINUTE, addSignInIdentity, chooseCompany, getAs, jsonOf, signIn, writeAs, type SignInApp, type TestIdentity } from "./sign-in.ts";

/** A company that its owner made through createCompany, with the owner's session working in it. */
export interface ApiCompany extends Company {
  /** The owner, who can sign in. */
  readonly creator: TestIdentity;
  /** The owner's session, which has chosen the company. */
  readonly session: string;
}

/** The roles a test connects as for its helpers: the app, and the owner, who makes the identities. */
export interface Clients {
  readonly app: Client;
  readonly owner: Client;
}

/** Signs `person` in, a minute after the last sign-in so a new TOTP code comes, and chooses `company`. Gives the session. */
export async function sessionIn(server: SignInApp, person: TestIdentity, company: string): Promise<string> {
  server.clock.advance(MINUTE);
  const { session } = await signIn(server, person);
  const chosen = await chooseCompany(server, session, company);
  if (chosen.status !== 200) {
    throw new Error(`The choice of the company answered ${String(chosen.status)}: ${await chosen.text()}`);
  }
  return session;
}

/** A new person makes a company with createCompany, and chooses it. */
export async function apiCompany(server: SignInApp, clients: Clients, name = "Testbolaget Alfa AB"): Promise<ApiCompany> {
  const creator = await addSignInIdentity(clients.owner);
  server.clock.advance(MINUTE);
  const signedIn = await signIn(server, creator);
  const made = await jsonOf<{ id: string; name: string; organizationNumber: string; databaseNumber: number }>(
    await writeAs(server, signedIn.session, "POST", "/v1/companies", { name, organizationNumber: "556000-0167" }),
    201,
  );
  const asOwner = { actor: creator.id, kind: "user" } as const;
  const [first] = await asMember<{ id: string }>(clients.app, made.id, asOwner, "SELECT id FROM access.memberships WHERE live_user_id = $1", [creator.id]);
  if (first === undefined) {
    throw new Error("createCompany made no membership for its creator.");
  }
  const chosen = await chooseCompany(server, signedIn.session, made.id);
  if (chosen.status !== 200) {
    throw new Error(`The choice of the new company answered ${String(chosen.status)}.`);
  }
  return {
    row: { company_id: made.id, name: made.name, organization_number: made.organizationNumber, database_number: made.databaseNumber },
    owner: creator.id,
    membership: first.id,
    id: made.id,
    asOwner,
    creator,
    session: signedIn.session,
  };
}

/** A member of the company: a person who can sign in, and the membership's id. */
export interface TestMember {
  readonly person: TestIdentity;
  readonly id: string;
}

/** A new person who is invited to the company and accepts, as the database holds it. */
export async function newMember(clients: Clients, company: Company): Promise<TestMember> {
  const person = await addSignInIdentity(clients.owner);
  return { person, id: await acceptedMember(clients.app, clients.owner, company, person.id) };
}

/** The answer of a call of an operation: its status and its body as JSON, or undefined for none. */
export interface Called<T = unknown> {
  readonly status: number;
  readonly body: T;
}

/** The status and the JSON of an answer, or undefined for an answer with no body. */
export async function called<T = unknown>(response: Response): Promise<Called<T>> {
  const text = await response.text();
  return { status: response.status, body: (text === "" ? undefined : JSON.parse(text)) as T };
}

/** The calls of the user administration, as the web app sends them with a session. */
export const calls = {
  listUsers: (server: SignInApp, session: string, query = ""): Promise<Response> => getAs(server, session, `/v1/users${query}`),
  getUser: (server: SignInApp, session: string, member: string): Promise<Response> => getAs(server, session, `/v1/users/${member}`),
  updateUser: (server: SignInApp, session: string, member: string, body: unknown, key?: string): Promise<Response> =>
    writeAs(server, session, "PATCH", `/v1/users/${member}`, body, key === undefined ? {} : { key }),
  removeUser: (server: SignInApp, session: string, member: string, key?: string): Promise<Response> =>
    writeAs(server, session, "DELETE", `/v1/users/${member}`, undefined, key === undefined ? {} : { key }),
  assignProgram: (server: SignInApp, session: string, member: string, program: string, body: unknown = { full: true }): Promise<Response> =>
    writeAs(server, session, "PUT", `/v1/users/${member}/programs/${program}`, body),
  removeProgram: (server: SignInApp, session: string, member: string, program: string): Promise<Response> =>
    writeAs(server, session, "DELETE", `/v1/users/${member}/programs/${program}`, undefined),
  moveProgram: (server: SignInApp, session: string, member: string, program: string, body: unknown): Promise<Response> =>
    writeAs(server, session, "POST", `/v1/users/${member}/programs/${program}/move`, body),
  updateUserRights: (server: SignInApp, session: string, member: string, permissions: readonly string[]): Promise<Response> =>
    writeAs(server, session, "PUT", `/v1/users/${member}/rights`, { permissions }),
  updateCompany: (server: SignInApp, session: string, body: unknown): Promise<Response> => writeAs(server, session, "PATCH", "/v1/company", body),
} as const;
