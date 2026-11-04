// SPDX-License-Identifier: AGPL-3.0-only

// I1: on an empty install, the setup link creates the first identity once,
// and a second use is refused, also in parallel. No setup link is made on an
// install that has an identity. completeSetup takes a password of 12
// characters and refuses 11 (I2's half for completeSetup), and it sets no
// session cookie: the new person signs in next, with the password and the
// first code of the TOTP secret that the answer gives.

import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_INSTALL_KEY, appPool, problemIn, type AppPool } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { DAY, TEST_ORIGIN, expectNoSecretsAtRestFromSignInApps, expectNoTokensFromSignInApps, postAsBrowser, signInApp, testClock, type SignInApp, type TestClock } from "../../../test/sign-in.ts";
import { open } from "../../auth/secret-box.ts";
import { base32Decode } from "../../auth/totp.ts";
import { createSetupLink } from "../../setup.ts";

/** An empty install: its own database, the app, and the owner to read what it holds. */
interface EmptyInstall {
  readonly db: TestDatabase;
  readonly pool: AppPool;
  readonly owner: Client;
  readonly server: SignInApp;
  readonly clock: TestClock;
}

const installs: EmptyInstall[] = [];

async function emptyInstall(): Promise<EmptyInstall> {
  const db = await freshDatabase();
  const pool = appPool(db, 4);
  const clock = testClock();
  const install = { db, pool, owner: await db.connect("owner"), server: signInApp(pool.database, { clock }), clock };
  installs.push(install);
  return install;
}

afterAll(async () => {
  for (const { db, pool } of installs) {
    await pool.pool.end();
    await db.close();
  }
});

/** The token of a setup link: its last path segment. */
async function setupToken(install: EmptyInstall): Promise<string> {
  const link = await createSetupLink(install.pool.database, TEST_ORIGIN, install.clock.now());
  return new URL(link.url).pathname.split("/").at(-1) ?? "";
}

/** The password of the first person in these tests: 20 characters. */
const PASSWORD = "första-lösenordet-20";

function complete(install: EmptyInstall, token: string, body: Readonly<Record<string, unknown>> = {}): Promise<Response> {
  return postAsBrowser(install.server, `/v1/setup/${token}`, { name: "Alva Berg", email: "alva.berg@example.com", password: PASSWORD, ...body });
}

const LINK_INVALID = {
  type: "about:blank",
  title: "Unprocessable Content",
  status: 422,
  detail: "The setup link does not work: it is unknown, used, stopped by a newer link, or past its end.",
  code: "setup-link-invalid",
};

interface SetupAnswer {
  readonly user: { readonly id: string; readonly name: string; readonly email: string; readonly language: string };
  readonly totpEnrolment: { readonly otpauthUri: string };
}

async function identitiesOf(owner: Client): Promise<{ id: string; name: string; email: string; two_step: string; status: string }[]> {
  return (await owner.query<{ id: string; name: string; email: string; two_step: string; status: string }>("SELECT id, name, email, two_step, status FROM access.identities")).rows;
}

