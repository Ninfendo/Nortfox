// SPDX-License-Identifier: AGPL-3.0-only

// A new setup link for a first identity that never confirmed its TOTP
// secret (issue 54). completeSetup's 201 holds the only copy of the first
// identity's pending TOTP secret. When that answer is lost, the setup command
// makes a new link, while the install's only identity is that unfinished one,
// which a setup link made. Using the new link replaces it: the old identity
// is deleted, so it keeps no e-mail address and its address is free; its
// password, its pending TOTP secret and its open challenges are gone; and a
// new identity comes from the new input, with a new pending secret in the
// new 201. Once the identity has confirmed its secret, nothing changes: the
// command makes no link, and a link made before refuses with
// install-not-empty. The same holds while the install has another identity.
// I1 holds: a link works once, and a newer link stops an older one. The
// races run through the API against real PostgreSQL, in parallel sessions of
// the app's pool. Every test ends with both secret scans, and no TOTP secret
// comes in more than one answer.

import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_INSTALL_KEY, appPool, problemIn, untilAtGate, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { addIdentity, deleteIdentity } from "../../../test/identities.ts";
import { expectNoTokensButChallenges, type SecretsInClear } from "../../../test/secrets.ts";
import {
  CODE_FAILED,
  DAY,
  MINUTE,
  PASSWORD_FAILED,
  TEST_ORIGIN,
  addSignInIdentity,
  challengeOf,
  codeOf,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  getAs,
  holdingWrites,
  jsonOf,
  passwordStep,
  postAsBrowser,
  setCookiesOf,
  signIn,
  signInApp,
  signInFailed,
  testClock,
  totpStep,
  untilSomeoneWaitsForLock,
  type SignInApp,
  type TestClock,
  type TestIdentity,
} from "../../../test/sign-in.ts";
import { open } from "../../auth/secret-box.ts";
import { base32Decode } from "../../auth/totp.ts";
import type { Database, TransactionSettings } from "../../db/database.ts";
import { createSetupLink, setupLinkMessage } from "../../setup.ts";

/** An install of its own: its database, the app's pool, the owner to read what it holds, an observer of the app's backends, and every sign-in app on it. */
interface Install {
  readonly db: TestDatabase;
  readonly pool: AppPool;
  readonly owner: Client;
  readonly observer: Client;
  readonly clock: TestClock;
  readonly server: SignInApp;
  readonly servers: SignInApp[];
}

const installs: Install[] = [];

async function emptyInstall(): Promise<Install> {
  const db = await freshDatabase();
  const pool = appPool(db, 6);
  const clock = testClock();
  const server = signInApp(pool.database, { clock });
  const install = { db, pool, owner: await db.connect("owner"), observer: await db.connect("app"), clock, server, servers: [server] };
  installs.push(install);
  return install;
}

afterAll(async () => {
  for (const { db, pool } of installs) {
    await pool.pool.end();
    await db.close();
  }
});

/** A sign-in app of the install on another database, such as one that holds a write at a gate, with the install's clock. */
function appOn(install: Install, database: Database): SignInApp {
  const server = signInApp(database, { clock: install.clock });
  install.servers.push(server);
  return server;
}

/** A new setup link of the install, as the setup command makes it: its token, and whether using it replaces the unfinished first identity. */
async function newLink(install: Install): Promise<{ readonly token: string; readonly replaces: boolean; readonly message: string }> {
  const link = await createSetupLink(install.pool.database, TEST_ORIGIN, install.clock.now());
  return { token: new URL(link.url).pathname.split("/").at(-1) ?? "", replaces: link.replaces, message: setupLinkMessage(link) };
}

/** The person of these tests, as the setup link gets them. */
const ALVA = { name: "Alva Berg", email: "alva.berg@example.com" } as const;
const FIRST_PASSWORD = "första-lösenordet-20";
const SECOND_PASSWORD = "andra-lösenordet-ett";
const THIRD_PASSWORD = "tredje-lösenordet-19";

function complete(server: SignInApp, token: string, body: Readonly<Record<string, unknown>>): Promise<Response> {
  return postAsBrowser(server, `/v1/setup/${token}`, { ...ALVA, ...body });
}

