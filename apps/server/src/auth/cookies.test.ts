// SPDX-License-Identifier: AGPL-3.0-only

// The three cookies of a browser's sign-in, as Set-Cookie headers (RFC 6265
// and the __Host- prefix of its successor). Each is HttpOnly and Secure, with
// Path=/ and no Domain, so a browser takes it only from this host over
// HTTPS. The session cookie and the device cookie are SameSite=Strict, so no
// other site's request carries them. The login cookie is SameSite=Lax, since
// an identity provider brings the browser back with a top-level GET.

import { describe, expect, it } from "vitest";
import { DEVICE_COOKIE, LOGIN_COOKIE, SESSION_COOKIE, carriesCookie, cookieValues, readCookie, setCookieHeader, type CookieEffect } from "./cookies.ts";

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

describe("reading the cookies of a request", () => {
  const headers = (cookie?: string): Headers => new Headers(cookie === undefined ? {} : { cookie });

  it("finds a cookie by its exact name among the others, as a browser sends them", () => {
    const sent = headers("theme=dark; __Host-nortfox-session=nfs_one; __Host-nortfox-device=nfd_two");
    expect(cookieValues(sent, SESSION_COOKIE)).toEqual(["nfs_one"]);
    expect(cookieValues(sent, DEVICE_COOKIE)).toEqual(["nfd_two"]);
    expect(cookieValues(sent, LOGIN_COOKIE)).toEqual([]);
    expect(readCookie(sent, SESSION_COOKIE)).toBe("nfs_one");
    expect(carriesCookie(sent, SESSION_COOKIE)).toBe(true);
    expect(carriesCookie(sent, LOGIN_COOKIE)).toBe(false);
  });

  it("takes a header without spaces, with spaces around the parts, and with an empty part", () => {
    expect(cookieValues(headers("a=1;__Host-nortfox-session=x"), SESSION_COOKIE)).toEqual(["x"]);
    expect(cookieValues(headers("  __Host-nortfox-session = x ;  ; a=1"), SESSION_COOKIE)).toEqual(["x"]);
    expect(cookieValues(headers("__Host-nortfox-session"), SESSION_COOKIE)).toEqual([]);
    expect(cookieValues(headers("__Host-nortfox-session="), SESSION_COOKIE)).toEqual([""]);
  });

  it("finds no cookie in a request without a Cookie header, and none under a name that only looks the same", () => {
    expect(cookieValues(headers(), SESSION_COOKIE)).toEqual([]);
    expect(carriesCookie(headers(), SESSION_COOKIE)).toBe(false);
    for (const cookie of ["__host-nortfox-session=x", "__Host-nortfox-sessions=x", "nortfox-session=x", "x__Host-nortfox-session=x", "__Host-nortfox-session-old=x"]) {
      expect(carriesCookie(headers(cookie), SESSION_COOKIE)).toBe(false);
    }
  });

  it("reads a value only when the cookie is there once, in the form NortFox writes", () => {
    expect(readCookie(headers("__Host-nortfox-session=a; __Host-nortfox-session=b"), SESSION_COOKIE)).toBeUndefined();
    expect(carriesCookie(headers("__Host-nortfox-session=a; __Host-nortfox-session=b"), SESSION_COOKIE)).toBe(true);
    for (const value of ["", "two%20words", "quote\"d", "x".repeat(513), "å"]) {
      expect(readCookie(headers(`__Host-nortfox-session=${value}`), SESSION_COOKIE)).toBeUndefined();
    }
    expect(readCookie(headers(`__Host-nortfox-session=${"x".repeat(512)}`), SESSION_COOKIE)).toBe("x".repeat(512));
  });
});
