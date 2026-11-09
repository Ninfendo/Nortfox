// SPDX-License-Identifier: AGPL-3.0-only

// With no mail set up for the install (issue 12, the API table and its
// done-when line; plan 2.15), inviteUser, resendInvitation and
// disconnectUserIdentity are each refused with 422 mail-not-configured, and
// nothing changes: no membership, no invitation, no link, no work contact,
// no behandlingshistorik row and no idempotency key. The setting is the
// install's, so the answer tells nothing about anyone. A mail that the mail
// server refuses is the server's failure: the request answers 500 and
// changes nothing either, and the report holds no address and no token.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool, type ProblemBody } from "../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../test/database.ts";
import { asMember } from "../../test/memberships.ts";
import { expectNoSecretsAtRestFromSignInApps, expectNoTokensFromSignInApps, jsonOf, signInApp, testClock, type SignInApp } from "../../test/sign-in.ts";
import { apiCompany, calls, invite, newMember, sessionIn, type ApiCompany } from "../../test/users.ts";
import { errorReport } from "../api/report.ts";

const NOT_CONFIGURED: ProblemBody = {
  type: "about:blank",
  title: "Unprocessable Content",
  status: 422,
  detail: "The install has no mail set up, so no invitation can be sent. Its operator sets the mail settings (deploy/README.md).",
  code: "mail-not-configured",
};