/** The identity that a 201 of completeSetup made, with its password and the TOTP secret of its answer. */
async function enrolled(response: Response, password: string): Promise<TestIdentity> {
  const answer = await jsonOf<{ user: { id: string; email: string }; totpEnrolment: { otpauthUri: string } }>(response, 201);
  const secret = base32Decode(new URL(answer.totpEnrolment.otpauthUri).searchParams.get("secret") ?? "");
  if (secret === undefined) {
    throw new Error("The answer holds no TOTP secret.");
  }
  return { id: answer.user.id, email: answer.user.email, password, totpSecret: secret };
}

/** The first identity of an empty install, made through a setup link, and the answer's secret, which the person loses. */
async function firstIdentity(install: Install): Promise<TestIdentity> {
  const { token } = await newLink(install);
  return enrolled(await complete(install.server, token, { password: FIRST_PASSWORD }), FIRST_PASSWORD);
}

const LINK_INVALID: ProblemBody = {
  type: "about:blank",
  title: "Unprocessable Content",
  status: 422,
  detail: "The setup link does not work: it is unknown, used, stopped by a newer link, or past its end.",
  code: "setup-link-invalid",
};

const INSTALL_NOT_EMPTY: ProblemBody = {
  type: "about:blank",
  title: "Unprocessable Content",
  status: 422,
  detail: "The install has an identity already, so its setup is done.",
  code: "install-not-empty",
};

/** The setup command's refusal, as in part 1. */
const NO_LINK = "This install has an identity already. A setup link makes only the first identity of an empty install: the others are invited.";

interface IdentityRow {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly personal_identity_number: string | null;
  readonly mobile: string | null;
  readonly status: string;
  readonly deleted: boolean;
}

/** Every identity of the install, as the owner reads them, in the order they were made. */
async function identitiesOf(install: Install): Promise<IdentityRow[]> {
  return (
    await install.owner.query<IdentityRow>(
      "SELECT id, name, email, personal_identity_number, mobile, status, deleted_at IS NOT NULL AS deleted FROM access.identities ORDER BY created_at",
    )
  ).rows;
}

/** The ids of the install's active identities. */
async function activeOf(install: Install): Promise<string[]> {
  return (await install.owner.query<{ id: string }>("SELECT id FROM access.identities WHERE status = 'active' ORDER BY created_at")).rows.map((row) => row.id);
}

/** The login rows of an identity, as the owner reads them. */
async function loginRowsOf(install: Install, identity: string): Promise<{ passwords: number; totpSecrets: string[]; challenges: number; sessions: number; devices: number }> {
  const found = await install.owner.query<{ passwords: number; totp_secrets: string[]; challenges: number; sessions: number; devices: number }>(
    `SELECT
       (SELECT count(*)::int FROM access.password_credentials WHERE identity_id = $1) AS passwords,
       ARRAY(SELECT state FROM access.totp_secrets WHERE identity_id = $1 ORDER BY created_at, state) AS totp_secrets,
       (SELECT count(*)::int FROM access.login_challenges WHERE identity_id = $1) AS challenges,
       (SELECT count(*)::int FROM access.sessions WHERE identity_id = $1) AS sessions,
       (SELECT count(*)::int FROM access.known_devices WHERE identity_id = $1) AS devices`,
    [identity],
  );
  const [row] = found.rows;
  if (row === undefined) {
    throw new Error("The owner read no row.");
  }
  return { passwords: row.passwords, totpSecrets: row.totp_secrets, challenges: row.challenges, sessions: row.sessions, devices: row.devices };
}

/** The install's setup links in the order they were made: the identity each made, the one it replaces, and whether it was used or stopped. */
async function linksOf(install: Install): Promise<{ made: string | null; replaces: string | null; used: boolean; stopped: boolean }[]> {
  return (
    await install.owner.query<{ made: string | null; replaces: string | null; used: boolean; stopped: boolean }>(
      `SELECT identity_id AS made, replaces_identity_id AS replaces, used_at IS NOT NULL AS used, superseded_at IS NOT NULL AS stopped
       FROM access.setup_tokens ORDER BY created_at, used_at NULLS LAST, superseded_at NULLS LAST`,
    )
  ).rows;
}

