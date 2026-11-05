// SPDX-License-Identifier: MIT

// Generated from openapi.json by scripts/generate.ts. Do not edit it by hand:
// change the API, then run `pnpm openapi`.

import type { CallOptions, Send, WriteOptions } from "./runtime.ts";

/**
 * A company: its id, name, organisation number and tenant id.
 */
export interface Company {
  /**
   * The company's id.
   */
  readonly id: string;
  /**
   * The company's name.
   */
  readonly name: string;
  /**
   * The organisation number: ten digits with a hyphen after the sixth. For a sole trader it is the owner's personal identity number.
   */
  readonly organizationNumber: string;
  /**
   * The company's number for programs, its tenant id. It never changes.
   */
  readonly databaseNumber: number;
}

/**
 * A company where the person is an active member, with the person's system administrator's level there when they have one.
 */
export interface CompanyChoice {
  readonly company: Company;
  readonly adminLevel?: SysAdmin;
}

/**
 * What is wrong with one field of a request.
 */
export interface FieldProblem {
  /**
   * What is wrong with the field, as a stable kebab-case code.
   */
  readonly code: string;
  /**
   * The same in an English sentence.
   */
  readonly detail: string;
  /**
   * A JSON Pointer to the field in the operation's input: the path parameters, the query parameters, the body's fields and, for a write, idempotencyKey. An empty pointer is the whole input.
   */
  readonly pointer: string;
  /**
   * The facts behind the code, such as expected, minimum, maximum or allowed. Absent when there are none.
   */
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * Whether the server is up.
 */
export interface Health {
  /**
   * Always "ok" when the server answers.
   */
  readonly status: "ok";
  /**
   * The version of the server that answered.
   */
  readonly version: string;
}

/**
 * The signed-in person, with their own login data, and the company the request works in with the person's membership and permissions there.
 */
export interface Me {
  readonly user: User;
  /**
   * The person's personnummer, in twelve digits with a hyphen. Absent until one is added.
   */
  readonly personalIdentityNumber?: string;
  /**
   * The person's mobile number. Absent when none is set.
   */
  readonly mobile?: string;
  /**
   * How often a password sign-in asks for a TOTP code: new_device_90_days on each new device and every 90 days on a known one, or every_login.
   */
  readonly twoStep: "new_device_90_days" | "every_login";
  readonly company?: Company;
  readonly membership?: Membership;
  /**
   * The permissions the person holds in that company, in alphabetical order. Empty when the request works in no company.
   */
  readonly permissions: readonly string[];
}

/**
 * Användare in one company: a person's membership there, with its status, the system administrator's level, the idle logout and the work contacts.
 */
export interface Membership {
  /**
   * The company's id.
   */
  readonly companyId: string;
  /**
   * The person's id. Absent while the membership is invited.
   */
  readonly userId?: string;
  /**
   * invited, active, inactive, removed or left.
   */
  readonly status: "invited" | "active" | "inactive" | "removed" | "left";
  readonly adminLevel?: SysAdmin;
  /**
   * Utloggning efter inaktivitet, in whole minutes: 15, 30, 60, 120 (2 hours, the default) or 480 (8 hours).
   */
  readonly idleTimeout: 15 | 30 | 60 | 120 | 480;
  /**
   * The person's work e-mail address in this company, where its notices go. Absent when none is set.
   */
  readonly workEmail?: string;
  /**
   * The person's work phone number in this company. Absent when none is set.
   */
  readonly workPhone?: string;
}

/**
 * What a right password gives: a session, or the TOTP step.
 */
export interface PasswordSignIn {
  /**
   * signed-in: the session cookie is set, on a known device inside its 90 days. totp-required: verifyTotp comes next, with the challenge.
   */
  readonly outcome: "signed-in" | "totp-required";
  /**
   * The login challenge, for verifyTotp, when the outcome is totp-required. It works for 20 minutes and for five codes.
   */
  readonly challenge?: string;
}

/**
 * Problem details (RFC 9457) with a stable code.
 */
export interface Problem {
  /**
   * A URI for the kind of problem. NortFox sends about:blank, and the code says what went wrong.
   */
  readonly type: string;
  /**
   * The status in words, such as Bad Request.
   */
  readonly title: string;
  /**
   * The HTTP status.
   */
  readonly status: number;
  /**
   * What went wrong, in an English sentence.
   */
  readonly detail: string;
  /**
   * What went wrong, as a stable kebab-case code. Clients rely on this.
   */
  readonly code: string;
  /**
   * For invalid-request: what is wrong with each field.
   */
  readonly errors?: readonly FieldProblem[];
  /**
   * For permission-missing: the permission the operation needs.
   */
  readonly permission?: string;
  /**
   * For a rule's refusal that concerns one field: that field's JSON Pointer.
   */
  readonly pointer?: string;
  /**
   * For a rule's refusal: the facts behind it.
   */
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * The three companies the person chose last, where the person is still an active member.
 */
export interface RecentCompanies {
  /**
   * The companies, the latest chosen first.
   */
  readonly companies: readonly CompanyChoice[];
}

/**
 * The browser's session: the person it signed in, and the company it works in once one is chosen.
 */
export interface Session {
  readonly user: User;
  readonly company?: Company;
}

/**
 * The first identity of the install, with its TOTP enrolment. The person signs in next, with the password and a code.
 */
export interface SetupResult {
  readonly user: User;
  readonly totpEnrolment: TotpEnrolment;
}

/**
 * Systemadministratör: owner, the person who made the company, or admin, a member made system administrator later. Both hold the same rights, and neither gives work rights by itself.
 */
export type SysAdmin = "owner" | "admin";

/**
 * A new TOTP secret, which the person adds to an authenticator app.
 */
export interface TotpEnrolment {
  /**
   * The TOTP secret as an otpauth URI, for an authenticator app: show it as a QR code. The first right code of it confirms it.
   */
  readonly otpauthUri: string;
}

/**
 * A person: their NortFox ID, the one login identity they use for every company.
 */
export interface User {
  /**
   * The person's id. The person stays the actor of every entry they made.
   */
  readonly id: string;
  /**
   * The person's name.
   */
  readonly name: string;
  /**
   * The person's personal e-mail address. A password sign-in takes it as the identifier, in any letter case.
   */
  readonly email: string;
  /**
   * Språk: sv (Svenska) or en (English). It applies in every company.
   */
  readonly language: "sv" | "en";
}

export interface Operations {
  /**
   * Sign out
   *
   * Ends the browser's session, so its cookie is refused from the next request, and clears the cookie.
   *
   * `POST /v1/auth/logout`
   *
   * Needs a signed-in person, and works in no company.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   *
   * Serves the browser's session: its MCP tool refuses every call.
   */
  logout(options: WriteOptions): Promise<void>;

