// SPDX-License-Identifier: AGPL-3.0-only

// The server's own settings, which main.ts reads before it starts, beside
// the database's (db/connect.ts). The server does not start without them:
//
// - NORTFOX_PUBLIC_ORIGIN: the origin people open NortFox at, such as
//   https://nortfox.example. The browser's writes with the session cookie,
//   and its sign-ins, must come from it. The cookies are Secure, so it is
//   https, or http on the host's own loopback address while developing.
// - NORTFOX_SECRET_KEY_FILE: the file of the install secret. Its first line
//   is the key id, a whole number from 1 to 255, and its second line the
//   secret: at least 32 random bytes, in hexadecimal. No message ever holds
//   the secret.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InstallKey } from "./auth/install-key.ts";
import { serverConfig } from "./config.ts";

const SECRET = "4b6d8f0a2c4e6b8d0f1a3c5e7b9d1f3a5c7e9b0d2f4a6c8e0b1d3f5a7c9e1b3d";
const FILE = "/run/secrets/install-key";

function files(content: string | undefined): (path: string) => string {
  return (path) => {
    if (path !== FILE || content === undefined) {
      throw new Error(`ENOENT: no such file, open '${path}'`);
    }
    return content;
  };
}

const ENV = { NORTFOX_PUBLIC_ORIGIN: "https://nortfox.example", NORTFOX_SECRET_KEY_FILE: FILE };

/** The error that serverConfig throws with this environment and key file, after checking it never names the secret. */
function failure(env: Readonly<Record<string, string | undefined>>, content: string | undefined): string {
  try {
    serverConfig(env, files(content));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain(SECRET.slice(0, 16));
    return message;
  }
  throw new Error("The server would start.");
}

describe("the server's settings", () => {
  it("are the public origin and the install secret", () => {
    const config = serverConfig(ENV, files(`7\n${SECRET}\n`));
    expect(config.publicOrigin).toBe("https://nortfox.example");
    expect(config.installKey.keyId).toBe(7);
    expect(config.installKey.key("totp-secret v1")).toEqual(new InstallKey(7, Buffer.from(SECRET, "hex")).key("totp-secret v1"));
  });

  it("take a key file with Windows line ends, without a last line end, and with the secret in capitals", () => {
    expect(serverConfig(ENV, files(`7\r\n${SECRET}\r\n`)).installKey.keyId).toBe(7);
    expect(serverConfig(ENV, files(`255\n${SECRET}`)).installKey.keyId).toBe(255);
    expect(serverConfig(ENV, files(`1\n${SECRET.toUpperCase()}${SECRET}\n`)).installKey.keyId).toBe(1);
  });

  it("read the key file from the disk, by default", () => {
    const folder = mkdtempSync(join(tmpdir(), "nortfox-config-"));
    try {
      const path = join(folder, "install-key");
      writeFileSync(path, `12\n${SECRET}\n`, { mode: 0o600 });
      expect(serverConfig({ ...ENV, NORTFOX_SECRET_KEY_FILE: path }).installKey.keyId).toBe(12);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it.each([
    ["http://localhost:5173"],
    ["http://127.0.0.1:4100"],
    ["http://[::1]:8080"],
    ["https://nortfox.example:8443"],
    ["https://bokforing.foretag.example"],
  ])("take the public origin %s", (origin) => {
    expect(serverConfig({ ...ENV, NORTFOX_PUBLIC_ORIGIN: origin }, files(`7\n${SECRET}\n`)).publicOrigin).toBe(origin);
  });
});

describe("the server does not start", () => {
  it("without a public origin", () => {
    const message = "NORTFOX_PUBLIC_ORIGIN is not set. Set it to the origin people open NortFox at, such as https://nortfox.example.";
    expect(failure({ NORTFOX_SECRET_KEY_FILE: FILE }, `7\n${SECRET}\n`)).toBe(message);
    expect(failure({ ...ENV, NORTFOX_PUBLIC_ORIGIN: "" }, `7\n${SECRET}\n`)).toBe(message);
  });

  it.each(["https://nortfox.example/", "https://nortfox.example/app", "https://NortFox.example", "https://nortfox.example:443", "nortfox.example", "null", "ftp://nortfox.example"])(
    "with the public origin %j, which is not an origin as a browser sends it",
    (origin) => {
      expect(failure({ ...ENV, NORTFOX_PUBLIC_ORIGIN: origin }, `7\n${SECRET}\n`)).toBe(
        `NORTFOX_PUBLIC_ORIGIN must be an origin as a browser sends it, such as https://nortfox.example, with no path; "${origin}" is not.`,
      );
    },
  );

  it.each(["http://nortfox.example", "http://bokforing.example:4100", "http://localhost.example"])("with the public origin %s, over http on a host that is not this one", (origin) => {
    expect(failure({ ...ENV, NORTFOX_PUBLIC_ORIGIN: origin }, `7\n${SECRET}\n`)).toBe(
      `NORTFOX_PUBLIC_ORIGIN must use https, since a browser keeps NortFox's Secure cookies only over https; "${origin}" does not. ` +
        "Only localhost, 127.0.0.1 and [::1] may use http, while developing.",
    );
  });

  it("without an install secret", () => {
    const message = "NORTFOX_SECRET_KEY_FILE is not set. Set it to the file of the install secret, as deploy/README.md says.";
    expect(failure({ NORTFOX_PUBLIC_ORIGIN: "https://nortfox.example" }, `7\n${SECRET}\n`)).toBe(message);
    expect(failure({ ...ENV, NORTFOX_SECRET_KEY_FILE: "" }, `7\n${SECRET}\n`)).toBe(message);
  });

  it("with a key file that cannot be read", () => {
    expect(failure(ENV, undefined)).toBe(`The install secret's file ${FILE} cannot be read.`);
  });

  it.each([
    ["no key id", `${SECRET}\n`],
    ["the secret on the key id's line", `7 ${SECRET}\n`],
    ["the key id 0", `0\n${SECRET}\n`],
    ["the key id 256", `256\n${SECRET}\n`],
    ["the key id 07", `07\n${SECRET}\n`],
    ["the key id 1.5", `1.5\n${SECRET}\n`],
    ["the key id -1", `-1\n${SECRET}\n`],
    ["a key id with a space", ` 7\n${SECRET}\n`],
    ["an empty file", ""],
  ])("with %s", (_case, content) => {
    expect(failure(ENV, content)).toBe(`The first line of the install secret's file ${FILE} must be its key id, a whole number from 1 to 255.`);
  });

  it.each([
    ["a short one: 31 bytes", `7\n${SECRET.slice(2)}\n`],
    ["an odd number of digits", `7\n${SECRET}a\n`],
    ["a character that is not hexadecimal", `7\n${SECRET.slice(1)}g\n`],
    ["a space in it", `7\n${SECRET.slice(0, 32)} ${SECRET.slice(32)}\n`],
    ["no second line", "7\n"],
    ["an empty second line", "7\n\n"],
  ])("with %s", (_case, content) => {
    expect(failure(ENV, content)).toBe(
      `The second line of the install secret's file ${FILE} must be the secret: at least 32 random bytes as 64 or more hexadecimal digits, an even number of them.`,
    );
  });

  it("with a key file of more than two lines", () => {
    expect(failure(ENV, `7\n${SECRET}\n${SECRET}\n`)).toBe(`The install secret's file ${FILE} must hold two lines: the key id, and the secret.`);
    expect(failure(ENV, `7\n${SECRET}\n\n`)).toBe(`The install secret's file ${FILE} must hold two lines: the key id, and the secret.`);
  });
});
