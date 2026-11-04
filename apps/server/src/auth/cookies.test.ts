// SPDX-License-Identifier: AGPL-3.0-only

// The three cookies of a browser's sign-in, as Set-Cookie headers (RFC 6265
// and the __Host- prefix of its successor). Each is HttpOnly and Secure, with
// Path=/ and no Domain, so a browser takes it only from this host over
// HTTPS. The session cookie and the device cookie are SameSite=Strict, so no
// other site's request carries them. The login cookie is SameSite=Lax, since
// an identity provider brings the browser back with a top-level GET.

import { describe, expect, it } from "vitest";
import { DEVICE_COOKIE, LOGIN_COOKIE, SESSION_COOKIE, setCookieHeader, type CookieEffect } from "./cookies.ts";

describe("the cookies", () => {
  it("have the __Host- prefix", () => {
    expect([SESSION_COOKIE, DEVICE_COOKIE, LOGIN_COOKIE]).toEqual(["__Host-nortfox-session", "__Host-nortfox-device", "__Host-nortfox-login"]);
  });

  it.each([
    [{ kind: "set-session", token: "nfs_AbC-123_xyz" }, "__Host-nortfox-session=nfs_AbC-123_xyz; Path=/; Secure; HttpOnly; SameSite=Strict"],
    [{ kind: "clear-session" }, "__Host-nortfox-session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict"],
    [{ kind: "set-device", token: "nfd_AbC-123_xyz" }, "__Host-nortfox-device=nfd_AbC-123_xyz; Path=/; Max-Age=34560000; Secure; HttpOnly; SameSite=Strict"],
    [{ kind: "set-login", token: "nfl_AbC-123_xyz" }, "__Host-nortfox-login=nfl_AbC-123_xyz; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax"],
    [{ kind: "clear-login" }, "__Host-nortfox-login=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax"],
  ] as const satisfies readonly (readonly [CookieEffect, string])[])("writes %j as its Set-Cookie header", (effect, header) => {
    expect(setCookieHeader(effect)).toBe(header);
  });

  it("gives the session cookie no Max-Age, so it ends with the browser, and the device cookie the browsers' cap of 400 days", () => {
    expect(setCookieHeader({ kind: "set-session", token: "x" })).not.toContain("Max-Age");
    expect(34_560_000).toBe(400 * 24 * 60 * 60);
  });

  it.each(["", "two words", "semi;colon", "comma,here", 'quote"d', "new\nline", "x".repeat(513), "non-ascii-å"])(
    "refuses the value %j, which a cookie cannot carry as it is",
    (token) => {
      expect(() => setCookieHeader({ kind: "set-session", token })).toThrow("A cookie's value is 1 to 512 characters of letters, digits, - and _.");
      expect(() => setCookieHeader({ kind: "set-device", token })).toThrow("A cookie's value is 1 to 512 characters of letters, digits, - and _.");
      expect(() => setCookieHeader({ kind: "set-login", token })).toThrow("A cookie's value is 1 to 512 characters of letters, digits, - and _.");
    },
  );
});
