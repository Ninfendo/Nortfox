// SPDX-License-Identifier: AGPL-3.0-only

// What the sign-in tests share: an app with the server's session resolver,
// a clock the test moves and a fake mail sink, identities with a real
// password hash and a real sealed TOTP secret, the steps of a sign-in as a
// browser sends them, and the cookies an answer sets. Every value is made
// up: the addresses are at example.com, and a personnummer comes only from
// the fixture guard's list. The passwords are hashed at the tests' small
// cost (test/api.ts), unless a test asks for the production cost.

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Client } from "pg";
import { expect } from "vitest";
import { buildTestApp, gate, testPasswords, TEST_INSTALL_KEY, TEST_NOW, type Gate, type ProblemBody } from "./api.ts";
import type { TestDatabase } from "./database.ts";
import { addIdentity, addPassword, someEmail } from "./identities.ts";
import { FakeMailSink, testMail } from "./mail.ts";
import { expectNoSecretsAtRest, expectNoTokensButChallenges, type SecretsInClear } from "./secrets.ts";
import type { ContextResolver } from "../src/api/context.ts";
import type { AppOptions, ServerApp } from "../src/app.ts";
import { sessionResolver } from "../src/auth/resolver.ts";
import { seal } from "../src/auth/secret-box.ts";
import { base32Decode, newTotpSecret, totpCode } from "../src/auth/totp.ts";
import type { PasswordHasher } from "../src/auth/password.ts";
import type { Database, Ending, TransactionSettings } from "../src/db/database.ts";

/** The install's own origin in the sign-in tests: the one a browser sends. */
export const TEST_ORIGIN = "https://nortfox.example";

/** The server's clock as a test moves it: only forwards. */
export interface TestClock {
  readonly now: () => Date;
  /** Moves the clock on by `ms` milliseconds. */
  advance(ms: number): void;
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function testClock(start: Date = TEST_NOW): TestClock {
  let at = start.getTime();
  return {
    now: () => new Date(at),
    advance: (ms) => {
      if (ms < 0) {
        throw new Error("The tests move the server's clock only forwards.");
      }
      at += ms;
    },
  };
}

/** The test app with the server's session resolver and a clock of its own, and what it reported. */
export interface SignInApp {
  readonly app: ServerApp;
  readonly clock: TestClock;
  /** The fake mail sink that the app's mail goes to: empty, and unused, for an app with no mail set up. */
  readonly mail: FakeMailSink;
  /** Every error the app reported, for the secret scan. */
  readonly reports: unknown[];
  /** The body of every answer that send gave, as text, for the secret scan. */
  readonly bodies: string[];
  /** Every password and code that send sent in a body, right or wrong, for the scan of the database. */
  readonly sent: { readonly passwords: string[]; readonly codes: string[] };
  /** Sends a request to the app, as app.request does, and keeps the answer's body. */
  send(path: string, init: RequestInit, bindings?: unknown): Promise<Response>;
}

export interface SignInAppOptions {
  readonly clock?: TestClock;
  readonly passwords?: PasswordHasher;
  readonly options?: Partial<AppOptions>;
  /** The install's mail: a fake sink of its own by default, or none set up. */
  readonly mail?: "none";
  /** "on": /mcp takes a session's token as a bearer token, and gives its principal (sessionsOnMcp). */
  readonly mcpSessions?: "on";
}

/**
 * The resolver of `resolve` on /v1, and on /mcp too, for the tests that send
 * one principal through both surfaces, until MCP's OAuth comes in a later
 * part of slice 2c: on /mcp, a bearer token that is a session's token gives
 * that session's principal, as `resolve` gives it on /v1 for the session
 * cookie. The server's own resolver never reads a session on /mcp, and the
 * part that brings MCP's tokens replaces this with real ones.
 */
export function sessionsOnMcp(resolve: ContextResolver): ContextResolver {
  return (request, surface) => {
    if (surface === "rest") {
      return resolve(request, surface);
    }
    const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    return token === undefined ? Promise.resolve(undefined) : resolve(new Request(request.url, { headers: cookieHeader({ session: token }) }), "rest");
  };
}

/** Every sign-in app that the test file made, for the secret scan at its end. */
const made: SignInApp[] = [];

/** Fails on a token in an answer or a report of any sign-in app that the test file made, but a login challenge where loginWithPassword gives it. */
export function expectNoTokensFromSignInApps(): void {
  expect(made.length, "The test file made no sign-in app.").toBeGreaterThan(0);
  for (const server of made) {
    expectNoTokensButChallenges(server.bodies, server.reports);
  }
}

/** Every TOTP secret that addSignInIdentity made in the test file, for the secret scan at its end. */
const madeTotpSecrets: Buffer[] = [];

/** Every password and TOTP code that the sign-in apps of the test file sent. */
export function sentSecrets(): { readonly passwords: string[]; readonly codes: string[] } {
  return { passwords: made.flatMap((server) => server.sent.passwords), codes: made.flatMap((server) => server.sent.codes) };
}

/** The secret of every otpauth URI in an answer of a sign-in app of the test file, as completeSetup gives one. */
function givenTotpSecrets(): Buffer[] {
  return made.flatMap((server) =>
    server.bodies.flatMap((body) => [...body.matchAll(/[?&]secret=([A-Z2-7]+)/g)].flatMap((match) => base32Decode(match[1] ?? "") ?? [])),
  );
}

/**
 * Fails on a token, or on a secret in clear, in the database: the secrets
 * the test names, every password and code, right or wrong, that a sign-in
 * app of the test file sent, every TOTP secret that addSignInIdentity made,
 * and every one that an answer gave in its otpauth URI.
 */
export async function expectNoSecretsAtRestFromSignInApps(db: TestDatabase, secrets: SecretsInClear = {}): Promise<void> {
  const sent = sentSecrets();
  await expectNoSecretsAtRest(db, {
    ...secrets,
    passwords: [...(secrets.passwords ?? []), ...sent.passwords],
    totpSecrets: [...(secrets.totpSecrets ?? []), ...madeTotpSecrets, ...givenTotpSecrets()],
    codes: [...(secrets.codes ?? []), ...sent.codes],
  });
}

/** Keeps each password and code of a JSON value, at any depth, such as a new identity's password. */
function keepSecretsOf(value: unknown, sent: SignInApp["sent"]): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [name, item] of Object.entries(value)) {
    if (name === "password" && typeof item === "string") {
      sent.passwords.push(item);
    } else if (name === "code" && typeof item === "string") {
      sent.codes.push(item);
    } else {
      keepSecretsOf(item, sent);
    }
  }
}

