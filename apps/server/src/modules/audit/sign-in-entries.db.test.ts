// SPDX-License-Identifier: AGPL-3.0-only

// H1's web half (issue 12, Behandlingshistorik 1): a sign-in writes an entry
// in the company it signs in to, when the web app chooses the company
// (selectCompany, at each choice, also when switching: choice 8): Program
// "Användare", Rubrik "Inloggning", and in Händelse the method, the second
// step and the time of the identification (when the session began, after
// its last step), the personnummer when the method gives one, the
// application "Webb" and the IP address. The time of the identification
// tells a switch of company from a new sign-in. The entry is one row of access.events, written by the
// person, and its history row is the behandlingshistorik's entry. The
// server's table of screen words gives the program's and the heading's
// words. The MCP login's half comes with OAuth, in a later part.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { PERSONAL_IDENTITY_NUMBERS } from "../../../test/identities.ts";
import { addCompanyWithOwner } from "../../../test/ledger.ts";
import { aCompany, addMembership } from "../../../test/memberships.ts";
import {
  MINUTE,
  addSignInIdentity,
  challengeOf,
  chooseCompany,
  codeOf,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  passwordStep,
  setCookiesOf,
  signIn,
  signInApp,
  testClock,
  totpStep,
  type SignInApp,
  type TestIdentity,
} from "../../../test/sign-in.ts";
import { ENTRY_WORDS } from "./entries.ts";

/** Addresses of the documentation range (RFC 5737), as a browser's requests come from them. */
const SIGN_IN_ADDRESS = "192.0.2.40";
const CHOICE_ADDRESS = "198.51.100.7";

interface Entry {
  readonly company_id: string;
  readonly program: string;
  readonly heading: string;
  readonly subject_id: string | null;
  readonly details: Record<string, unknown>;
  readonly at: Date;
}

