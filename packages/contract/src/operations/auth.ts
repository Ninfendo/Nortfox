// SPDX-License-Identifier: AGPL-3.0-only

// The browser's sign-in (docs/decisions/0008-authentication.md). Each of these
// operations serves the browser's session, so its MCP tool refuses every
// call: an MCP client signs in through OAuth. No answer body holds a session's
// token: the session and the known device come in cookies.

import { z } from "zod";
import { NoBody, defineOperation } from "../operation.ts";
import { newPassword } from "../password.ts";
import { noNul } from "../text.ts";
import { User } from "./me.ts";

/** A token's form: nf, its kind's letter, an underscore and 43 characters of base64url. */
function token(letter: string, description: string): z.ZodString {
  return z
    .string()
    .regex(new RegExp(`^nf${letter}_[A-Za-z0-9_-]{43}$`))
    .meta({ description });
}

export const TotpEnrolment = z
  .strictObject({
    otpauthUri: z.string().meta({
      description: "The TOTP secret as an otpauth URI, for an authenticator app: show it as a QR code. The first right code of it confirms it.",
    }),
  })
  .meta({ id: "TotpEnrolment", description: "A new TOTP secret, which the person adds to an authenticator app." });

export type TotpEnrolment = z.infer<typeof TotpEnrolment>;

export const SetupResult = z
  .strictObject({
    user: User,
    totpEnrolment: TotpEnrolment,
  })
  .meta({ id: "SetupResult", description: "The first identity of the install, with its TOTP enrolment. The person signs in next, with the password and a code." });

export type SetupResult = z.infer<typeof SetupResult>;

/** The first identity of an empty install, from the setup link that the install's command prints. */
export const completeSetup = defineOperation({
  id: "completeSetup",
  method: "post",
  path: "/v1/setup/{token}",
  tags: ["auth"],
  summary: "Make the first identity",
  description:
    "Makes the install's first identity from its setup link, with a name, an e-mail address and a password of 12 to 1024 characters. " +
    "The link works once, for 28 days, on an install with no identity, and a newer link stops it. " +
    "The answer gives the new TOTP secret. It sets no session: the person signs in next, with the password and a code.",
  params: z.strictObject({ token: token("u", "The setup link's token, which the install's setup command printed.") }),
  body: z.strictObject({
    name: z.string().min(1).max(200).check(noNul()).meta({ description: "The person's name." }),
    email: z
      .email({ pattern: z.regexes.unicodeEmail })
      .max(254)
      .check(noNul())
      .meta({ description: "The person's personal e-mail address." }),
    password: z.string().check(newPassword()).meta({ description: "The password: 12 to 1024 characters." }),
  }),
  output: SetupResult,
  status: 201,
  permission: "none",
  session: "flow",
  tool: "Makes the first identity of an empty install. It serves the browser's sign-in, so this tool refuses every call.",
  writes: true,
});

export const PasswordSignIn = z
  .strictObject({
    outcome: z.enum(["signed-in", "totp-required"]).meta({
      description: "signed-in: the session cookie is set, on a known device inside its 90 days. totp-required: verifyTotp comes next, with the challenge.",
    }),
    challenge: token("c", "The login challenge, for verifyTotp, when the outcome is totp-required. It works for 20 minutes and for five codes.")
      .optional(),
  })
  .meta({ id: "PasswordSignIn", description: "What a right password gives: a session, or the TOTP step." });

export type PasswordSignIn = z.infer<typeof PasswordSignIn>;

/** The password sign-in, with the e-mail address or the personnummer. */
export const loginWithPassword = defineOperation({
  id: "loginWithPassword",
  method: "post",
  path: "/v1/auth/password",
  tags: ["auth"],
  summary: "Sign in with a password",
  description:
    "Signs in with an identifier, the e-mail address in any letter case or the personnummer, and the password. " +
    "A right password gives the TOTP step, or a session on a known device inside its 90 days when the person's two-step choice allows it. " +
    "Every failure gets the same answer. After 5 failures in an hour each attempt waits longer, and after 100 the sign-in waits until the hour has passed.",
  body: z.strictObject({
    identifier: z.string().min(1).max(254).check(noNul()).meta({ description: "The e-mail address, or the personnummer in 10 or 12 digits." }),
    password: z.string().min(1).meta({ description: "The password." }),
  }),
  output: PasswordSignIn,
  permission: "none",
  session: "flow",
  tool: "Signs a browser in with a password. It serves the browser's sign-in, so this tool refuses every call: an MCP client signs in through OAuth.",
  writes: true,
});

/** The TOTP step of a password sign-in. A right code sets the session cookie. */
export const verifyTotp = defineOperation({
  id: "verifyTotp",
  method: "post",
  path: "/v1/auth/totp",
  tags: ["auth"],
  summary: "Give the TOTP code",
  description:
    "Ends a password sign-in with the six digits of the person's authenticator app. A right code sets the session cookie, and makes the browser a known device. " +
    "A code works once. A challenge takes five codes, and ten wrong codes in 15 minutes stop the TOTP step for 15 minutes.",
  body: z.strictObject({
    challenge: token("c", "The login challenge that loginWithPassword gave."),
    code: z
      .string()
      .regex(/^[0-9]{6}$/)
      .meta({ description: "The six digits of the authenticator app." }),
  }),
  output: NoBody,
  status: 204,
  permission: "none",
  session: "flow",
  tool: "Gives the TOTP code of a browser's sign-in. It serves the browser's sign-in, so this tool refuses every call: an MCP client signs in through OAuth.",
  writes: true,
});

/** Ends the browser's session and clears its cookie. */
export const logout = defineOperation({
  id: "logout",
  method: "post",
  path: "/v1/auth/logout",
  tags: ["auth"],
  summary: "Sign out",
  description: "Ends the browser's session, so its cookie is refused from the next request, and clears the cookie.",
  output: NoBody,
  status: 204,
  permission: "signed-in",
  session: "flow",
  tool: "Signs a browser out. It serves the browser's session, so this tool refuses every call.",
  writes: true,
});