/** The fields of a JSON body that are secrets in clear: its passwords and its codes, when it has them. */
function keepSecrets(body: unknown, sent: SignInApp["sent"]): void {
  if (typeof body !== "string") {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return;
  }
  keepSecretsOf(parsed, sent);
}

export function signInApp(database: Database, options: SignInAppOptions = {}): SignInApp {
  const clock = options.clock ?? testClock();
  const reports: unknown[] = [];
  const bodies: string[] = [];
  const sent: SignInApp["sent"] = { passwords: [], codes: [] };
  const mail = new FakeMailSink();
  const sessions = sessionResolver({ database, now: clock.now });
  const app = buildTestApp({
    database,
    resolve: options.mcpSessions === "on" ? sessionsOnMcp(sessions) : sessions,
    now: clock.now,
    allowedOrigins: [TEST_ORIGIN],
    passwordHasher: options.passwords ?? testPasswords(),
    report: (error) => reports.push(error),
    ...(options.mail === "none" ? {} : { mail: testMail(mail) }),
    ...options.options,
  });
  const server: SignInApp = {
    app,
    clock,
    mail,
    reports,
    bodies,
    sent,
    async send(path, init, bindings) {
      keepSecrets(init.body, sent);
      const response = await app.hono.request(path, init, bindings);
      // The answer keeps its own body: the scan reads a copy.
      bodies.push(await response.clone().text());
      return response;
    },
  };
  made.push(server);
  return server;
}

/** An identity that can sign in: its password and, unless it has none, its TOTP secret in clear, as only the test knows them. */
export interface TestIdentity {
  readonly id: string;
  readonly email: string;
  readonly password: string;
  readonly personalIdentityNumber?: string;
  readonly totpSecret?: Buffer;
  readonly totpSecretId?: string;
}