/** An identity's TOTP secret as the database keeps it, sealed, with its row's id. */
async function sealedOf(install: Install, identity: string): Promise<{ id: string; secret: Buffer }> {
  const [row] = (await install.owner.query<{ id: string; secret: Buffer }>("SELECT id, secret FROM access.totp_secrets WHERE identity_id = $1", [identity])).rows;
  if (row === undefined) {
    throw new Error("The identity has no TOTP secret.");
  }
  return row;
}

/** Whether a transaction is the person's own. */
function asActor(person: string): (settings: TransactionSettings) => boolean {
  return (settings) => settings.actorId === person;
}

/**
 * Both secret scans of part 1 over every sign-in app of the install and its
 * database, with the secrets that the test names apart, and no TOTP secret in
 * more than one answer.
 */
async function scanned(install: Install, apart: SecretsInClear = {}): Promise<void> {
  for (const server of install.servers) {
    await server.app.afterAnswer.idle();
    expectNoTokensButChallenges(server.bodies, server.reports);
  }
  const given = install.servers.flatMap((server) => server.bodies.flatMap((body) => [...body.matchAll(/[?&]secret=([A-Z2-7]+)/g)].map((match) => match[1] ?? "")));
  expect(given.length, "A TOTP secret came in two answers.").toBe(new Set(given).size);
  await expectNoSecretsAtRestFromSignInApps(install.db, apart);
}

describe("a new setup link while the first identity never confirmed its TOTP secret", () => {
  it("replaces the identity whose answer was lost, and the new identity signs in with its password and a TOTP code", async () => {
    const install = await emptyInstall();
    const first = await newLink(install);
    expect(first.replaces).toBe(false);
    const lost = await complete(install.server, first.token, { password: FIRST_PASSWORD });
    // The answer is lost: the test never reads it. The person's password opens the TOTP step, which only the lost secret passes.
    expect(lost.status).toBe(201);
    const [old] = await identitiesOf(install);
    if (old === undefined) {
      throw new Error("The first use made no identity.");
    }
    const oldChallenge = await challengeOf(await passwordStep(install.server, ALVA.email, FIRST_PASSWORD));
    const oldSealed = await sealedOf(install, old.id);
    // The test opens the old secret with the install key, to show that even its right code works no more.
    const oldSecret = open(TEST_INSTALL_KEY, "totp-secret v1", oldSealed.secret, [old.id, oldSealed.id]);
    if (oldSecret === undefined) {
      throw new Error("The old secret does not open.");
    }
    // A second use of the first link is refused (I1).
    expect(await problemIn(await complete(install.server, first.token, { password: FIRST_PASSWORD }))).toEqual(LINK_INVALID);

    // The setup command makes a new link, and says that using it replaces the identity.
    install.clock.advance(MINUTE);
    const second = await newLink(install);
    expect(second.replaces).toBe(true);
    expect(second.message).toContain("Using this link replaces it");
    // The old address, in another letter case: the old identity's address is free once it is replaced.
    const made = await complete(install.server, second.token, { email: "Alva.Berg@example.com", password: SECOND_PASSWORD });
    const person = await enrolled(made, SECOND_PASSWORD);
    expect(made.headers.getSetCookie()).toEqual([]);
    expect(person.id).not.toBe(old.id);
    expect(person.email).toBe("Alva.Berg@example.com");
    expect(person.totpSecret).not.toEqual(oldSecret);

    expect(await identitiesOf(install)).toEqual([
      { id: old.id, name: "Alva Berg", email: null, personal_identity_number: null, mobile: null, status: "deleted", deleted: true },
      { id: person.id, name: "Alva Berg", email: "Alva.Berg@example.com", personal_identity_number: null, mobile: null, status: "active", deleted: false },
    ]);
    expect(await loginRowsOf(install, old.id)).toEqual({ passwords: 0, totpSecrets: [], challenges: 0, sessions: 0, devices: 0 });
    expect(await loginRowsOf(install, person.id)).toEqual({ passwords: 1, totpSecrets: ["pending"], challenges: 0, sessions: 0, devices: 0 });
    // Each used link names the identity it made, and the new one the identity it replaced.
    expect(await linksOf(install)).toEqual([
      { made: old.id, replaces: null, used: true, stopped: false },
      { made: person.id, replaces: old.id, used: true, stopped: false },
    ]);

    // The old identity's challenge refuses even the old secret's right code, and its password works no more.
    expect(await problemIn(await totpStep(install.server, oldChallenge, codeOf({ ...person, totpSecret: oldSecret }, install.clock.now())))).toEqual(
      signInFailed(CODE_FAILED),
    );
    expect(await problemIn(await passwordStep(install.server, ALVA.email, FIRST_PASSWORD))).toEqual(signInFailed(PASSWORD_FAILED));

    // The new identity signs in with its password and the first code of the new secret, which confirms it.
    const signedIn = await signIn(install.server, person);
    const session = await jsonOf<{ user: { id: string; email: string } }>(await getAs(install.server, signedIn.session, "/v1/session"));
    expect(session.user).toMatchObject({ id: person.id, email: "Alva.Berg@example.com" });
    expect((await loginRowsOf(install, person.id)).totpSecrets).toEqual(["active"]);
    // The old secret, in clear or sealed, is nowhere in the database.
    await scanned(install, { totpSecrets: [oldSecret, oldSealed.secret] });
  });

  it("replaces the new identity too when its answer is lost as well, and the next one may take another address", async () => {
    const install = await emptyInstall();
    const first = await firstIdentity(install);
    const second = await newLink(install);
    const lostAgain = await enrolled(await complete(install.server, second.token, { password: SECOND_PASSWORD }), SECOND_PASSWORD);
    const third = await newLink(install);
    expect(third.replaces).toBe(true);
    const person = await enrolled(await complete(install.server, third.token, { name: "Alva Bergström", email: "alva.b@example.org", password: THIRD_PASSWORD }), THIRD_PASSWORD);
    expect((await identitiesOf(install)).map((row) => [row.id, row.email, row.status])).toEqual([
      [first.id, null, "deleted"],
      [lostAgain.id, null, "deleted"],
      [person.id, "alva.b@example.org", "active"],
    ]);
    expect(await linksOf(install)).toEqual([
      { made: first.id, replaces: null, used: true, stopped: false },
      { made: lostAgain.id, replaces: first.id, used: true, stopped: false },
      { made: person.id, replaces: lostAgain.id, used: true, stopped: false },
    ]);
    expect(await loginRowsOf(install, lostAgain.id)).toEqual({ passwords: 0, totpSecrets: [], challenges: 0, sessions: 0, devices: 0 });
    // The old address names nobody now.
    expect(await problemIn(await passwordStep(install.server, ALVA.email, SECOND_PASSWORD))).toEqual(signInFailed(PASSWORD_FAILED));
    await signIn(install.server, person);
    await scanned(install);
  });
});

