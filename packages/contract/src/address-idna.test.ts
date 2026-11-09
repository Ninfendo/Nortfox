// SPDX-License-Identifier: AGPL-3.0-only

// An A-label (xn--) is refused by the address check's own rule, not by how
// the IDNA library of a given Node release reads it. An older release maps
// an A-label whose Punycode does not decode to nothing, and a newer one
// (Node 24.22, ada 4) hands it back as it is. Here node:url reads such a
// label as the newer one does, so the rule must hold on every Node 24.

import type * as NodeUrl from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:url", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeUrl>();
  /** Whether a domain holds an A-label. */
  const aLabel = (domain: string): boolean => /(?:^|\.)xn--/i.test(domain);
  return {
    ...actual,
    domainToASCII: (domain: string): string => {
      const ascii = actual.domainToASCII(domain);
      return ascii === "" && aLabel(domain) ? domain.toLowerCase() : ascii;
    },
    domainToUnicode: (domain: string): string => {
      const unicode = actual.domainToUnicode(domain);
      return unicode === "" && aLabel(domain) ? domain : unicode;
    },
  };
});

const { emailAddress, writtenAsMailed } = await import("./address.ts");

describe("an A-label, where the IDNA mapping hands one that does not decode back as it is", () => {
  it.each(["xn--zz.example", "xn--a", "x.xn--a-ecp.example", "XN--ZZ.example"])("is refused in %j", (domain) => {
    expect(writtenAsMailed(domain)).toBe(false);
    expect(emailAddress().safeParse(`anna.lind@${domain}`).success).toBe(false);
  });

  it("leaves the domains that are written as they are mailed alone", () => {
    expect(writtenAsMailed("example.com")).toBe(true);
    expect(writtenAsMailed("m\u{00FC}nchen.example")).toBe(true);
    expect(writtenAsMailed("axn--b.example")).toBe(true);
  });
});
