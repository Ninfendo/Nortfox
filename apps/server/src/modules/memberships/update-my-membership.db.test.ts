// SPDX-License-Identifier: AGPL-3.0-only

// updateMyMembership: Användaruppgifter (issue 12, "Users in a company" 8
// and 9). The signed-in person changes their own work e-mail address and
// phone number, and the idle logout, in a company where they are an active
// member, which the path names; a field left out stays, and null takes a
// work contact away. Any other company gets the same refusal as one that
// does not exist. The idle time is the membership's column, so its change is
// in the behandlingshistorik; the work contacts are kept beside it, and leave
// no history. These run through /v1 as nortfox_app.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, gate, type AppPool, type Gate, type ProblemBody } from "../../../test/api.ts";
import { begin, freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { aCompany, addMembership, changeMembership, type Company } from "../../../test/memberships.ts";
import {
  addSignInIdentity,
  chooseCompany,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  jsonOf,
  signIn,
  signInApp,
  testClock,
  untilSomeoneWaitsForLock,
  writeAs,
  type SignInApp,
  type TestIdentity,
} from "../../../test/sign-in.ts";
import type { Database } from "../../db/database.ts";

interface MembershipJson {
  readonly companyId: string;
  readonly userId?: string;
  readonly status: string;
  readonly adminLevel?: string;
  readonly idleTimeout: number;
  readonly workEmail?: string;
  readonly workPhone?: string;
}

describe("updateMyMembership", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  /** Reads the company tables past row level security, for the checks. */
  let superuser: Client;
  let pool: AppPool;
  let server: SignInApp;
  let person: TestIdentity;
  let session: string;
  let alfa: Company;
  let beta: Company;
  let inBeta: string;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    superuser = await db.admin();
    pool = appPool(db, 4);
    server = signInApp(pool.database, { clock: testClock() });
    person = await addSignInIdentity(owner);
    alfa = await aCompany(app, "Testbolaget Alfa AB");
    await addMembership(app, owner, alfa, { user: person.id });
    beta = await aCompany(app, "Testbolaget Beta AB");
    inBeta = await addMembership(app, owner, beta, { user: person.id });
    session = (await signIn(server, person)).session;
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  function change(company: string, body: unknown): Promise<Response> {
    return writeAs(server, session, "PATCH", `/v1/me/companies/${company}`, body);
  }

  async function contactsOf(company: string): Promise<{ work_email: string | null; work_phone: string | null }[]> {
    return (await owner.query<{ work_email: string | null; work_phone: string | null }>("SELECT work_email, work_phone FROM access.membership_contacts WHERE contact_company_id = $1", [company])).rows;
  }

  async function historyOf(company: string): Promise<number> {
    return Number((await superuser.query<{ n: string }>("SELECT count(*) AS n FROM audit.history WHERE company_id = $1", [company])).rows[0]?.n);
  }

  it("changes one work contact and keeps the other, and null takes one away", async () => {
    const base = { companyId: alfa.id, userId: person.id, status: "active", idleTimeout: 120, roles: [], programs: [], programsAdministered: [] };
    expect(await jsonOf<MembershipJson>(await change(alfa.id, { workEmail: "alva.berg@example.com" }))).toEqual({ ...base, workEmail: "alva.berg@example.com" });
    expect(await jsonOf<MembershipJson>(await change(alfa.id, { workPhone: "070-174 06 07" }))).toEqual({ ...base, workEmail: "alva.berg@example.com", workPhone: "070-174 06 07" });
    expect(await jsonOf<MembershipJson>(await change(alfa.id, { workEmail: null }))).toEqual({ ...base, workPhone: "070-174 06 07" });
    expect(await contactsOf(alfa.id)).toEqual([{ work_email: null, work_phone: "070-174 06 07" }]);
    expect(await jsonOf<MembershipJson>(await change(alfa.id, { workPhone: null }))).toEqual(base);
    // With neither left, the row goes.
    expect(await contactsOf(alfa.id)).toEqual([]);
  });

  it("changes nothing for an empty body, and writes no history for an idle time that stays", async () => {
    const before = await historyOf(alfa.id);
    expect((await jsonOf<MembershipJson>(await change(alfa.id, {}))).idleTimeout).toBe(120);
    expect((await jsonOf<MembershipJson>(await change(alfa.id, { idleTimeout: 120 }))).idleTimeout).toBe(120);
    expect(await historyOf(alfa.id)).toBe(before);
    expect((await jsonOf<MembershipJson>(await change(alfa.id, { idleTimeout: 30 }))).idleTimeout).toBe(30);
    expect(await historyOf(alfa.id)).toBe(before + 1);
  });

  it("works in the company that the path names, also when the session works in another, and changes only the person's own membership", async () => {
    expect((await chooseCompany(server, session, alfa.id)).status).toBe(200);
    expect(await jsonOf<MembershipJson>(await change(beta.id, { idleTimeout: 480, workEmail: "alva.beta@example.org" }))).toEqual({
      companyId: beta.id,
      userId: person.id,
      status: "active",
      idleTimeout: 480,
      workEmail: "alva.beta@example.org",
      roles: [],
      programs: [],
      programsAdministered: [],
    });
    const memberships = await superuser.query<{ id: string; idle_timeout_minutes: number }>(
      "SELECT id, idle_timeout_minutes FROM access.memberships WHERE company_id = $1 ORDER BY idle_timeout_minutes",
      [beta.id],
    );
    expect(memberships.rows).toEqual([
      { id: beta.membership, idle_timeout_minutes: 120 },
      { id: inBeta, idle_timeout_minutes: 480 },
    ]);
    expect(await contactsOf(beta.id)).toEqual([{ work_email: "alva.beta@example.org", work_phone: null }]);
  });

  it("refuses a company where the person is no active member with the same answer as one that does not exist, and changes nothing", async () => {
    const gamma = await aCompany(app, "Testbolaget Gamma AB");
    await changeMembership(app, gamma, await addMembership(app, owner, gamma, { user: person.id }), "status = 'inactive'");
    const stranger = await aCompany(app, "Testbolaget Delta AB");
    const answers: ProblemBody[] = [];
    for (const company of [gamma.id, stranger.id, randomUUID()]) {
      answers.push(await jsonOf<ProblemBody>(await change(company, { idleTimeout: 15 }), 422));
    }
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(answers[0]).toEqual({
      type: "about:blank",
      title: "Unprocessable Content",
      status: 422,
      detail: "The person is no active member of the company that companyId names, or it does not exist.",
      code: "company-not-available",
      pointer: "/companyId",
    });
    const idle = await superuser.query("SELECT 1 FROM access.memberships WHERE company_id = $1 AND idle_timeout_minutes = 15", [gamma.id]);
    expect(idle.rows).toEqual([]);
    // A company id of another form is a field problem.
    expect((await jsonOf<ProblemBody>(await change("Testbolaget-Alfa", { idleTimeout: 15 }), 400)).errors?.[0]).toMatchObject({ code: "bad-format", pointer: "/companyId" });
  });

  describe("at the same time as another change", () => {
    /** A server whose next person's write, once armed, waits at a gate before its commit, with its row locks held. */
    function holdingServer(): { readonly racer: SignInApp; readonly held: Gate; readonly arm: () => void } {
      const held = gate();
      let armed = false;
      const holding: Database = {
        ...pool.database,
        person: (mode, settings, work) =>
          pool.database.person(mode, settings, async (tx) => {
            const picked = armed && mode === "write";
            armed &&= !picked;
            const ending = await work(tx);
            if (picked) {
              await held.pass();
            }
            return ending;
          }),
      };
      return {
        racer: signInApp(holding, { clock: testClock() }),
        held,
        arm: () => {
          armed = true;
        },
      };
    }

    it("keeps both work contacts when two changes of one membership come at once, one for each field", async () => {
      const someone = await addSignInIdentity(owner);
      const epsilon = await aCompany(app, "Testbolaget Epsilon AB");
      await addMembership(app, owner, epsilon, { user: someone.id });
      const { racer, held, arm } = holdingServer();
      const racing = (await signIn(racer, someone)).session;
      arm();
      const first = writeAs(racer, racing, "PATCH", `/v1/me/companies/${epsilon.id}`, { workEmail: "alva.berg@example.com" });
      await held.reached;
      // The second change starts while the first holds its locks, before the first commits.
      const second = writeAs(racer, racing, "PATCH", `/v1/me/companies/${epsilon.id}`, { workPhone: "070-174 06 08" });
      await untilSomeoneWaitsForLock(app);
      held.open();
      expect([(await first).status, (await second).status]).toEqual([200, 200]);
      expect(await contactsOf(epsilon.id)).toEqual([{ work_email: "alva.berg@example.com", work_phone: "070-174 06 08" }]);
    });

    it("refuses with company-not-available a change that waited for the membership's removal or deactivation, and writes nothing", async () => {
      for (const [set, body] of [
        ["status = 'removed'", { idleTimeout: 15 }],
        ["status = 'inactive'", { workEmail: "alva.zeta@example.com" }],
      ] as const) {
        const zeta = await aCompany(app, "Testbolaget Zeta AB");
        const membership = await addMembership(app, owner, zeta, { user: person.id });
        const remover = await db.connect("app");
        try {
          await begin(remover, { company: zeta.id, ...zeta.asOwner, channel: "rest" });
          await remover.query(`UPDATE access.memberships SET ${set} WHERE id = $1`, [membership]);
          const changing = change(zeta.id, body);
          await untilSomeoneWaitsForLock(app);
          await remover.query("COMMIT");
          expect(await jsonOf<ProblemBody>(await changing, 422), set).toMatchObject({ code: "company-not-available", pointer: "/companyId" });
        } finally {
          await remover.end();
        }
        expect(await contactsOf(zeta.id)).toEqual([]);
        const idle = await superuser.query("SELECT 1 FROM access.memberships WHERE id = $1 AND idle_timeout_minutes = 15", [membership]);
        expect(idle.rows).toEqual([]);
      }
    });
  });

  it("refuses a work e-mail of another form and a work phone that is empty or too long", async () => {
    for (const body of [{ workEmail: "inte en adress" }, { workEmail: "" }, { workPhone: "" }, { workPhone: "0".repeat(51) }, { workEmail: 7 }]) {
      const problem = await jsonOf<ProblemBody>(await change(alfa.id, body), 400);
      expect(problem.errors?.[0]?.pointer, JSON.stringify(body)).toBe(`/${Object.keys(body)[0] ?? ""}`);
    }
  });

  it("refuses a work contact with a lone surrogate or U+0000 as a field problem, never a server failure, and keeps what was there", async () => {
    expect((await change(beta.id, { workEmail: "alva.berg@example.com", workPhone: "070-174 06 07" })).status).toBe(200);
    const reports = server.reports.length;
    for (const body of [{ workPhone: "070 \uD800" }, { workEmail: "a\uDC00@example.com" }]) {
      const field = Object.keys(body)[0] ?? "";
      const problem = await jsonOf<ProblemBody>(await change(beta.id, body), 400);
      expect(problem.errors?.map((error) => [error.code, error.pointer, error.detail])).toEqual([
        ["invalid-value", `/${field}`, `The field /${field} holds a lone surrogate, which is not a character.`],
      ]);
    }
    for (const body of [{ workPhone: "070-174 06 07\u0000" }, { workEmail: "a\u0000@example.com" }]) {
      const field = Object.keys(body)[0] ?? "";
      const problem = await jsonOf<ProblemBody>(await change(beta.id, body), 400);
      expect(problem.errors?.map((error) => [error.code, error.pointer, error.detail])).toEqual([
        ["invalid-value", `/${field}`, `The field /${field} holds the character U+0000, which no text may hold.`],
      ]);
    }
    expect(await contactsOf(beta.id)).toEqual([{ work_email: "alva.berg@example.com", work_phone: "070-174 06 07" }]);
    expect(server.reports.length).toBe(reports);
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