describe("a new setup link once the first identity confirmed its TOTP secret, or beside another identity", () => {
  it("is not made once the identity confirmed its secret, and a link made before refuses with install-not-empty", async () => {
    const install = await emptyInstall();
    const person = await firstIdentity(install);
    // A link made while the identity was unfinished.
    const before = await newLink(install);
    expect(before.replaces).toBe(true);
    // The first code confirms the secret.
    const { session } = await signIn(install.server, person);
    await expect(newLink(install)).rejects.toThrow(NO_LINK);
    const refused = await complete(install.server, before.token, { password: SECOND_PASSWORD });
    expect(await problemIn(refused)).toEqual(INSTALL_NOT_EMPTY);
    // Nothing changed: the identity, its rows and its session stay, and the link is still unused.
    expect((await identitiesOf(install)).map((row) => [row.id, row.status])).toEqual([[person.id, "active"]]);
    expect(await loginRowsOf(install, person.id)).toEqual({ passwords: 1, totpSecrets: ["active"], challenges: 1, sessions: 1, devices: 1 });
    expect((await getAs(install.server, session, "/v1/session")).status).toBe(200);
    expect((await linksOf(install)).map((link) => link.used)).toEqual([true, false]);
    await scanned(install);
  });

  it("is not made while the install has another identity, also a deleted one that no setup link replaced, and a link made before refuses", async () => {
    const install = await emptyInstall();
    const person = await firstIdentity(install);
    const before = await newLink(install);
    // Another identity, which only the owner or a later part could add.
    const other = await addIdentity(install.owner, { name: "Ebba Holm", email: "ebba.holm@example.com" });
    await expect(newLink(install)).rejects.toThrow(NO_LINK);
    expect(await problemIn(await complete(install.server, before.token, { password: SECOND_PASSWORD }))).toEqual(INSTALL_NOT_EMPTY);
    // Deleted, it is still no identity of the setup links.
    const app = await install.db.connect("app");
    await deleteIdentity(app, other);
    await expect(newLink(install)).rejects.toThrow(NO_LINK);
    expect(await problemIn(await complete(install.server, before.token, { password: SECOND_PASSWORD }))).toEqual(INSTALL_NOT_EMPTY);
    // The unfinished identity stays as it was.
    expect((await identitiesOf(install)).map((row) => [row.id, row.status])).toEqual([
      [person.id, "active"],
      [other, "deleted"],
    ]);
    expect(await loginRowsOf(install, person.id)).toEqual({ passwords: 1, totpSecrets: ["pending"], challenges: 0, sessions: 0, devices: 0 });
    await signIn(install.server, person);
    await scanned(install);
  });

  it("is not made while the only identity is not a setup link's, also one that never confirmed a TOTP secret, and a link made before refuses", async () => {
    const install = await emptyInstall();
    const early = await newLink(install);
    // An identity that came another way, with a pending secret: it looks unfinished, but no setup link made it.
    const other = await addSignInIdentity(install.owner, { totp: "pending" });
    await expect(newLink(install)).rejects.toThrow(NO_LINK);
    expect(await problemIn(await complete(install.server, early.token, { password: SECOND_PASSWORD }))).toEqual(INSTALL_NOT_EMPTY);
    expect((await identitiesOf(install)).map((row) => [row.id, row.status])).toEqual([[other.id, "active"]]);
    expect(await loginRowsOf(install, other.id)).toEqual({ passwords: 1, totpSecrets: ["pending"], challenges: 0, sessions: 0, devices: 0 });
    await scanned(install);
  });
});