  /**
   * Sign in with a password
   *
   * Signs in with an identifier, the e-mail address in any letter case or the personnummer, and the password. A right password gives the TOTP step, or a session on a known device inside its 90 days when the person's two-step choice allows it. Every failure gets the same answer. After 5 failures in an hour each attempt waits longer, and after 100 the sign-in waits until the hour has passed.
   *
   * `POST /v1/auth/password`
   *
   * Needs no actor: anyone may call it, before signing in.
   *
   * Serves the browser's session: its MCP tool refuses every call.
   */
  loginWithPassword(
    input: {
      /**
       * The e-mail address, or the personnummer in 10 or 12 digits.
       */
      readonly identifier: string;
      /**
       * The password.
       */
      readonly password: string;
    },
    options?: CallOptions,
  ): Promise<PasswordSignIn>;

  /**
   * Give the TOTP code
   *
   * Ends a password sign-in with the six digits of the person's authenticator app. A right code sets the session cookie, and makes the browser a known device. A code works once. A challenge takes five codes, and ten wrong codes in 15 minutes stop the TOTP step for 15 minutes.
   *
   * `POST /v1/auth/totp`
   *
   * Needs no actor: anyone may call it, before signing in.
   *
   * Serves the browser's session: its MCP tool refuses every call.
   */
  verifyTotp(
    input: {
      /**
       * The login challenge that loginWithPassword gave.
       */
      readonly challenge: string;
      /**
       * The six digits of the authenticator app.
       */
      readonly code: string;
    },
    options?: CallOptions,
  ): Promise<void>;