describe("an install with no mail set up", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let superuser: Client;
  let pool: AppPool;
  /** The same install with mail, which makes the members that the other one then works on. */
  let withMail: SignInApp;
  let without: SignInApp;
  let company: ApiCompany;
  let session: string;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    superuser = await db.admin();
    pool = appPool(db, 4);
    const clock = testClock(new Date());
    withMail = signInApp(pool.database, { clock });
    without = signInApp(pool.database, { clock, mail: "none" });
    company = await apiCompany(withMail, { app, owner });
    session = await sessionIn(without, company.creator, company.id);
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** Every row that a refused call could have changed. */
  async function rows(): Promise<string> {
    const found = await superuser.query<{ rows: string }>(
      `SELECT pg_catalog.jsonb_build_array(
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.memberships AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.invitations AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.invitation_links AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.contact_company_id, t.membership_id) FROM access.membership_contacts AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.sessions AS t WHERE t.ended_at IS NOT NULL),
         (SELECT count(*) FROM audit.history),
         (SELECT count(*) FROM ledger.idempotency_keys),
         (SELECT count(*) FROM access.idempotency_keys)
       )::text AS rows`,
    );
    return found.rows[0]?.rows ?? "";
  }

  it("refuses inviteUser, resendInvitation and disconnectUserIdentity with mail-not-configured, and changes nothing", async () => {
    const invited = await invite(withMail, company.session, "jonas.bjuden@example.com", "Jonas Bjuden");
    const member = await newMember(withMail, { app, owner }, company);
    await sessionIn(withMail, member.person, company.id);
    const before = await rows();
    expect(await jsonOf<ProblemBody>(await calls.inviteUser(without, session, { name: "Klara Ny", email: "klara.ny@example.com" }), 422)).toEqual(NOT_CONFIGURED);
    expect(await jsonOf<ProblemBody>(await calls.resendInvitation(without, session, invited.id), 422)).toEqual(NOT_CONFIGURED);
    expect(await jsonOf<ProblemBody>(await calls.disconnectUserIdentity(without, session, member.id), 422)).toEqual(NOT_CONFIGURED);
    expect(await rows()).toEqual(before);
    expect(without.mail.messages).toEqual([]);
    // The old link still works.
    expect((await calls.getInvitation(without, invited.token)).status).toBe(200);
  });

  it("refuses before the request's own checks, so it tells nothing about a member", async () => {
    const unknown = "00000000-0000-4000-8000-000000000000";
    const invited = await invite(withMail, company.session, "ivan.inbjuden@example.com", "Ivan Inbjuden");
    expect(await jsonOf<ProblemBody>(await calls.resendInvitation(without, session, unknown), 422)).toEqual(NOT_CONFIGURED);
    // disconnectUserIdentity refuses before user-not-found, user-invited and last-system-administrator.
    expect(await jsonOf<ProblemBody>(await calls.disconnectUserIdentity(without, session, unknown), 422)).toEqual(NOT_CONFIGURED);
    expect(await jsonOf<ProblemBody>(await calls.disconnectUserIdentity(without, session, invited.id), 422)).toEqual(NOT_CONFIGURED);
    expect(await jsonOf<ProblemBody>(await calls.disconnectUserIdentity(without, session, company.membership), 422)).toEqual(NOT_CONFIGURED);
    // inviteUser refuses before it reads the addresses: a member's, and an open invitation's in another letter case, get the same answer as any other.
    await invite(withMail, company.session, "olle.oppen@example.com", "Olle Öppen");
    const before = await rows();
    expect(await jsonOf<ProblemBody>(await calls.inviteUser(without, session, { name: "Någon Annan", email: company.creator.email }), 422)).toEqual(NOT_CONFIGURED);
    expect(await jsonOf<ProblemBody>(await calls.inviteUser(without, session, { name: "Olle Öppen", email: "Olle.Oppen@Example.com" }), 422)).toEqual(NOT_CONFIGURED);
    expect(await rows()).toEqual(before);
    expect(without.mail.messages).toEqual([]);
  });

  it("answers a mail that the mail server refuses with 500, and changes nothing", async () => {
    const before = await rows();
    const reported = withMail.reports.length;
    withMail.mail.failNext("550 5.1.1 <lena.fel@example.com>: no such user");
    const failed = await calls.inviteUser(withMail, company.session, { name: "Lena Fel", email: "lena.fel@example.com" });
    expect(await jsonOf<ProblemBody>(failed, 500)).toMatchObject({ code: "internal-error" });
    expect(await rows()).toEqual(before);
    expect(withMail.reports).toHaveLength(reported + 1);
    expect(errorReport(withMail.reports.at(-1))).not.toContain("lena.fel@example.com");
  });

  it.each(["kalle@intranet", "anna@example.c"])("keeps the address %s out of the report when the mail server quotes it in its refusal", async (email) => {
    const before = await rows();
    withMail.mail.failNext(`Can't send mail - all recipients were rejected: 550 5.1.1 <${email}>: Recipient address rejected: User unknown in local recipient table`);
    const failed = await calls.inviteUser(withMail, company.session, { name: "Kalle Berg", email });
    expect(await jsonOf<ProblemBody>(failed, 500)).toMatchObject({ code: "internal-error" });
    expect(await rows()).toEqual(before);
    const report = errorReport(withMail.reports.at(-1));
    expect(report).toContain("<[e-mail]>: Recipient address rejected");
    expect(report).not.toContain(email);
  });

  // inviteUser refuses a local part outside ASCII (the owner's rule of 2026-11-09), but a work e-mail that came from
  // the person's own address, as createCompany and migration 0009 copy it, can still hold one, and a disconnect mails it.
  it.each(["\u{1F600}@example.com", "anna\u2603berg@example.com", "o\u2019brien@example.com", "col\u00B7lecta@example.com"])(
    "keeps the address %s, whose local part is outside ASCII, out of the report when the mail server refuses a disconnect's mail to it",
    async (email) => {
      const refused = await calls.inviteUser(withMail, company.session, { name: "Kalle Berg", email });
      expect((await jsonOf<ProblemBody>(refused, 400)).errors?.map((error) => [error.code, error.pointer])).toEqual([["bad-format", "/email"]]);
      const member = await newMember(withMail, { app, owner }, company);
      await asMember(app, company.id, company.asOwner, "UPDATE access.membership_contacts SET work_email = $2 WHERE membership_id = $1", [member.id, email]);
      const before = await rows();
      withMail.mail.failNext(`Can't send mail - all recipients were rejected: 550 5.1.1 <${email}>: Recipient address rejected: User unknown in local recipient table`);
      const failed = await calls.disconnectUserIdentity(withMail, company.session, member.id);
      expect(await jsonOf<ProblemBody>(failed, 500)).toMatchObject({ code: "internal-error" });
      expect(await rows()).toEqual(before);
      const report = errorReport(withMail.reports.at(-1));
      expect(report).toContain("<[e-mail]>: Recipient address rejected");
      expect(report).not.toContain(email);
    },
  );

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