describe("I1 with a new link", () => {
  it("refuses a second use of any link, a link that a newer one stopped and one past its end, and only the newest link works", async () => {
    const install = await emptyInstall();
    const first = await newLink(install);
    const person = await enrolled(await complete(install.server, first.token, { password: FIRST_PASSWORD }), FIRST_PASSWORD);
    expect(await problemIn(await complete(install.server, first.token, { password: FIRST_PASSWORD }))).toEqual(LINK_INVALID);
    install.clock.advance(MINUTE);
    const stopped = await newLink(install);
    install.clock.advance(MINUTE);
    const newest = await newLink(install);
    expect([stopped.replaces, newest.replaces]).toEqual([true, true]);
    // The stopped link and an unknown one are refused, and change nothing.
    for (const token of [stopped.token, `nfu_${"A".repeat(43)}`]) {
      expect(await problemIn(await complete(install.server, token, { password: SECOND_PASSWORD }))).toEqual(LINK_INVALID);
    }
    expect(await loginRowsOf(install, person.id)).toEqual({ passwords: 1, totpSecrets: ["pending"], challenges: 0, sessions: 0, devices: 0 });
    expect(await activeOf(install)).toEqual([person.id]);
    const replacing = await enrolled(await complete(install.server, newest.token, { password: SECOND_PASSWORD }), SECOND_PASSWORD);
    // A second use of the new link, and every older link, is refused.
    for (const token of [newest.token, stopped.token, first.token]) {
      expect(await problemIn(await complete(install.server, token, { password: THIRD_PASSWORD }))).toEqual(LINK_INVALID);
    }
    expect(await activeOf(install)).toEqual([replacing.id]);
    // The first link, the stopped one and the newest, in the order they were made.
    expect((await linksOf(install)).map((link) => [link.used, link.stopped])).toEqual([
      [true, false],
      [false, true],
      [true, false],
    ]);
    // A link past its 28 days is refused too.
    const late = await newLink(install);
    install.clock.advance(28 * DAY);
    expect(await problemIn(await complete(install.server, late.token, { password: THIRD_PASSWORD }))).toEqual(LINK_INVALID);
    expect(await activeOf(install)).toEqual([replacing.id]);
    await signIn(install.server, replacing);
    await scanned(install);
  });
});