  /**
   * List your companies
   *
   * Lists the companies where the signed-in person is an active member, by name, with the person's system administrator's level in each. query keeps the companies whose name holds it, in any letter case, or whose organisation number holds it, with or without the hyphen.
   *
   * `GET /v1/companies`
   *
   * Needs a signed-in person, and works in no company.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   */
  listCompanies(
    input?: {
      /**
       * A part of the company's name, in any letter case, or of its organisation number, with or without the hyphen.
       */
      readonly query?: string;
      /**
       * How many items a page holds: from 1 to 500. Any other whole number gives 100.
       */
      readonly limit?: number;
      /**
       * Where the page starts: the nextCursor of the page before. Leave it out for the first page.
       */
      readonly cursor?: string;
    },
    options?: CallOptions,
  ): Promise<{
  /**
   * The items of this page, in the list's order.
   */
  readonly items: readonly CompanyChoice[];
  /**
   * Where the next page starts. It is absent on the last page.
   */
  readonly nextCursor?: string;
  /**
   * How many items the whole list holds.
   */
  readonly total: number;
}>;

  /**
   * Create a company
   *
   * Makes a company with its name and organisation number, and makes the signed-in person its owner, a system administrator, in the same transaction. The company gets its tenant id, a number that is never given out again. The organisation number never changes.
   *
   * `POST /v1/companies`
   *
   * Needs a signed-in person, and works in the company it makes.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   */
  createCompany(
    input: {
      /**
       * The company's name.
       */
      readonly name: string;
      /**
       * The organisation number: ten digits with a hyphen after the sixth.
       */
      readonly organizationNumber: string;
    },
    options: WriteOptions,
  ): Promise<Company>;

  /**
   * Read the company
   *
   * Gives the company the request works in: its id, name, organisation number and tenant id. The company comes from the request's credential.
   *
   * `GET /v1/company`
   *
   * Needs the permission `company:read`, in the company that the credential names.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   */
  getCompany(options?: CallOptions): Promise<Company>;

  /**
   * Check that the server is up
   *
   * Answers as soon as the server runs. It reads no data.
   *
   * `GET /v1/health`
   *
   * Needs no permission: it reads no data.
   */
  getHealth(options?: CallOptions): Promise<Health>;

  /**
   * Read yourself
   *
   * Gives the signed-in person: their name, e-mail address and language, their personnummer and mobile number when set, and their two-step choice. When the request works in a company, it gives that company too, with the person's membership and permissions there.
   *
   * `GET /v1/me`
   *
   * Needs a signed-in person, and works in the company that the credential names, or in none.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   *
   * The answer holds personal data: `/user/name`, `/user/email`, `/personalIdentityNumber`, `/mobile`, `/membership/workEmail`, `/membership/workPhone`.
   */
  getMe(options?: CallOptions): Promise<Me>;

  /**
   * List your recent companies
   *
   * Gives the three companies the signed-in person chose last, the latest first, of those where the person is still an active member.
   *
   * `GET /v1/me/companies/recent`
   *
   * Needs a signed-in person, and works in no company.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   */
  listRecentCompanies(options?: CallOptions): Promise<RecentCompanies>;

  /**
   * Change your membership
   *
   * Changes the signed-in person's own membership in the company that the path names, where the person must be an active member: the work e-mail address and phone number there, and the idle logout. A field left out stays as it is, and null takes a work contact away.
   *
   * `PATCH /v1/me/companies/{companyId}`
   *
   * Needs a signed-in person, and works in the company that `companyId` names, where the person must be an active member.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   *
   * The answer holds personal data: `/workEmail`, `/workPhone`.
   */
  updateMyMembership(
    input: {
      /**
       * The company's id.
       */
      readonly companyId: string;
    } & {
      /**
       * The work e-mail address in this company, or null for none.
       */
      readonly workEmail?: string | null;
      /**
       * The work phone number in this company, or null for none.
       */
      readonly workPhone?: string | null;
      /**
       * Utloggning efter inaktivitet, in whole minutes: 15, 30, 60, 120 (2 hours, the default) or 480 (8 hours).
       */
      readonly idleTimeout?: 15 | 30 | 60 | 120 | 480;
    },
    options: WriteOptions,
  ): Promise<Membership>;

