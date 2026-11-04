// SPDX-License-Identifier: AGPL-3.0-only

// The server's own settings, which main.ts reads before it starts
// (deploy/README.md). The database's are in db/connect.ts. Each one missing
// or wrong stops the start, with a message that says what to set. No message
// holds the secret.
//
// - NORTFOX_PUBLIC_ORIGIN: the origin people open NortFox at, such as
//   https://nortfox.example. It is the one origin that /v1 and /mcp allow
//   (auth/origin.ts). NortFox's cookies are Secure, which a browser keeps
//   only over https, or over http on the host's own loopback address. So the
//   origin is https, or http on localhost, 127.0.0.1 or [::1] while
//   developing.
// - NORTFOX_SECRET_KEY_FILE: the file of the install secret
//   (auth/install-key.ts). Its first line is the key id, a whole number from
//   1 to 255 written without a leading zero, and its second line is the
//   secret: at least 32 random bytes, as an even number of hexadecimal
//   digits. Nothing else is in the file but a line end after the secret.

import { readFileSync } from "node:fs";
import { INSTALL_SECRET_MIN_BYTES, InstallKey } from "./auth/install-key.ts";
import { isOrigin } from "./auth/origin.ts";
import type { Environment } from "./db/connect.ts";

export interface ServerConfig {
  /** The origin people open NortFox at: the one browser origin that /v1 and /mcp allow. */
  readonly publicOrigin: string;
  /** The install secret. */
  readonly installKey: InstallKey;
}

/** The hosts that a browser treats as this machine, where http keeps a Secure cookie. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function publicOriginOf(env: Environment): string {
  const origin = env["NORTFOX_PUBLIC_ORIGIN"];
  if (origin === undefined || origin === "") {
    throw new Error("NORTFOX_PUBLIC_ORIGIN is not set. Set it to the origin people open NortFox at, such as https://nortfox.example.");
  }
  const url = isOrigin(origin) ? new URL(origin) : undefined;
  if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new Error(`NORTFOX_PUBLIC_ORIGIN must be an origin as a browser sends it, such as https://nortfox.example, with no path; "${origin}" is not.`);
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `NORTFOX_PUBLIC_ORIGIN must use https, since a browser keeps NortFox's Secure cookies only over https; "${origin}" does not. ` +
        "Only localhost, 127.0.0.1 and [::1] may use http, while developing.",
    );
  }
  return origin;
}

/** A key id: 1 to 255, with no leading zero. */
const KEY_ID = /^(?:[1-9][0-9]{0,2})$/;

/** The secret: an even number of hexadecimal digits, at least two for each of its bytes. */
const SECRET = new RegExp(`^(?:[0-9A-Fa-f]{2}){${String(INSTALL_SECRET_MIN_BYTES)},}$`);

/** Reads the install secret's file at `path`. */
export function readInstallKey(path: string, readFile: (path: string) => string): InstallKey {
  let text: string;
  try {
    text = readFile(path);
  } catch {
    throw new Error(`The install secret's file ${path} cannot be read.`);
  }
  // split always gives a first line, which may be empty.
  const [keyId, secret = "", ...more] = text.replace(/\r?\n$/, "").split(/\r?\n/) as [string, ...string[]];
  if (!KEY_ID.test(keyId) || Number(keyId) > 255) {
    throw new Error(`The first line of the install secret's file ${path} must be its key id, a whole number from 1 to 255.`);
  }
  if (more.length > 0) {
    throw new Error(`The install secret's file ${path} must hold two lines: the key id, and the secret.`);
  }
  if (!SECRET.test(secret)) {
    throw new Error(
      `The second line of the install secret's file ${path} must be the secret: ` +
        `at least ${String(INSTALL_SECRET_MIN_BYTES)} random bytes as ${String(2 * INSTALL_SECRET_MIN_BYTES)} or more hexadecimal digits, an even number of them.`,
    );
  }
  return new InstallKey(Number(keyId), Buffer.from(secret, "hex"));
}

/** The server's settings from the environment. Throws on any that is missing or wrong. */
export function serverConfig(env: Environment, readFile: (path: string) => string = (path) => readFileSync(path, "utf8")): ServerConfig {
  const publicOrigin = publicOriginOf(env);
  const keyFile = env["NORTFOX_SECRET_KEY_FILE"];
  if (keyFile === undefined || keyFile === "") {
    throw new Error("NORTFOX_SECRET_KEY_FILE is not set. Set it to the file of the install secret, as deploy/README.md says.");
  }
  return { publicOrigin, installKey: readInstallKey(keyFile, readFile) };
}
