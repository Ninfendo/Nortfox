// SPDX-License-Identifier: AGPL-3.0-only

// The owner's two rules for an e-mail address (2026-11-09), by the API, where
// the issue says nothing:
//
// - An address that can become an identity's, or a work e-mail that a
//   disconnect invites, holds no character whose case fold is not its lower
//   case, in NFC: ß, ẞ, ς, ſ, µ, the ligatures, the Cherokee letters and
//   every other such character. casefold() makes straße.example into
//   strasse.example, which IDNA2008 keeps apart, so such an address would
//   share an identity's place with another mailbox. completeSetup,
//   inviteUser, updateUser's and updateMyMembership's work e-mail refuse it,
//   400 bad-format, and change nothing. acceptInvitation takes no address.
// - An address that NortFox sends mail to has a local part in ASCII, since a
//   relay without SMTPUTF8 must not take another (RFC 6531): inviteUser's
//   address and the work e-mail refuse one, 400 bad-format. Its domain may be
//   internationalised: nodemailer sends it as its A-label. completeSetup
//   still takes such a local part, since no mail goes to it in this part.
//
// The sign-in keeps folding: a known identity signs in with its address in
// any letter case, also with ß for ss.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, problemIn, type AppPool } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import {
  TEST_ORIGIN,
  addSignInIdentity,
  challengeOf,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  jsonOf,
  passwordStep,
  postAsBrowser,
  signInApp,
  testClock,
  writeAs,
  type SignInApp,
} from "../../../test/sign-in.ts";
import { apiCompany, calls, newMember, type ApiCompany } from "../../../test/users.ts";
import { createSetupLink } from "../../setup.ts";

/** Addresses with a character whose case fold is not its lower case, each with an ASCII local part or not. */
const FOLD_TWINS = [
  "karin.lund@straße.example",
  "karin.lund@παράδειγμας.example",
  "karin.straße@example.com",
  "\u{17F}ven.ek@example.com",
  "\u{FB01}a.strand@example.com",
  "\u{AB70}@example.com",
  "\u{B5}@example.com",
];

/** Addresses with a character outside ASCII in the local part, and none whose fold is not its lower case. */
const WIDE_LOCAL_PARTS = ["kärin.lund@example.com", "åsa.lind@exämple.test", "\u{212A}arin.lund@example.com"];

/** The one field problem of an address that the rules refuse. */
function badFormatAt(pointer: string): unknown {
  return [{ code: "bad-format", detail: expect.stringContaining(`The field ${pointer} does not have the format email`) as unknown, pointer, data: { format: "email" } }];
}