describe("the setup link", () => {
  it("creates the first identity once, with its password and a pending TOTP secret, and sets no session cookie", async () => {
    const install = await emptyInstall();
    const token = await setupToken(install);
    // Å written as A and a combining ring is kept as one letter.
    const response = await complete(install, token, { email: "Åsa.Berg@example.com", name: "Åsa Berg" });
    expect(response.status).toBe(201);
    expect(response.headers.getSetCookie()).toEqual([]);
    const answer = (await response.json()) as SetupAnswer;
    expect(answer.user).toEqual({ id: expect.any(String) as unknown, name: "Åsa Berg", email: "Åsa.Berg@example.com", language: "sv" });
    const uri = new URL(answer.totpEnrolment.otpauthUri);
    expect([uri.protocol, uri.host]).toEqual(["otpauth:", "totp"]);
    expect(decodeURIComponent(uri.pathname)).toBe("/NortFox:Åsa.Berg@example.com");
    expect(uri.searchParams.get("issuer")).toBe("NortFox");
    const secret = base32Decode(uri.searchParams.get("secret") ?? "");
    expect(secret?.length).toBe(20);

    expect(await identitiesOf(install.owner)).toEqual([{ id: answer.user.id, name: "Åsa Berg", email: "Åsa.Berg@example.com", two_step: "new_device_90_days", status: "active" }]);
    const password = await install.owner.query<{ password_hash: string }>("SELECT password_hash FROM access.password_credentials WHERE identity_id = $1", [answer.user.id]);
    expect(password.rows[0]?.password_hash).toMatch(/^\$argon2id\$v=19\$m=64,t=1,p=1\$/);
    const stored = await install.owner.query<{ id: string; secret: Buffer; state: string }>("SELECT id, secret, state FROM access.totp_secrets WHERE identity_id = $1", [answer.user.id]);
    expect(stored.rows.map((row) => row.state)).toEqual(["pending"]);
    const [row] = stored.rows;
    // The stored secret opens with the install key, bound to its identity and its row, and is the one the answer gave.
    expect(open(TEST_INSTALL_KEY, "totp-secret v1", row?.secret ?? Buffer.alloc(0), [answer.user.id, row?.id ?? ""])).toEqual(secret);
    expect(await install.owner.query("SELECT 1 FROM access.sessions")).toMatchObject({ rowCount: 0 });

    // A second use is refused, and makes nothing.
    const again = await complete(install, token, { email: "other@example.com" });
    expect(again.status).toBe(422);
    expect(await problemIn(again)).toEqual(LINK_INVALID);
    expect(await identitiesOf(install.owner)).toHaveLength(1);

  });

  it("is refused, of two uses at once, for one", async () => {
    const install = await emptyInstall();
    const token = await setupToken(install);
    const answers = await Promise.all([complete(install, token, { email: "first@example.com" }), complete(install, token, { email: "second@example.com" })]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 422]);
    expect(await identitiesOf(install.owner)).toHaveLength(1);
    const refusedOne = answers.find((answer) => answer.status === 422);
    expect(refusedOne === undefined ? undefined : await problemIn(refusedOne)).toEqual(LINK_INVALID);
  });

  it("refuses an unknown link, one that a newer link stopped and one past its 28 days, with the same answer", async () => {
    const install = await emptyInstall();
    const stopped = await setupToken(install);
    const newer = await setupToken(install);
    const unknown = `nfu_${"A".repeat(43)}`;
    for (const token of [unknown, stopped]) {
      const response = await complete(install, token);
      expect(response.status).toBe(422);
      expect(await problemIn(response)).toEqual(LINK_INVALID);
    }
    install.clock.advance(28 * DAY);
    const late = await complete(install, newer);
    expect(late.status).toBe(422);
    expect(await problemIn(late)).toEqual(LINK_INVALID);
    expect(await identitiesOf(install.owner)).toEqual([]);
  });

  it("refuses a link that is not a setup link's form as a field problem, before anything is asked", async () => {
    const install = await emptyInstall();
    const response = await complete(install, "nfc_" + "A".repeat(43));
    expect(response.status).toBe(400);
    expect((await problemIn(response)).errors?.map((error) => [error.code, error.pointer])).toEqual([["bad-format", "/token"]]);
  });

  it("makes no setup link on an install that has an identity, and a link made before refuses to make a second identity", async () => {
    const install = await emptyInstall();
    const token = await setupToken(install);
    expect((await complete(install, token)).status).toBe(201);
    await expect(createSetupLink(install.pool.database, TEST_ORIGIN, install.clock.now())).rejects.toThrow("This install has an identity already.");

    // A link from before an identity came another way, as a race would leave it, makes none.
    const other = await emptyInstall();
    const early = await setupToken(other);
    await other.owner.query("INSERT INTO access.identities (name, email) VALUES ('Ebba Holm', 'ebba.holm@example.com')");
    const response = await complete(other, early);
    expect(response.status).toBe(422);
    expect((await problemIn(response)).code).toBe("install-not-empty");
    expect(await identitiesOf(other.owner)).toHaveLength(1);
  });
});