describe("the races of a new setup link", () => {
  it("refuses the old identity's TOTP step after the new link's use, also with the right code of its old secret", async () => {
    const install = await emptyInstall();
    const old = await firstIdentity(install);
    const challenge = await challengeOf(await passwordStep(install.server, old.email, old.password));
    const link = await newLink(install);
    const person = await enrolled(await complete(install.server, link.token, { password: SECOND_PASSWORD }), SECOND_PASSWORD);
    const refused = await totpStep(install.server, challenge, codeOf(old, install.clock.now()));
    expect(await problemIn(refused)).toEqual(signInFailed(CODE_FAILED));
    expect(setCookiesOf(refused)).toEqual({});
    expect(await activeOf(install)).toEqual([person.id]);
    expect(await loginRowsOf(install, old.id)).toEqual({ passwords: 0, totpSecrets: [], challenges: 0, sessions: 0, devices: 0 });
    await scanned(install);
  });

  it("refuses the new link's use with install-not-empty when the old identity's TOTP step holds its secret, and the step signs in", async () => {
    const install = await emptyInstall();
    const old = await firstIdentity(install);
    const challenge = await challengeOf(await passwordStep(install.server, old.email, old.password));
    const link = await newLink(install);
    // The old identity's right code: its transaction waits before its commit, with the challenge and the secret locked.
    const holding = holdingWrites(install.pool.database, asActor(old.id), "commit");
    const confirming = totpStep(appOn(install, holding.database), challenge, codeOf(old, install.clock.now()));
    await untilAtGate(holding.gate, confirming);
    const use = complete(install.server, link.token, { password: SECOND_PASSWORD });
    await untilSomeoneWaitsForLock(install.observer);
    holding.gate.open();
    const confirmed = await confirming;
    expect(confirmed.status).toBe(204);
    expect(await problemIn(await use)).toEqual(INSTALL_NOT_EMPTY);
    expect(await activeOf(install)).toEqual([old.id]);
    expect(await loginRowsOf(install, old.id)).toEqual({ passwords: 1, totpSecrets: ["active"], challenges: 1, sessions: 1, devices: 1 });
    const session = setCookiesOf(confirmed)["__Host-nortfox-session"]?.value ?? "";
    expect((await getAs(install.server, session, "/v1/session")).status).toBe(200);
    await scanned(install);
  });

  it("refuses the old identity's TOTP step when the new link's use holds its rows, and the use replaces it", async () => {
    const install = await emptyInstall();
    const old = await firstIdentity(install);
    const challenge = await challengeOf(await passwordStep(install.server, old.email, old.password));
    const link = await newLink(install);
    // The new link's use waits before its commit, with the old identity's rows locked.
    const holding = holdingWrites(install.pool.database, () => true, "commit");
    const use = complete(appOn(install, holding.database), link.token, { password: SECOND_PASSWORD });
    await untilAtGate(holding.gate, use);
    const step = totpStep(install.server, challenge, codeOf(old, install.clock.now()));
    await untilSomeoneWaitsForLock(install.observer);
    holding.gate.open();
    const person = await enrolled(await use, SECOND_PASSWORD);
    const refused = await step;
    expect(await problemIn(refused)).toEqual(signInFailed(CODE_FAILED));
    expect(setCookiesOf(refused)).toEqual({});
    expect(await activeOf(install)).toEqual([person.id]);
    expect(await loginRowsOf(install, old.id)).toEqual({ passwords: 0, totpSecrets: [], challenges: 0, sessions: 0, devices: 0 });
    await signIn(install.server, person);
    await scanned(install);
  });

  it("lets one of them win when the old identity's TOTP step and the new link's use run at once, and never both", async () => {
    for (let round = 0; round < 4; round += 1) {
      const install = await emptyInstall();
      const old = await firstIdentity(install);
      const challenge = await challengeOf(await passwordStep(install.server, old.email, old.password));
      const link = await newLink(install);
      const [step, use] = await Promise.all([
        totpStep(install.server, challenge, codeOf(old, install.clock.now())),
        complete(install.server, link.token, { password: SECOND_PASSWORD }),
      ]);
      if (step.status === 204) {
        expect(await problemIn(use)).toEqual(INSTALL_NOT_EMPTY);
        expect(await activeOf(install)).toEqual([old.id]);
        expect((await loginRowsOf(install, old.id)).totpSecrets).toEqual(["active"]);
      } else {
        expect(await problemIn(step)).toEqual(signInFailed(CODE_FAILED));
        const person = await enrolled(use, SECOND_PASSWORD);
        expect(await activeOf(install)).toEqual([person.id]);
        expect(await loginRowsOf(install, old.id)).toEqual({ passwords: 0, totpSecrets: [], challenges: 0, sessions: 0, devices: 0 });
      }
      await scanned(install);
    }
  });

  it("replaces once when the new link is used twice at once, held or not", async () => {
    const install = await emptyInstall();
    const old = await firstIdentity(install);
    const link = await newLink(install);
    // The first use waits before its commit; the second waits for the setup links' lock, and then finds the link used.
    const holding = holdingWrites(install.pool.database, () => true, "commit");
    const held = complete(appOn(install, holding.database), link.token, { email: "first@example.com", password: SECOND_PASSWORD });
    await untilAtGate(holding.gate, held);
    const waiting = complete(install.server, link.token, { email: "second@example.com", password: THIRD_PASSWORD });
    await untilSomeoneWaitsForLock(install.observer);
    holding.gate.open();
    const person = await enrolled(await held, SECOND_PASSWORD);
    expect(await problemIn(await waiting)).toEqual(LINK_INVALID);
    expect(await activeOf(install)).toEqual([person.id]);
    expect((await identitiesOf(install)).map((row) => [row.id, row.status])).toEqual([
      [old.id, "deleted"],
      [person.id, "active"],
    ]);

    // Two uses of the next link at once, as they come.
    const next = await newLink(install);
    const answers = await Promise.all([
      complete(install.server, next.token, { email: "third@example.com", password: THIRD_PASSWORD }),
      complete(install.server, next.token, { email: "fourth@example.com", password: THIRD_PASSWORD }),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 422]);
    const refused = answers.find((answer) => answer.status === 422);
    expect(refused === undefined ? undefined : await problemIn(refused)).toEqual(LINK_INVALID);
    expect(await activeOf(install)).toHaveLength(1);
    expect((await identitiesOf(install)).filter((row) => row.status === "deleted").map((row) => row.id)).toEqual([old.id, person.id]);
    await scanned(install);
  });

  it("leaves one live link when two setup commands run at once, held or not, and only that one replaces the identity", async () => {
    const install = await emptyInstall();
    const person = await firstIdentity(install);
    const holding = holdingWrites(install.pool.database, () => true, "commit");
    const held = createSetupLink(holding.database, TEST_ORIGIN, install.clock.now());
    await untilAtGate(holding.gate, held);
    const waiting = newLink(install);
    await untilSomeoneWaitsForLock(install.observer);
    holding.gate.open();
    const older = await held;
    const newer = await waiting;
    expect([older.replaces, newer.replaces]).toEqual([true, true]);
    expect(await problemIn(await complete(install.server, new URL(older.url).pathname.split("/").at(-1) ?? "", { password: SECOND_PASSWORD }))).toEqual(LINK_INVALID);
    expect(await activeOf(install)).toEqual([person.id]);

    // Two commands at once, as they come: of the two links, one works.
    install.clock.advance(MINUTE);
    const links = await Promise.all([newLink(install), newLink(install)]);
    expect((await linksOf(install)).filter((link) => !link.used && !link.stopped)).toHaveLength(1);
    const answers = await Promise.all(links.map((link) => complete(install.server, link.token, { password: SECOND_PASSWORD })));
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 422]);
    const made = answers.find((answer) => answer.status === 201);
    const replacing = made === undefined ? undefined : await enrolled(made, SECOND_PASSWORD);
    expect(await activeOf(install)).toEqual([replacing?.id]);
    await scanned(install);
  });
});

describe("every install of these tests", () => {
  it("leaves no token in an answer or a report of any of its sign-in apps", () => {
    expect(installs.length).toBeGreaterThan(9);
    expectNoTokensFromSignInApps();
  });
});