export interface NewSignInIdentity {
  readonly email?: string;
  readonly password?: string;
  readonly personalIdentityNumber?: string;
  readonly twoStep?: "new_device_90_days" | "every_login";
  /** The state of its TOTP secret, or none. By default active. */
  readonly totp?: "active" | "pending" | "none";
  readonly passwords?: PasswordHasher;
}

/** A made-up password of 20 characters. */
export function somePassword(): string {
  return `lösen-${randomUUID().slice(0, 14)}`;
}

/**
 * Adds an identity as the owner, as the database's own functions do, with a
 * password hashed by the server's wrapper and a TOTP secret sealed with the
 * test install key, as completeSetup keeps them.
 */
export async function addSignInIdentity(owner: Client, wanted: NewSignInIdentity = {}): Promise<TestIdentity> {
  const email = wanted.email ?? someEmail();
  const password = wanted.password ?? somePassword();
  const id = await addIdentity(owner, {
    email,
    ...(wanted.personalIdentityNumber === undefined ? {} : { personalIdentityNumber: wanted.personalIdentityNumber }),
    ...(wanted.twoStep === undefined ? {} : { twoStep: wanted.twoStep }),
  });
  const hashed = await (wanted.passwords ?? testPasswords()).hash(password, "/password");
  if (!hashed.ok) {
    throw new Error("The test's password is not a password the server takes.");
  }
  await addPassword(owner, id, hashed.hash);
  const base = { id, email, password, ...(wanted.personalIdentityNumber === undefined ? {} : { personalIdentityNumber: wanted.personalIdentityNumber }) };
  const state = wanted.totp ?? "active";
  if (state === "none") {
    return base;
  }
  const totpSecret = newTotpSecret();
  madeTotpSecrets.push(totpSecret);
  const totpSecretId = randomUUID();
  await owner.query(
    `INSERT INTO access.totp_secrets (id, identity_id, secret, state, created_at, confirmed_at)
     VALUES ($1, $2, $3, $4, pg_catalog.clock_timestamp(), CASE WHEN $4 = 'active' THEN pg_catalog.clock_timestamp() END)`,
    [totpSecretId, id, seal(TEST_INSTALL_KEY, "totp-secret v1", totpSecret, [id, totpSecretId]), state],
  );
  return { ...base, totpSecret, totpSecretId };
}

/** The TOTP code of an identity's secret at the server's time. */
export function codeOf(identity: TestIdentity, at: Date): string {
  if (identity.totpSecret === undefined) {
    throw new Error("The identity has no TOTP secret.");
  }
  return totpCode(identity.totpSecret, at);
}

/** A wrong code at `at`: the right one with its last digit moved on. */
export function wrongCodeOf(identity: TestIdentity, at: Date): string {
  const right = codeOf(identity, at);
  return `${right.slice(0, 5)}${String((Number(right.slice(5)) + 1) % 10)}`;
}

/** The cookies a browser holds, by name. */
export interface Cookies {
  readonly session?: string;
  readonly device?: string;
}

/** The Cookie header of the browser's cookies. */
export function cookieHeader(cookies: Cookies): Record<string, string> {
  const parts = [
    ...(cookies.session === undefined ? [] : [`__Host-nortfox-session=${cookies.session}`]),
    ...(cookies.device === undefined ? [] : [`__Host-nortfox-device=${cookies.device}`]),
  ];
  return parts.length === 0 ? {} : { cookie: parts.join("; ") };
}

/** A cookie as an answer sets it: its value and each of its attributes. */
export interface SetCookie {
  readonly value: string;
  readonly attributes: readonly string[];
}

/** The cookies an answer sets, by name. */
export function setCookiesOf(response: Response): Readonly<Record<string, SetCookie>> {
  return Object.fromEntries(
    response.headers.getSetCookie().map((line) => {
      const [pair = "", ...attributes] = line.split("; ");
      const equals = pair.indexOf("=");
      return [pair.slice(0, equals), { value: pair.slice(equals + 1), attributes }];
    }),
  );
}

/** What a browser sends with a sign-in: its own origin and its cookies. */
export interface Browser {
  readonly cookies?: Cookies;
  /** The request's address, as Node gives it to the server. */
  readonly ipAddress?: string;
}