describe("the owner's rules for an e-mail address, by the API", () => {
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
    pool = appPool(db, 4);
    server = signInApp(pool.database, { clock: testClock(new Date()) });
    company = await apiCompany(server, { app, owner });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  async function memberCount(): Promise<number> {
    return Number((await superuser.query<{ n: string }>("SELECT count(*) AS n FROM access.memberships WHERE company_id = $1", [company.id])).rows[0]?.n);
  }

  async function workEmailOf(membership: string): Promise<string | null | undefined> {
    return (await superuser.query<{ work_email: string | null }>("SELECT work_email FROM access.membership_contacts WHERE membership_id = $1", [membership])).rows[0]?.work_email;
  }

  it("inviteUser refuses an address with a fold twin or a local part outside ASCII, sends no mail and makes no member", async () => {
    const members = await memberCount();
    const mails = server.mail.messages.length;
    for (const email of [...FOLD_TWINS, ...WIDE_LOCAL_PARTS]) {
      const answer = await calls.inviteUser(server, company.session, { name: "Karin Lund", email });
      expect(answer.status, email).toBe(400);
      expect((await problemIn(answer)).errors, email).toEqual(badFormatAt("/email"));
    }
    expect(server.mail.messages).toHaveLength(mails);
    expect(await memberCount()).toBe(members);
    // An internationalised domain is taken, with the local part in ASCII.
    const invited = await calls.inviteUser(server, company.session, { name: "Karin Lund", email: "karin.lund@exämple.test" });
    expect(invited.status).toBe(201);
    expect(server.mail.to("karin.lund@exämple.test")).toHaveLength(1);
  });

  it("updateUser refuses such a work e-mail and keeps the one the member has", async () => {
    const member = await newMember(server, { app, owner }, company);
    const before = await workEmailOf(member.id);
    expect(before).toBe(member.person.email);
    for (const workEmail of [...FOLD_TWINS, ...WIDE_LOCAL_PARTS]) {
      const answer = await calls.updateUser(server, company.session, member.id, { workEmail });
      expect(answer.status, workEmail).toBe(400);
      expect((await problemIn(answer)).errors, workEmail).toEqual(badFormatAt("/workEmail"));
    }
    expect(await workEmailOf(member.id)).toBe(before);
    const changed = await jsonOf<{ workEmail?: string }>(await calls.updateUser(server, company.session, member.id, { workEmail: "gunnar.holm@bücher.example" }));
    expect(changed.workEmail).toBe("gunnar.holm@bücher.example");
  });

  it("updateMyMembership refuses such a work e-mail and keeps the one the person has", async () => {
    const path = `/v1/me/companies/${company.id}`;
    const before = await workEmailOf(company.membership);
    for (const workEmail of [...FOLD_TWINS, ...WIDE_LOCAL_PARTS]) {
      const answer = await writeAs(server, company.session, "PATCH", path, { workEmail });
      expect(answer.status, workEmail).toBe(400);
      expect((await problemIn(answer)).errors, workEmail).toEqual(badFormatAt("/workEmail"));
    }
    expect(await workEmailOf(company.membership)).toBe(before);
    const changed = await jsonOf<{ workEmail?: string }>(await writeAs(server, company.session, "PATCH", path, { workEmail: "alva.arbete@exämple.test" }));
    expect(changed.workEmail).toBe("alva.arbete@exämple.test");
  });

  it("signs a known identity in with its address in any letter case, also with ß for ss, as before", async () => {
    const person = await addSignInIdentity(owner, { email: "anna.strasse@example.com" });
    for (const identifier of ["anna.strasse@example.com", "ANNA.STRASSE@EXAMPLE.COM", "Anna.Straße@Example.com", "anna.\u{17F}tra\u{DF}e@example.com"]) {
      expect(await challengeOf(await passwordStep(server, identifier, person.password)), identifier).toMatch(/^nfc_/);
    }
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});

describe("the owner's rules for the first identity's address, by completeSetup", () => {
  let db: TestDatabase;
  let pool: AppPool;
  let owner: Client;
  let server: SignInApp;

  beforeAll(async () => {
    db = await freshDatabase();
    pool = appPool(db, 4);
    owner = await db.connect("owner");
    server = signInApp(pool.database, { clock: testClock() });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  it("refuses an address with a fold twin, makes no identity, and leaves the link working; a local part outside ASCII is taken", async () => {
    const link = await createSetupLink(pool.database, TEST_ORIGIN, server.clock.now());
    const path = `/v1/setup/${new URL(link.url).pathname.split("/").at(-1) ?? ""}`;
    for (const email of FOLD_TWINS) {
      const answer = await postAsBrowser(server, path, { name: "Alva Berg", email, password: "första-lösenordet-20" });
      expect(answer.status, email).toBe(400);
      expect((await problemIn(answer)).errors, email).toEqual(badFormatAt("/email"));
    }
    expect((await owner.query("SELECT 1 FROM access.identities")).rowCount).toBe(0);
    const made = await jsonOf<{ user: { email: string } }>(
      await postAsBrowser(server, path, { name: "Åsa Lind", email: "åsa.lind@exämple.test", password: "första-lösenordet-20" }),
      201,
    );
    expect(made.user.email).toBe("åsa.lind@exämple.test");
  });
});
