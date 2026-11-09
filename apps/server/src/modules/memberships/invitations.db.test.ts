// SPDX-License-Identifier: AGPL-3.0-only

// M4 and M5 (issue 12, "Users in a company" 1 to 3; open point 5), with I2's
// half for acceptInvitation. "Lägg till användare" needs a name and an
// e-mail address, makes an invited member and sends the invitation to the
// fake mail sink. Its link works for 14 days and once, also for two
// parallel accepts, and "Skicka en ny inbjudan" stops the old link.
// Accepting creates a new identity, which takes the invitation's address and
// gets its TOTP enrolment and no session: the person signs in next with the
// password and a code, which makes the pending TOTP secret active. Or it
// links the signed-in identity, which needs a session. The member's work
// e-mail becomes the invitation's address either way. A bearer token links
// nothing: part 4 adds that case to this file.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { addMembership } from "../../../test/memberships.ts";
import { MAIL_ORIGIN } from "../../../test/mail.ts";
import {
  DAY,
  MINUTE,
  addSignInIdentity,
  challengeOf,
  chooseCompany,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  getAs,
  holdingWrites,
  jsonOf,
  passwordStep,
  setCookiesOf,
  signIn,
  signInApp,
  testClock,
  totpStep,
  untilSomeoneWaitsForLock,
  writeAs,
  type SignInApp,
} from "../../../test/sign-in.ts";
import { acceptAs, apiCompany, calls, invite, newMember, type ApiCompany } from "../../../test/users.ts";
import { tokenHash } from "../../auth/tokens.ts";
import { base32Decode, totpCode } from "../../auth/totp.ts";
import { invitationLink, invitationMail } from "../../mail/texts.ts";

/** The answer of acceptInvitation. */
interface Acceptance {
  readonly user: { readonly id: string; readonly name: string; readonly email: string; readonly language: string };
  readonly membership: { readonly id: string; readonly companyId: string; readonly userId: string; readonly status: string; readonly workEmail: string };
  readonly totpEnrolment?: { readonly otpauthUri: string };
}

/** The refusal of a link that does not work. */
const LINK_INVALID: ProblemBody = {
  type: "about:blank",
  title: "Unprocessable Content",
  status: 422,
  detail: "The invitation's link does not work: it is unknown, used, stopped by a newer invitation, or past its end.",
  code: "invitation-link-invalid",
};

/** The field problems of a request that does not fit, as /v1 answers them. */
function invalid(errors: ProblemBody["errors"]): ProblemBody {
  return {
    type: "about:blank",
    title: "Bad Request",
    status: 400,
    detail: "The request does not fit the operation. Each field problem names its field.",
    code: "invalid-request",
    ...(errors === undefined ? {} : { errors }),
  };
}

/** The TOTP secret of an answer's otpauth URI. */
function secretOf(acceptance: Acceptance): Buffer {
  const secret = base32Decode(new URL(acceptance.totpEnrolment?.otpauthUri ?? "otpauth://totp/none").searchParams.get("secret") ?? "");
  if (secret === undefined) {
    throw new Error("The answer gives no TOTP secret.");
  }
  return secret;
}