/** The bindings that give the server a request's address, as @hono/node-server does. */
function addressOf(browser: Browser): { incoming: { socket: { remoteAddress: string } } } | undefined {
  return browser.ipAddress === undefined ? undefined : { incoming: { socket: { remoteAddress: browser.ipAddress } } };
}

/** Posts JSON to `path` as a browser on the install's own site does. */
export function postAsBrowser(app: SignInApp, path: string, body: unknown, browser: Browser = {}, headers: Record<string, string> = {}): Promise<Response> {
  return app.send(
    path,
    {
      method: "POST",
      headers: { origin: TEST_ORIGIN, "content-type": "application/json", ...cookieHeader(browser.cookies ?? {}), ...headers },
      body: JSON.stringify(body),
    },
    addressOf(browser),
  );
}

/** Sends a request that carries the browser's cookies, from its own site. */
export function sendAsBrowser(app: SignInApp, method: string, path: string, browser: Browser = {}, headers: Record<string, string> = {}): Promise<Response> {
  return app.send(path, { method, headers: { origin: TEST_ORIGIN, ...cookieHeader(browser.cookies ?? {}), ...headers } }, addressOf(browser));
}

export function passwordStep(app: SignInApp, identifier: string, password: string, browser: Browser = {}): Promise<Response> {
  return postAsBrowser(app, "/v1/auth/password", { identifier, password }, browser);
}

export function totpStep(app: SignInApp, challenge: string, code: string, browser: Browser = {}): Promise<Response> {
  return postAsBrowser(app, "/v1/auth/totp", { challenge, code }, browser);
}

/** The answer of loginWithPassword. */
export interface PasswordAnswer {
  readonly outcome: "signed-in" | "totp-required";
  readonly challenge?: string;
}

/** The challenge of a right password's answer, after checking that the TOTP step comes next. */
export async function challengeOf(response: Response): Promise<string> {
  const answer = (await response.json()) as PasswordAnswer;
  if (response.status !== 200 || answer.outcome !== "totp-required" || answer.challenge === undefined) {
    throw new Error(`The password step answered ${String(response.status)} ${JSON.stringify(answer)}, not the TOTP step.`);
  }
  return answer.challenge;
}

/** A browser after a sign-in: the cookies it holds. */
export interface SignedIn extends Cookies {
  readonly session: string;
  readonly device: string;
}

/**
 * Signs `identity` in with its e-mail, its password and the TOTP code of the
 * server's time, as a browser on the install's own site does, and gives the
 * cookies the browser then holds.
 */
export async function signIn(app: SignInApp, identity: TestIdentity, browser: Browser = {}): Promise<SignedIn> {
  const challenge = await challengeOf(await passwordStep(app, identity.email, identity.password, browser));
  const answer = await totpStep(app, challenge, codeOf(identity, app.clock.now()), browser);
  if (answer.status !== 204) {
    throw new Error(`The TOTP step answered ${String(answer.status)}: ${await answer.text()}`);
  }
  const set = setCookiesOf(answer);
  const session = set["__Host-nortfox-session"]?.value;
  const device = set["__Host-nortfox-device"]?.value ?? browser.cookies?.device;
  if (session === undefined || device === undefined) {
    throw new Error("The TOTP step set no session cookie, or the browser has no device cookie.");
  }
  return { session, device };
}

/**
 * A database whose next write that `holds` picks, a write of a company or a
 * person's write, waits at a gate until the test opens it: at its start,
 * before its work runs, or before its commit, after its work, with its row
 * locks held. Every other transaction runs as it is.
 */
export function holdingWrites(
  database: Database,
  holds: (settings: TransactionSettings) => boolean,
  where: "start" | "commit",
): { readonly database: Database; readonly gate: Gate } {
  const held = gate();
  let armed = true;
  const picks = (settings: TransactionSettings): boolean => {
    const picked = armed && holds(settings);
    armed &&= !picked;
    return picked;
  };
  /** The work, held at the gate when `settings` are picked. */
  const heldWork =
    <Q, T>(settings: TransactionSettings, work: (tx: Q) => Promise<Ending<T>>) =>
    async (tx: Q): Promise<Ending<T>> => {
      const picked = picks(settings);
      if (picked && where === "start") {
        await held.pass();
      }
      const ending = await work(tx);
      if (picked && where === "commit") {
        await held.pass();
      }
      return ending;
    };
  return {
    gate: held,
    database: {
      ...database,
      write: (settings, work) => database.write(settings, heldWork(settings, work)),
      person: (mode, settings, work) => database.person(mode, settings, mode === "write" ? heldWork(settings, work) : work),
    },
  };
}

