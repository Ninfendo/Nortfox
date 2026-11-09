// SPDX-License-Identifier: AGPL-3.0-only

// The unique violations that a request can meet (plan 2.21, issue 12, The
// login identity 6): a unique index of the database refuses a second
// identity with the same e-mail address in any letter case, and a second
// live membership of one person in one company. Where only a race gets past
// the server's own checks, the API answers the database's refusal as a
// rule's, 422 with a stable code, never 500: email-taken for two
// invitations to the same address, in two companies, accepted at once as
// new identities, and for completeSetup when another identity with its
// address is made at the same time; already-member for one person who
// accepts two invitations of one company at once. Nothing reaches the
// report, and no answer holds a token. Every other unique violation stays a
// fault of the server. The personnummer's index gets its code with the
// operations that set a personnummer (part 6); ledger-refusals.test.ts maps
// it.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, problemIn, type AppPool, type ProblemBody } from "../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../test/database.ts";
import { addIdentity } from "../../test/identities.ts";
import {
  MINUTE,
  TEST_ORIGIN,
  addSignInIdentity,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  jsonOf,
  postAsBrowser,
  signIn,
  signInApp,
  testClock,
  untilSomeoneWaitsForLock,
  type SignInApp,
} from "../../test/sign-in.ts";
import { apiCompany, calls, invite } from "../../test/users.ts";
import { createSetupLink } from "../setup.ts";

const EMAIL_TAKEN = {
  type: "about:blank",
  title: "Unprocessable Content",
  status: 422,
  detail: "Another identity has this e-mail address, in any letter case.",
  code: "email-taken",
};

describe("unique violations a request can meet", () => {
  const databases: TestDatabase[] = [];
  const pools: AppPool[] = [];

  afterAll(async () => {
    for (const pool of pools) {
      await pool.pool.end();
    }
    for (const db of databases) {
      await db.close();
    }
  });

  async function install(): Promise<{ db: TestDatabase; app: Client; owner: Client; superuser: Client; pool: AppPool; server: SignInApp }> {
    const db = await freshDatabase();
    databases.push(db);
    const pool = appPool(db, 6);
    pools.push(pool);
    return {
      db,
      app: await db.connect("app"),
      owner: await db.connect("owner"),
      superuser: await db.admin(),
      pool,
      server: signInApp(pool.database, { clock: testClock(new Date()) }),
    };
  }

  describe("with companies", () => {
    let made: Awaited<ReturnType<typeof install>>;

    beforeAll(async () => {
      made = await install();
    });

    it("two invitations to the same address in two companies, accepted at once as new identities: one 200, one 422 email-taken", async () => {
      const { app, owner, superuser, server } = made;
      const alfa = await apiCompany(server, { app, owner }, "Testbolaget Alfa AB");
      const beta = await apiCompany(server, { app, owner }, "Testbolaget Beta AB");
      const first = await invite(server, alfa.session, "greta.dubbel@example.com", "Greta Dubbel");
      const second = await invite(server, beta.session, "Greta.Dubbel@example.com", "Greta Dubbel");
      const answers = await Promise.all(
        [first, second].map((invited) => calls.acceptInvitation(server, invited.token, { newIdentity: { name: "Greta Dubbel", password: "gretas-lösenord" } })),
      );
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 422]);
      const refused = answers.find((answer) => answer.status === 422);
      expect(await problemIn(refused ?? new Response())).toEqual(EMAIL_TAKEN);
      const identities = await superuser.query("SELECT 1 FROM access.identities WHERE lower(email) = 'greta.dubbel@example.com'");
      expect(identities.rows).toHaveLength(1);
      // The refused one changed nothing: its link and its membership are as they were.
      const loser = answers[0]?.status === 422 ? first : second;
      expect((await calls.getInvitation(server, loser.token)).status).toBe(200);
      const membership = await superuser.query<{ status: string }>("SELECT status FROM access.memberships WHERE id = $1", [loser.id]);
      expect(membership.rows).toEqual([{ status: "invited" }]);
      // Now no race is needed: the address is taken.
      expect(await jsonOf<ProblemBody>(await calls.acceptInvitation(server, loser.token, { newIdentity: { name: "Greta Dubbel", password: "gretas-lösenord" } }), 422)).toEqual(EMAIL_TAKEN);
      expect(server.reports).toEqual([]);
    });

    it("one person accepting two invitations of one company at once: one 200, one 422 already-member", async () => {
      const { app, owner, superuser, server } = made;
      const company = await apiCompany(server, { app, owner }, "Testbolaget Gamma AB");
      const person = await addSignInIdentity(owner);
      const first = await invite(server, company.session, "hans.ett@example.com", "Hans Ett");
      const second = await invite(server, company.session, "hans.tva@example.com", "Hans Två");
      server.clock.advance(MINUTE);
      const { session } = await signIn(server, person);
      const answers = await Promise.all([first, second].map((invited) => calls.acceptInvitation(server, invited.token, {}, session)));
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 422]);
      const refused = answers.find((answer) => answer.status === 422);
      expect(await problemIn(refused ?? new Response())).toEqual({
        type: "about:blank",
        title: "Unprocessable Content",
        status: 422,
        detail: "The person is a member of the company already.",
        code: "already-member",
      });
      const live = await superuser.query("SELECT 1 FROM access.memberships WHERE company_id = $1 AND live_user_id = $2", [company.id, person.id]);
      expect(live.rows).toHaveLength(1);
      expect(server.reports).toEqual([]);
    });
  });

  it("completeSetup while another identity with its address is made at the same time: 422 email-taken at /email", async () => {
    const { owner, superuser, pool, server } = await install();
    const link = await createSetupLink(pool.database, TEST_ORIGIN, server.clock.now());
    const token = new URL(link.url).pathname.split("/").at(-1) ?? "";
    // Another transaction makes an identity with the address, and has not committed when completeSetup checks that the install is empty.
    await owner.query("BEGIN");
    await addIdentity(owner, { name: "Ines Först", email: "ines.forst@example.com" });
    const running = postAsBrowser(server, `/v1/setup/${token}`, { name: "Ines Först", email: "INES.forst@example.com", password: "ines-lösenord!" });
    await untilSomeoneWaitsForLock(superuser);
    await owner.query("COMMIT");
    const answer = await running;
    expect(answer.status).toBe(422);
    expect(await problemIn(answer)).toEqual({ ...EMAIL_TAKEN, pointer: "/email" });
    // Nothing of the setup was kept: the link still works, on an install that now has an identity.
    const used = await superuser.query<{ used: boolean }>("SELECT used_at IS NOT NULL AS used FROM access.setup_tokens");
    expect(used.rows).toEqual([{ used: false }]);
    expect(server.reports).toEqual([]);
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    for (const db of databases) {
      await expectNoSecretsAtRestFromSignInApps(db);
    }
  });
});