describe("the behandlingshistorik of a sign-in", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  /** Reads the company tables past row level security, for the checks. */
  let superuser: Client;
  let pool: AppPool;
  let server: SignInApp;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    superuser = await db.admin();
    pool = appPool(db, 4);
    server = signInApp(pool.database, { clock: testClock() });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  async function companyOf(person: TestIdentity, name = "Testbolaget Alfa AB"): Promise<string> {
    return (await addCompanyWithOwner(app, { actor: person.id, kind: "user" }, { name })).row.company_id;
  }

  async function entriesIn(company: string, person: TestIdentity): Promise<Entry[]> {
    return (await superuser.query<Entry>(
      "SELECT company_id, program, heading, subject_id, details, at FROM access.events WHERE company_id = $1 AND subject_id = $2 ORDER BY at, id",
      [company, person.id],
    )).rows;
  }

  it("a web sign-in with the e-mail writes Användare, Inloggning, the method, the application and the IP address", async () => {
    const person = await addSignInIdentity(owner);
    const company = await companyOf(person);
    const { session } = await signIn(server, person, { ipAddress: SIGN_IN_ADDRESS });
    const signedInAt = server.clock.now().toISOString();
    expect((await chooseCompany(server, session, company, { ipAddress: CHOICE_ADDRESS })).status).toBe(200);
    expect(await entriesIn(company, person)).toEqual([
      {
        company_id: company,
        program: "users",
        heading: "sign-in",
        subject_id: person.id,
        details: { method: "password-email", secondStep: "totp", identifiedAt: signedInAt, application: "web", ipAddress: CHOICE_ADDRESS, outcome: "succeeded" },
        at: server.clock.now(),
      },
    ]);
    // The entry's history row is the behandlingshistorik's entry, by the person.
    const history = await superuser.query<{ operation: string; actor_id: string; actor_kind: string; new_values: { details: unknown } }>(
      "SELECT operation, actor_id, actor_kind, new_values FROM audit.history WHERE company_id = $1 AND table_name = 'access.events'",
      [company],
    );
    expect(history.rows.map(({ operation, actor_id, actor_kind, new_values }) => ({ operation, actor_id, actor_kind, details: new_values.details }))).toEqual([
      {
        operation: "INSERT",
        actor_id: person.id,
        actor_kind: "user",
        details: { method: "password-email", secondStep: "totp", identifiedAt: signedInAt, application: "web", ipAddress: CHOICE_ADDRESS, outcome: "succeeded" },
      },
    ]);
    // The server's screen words of the entry.
    expect(ENTRY_WORDS.programs.users).toBe("Användare");
    expect(ENTRY_WORDS.headings["sign-in"]).toBe("Inloggning");
    // The method and the time of the identification share the line Identifiering, as in "Identifiering: <method>, <date and time>".
    expect(ENTRY_WORDS.details).toEqual({
      method: "Identifiering",
      identifiedAt: "Identifiering",
      personalIdentityNumber: "Personnummer",
      application: "Applikation",
      ipAddress: "IP-adress",
    });
    expect(ENTRY_WORDS.applications.web).toBe("Webb");
  });

  it("writes an IPv4 client's address as IPv4, also when the socket gives it in the IPv4-mapped IPv6 form", async () => {
    const person = await addSignInIdentity(owner);
    const company = await companyOf(person);
    const { session } = await signIn(server, person);
    // A server that listens on both IPv4 and IPv6 sees an IPv4 client as ::ffff:a.b.c.d.
    expect((await chooseCompany(server, session, company, { ipAddress: `::ffff:${CHOICE_ADDRESS}` })).status).toBe(200);
    server.clock.advance(MINUTE);
    // An IPv6 client's address stays as it is (RFC 3849's documentation range).
    expect((await chooseCompany(server, session, company, { ipAddress: "2001:db8::7" })).status).toBe(200);
    expect((await entriesIn(company, person)).map((entry) => entry.details["ipAddress"])).toEqual([CHOICE_ADDRESS, "2001:db8::7"]);
  });

  it("a sign-in with the personnummer and the password also writes the personnummer", async () => {
    const number = PERSONAL_IDENTITY_NUMBERS[0];
    const person = await addSignInIdentity(owner, { personalIdentityNumber: number });
    const company = await companyOf(person);
    const challenge = await challengeOf(await passwordStep(server, number, person.password));
    const signedIn = await totpStep(server, challenge, codeOf(person, server.clock.now()));
    const session = setCookiesOf(signedIn)["__Host-nortfox-session"]?.value ?? "";
    expect((await chooseCompany(server, session, company, { ipAddress: CHOICE_ADDRESS })).status).toBe(200);
    expect((await entriesIn(company, person)).map((entry) => entry.details)).toEqual([
      {
        method: "password-personnummer",
        secondStep: "totp",
        identifiedAt: server.clock.now().toISOString(),
        personalIdentityNumber: number,
        application: "web",
        ipAddress: CHOICE_ADDRESS,
        outcome: "succeeded",
      },
    ]);
    // A sign-in with the e-mail of the same person writes no personnummer.
    server.clock.advance(MINUTE);
    const byEmail = (await signIn(server, person)).session;
    expect((await chooseCompany(server, byEmail, company, { ipAddress: CHOICE_ADDRESS })).status).toBe(200);
    expect((await entriesIn(company, person)).at(-1)?.details).toEqual({
      method: "password-email",
      secondStep: "totp",
      identifiedAt: server.clock.now().toISOString(),
      application: "web",
      ipAddress: CHOICE_ADDRESS,
      outcome: "succeeded",
    });
  });

  it("writes the known device as the second step of a sign-in on it", async () => {
    const person = await addSignInIdentity(owner);
    const company = await companyOf(person);
    const { device } = await signIn(server, person);
    server.clock.advance(MINUTE);
    const known = setCookiesOf(await passwordStep(server, person.email, person.password, { cookies: { device } }));
    const session = known["__Host-nortfox-session"]?.value ?? "";
    expect((await chooseCompany(server, session, company)).status).toBe(200);
    expect((await entriesIn(company, person)).map((entry) => entry.details)).toEqual([
      { method: "password-email", secondStep: "known-device", identifiedAt: server.clock.now().toISOString(), application: "web", outcome: "succeeded" },
    ]);
  });

  it("writes one at each choice, also when switching, in the company chosen", async () => {
    const person = await addSignInIdentity(owner);
    const alfa = await companyOf(person, "Testbolaget Alfa AB");
    const beta = await aCompany(app, "Testbolaget Beta AB");
    await addMembership(app, owner, beta, { user: person.id });
    const { session } = await signIn(server, person);
    const signedInAt = server.clock.now();
    for (const company of [alfa, beta.id, alfa]) {
      server.clock.advance(MINUTE);
      expect((await chooseCompany(server, session, company)).status).toBe(200);
    }
    expect(await entriesIn(alfa, person)).toHaveLength(2);
    expect(await entriesIn(beta.id, person)).toHaveLength(1);
    // Each names when the person identified, apart from when it was written: a switch is told from a new sign-in.
    const entries = [...(await entriesIn(alfa, person)), ...(await entriesIn(beta.id, person))].sort((a, b) => a.at.getTime() - b.at.getTime());
    expect(entries.map((entry) => [entry.details["identifiedAt"], entry.at.getTime() - signedInAt.getTime()])).toEqual([
      [signedInAt.toISOString(), MINUTE],
      [signedInAt.toISOString(), 2 * MINUTE],
      [signedInAt.toISOString(), 3 * MINUTE],
    ]);
    // A refused choice writes nothing.
    const gamma = await aCompany(app, "Testbolaget Gamma AB");
    expect((await chooseCompany(server, session, gamma.id)).status).toBe(422);
    expect((await superuser.query("SELECT 1 FROM access.events WHERE company_id = $1", [gamma.id])).rows).toEqual([]);
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