describe("completeSetup's password", () => {
  it("refuses 11 characters and takes 12, counted after NFC", async () => {
    const install = await emptyInstall();
    const token = await setupToken(install);
    // é as e and a combining accent is one character: eleven in all.
    for (const password of ["elva-tecken", "elva-teckén"]) {
      const response = await complete(install, token, { password });
      expect(response.status).toBe(400);
      expect(await problemIn(response)).toEqual({
        type: "about:blank",
        title: "Bad Request",
        status: 400,
        detail: "The request does not fit the operation. Each field problem names its field.",
        code: "invalid-request",
        errors: [{ code: "too-short", detail: "The field /password must be at least 12 characters long.", pointer: "/password", data: { minimum: 12 } }],
      });
    }
    // The refusals left the link as it was.
    const response = await complete(install, token, { password: "tolv-tecken!" });
    expect(response.status).toBe(201);
  });

  it("refuses more than 1024 characters, and every other field problem with it in one answer when the rest fits", async () => {
    const install = await emptyInstall();
    const token = await setupToken(install);
    const tooLong = await complete(install, token, { password: "å".repeat(1025) });
    expect((await problemIn(tooLong)).errors).toEqual([
      { code: "too-long", detail: "The field /password must be at most 1024 characters long.", pointer: "/password", data: { maximum: 1024 } },
    ]);
    const badFields = await complete(install, token, { name: "", email: "inte en adress" });
    expect((await problemIn(badFields)).errors?.map((error) => [error.code, error.pointer])).toEqual([
      ["too-short", "/name"],
      ["bad-format", "/email"],
    ]);
    expect(await identitiesOf(install.owner)).toEqual([]);
  });

  it("refuses U+0000 in the name or the e-mail address, and a lone surrogate in the password, as field problems, and leaves the link as it was", async () => {
    const install = await emptyInstall();
    const token = await setupToken(install);
    const nul = await complete(install, token, { name: "Alva\u0000Berg", email: "alva\u0000berg@example.com" });
    expect(nul.status).toBe(400);
    expect((await problemIn(nul)).errors?.map((error) => [error.code, error.pointer, error.detail])).toEqual([
      ["invalid-value", "/name", "The field /name holds the character U+0000, which no text may hold."],
      ["invalid-value", "/email", "The field /email holds the character U+0000, which no text may hold."],
    ]);
    // JSON carries a lone surrogate as an escape.
    const lone = await complete(install, token, { password: "första-lösenordet-\uD800" });
    expect(lone.status).toBe(400);
    expect((await problemIn(lone)).errors?.map((error) => [error.code, error.pointer, error.detail])).toEqual([
      ["invalid-value", "/password", "The field /password holds a lone surrogate, which is not a character."],
    ]);
    expect(install.server.reports).toEqual([]);
    expect(await identitiesOf(install.owner)).toEqual([]);
    expect((await complete(install, token)).status).toBe(201);
  });
});

describe("every install of these tests", () => {
  it("leaves no token in an answer or a report, and no password or TOTP secret in clear in its database", async () => {
    expect(installs.length).toBeGreaterThan(5);
    expectNoTokensFromSignInApps();
    for (const install of installs) {
      // The TOTP secrets that the answers gave, each in its otpauth URI.
      const secrets = install.server.bodies.flatMap((body) => [...body.matchAll(/[?&]secret=([A-Z2-7]+)/g)].map((match) => base32Decode(match[1] ?? "") ?? Buffer.alloc(0)));
      await expectNoSecretsAtRestFromSignInApps(install.db, { passwords: [PASSWORD, "tolv-tecken!", "elva-tecken"], totpSecrets: secrets });
    }
  });
});
