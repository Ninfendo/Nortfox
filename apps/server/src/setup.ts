// SPDX-License-Identifier: AGPL-3.0-only

// The setup link (open point 12): the first identity of an empty install
// comes from a link that the install's own command prints (setup-main.ts).
// The link holds a setup token, which the database keeps only as its hash.
// It works once, for 28 days, as the established system's welcome link does
// (choice 5), and a newer link stops it. completeSetup takes it, with the
// person's name, e-mail address and password. completeSetup's answer holds
// the only copy of the new identity's TOTP secret, so when that answer is
// lost, the command makes a new link while the install's only identity is
// the one a setup link made and it never confirmed its secret: using the new
// link replaces that identity (issue 54). On an install with any other
// identity, or once that one confirmed its secret, no link is made: every
// other person is invited.

import { readRefusal } from "./db/refusals.ts";
import { commit, type Database } from "./db/database.ts";
import { newToken, tokenHash } from "./auth/tokens.ts";

/** A setup link works this long. */
export const SETUP_LINK_LIFETIME_MS = 28 * 24 * 60 * 60 * 1000;

export interface SetupLink {
  /** The link: completeSetup's path on the install's own origin, with the token. */
  readonly url: string;
  readonly expiresAt: Date;
  /** Whether using the link replaces the install's only identity, which never confirmed its TOTP secret. */
  readonly replaces: boolean;
}

/** Makes the install's setup link at `at`, and stops every older one. Throws on an install that has an identity it may not replace. */
export async function createSetupLink(database: Database, publicOrigin: string, at: Date): Promise<SetupLink> {
  const token = newToken("setup");
  const expiresAt = new Date(at.getTime() + SETUP_LINK_LIFETIME_MS);
  return { url: `${publicOrigin}/v1/setup/${token}`, expiresAt, replaces: await storeLink(database, tokenHash(token), at, expiresAt) };
}

/** Stores a link's hash, and gives whether using it replaces the install's unfinished identity. */
async function storeLink(database: Database, hash: Buffer, at: Date, expiresAt: Date): Promise<boolean> {
  try {
    // No row it writes takes the channel; it is set because every transaction needs one.
    return await database.write({ channel: "rest" }, async (tx) => {
      const made = await tx.query<{ replaces_identity: boolean }>("SELECT replaces_identity FROM access.create_setup_token($1, $2, $3)", [hash, at, expiresAt]);
      // The function gives one row: the link's.
      return commit((made.rows as [{ readonly replaces_identity: boolean }])[0].replaces_identity);
    });
  } catch (error) {
    if (readRefusal(error)?.reason === "install_not_empty") {
      throw new Error("This install has an identity already. A setup link makes only the first identity of an empty install: the others are invited.", {
        cause: error,
      });
    }
    throw error;
  }
}

/** What the setup command prints: the link, until when it works, what its use replaces, and how to use it. */
export function setupLinkMessage(link: SetupLink): string {
  return [
    `The setup link of this install. It makes the first identity once, until ${link.expiresAt.toISOString()}, and a newer link stops it:`,
    "",
    `  ${link.url}`,
    "",
    ...(link.replaces
      ? [
          "This install's only identity never confirmed its TOTP secret. Using this link replaces it: that identity is deleted, with its password and its TOTP secret, and the link makes a new one.",
        ]
      : []),
    'Send it a POST with the JSON body {"name": "...", "email": "...", "password": "..."}, with a password of 12 to 1024 characters.',
    "The answer holds the TOTP secret for an authenticator app. Then sign in with the e-mail address, the password and a code.",
  ].join("\n");
}
