// SPDX-License-Identifier: AGPL-3.0-only

// The setup link (open point 12): the first identity of an empty install
// comes from a link that the install's own command prints (setup-main.ts).
// The link holds a setup token, which the database keeps only as its hash.
// It works once, for 28 days, as the established system's welcome link does
// (choice 5), and a newer link stops it. completeSetup takes it, with the
// person's name, e-mail address and password. On an install that has an
// identity no link is made: every other person is invited.

import { readRefusal } from "./db/refusals.ts";
import { commit, type Database } from "./db/database.ts";
import { newToken, tokenHash } from "./auth/tokens.ts";

/** A setup link works this long. */
export const SETUP_LINK_LIFETIME_MS = 28 * 24 * 60 * 60 * 1000;

export interface SetupLink {
  /** The link: completeSetup's path on the install's own origin, with the token. */
  readonly url: string;
  readonly expiresAt: Date;
}

/** Makes the install's setup link at `at`, and stops every older one. Throws on an install that has an identity. */
export async function createSetupLink(database: Database, publicOrigin: string, at: Date): Promise<SetupLink> {
  const token = newToken("setup");
  const expiresAt = new Date(at.getTime() + SETUP_LINK_LIFETIME_MS);
  try {
    // No row it writes takes the channel; it is set because every transaction needs one.
    await database.write({ channel: "rest" }, async (tx) => {
      await tx.query("SELECT access.create_setup_token($1, $2, $3)", [tokenHash(token), at, expiresAt]);
      return commit(undefined);
    });
  } catch (error) {
    if (readRefusal(error)?.reason === "install_not_empty") {
      throw new Error("This install has an identity already. A setup link makes only the first identity of an empty install: the others are invited.", {
        cause: error,
      });
    }
    throw error;
  }
  return { url: `${publicOrigin}/v1/setup/${token}`, expiresAt };
}

/** What the setup command prints: the link, until when it works, and how to use it. */
export function setupLinkMessage(link: SetupLink): string {
  return [
    `The setup link of this install. It makes the first identity once, until ${link.expiresAt.toISOString()}, and a newer link stops it:`,
    "",
    `  ${link.url}`,
    "",
    'Send it a POST with the JSON body {"name": "...", "email": "...", "password": "..."}, with a password of 12 to 1024 characters.',
    "The answer holds the TOTP secret for an authenticator app. Then sign in with the e-mail address, the password and a code.",
  ].join("\n");
}