  /**
   * Read the session
   *
   * Gives the browser's session: the person it signed in, and the company it works in once one is chosen.
   *
   * `GET /v1/session`
   *
   * Needs a signed-in person, and works in the company that the credential names, or in none.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   *
   * Serves the browser's session: its MCP tool refuses every call.
   *
   * The answer holds personal data: `/user/name`, `/user/email`.
   */
  getSession(options?: CallOptions): Promise<Session>;

  /**
   * Choose the company
   *
   * Makes the browser's session work in the company that companyId names, where the person must be an active member, without a new sign-in. Any other company, also one that does not exist, gets the same refusal. The session takes the person's permissions there as they are now, and the company's behandlingshistorik gets the sign-in.
   *
   * `POST /v1/session/company`
   *
   * Needs a signed-in person, and works in the company that `companyId` names, where the person must be an active member.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   *
   * Serves the browser's session: its MCP tool refuses every call.
   *
   * The answer holds personal data: `/user/name`, `/user/email`.
   */
  selectCompany(
    input: {
      /**
       * The id of the company to work in.
       */
      readonly companyId: string;
    },
    options: WriteOptions,
  ): Promise<Session>;

  /**
   * Make the first identity
   *
   * Makes the install's first identity from its setup link, with a name, an e-mail address and a password of 12 to 1024 characters. The link works once, for 28 days, on an install with no identity, and a newer link stops it. The answer gives the new TOTP secret. It sets no session: the person signs in next, with the password and a code.
   *
   * `POST /v1/setup/{token}`
   *
   * Needs no actor: anyone may call it, before signing in.
   *
   * Serves the browser's session: its MCP tool refuses every call.
   *
   * The answer holds personal data: `/user/name`, `/user/email`.
   */
  completeSetup(
    input: {
      /**
       * The setup link's token, which the install's setup command printed.
       */
      readonly token: string;
    } & {
      /**
       * The person's name.
       */
      readonly name: string;
      /**
       * The person's personal e-mail address.
       */
      readonly email: string;
      /**
       * The password: 12 to 1024 characters.
       */
      readonly password: string;
    },
    options?: CallOptions,
  ): Promise<SetupResult>;
}

export function createOperations(send: Send): Operations {
  return {
    logout: async (options) => { await send({ method: "POST", path: "/v1/auth/logout", key: true, answer: "none" }, undefined, options); },
    loginWithPassword: async (input, options) => (await send({ method: "POST", path: "/v1/auth/password", body: true }, input, options)) as PasswordSignIn,
    verifyTotp: async (input, options) => { await send({ method: "POST", path: "/v1/auth/totp", body: true, answer: "none" }, input, options); },
    listCompanies: async (input, options) => (await send({ method: "GET", path: "/v1/companies", query: ["query", "limit", "cursor"] }, input, options)) as {
  /**
   * The items of this page, in the list's order.
   */
  readonly items: readonly CompanyChoice[];
  /**
   * Where the next page starts. It is absent on the last page.
   */
  readonly nextCursor?: string;
  /**
   * How many items the whole list holds.
   */
  readonly total: number;
},
    createCompany: async (input, options) => (await send({ method: "POST", path: "/v1/companies", body: true, key: true }, input, options)) as Company,
    getCompany: async (options) => (await send({ method: "GET", path: "/v1/company" }, undefined, options)) as Company,
    getHealth: async (options) => (await send({ method: "GET", path: "/v1/health" }, undefined, options)) as Health,
    getMe: async (options) => (await send({ method: "GET", path: "/v1/me" }, undefined, options)) as Me,
    listRecentCompanies: async (options) => (await send({ method: "GET", path: "/v1/me/companies/recent" }, undefined, options)) as RecentCompanies,
    updateMyMembership: async (input, options) => (await send({ method: "PATCH", path: "/v1/me/companies/{companyId}", params: ["companyId"], body: true, key: true }, input, options)) as Membership,
    getSession: async (options) => (await send({ method: "GET", path: "/v1/session" }, undefined, options)) as Session,
    selectCompany: async (input, options) => (await send({ method: "POST", path: "/v1/session/company", body: true, key: true }, input, options)) as Session,
    completeSetup: async (input, options) => (await send({ method: "POST", path: "/v1/setup/{token}", params: ["token"], body: true }, input, options)) as SetupResult,
  };
}
