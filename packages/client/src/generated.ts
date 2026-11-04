// SPDX-License-Identifier: MIT

// Generated from openapi.json by scripts/generate.ts. Do not edit it by hand:
// change the API, then run `pnpm openapi`.

import type { CallOptions, Send, WriteOptions } from "./runtime.ts";

/**
 * The company the request works in. Every data request works in exactly one company.
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
 * The signed-in person, with their own login data.
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
 * The browser's session: the person it signed in. A session works in no company until one is chosen.
 */
export interface Session {
  readonly user: User;
}

/**
 * The first identity of the install, with its TOTP enrolment. The person signs in next, with the password and a code.
 */
export interface SetupResult {
  readonly user: User;
  readonly totpEnrolment: TotpEnrolment;
}

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
   * Gives the signed-in person: their name, e-mail address and language, their personnummer and mobile number when set, and their two-step choice.
   *
   * `GET /v1/me`
   *
   * Needs a signed-in person, and works in no company.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   */
  getMe(options?: CallOptions): Promise<Me>;

  /**
   * Read the session
   *
   * Gives the browser's session: the person it signed in.
   *
   * `GET /v1/session`
   *
   * Needs a signed-in person, and works in no company.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   *
   * Serves the browser's session: its MCP tool refuses every call.
   */
  getSession(options?: CallOptions): Promise<Session>;

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
    getCompany: async (options) => (await send({ method: "GET", path: "/v1/company" }, undefined, options)) as Company,
    getHealth: async (options) => (await send({ method: "GET", path: "/v1/health" }, undefined, options)) as Health,
    getMe: async (options) => (await send({ method: "GET", path: "/v1/me" }, undefined, options)) as Me,
    getSession: async (options) => (await send({ method: "GET", path: "/v1/session" }, undefined, options)) as Session,
    completeSetup: async (input, options) => (await send({ method: "POST", path: "/v1/setup/{token}", params: ["token"], body: true }, input, options)) as SetupResult,
  };
}