describe("invitations", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let superuser: Client;
  let pool: AppPool;
  let server: SignInApp;
  let company: ApiCompany;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    superuser = await db.admin();
    pool = appPool(db, 6);
    // The database stamps an invitation's time with its own clock, so the server's starts at the same time.
    server = signInApp(pool.database, { clock: testClock(new Date()) });
    company = await apiCompany(server, { app, owner });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** The invitations of a member, oldest first, as the database holds them. */
  async function invitationsOf(member: string): Promise<{ id: string; name: string; email: string; invited_by: string; days: number; accepted: boolean; superseded: boolean }[]> {
    const found = await superuser.query<{ id: string; name: string; email: string; invited_by: string; days: number; accepted: boolean; superseded: boolean }>(
      `SELECT id, name, email, invited_by, extract(epoch FROM expires_at - created_at)::integer / 86400 AS days,
         accepted_at IS NOT NULL AS accepted, superseded_at IS NOT NULL AS superseded
       FROM access.invitations WHERE membership_id = $1 ORDER BY created_at`,
      [member],
    );
    return found.rows;
  }

  /** The link of a token, as the database holds it. */
  async function linkOf(token: string): Promise<{ used: boolean; superseded: boolean } | undefined> {
    const found = await superuser.query<{ used: boolean; superseded: boolean }>(
      "SELECT used_at IS NOT NULL AS used, superseded_at IS NOT NULL AS superseded FROM access.invitation_links WHERE token_hash = $1",
      [tokenHash(token)],
    );
    return found.rows[0];
  }

  /** The members of the company with their status and person, as the database holds them. */
  async function membershipOf(id: string): Promise<{ status: string; user_id: string | null } | undefined> {
    return (await superuser.query<{ status: string; user_id: string | null }>("SELECT status, user_id FROM access.memberships WHERE id = $1", [id])).rows[0];
  }

  /** A new identity's acceptance of `token`. */
  function asNew(token: string, name = "Olle Nyström", password = "olles-lösenord-1"): Promise<Response> {
    return calls.acceptInvitation(server, token, { newIdentity: { name, password } });
  }

  describe("inviteUser", () => {
    it("needs a name and an e-mail", async () => {
      const members = await superuser.query("SELECT id FROM access.memberships");
      const mails = server.mail.messages.length;
      expect(await jsonOf<ProblemBody>(await calls.inviteUser(server, company.session, { email: "karin.lund@example.com" }), 400)).toEqual(
        invalid([{ code: "missing-field", detail: "The field /name is missing.", pointer: "/name", data: { expected: "string" } }]),
      );
      expect(await jsonOf<ProblemBody>(await calls.inviteUser(server, company.session, { name: "Karin Lund" }), 400)).toEqual(
        invalid([{ code: "missing-field", detail: "The field /email is missing.", pointer: "/email", data: { expected: "string" } }]),
      );
      const both = await jsonOf<ProblemBody>(await calls.inviteUser(server, company.session, { name: "", email: "karin.lund" }), 400);
      expect(both.errors?.map((error) => [error.pointer, error.code])).toEqual([
        ["/name", "too-short"],
        ["/email", "bad-format"],
      ]);
      expect((await superuser.query("SELECT id FROM access.memberships")).rows).toEqual(members.rows);
      expect(server.mail.messages).toHaveLength(mails);
    });

    it("needs a name on one line and an address that is one mailbox, so the mail goes there and holds the lines it should", async () => {
      const members = await superuser.query("SELECT id FROM access.memberships");
      const mails = server.mail.messages.length;
      for (const name of ["Karin\r\n\r\nAcceptera inbjudan:\nhttps://evil.example/x", "Karin\u2028Lund", "Karin\u202ELund"]) {
        const problem = await jsonOf<ProblemBody>(await calls.inviteUser(server, company.session, { name, email: "karin.lund@example.com" }), 400);
        expect(problem.errors?.map((error) => [error.code, error.pointer])).toEqual([["invalid-value", "/name"]]);
      }
      for (const email of ["victim<x@evil.example>", "a,b@evil.example", "anna@example.org,", "(c)x@example.org", "g:x@example.org;", "x@example.org\u0085"]) {
        const problem = await jsonOf<ProblemBody>(await calls.inviteUser(server, company.session, { name: "Karin Lund", email }), 400);
        expect(problem.errors?.map((error) => [error.code, error.pointer])).toEqual([["bad-format", "/email"]]);
      }
      expect((await superuser.query("SELECT id FROM access.memberships")).rows).toEqual(members.rows);
      expect(server.mail.messages).toHaveLength(mails);
    });

    it("makes an invited member and sends the invitation to its address", async () => {
      const response = await calls.inviteUser(server, company.session, { name: "Karin Lund", email: "karin.lund@example.com" });
      const member = await jsonOf<{ id: string }>(response, 201);
      expect(member).toEqual({
        id: member.id,
        companyId: company.id,
        name: "Karin Lund",
        status: "invited",
        idleTimeout: 120,
        roles: [],
        programs: [],
        programsAdministered: [],
      });
      const token = server.mail.invitationTokenTo("karin.lund@example.com");
      expect(server.mail.lastTo("karin.lund@example.com")).toEqual(
        invitationMail({
          to: "karin.lund@example.com",
          name: "Karin Lund",
          companyName: "Testbolaget Alfa AB",
          inviterName: "Alva Berg",
          link: invitationLink(MAIL_ORIGIN, token),
        }),
      );
      expect(await jsonOf(await calls.getUser(server, company.session, member.id))).toEqual(member);
      const listed = await jsonOf<{ items: { id: string }[] }>(await calls.listUsers(server, company.session));
      expect(listed.items).toContainEqual(member);
      // The database stamps who sent it and its 14 days, and the behandlingshistorik holds it.
      expect(await invitationsOf(member.id)).toEqual([
        { id: expect.any(String) as unknown, name: "Karin Lund", email: "karin.lund@example.com", invited_by: company.creator.id, days: 14, accepted: false, superseded: false },
      ]);
      const history = await superuser.query<{ actor_id: string; name: string }>(
        "SELECT actor_id, new_values->>'name' AS name FROM audit.history WHERE table_name = 'access.invitations' AND operation = 'INSERT' AND new_values->>'membership_id' = $1",
        [member.id],
      );
      expect(history.rows).toEqual([{ actor_id: company.creator.id, name: "Karin Lund" }]);
    });

    it("refuses an address that a member of the company or an open invitation has, in any letter case", async () => {
      const mails = server.mail.messages.length;
      const already = { type: "about:blank", title: "Unprocessable Content", status: 422, code: "already-member" };
      expect(await jsonOf<ProblemBody>(await calls.inviteUser(server, company.session, { name: "Alva Berg", email: company.creator.email.toUpperCase() }), 422)).toMatchObject({
        ...already,
        pointer: "/email",
      });
      await invite(server, company.session, "lisa.open@example.com", "Lisa Öppen");
      const mailsAfterOne = server.mail.messages.length;
      expect(await jsonOf<ProblemBody>(await calls.inviteUser(server, company.session, { name: "Lisa Öppen", email: "Lisa.Open@example.com" }), 422)).toMatchObject(already);
      expect(server.mail.messages).toHaveLength(mailsAfterOne);
      expect(mailsAfterOne).toBe(mails + 1);
    });

    it("refuses an address that a member has only as the work e-mail, in any letter case", async () => {
      const member = await newMember(server, { app, owner }, company);
      expect((await calls.updateUser(server, company.session, member.id, { workEmail: "berit.arbete@example.com" })).status).toBe(200);
      const mails = server.mail.messages.length;
      expect(await jsonOf<ProblemBody>(await calls.inviteUser(server, company.session, { name: "Berit Arbete", email: "Berit.Arbete@Example.com" }), 422)).toMatchObject({
        code: "already-member",
        pointer: "/email",
      });
      expect(server.mail.messages).toHaveLength(mails);
    });

    it("refuses the second of two invitations to one address at once", async () => {
      const members = (await superuser.query("SELECT id FROM access.memberships WHERE company_id = $1", [company.id])).rows.length;
      // The first holds the company's row, and has sent its mail, when it waits before its commit.
      const holding = holdingWrites(pool.database, () => true, "commit");
      const racer = signInApp(holding.database, { clock: server.clock });
      const first = calls.inviteUser(racer, company.session, { name: "Cecilia Samtidig", email: "cecilia.samtidig@example.com" });
      await holding.gate.reached;
      // The second waits for the company's row, and then reads the first's invitation.
      const second = calls.inviteUser(server, company.session, { name: "Cecilia Samtidig", email: "Cecilia.Samtidig@example.com" });
      try {
        await untilSomeoneWaitsForLock(superuser);
      } finally {
        holding.gate.open();
      }
      expect((await first).status).toBe(201);
      expect(await jsonOf<ProblemBody>(await second, 422)).toMatchObject({ code: "already-member", pointer: "/email" });
      expect((await superuser.query("SELECT id FROM access.memberships WHERE company_id = $1", [company.id])).rows).toHaveLength(members + 1);
      expect(server.mail.to("Cecilia.Samtidig@example.com")).toEqual([]);
      expect(racer.mail.to("cecilia.samtidig@example.com")).toHaveLength(1);
    });

    it("keeps its answer for a repeat with its key, and sends no second mail", async () => {
      const key = "invite-maja-once";
      const first = await jsonOf<{ id: string }>(await calls.inviteUser(server, company.session, { name: "Maja Ek", email: "maja.ek@example.com" }, key), 201);
      const again = await jsonOf<{ id: string }>(await calls.inviteUser(server, company.session, { name: "Maja Ek", email: "maja.ek@example.com" }, key), 201);
      expect(again).toEqual(first);
      expect(server.mail.to("maja.ek@example.com")).toHaveLength(1);
      // The answer holds the name, so its key is kept outside every company table.
      const kept = await superuser.query("SELECT 1 FROM ledger.idempotency_keys WHERE idempotency_key = $1", [key]);
      expect(kept.rows).toEqual([]);
    });
  });

  describe("the link", () => {
    it("getInvitation gives what the link's page shows, and refuses a link that does not work", async () => {
      const { id, token } = await invite(server, company.session, "nils.ny@example.com", "Nils Ny");
      const shown = await jsonOf<{ expiresAt: string }>(await calls.getInvitation(server, token));
      const [stored] = (await superuser.query<{ expires_at: Date }>("SELECT expires_at FROM access.invitations WHERE membership_id = $1", [id])).rows;
      expect(shown).toEqual({
        name: "Nils Ny",
        email: "nils.ny@example.com",
        expiresAt: stored?.expires_at.toISOString(),
        companyName: "Testbolaget Alfa AB",
        inviterName: "Alva Berg",
      });
      expect(await jsonOf<ProblemBody>(await calls.getInvitation(server, `nfi_${"A".repeat(43)}`), 422)).toEqual(LINK_INVALID);
      expect((await calls.getInvitation(server, "nfi_short")).status).toBe(400);
    });

    it("works for 14 days", async () => {
      // A server of its own, whose clock moves 14 days on, from the shared server's time, so the inviter's next TOTP code is a new one.
      const later = signInApp(pool.database, { clock: testClock(server.clock.now()) });
      later.clock.advance(MINUTE);
      const inviter = await signIn(later, company.creator);
      expect((await chooseCompany(later, inviter.session, company.id)).status).toBe(200);
      const first = await invite(later, inviter.session, "oskar.sen@example.com", "Oskar Sen");
      const second = await invite(later, inviter.session, "petra.sen@example.com", "Petra Sen");
      const endOf = async (token: string): Promise<number> => Date.parse((await jsonOf<{ expiresAt: string }>(await calls.getInvitation(later, token))).expiresAt);
      const firstEnd = await endOf(first.token);
      const secondEnd = await endOf(second.token);
      expect(firstEnd - Date.now()).toBeGreaterThan(14 * DAY - 10 * MINUTE);
      // Up to the last millisecond of its 14 days it works; at its end it does not.
      later.clock.advance(firstEnd - later.clock.now().getTime() - 1);
      expect((await calls.getInvitation(later, first.token)).status).toBe(200);
      later.clock.advance(1);
      expect(await jsonOf<ProblemBody>(await calls.getInvitation(later, first.token), 422)).toEqual(LINK_INVALID);
      const late = await calls.acceptInvitation(later, first.token, { newIdentity: { name: "Oskar Sen", password: "oskars-lösenord" } });
      expect(await jsonOf<ProblemBody>(late, 422)).toEqual(LINK_INVALID);
      expect((await membershipOf(first.id))?.status).toBe("invited");
      // An acceptance in the last millisecond works.
      later.clock.advance(secondEnd - later.clock.now().getTime() - 1);
      const inTime = await calls.acceptInvitation(later, second.token, { newIdentity: { name: "Petra Sen", password: "petras-lösenord" } });
      expect(inTime.status).toBe(200);
      expect((await membershipOf(second.id))?.status).toBe("active");
    });

    it("works once", async () => {
      const { id, token } = await invite(server, company.session, "rut.en@example.com", "Rut En");
      expect((await asNew(token, "Rut En", "ruts-lösenord!")).status).toBe(200);
      expect(await linkOf(token)).toEqual({ used: true, superseded: false });
      expect(await jsonOf<ProblemBody>(await asNew(token, "Rut Två", "ruts-andra-lösen"), 422)).toEqual(LINK_INVALID);
      expect(await jsonOf<ProblemBody>(await calls.getInvitation(server, token), 422)).toEqual(LINK_INVALID);
      const person = await addSignInIdentity(owner);
      expect(await jsonOf<ProblemBody>(await acceptAs(server, person, token), 422)).toEqual(LINK_INVALID);
      expect((await invitationsOf(id)).map((invitation) => invitation.accepted)).toEqual([true]);
    });

    it("works once for two parallel accepts by two signed-in people", async () => {
      const { id, token } = await invite(server, company.session, "sara.par@example.com", "Sara Par");
      const first = await addSignInIdentity(owner);
      const second = await addSignInIdentity(owner);
      server.clock.advance(MINUTE);
      const sessions = [await signIn(server, first), await signIn(server, second)];
      const answers = await Promise.all(sessions.map((signedIn) => calls.acceptInvitation(server, token, {}, signedIn.session)));
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 422]);
      const loser = answers.find((answer) => answer.status === 422);
      expect(await jsonOf<ProblemBody>(loser ?? new Response(), 422)).toEqual(LINK_INVALID);
      const accepted = await membershipOf(id);
      expect(accepted?.status).toBe("active");
      expect([first.id, second.id]).toContain(accepted?.user_id);
      const memberships = await superuser.query("SELECT 1 FROM access.memberships WHERE company_id = $1 AND user_id = ANY ($2)", [company.id, [first.id, second.id]]);
      expect(memberships.rows).toHaveLength(1);
    });

    it("works once for two parallel accepts as new identities", async () => {
      const { id, token } = await invite(server, company.session, "tor.par@example.com", "Tor Par");
      const answers = await Promise.all([asNew(token, "Tor Par", "tors-lösenord-1"), asNew(token, "Tor Annan", "tors-lösenord-2")]);
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 422]);
      const identities = await superuser.query("SELECT 1 FROM access.identities WHERE email = 'tor.par@example.com'");
      expect(identities.rows).toHaveLength(1);
      expect((await membershipOf(id))?.status).toBe("active");
    });
  });

  describe("resendInvitation", () => {
    it("stops the old link, and the new one works", async () => {
      const { id, token: old } = await invite(server, company.session, "ulla.om@example.com", "Ulla Om");
      const oldEnd = Date.parse((await jsonOf<{ expiresAt: string }>(await calls.getInvitation(server, old))).expiresAt);
      server.clock.advance(MINUTE);
      expect((await calls.resendInvitation(server, company.session, id)).status).toBe(204);
      expect(server.mail.to("ulla.om@example.com")).toHaveLength(2);
      const renewed = server.mail.invitationTokenTo("ulla.om@example.com");
      expect(renewed).not.toBe(old);
      expect(await jsonOf<ProblemBody>(await calls.getInvitation(server, old), 422)).toEqual(LINK_INVALID);
      expect(await linkOf(old)).toEqual({ used: false, superseded: true });
      const shown = await jsonOf<{ name: string; email: string; expiresAt: string }>(await calls.getInvitation(server, renewed));
      expect(shown).toMatchObject({ name: "Ulla Om", email: "ulla.om@example.com" });
      expect(Date.parse(shown.expiresAt)).toBeGreaterThan(oldEnd);
      expect((await invitationsOf(id)).map((invitation) => [invitation.name, invitation.accepted, invitation.superseded])).toEqual([
        ["Ulla Om", false, true],
        ["Ulla Om", false, false],
      ]);
      expect(await jsonOf<ProblemBody>(await asNew(old, "Ulla Om", "ullas-lösenord!"), 422)).toEqual(LINK_INVALID);
      expect((await asNew(renewed, "Ulla Om", "ullas-lösenord!")).status).toBe(200);
    });

    it("stops the link of an acceptance that waits for the member while the resend runs", async () => {
      const { id, token } = await invite(server, company.session, "astrid.vantar@example.com", "Astrid Väntar");
      // The resend holds the member's row, and has stopped the old link, when it waits before its commit.
      const holding = holdingWrites(pool.database, () => true, "commit");
      const racer = signInApp(holding.database, { clock: server.clock });
      const resending = calls.resendInvitation(racer, company.session, id);
      await holding.gate.reached;
      // The acceptance reads the old link as live, enters the company, and waits for the member's row.
      const accepting = asNew(token, "Astrid Väntar", "astrids-lösenord");
      await untilSomeoneWaitsForLock(superuser);
      holding.gate.open();
      expect((await resending).status).toBe(204);
      expect(await jsonOf<ProblemBody>(await accepting, 422)).toEqual(LINK_INVALID);
      expect((await membershipOf(id))?.status).toBe("invited");
      expect((await superuser.query("SELECT 1 FROM access.identities WHERE email = 'astrid.vantar@example.com'")).rows).toEqual([]);
    });

    it("stops the link of a signed-in person's acceptance that waits for the member while the resend runs", async () => {
      const { id, token } = await invite(server, company.session, "dagny.vantar@example.com", "Dagny Väntar");
      const person = await addSignInIdentity(owner);
      server.clock.advance(MINUTE);
      const { session } = await signIn(server, person);
      const holding = holdingWrites(pool.database, () => true, "commit");
      const racer = signInApp(holding.database, { clock: server.clock });
      const resending = calls.resendInvitation(racer, company.session, id);
      await holding.gate.reached;
      // The acceptance reads the old link as live, enters the company, and waits for the member's row.
      const accepting = calls.acceptInvitation(server, token, {}, session);
      await untilSomeoneWaitsForLock(superuser);
      holding.gate.open();
      expect((await resending).status).toBe(204);
      expect(await jsonOf<ProblemBody>(await accepting, 422)).toEqual(LINK_INVALID);
      expect(await membershipOf(id)).toEqual({ status: "invited", user_id: null });
      expect(await linkOf(token)).toEqual({ used: false, superseded: true });
    });

    it("refuses a member who is not invited, and one the company does not have", async () => {
      const member = await newMember(server, { app, owner }, company);
      expect(await jsonOf<ProblemBody>(await calls.resendInvitation(server, company.session, member.id), 422)).toEqual({
        type: "about:blank",
        title: "Unprocessable Content",
        status: 422,
        detail: "The member is not invited, so there is no invitation to send again.",
        code: "user-not-invited",
        pointer: "/memberId",
      });
      // An invited member that holds no invitation, as only SQL by hand makes one, has none to send again.
      const bare = await addMembership(app, owner, company, { status: "invited" });
      expect(await jsonOf<ProblemBody>(await calls.resendInvitation(server, company.session, bare), 422)).toMatchObject({ code: "user-not-invited" });
      expect(await jsonOf<ProblemBody>(await calls.resendInvitation(server, company.session, "00000000-0000-4000-8000-000000000000"), 422)).toMatchObject({
        code: "user-not-found",
        pointer: "/memberId",
      });
    });
  });

  describe("acceptInvitation", () => {
    it("creates a new identity with the invitation's address and its TOTP enrolment, and no session", async () => {
      const { id, token } = await invite(server, company.session, "vera.ny@example.com", "Vera Ny");
      const response = await asNew(token, "Vera Nyberg", "veras-lösenord!");
      expect(setCookiesOf(response)).toEqual({});
      const accepted = await jsonOf<Acceptance>(response);
      expect(accepted.user).toEqual({ id: accepted.user.id, name: "Vera Nyberg", email: "vera.ny@example.com", language: "sv" });
      expect(accepted.membership).toMatchObject({ id, companyId: company.id, userId: accepted.user.id, status: "active", workEmail: "vera.ny@example.com", roles: [] });
      const uri = new URL(accepted.totpEnrolment?.otpauthUri ?? "");
      expect([uri.protocol, uri.host, decodeURIComponent(uri.pathname)]).toEqual(["otpauth:", "totp", "/NortFox:vera.ny@example.com"]);
      // The identity has a password and a pending TOTP secret, and no session.
      const stored = await superuser.query<{ state: string; hash: string; sessions: string }>(
        `SELECT t.state, p.password_hash AS hash, (SELECT count(*) FROM access.sessions AS s WHERE s.identity_id = i.id)::text AS sessions
         FROM access.identities AS i JOIN access.totp_secrets AS t ON t.identity_id = i.id JOIN access.password_credentials AS p ON p.identity_id = i.id
         WHERE i.id = $1`,
        [accepted.user.id],
      );
      expect(stored.rows).toEqual([{ state: "pending", hash: expect.stringMatching(/^\$argon2id\$v=19\$/) as unknown, sessions: "0" }]);
      // The acceptance is the new person's own act in the behandlingshistorik.
      const history = await superuser.query<{ actor_id: string }>(
        "SELECT actor_id FROM audit.history WHERE table_name = 'access.memberships' AND row_id = $1 AND new_values->>'status' = 'active'",
        [id],
      );
      expect(history.rows).toEqual([{ actor_id: accepted.user.id }]);
      // The person signs in next: the password, then a code of the new secret, which makes it active.
      server.clock.advance(MINUTE);
      const challenge = await challengeOf(await passwordStep(server, "vera.ny@example.com", "veras-lösenord!"));
      const signedIn = await totpStep(server, challenge, totpCode(secretOf(accepted), server.clock.now()));
      expect(signedIn.status).toBe(204);
      const session = setCookiesOf(signedIn)["__Host-nortfox-session"]?.value ?? "";
      const states = await superuser.query<{ state: string }>("SELECT state FROM access.totp_secrets WHERE identity_id = $1", [accepted.user.id]);
      expect(states.rows).toEqual([{ state: "active" }]);
      expect((await chooseCompany(server, session, company.id)).status).toBe(200);
      const me = await jsonOf<{ membership: { id: string; workEmail: string } }>(await getAs(server, session, "/v1/me"));
      expect(me.membership).toMatchObject({ id, workEmail: "vera.ny@example.com" });
    });

    it("refuses 11 characters and takes 12 for a new identity's password", async () => {
      const { token } = await invite(server, company.session, "william.ny@example.com", "William Ny");
      for (const password of ["elva-tecken", "elva-teckén"]) {
        expect(await jsonOf<ProblemBody>(await asNew(token, "William Ny", password), 400)).toEqual(
          invalid([{ code: "too-short", detail: "The field /newIdentity/password must be at least 12 characters long.", pointer: "/newIdentity/password", data: { minimum: 12 } }]),
        );
      }
      // The refusals left the link as it was.
      expect(await linkOf(token)).toEqual({ used: false, superseded: false });
      expect((await asNew(token, "William Ny", "tolv-tecken!")).status).toBe(200);
    });

    it("links the signed-in identity, whose work e-mail becomes the invitation's address", async () => {
      const person = await addSignInIdentity(owner, { email: "yngve.eget@example.com" });
      const { id, token } = await invite(server, company.session, "yngve.arbete@example.com", "Yngve Arbete");
      server.clock.advance(MINUTE);
      const { session } = await signIn(server, person);
      const response = await calls.acceptInvitation(server, token, {}, session);
      expect(setCookiesOf(response)).toEqual({});
      const accepted = await jsonOf<Acceptance>(response);
      expect(accepted.totpEnrolment).toBeUndefined();
      expect(accepted.user).toEqual({ id: person.id, name: "Alva Berg", email: "yngve.eget@example.com", language: "sv" });
      expect(accepted.membership).toMatchObject({ id, userId: person.id, status: "active", workEmail: "yngve.arbete@example.com" });
      // The session chooses the company from now on.
      expect((await chooseCompany(server, session, company.id)).status).toBe(200);
    });

    it("needs a session to link an identity", async () => {
      const { token } = await invite(server, company.session, "zara.ingen@example.com", "Zara Ingen");
      expect(await jsonOf<ProblemBody>(await calls.acceptInvitation(server, token, {}), 422)).toEqual({
        type: "about:blank",
        title: "Unprocessable Content",
        status: 422,
        detail: "Koppla ihop med befintligt NortFox ID needs a signed-in session. Sign in first, or create a new NortFox ID with newIdentity.",
        code: "sign-in-required",
      });
      // A session that has ended is none.
      const person = await addSignInIdentity(owner);
      server.clock.advance(MINUTE);
      const { session } = await signIn(server, person);
      expect((await writeAs(server, session, "POST", "/v1/auth/logout", undefined)).status).toBe(204);
      expect(await jsonOf<ProblemBody>(await calls.acceptInvitation(server, token, {}, session), 422)).toMatchObject({ code: "sign-in-required" });
      expect(await linkOf(token)).toEqual({ used: false, superseded: false });
    });

    it("refuses a person who is a member of the company already, and keeps the link", async () => {
      const { token } = await invite(server, company.session, "agnes.dubbel@example.com", "Agnes Dubbel");
      const answer = await acceptAs(server, company.creator, token);
      expect(await jsonOf<ProblemBody>(answer, 422)).toEqual({
        type: "about:blank",
        title: "Unprocessable Content",
        status: 422,
        detail: "The person is a member of the company already.",
        code: "already-member",
      });
      expect(await linkOf(token)).toEqual({ used: false, superseded: false });
    });
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