/** Waits until a backend of the test's database waits for a lock that another holds. `observer` logs in as the role whose backends it watches. */
export async function untilSomeoneWaitsForLock(observer: Client): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const found = await observer.query("SELECT 1 FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database() AND wait_event_type = 'Lock'");
    if ((found.rowCount ?? 0) > 0) {
      return;
    }
    await delay(10);
  }
  throw new Error("No backend ever waited for a lock.");
}

/**
 * The answer of `call`, when it comes before any backend of the test's
 * database waits for a lock; or "waited" when one waits first, and the call
 * still runs. `observer` logs in as the role whose backends it watches.
 */
export async function answeredWithoutWaiting<T>(observer: Client, call: Promise<T>): Promise<T | "waited"> {
  const state = { settled: false };
  const watched = call.finally(() => {
    state.settled = true;
  });
  // A call that throws later, after the test moved on, is the test's own to await.
  void watched.catch(() => undefined);
  for (let attempt = 0; attempt < 1000 && !state.settled; attempt += 1) {
    const found = await observer.query("SELECT 1 FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database() AND wait_event_type = 'Lock'");
    if ((found.rowCount ?? 0) > 0) {
      return "waited";
    }
    await delay(10);
  }
  return watched;
}

/**
 * The answer of `call` when it comes within `ms`, or "no answer" while it
 * still runs, as a call does that waits for a turn or for a connection of
 * the pool. The call runs on either way, and is the test's own to await.
 */
export async function answeredWithin<T>(call: Promise<T>, ms: number): Promise<T | "no answer"> {
  void call.catch(() => undefined);
  return Promise.race([call, delay(ms).then(() => "no answer" as const)]);
}

/** Reads `path` with the browser's session cookie, as the web app does. */
export function getAs(app: SignInApp, session: string, path: string, browser: Omit<Browser, "cookies"> = {}): Promise<Response> {
  return sendAsBrowser(app, "GET", path, { ...browser, cookies: { session } });
}

/** Sends a write with a body and an idempotency key, with the browser's session cookie, as the web app does. */
export function writeAs(
  app: SignInApp,
  session: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body: unknown,
  options: { readonly key?: string; readonly ipAddress?: string } = {},
): Promise<Response> {
  return app.send(
    path,
    {
      method,
      headers: {
        origin: TEST_ORIGIN,
        "content-type": "application/json",
        "idempotency-key": options.key ?? randomUUID(),
        ...cookieHeader({ session }),
      },
      body: JSON.stringify(body),
    },
    addressOf(options.ipAddress === undefined ? {} : { ipAddress: options.ipAddress }),
  );
}

/** Byt företag: the session chooses the company, as the web app does. */
export function chooseCompany(app: SignInApp, session: string, companyId: string, options: { readonly key?: string; readonly ipAddress?: string } = {}): Promise<Response> {
  return writeAs(app, session, "POST", "/v1/session/company", { companyId }, options);
}

/** The answer's JSON, after checking its status. */
export async function jsonOf<T = Record<string, unknown>>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) {
    throw new Error(`The answer is ${String(response.status)}, not ${String(status)}: ${text}`);
  }
  return JSON.parse(text) as T;
}

/** The problem details of a 422 sign-in-failed, the one answer of every failed sign-in step. */
export function signInFailed(detail: string): ProblemBody {
  return { type: "about:blank", title: "Unprocessable Content", status: 422, detail, code: "sign-in-failed" };
}

/** The detail of a failed password step. */
export const PASSWORD_FAILED = "The sign-in failed: the identifier or the password is wrong.";

/** The detail of a failed TOTP step. */
export const CODE_FAILED = "The sign-in failed: the code is wrong, or the sign-in has ended. Start again with the password when it has ended.";
