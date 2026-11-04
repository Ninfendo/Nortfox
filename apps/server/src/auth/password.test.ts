// SPDX-License-Identifier: AGPL-3.0-only

// Passwords (docs/decisions/0008-authentication.md): a new password is 12 to
// 1024 characters, counted in code points after NFC, and hashed in that
// form with Argon2id through Node's own crypto.argon2, at OWASP's first
// Argon2id setting, and kept as a PHC string. A check runs against the
// stored string, or against a fixed dummy when there is none, so the time
// does not tell an unknown person from a wrong password. At most as many
// hashes run at once as the host has cores, with a queue of the same length;
// past that, the hasher refuses with server-busy.
//
// Most tests here use a small cost, so they run fast. The production cost
// has its own test, which pins it.

import type * as NodeCrypto from "node:crypto";
import type { Argon2Parameters } from "node:crypto";
import { availableParallelism } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  HASH_BYTES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MAX_MARK_RUN,
  PASSWORD_MAX_UNITS,
  PASSWORD_MIN_LENGTH,
  PRODUCTION_PASSWORD_COST,
  PasswordHasher,
  SALT_BYTES,
  ServerBusy,
  newPasswordIssue,
  nodeArgon2id,
  passwordLength,
  phcString,
  type Argon2id,
  type NewPassword,
} from "./password.ts";

const { timingSafeEqual } = vi.hoisted(() => ({ timingSafeEqual: { calls: [] as [Uint8Array, Uint8Array][] } }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView): boolean => {
      timingSafeEqual.calls.push([new Uint8Array(a.buffer, a.byteOffset, a.byteLength), new Uint8Array(b.buffer, b.byteOffset, b.byteLength)]);
      return actual.timingSafeEqual(a, b);
    },
  };
});

/** A small cost, for the tests that only need some password. Argon2id's least memory is 8 KiB per lane. */
const SMALL = { memory: 64, passes: 1, parallelism: 1 } as const;

/** The form of the stored hash, as the database's check password_credentials_argon2id has it. */
const DATABASE_FORM = /^\$argon2id\$v=19\$m=[0-9]+,t=[0-9]+,p=[0-9]+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

/** A hasher at the small cost, whose Argon2id calls the test sees. */
function watched(options: { readonly concurrency?: number } = {}): { hasher: PasswordHasher; calls: Argon2Parameters[] } {
  const calls: Argon2Parameters[] = [];
  const argon2id: Argon2id = (parameters) => {
    calls.push(parameters);
    return nodeArgon2id(parameters);
  };
  return { hasher: new PasswordHasher({ cost: SMALL, argon2id, ...options }), calls };
}

function hashOf(result: NewPassword): string {
  if (!result.ok) {
    throw new Error(`The password was refused: ${result.issue.code}.`);
  }
  return result.hash;
}

describe("Argon2id", () => {
  it("gives RFC 9106's Argon2id test vector through the wrapper", async () => {
    const tag = await nodeArgon2id({
      message: Buffer.alloc(32, 0x01),
      nonce: Buffer.alloc(16, 0x02),
      secret: Buffer.alloc(8, 0x03),
      associatedData: Buffer.alloc(12, 0x04),
      parallelism: 4,
      tagLength: 32,
      memory: 32,
      passes: 3,
    });
    expect(tag.toString("hex")).toBe("0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659");
  });

  it("rejects what Argon2id refuses, such as less memory than its lanes need", async () => {
    await expect(nodeArgon2id({ message: Buffer.from("x"), nonce: Buffer.alloc(16), parallelism: 1, tagLength: 32, memory: 1, passes: 1 })).rejects.toThrow();
  });
});

describe("the production cost", () => {
  it("is OWASP's first Argon2id setting: 19 MiB, 2 passes, 1 lane, with a 16-byte salt and a 32-byte hash", () => {
    expect(PRODUCTION_PASSWORD_COST).toEqual({ memory: 19456, passes: 2, parallelism: 1 });
    expect([SALT_BYTES, HASH_BYTES]).toEqual([16, 32]);
    expect(new PasswordHasher().cost).toEqual(PRODUCTION_PASSWORD_COST);
  });

  it("keeps a password as a PHC string with its parameters, which the database's check takes", async () => {
    const hasher = new PasswordHasher();
    const stored = hashOf(await hasher.hash("korrekt-häst-batteri", "/password"));
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(stored).toMatch(DATABASE_FORM);
    expect(await hasher.verify("korrekt-häst-batteri", stored)).toBe(true);
    expect(await hasher.verify("korrekt-häst-batteri!", stored)).toBe(false);
  });

  it("runs at most as many hashes at once as the host has cores, by default", () => {
    expect(new PasswordHasher().concurrency).toBe(availableParallelism());
  });
});

describe("a new password", () => {
  it("refuses 11 characters and takes 12", async () => {
    const { hasher } = watched();
    expect(await hasher.hash("elva-tecken", "/password")).toEqual({
      ok: false,
      issue: { code: "too-short", detail: "The field /password must be at least 12 characters long.", pointer: "/password", data: { minimum: 12 } },
    });
    const twelve = await hasher.hash("tolv-tecken!", "/password");
    expect(twelve.ok).toBe(true);
    expect(await hasher.verify("tolv-tecken!", hashOf(twelve))).toBe(true);
  });

  it("refuses more than 1024 characters and takes 1024", async () => {
    const { hasher } = watched();
    expect([PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]).toEqual([12, 1024]);
    expect(await hasher.hash("a".repeat(1025), "/newPassword")).toEqual({
      ok: false,
      issue: { code: "too-long", detail: "The field /newPassword must be at most 1024 characters long.", pointer: "/newPassword", data: { maximum: 1024 } },
    });
    expect((await hasher.hash("a".repeat(1024), "/newPassword")).ok).toBe(true);
  });

  it("counts code points after NFC, not UTF-16 units and not combining marks", () => {
    // e and a combining acute accent: two code points that NFC makes one, é.
    expect(passwordLength("é".repeat(12))).toBe(12);
    // An emoji is one code point in two UTF-16 units.
    expect(passwordLength("😀".repeat(11))).toBe(11);
    expect(newPasswordIssue("é".repeat(11), "/password")?.code).toBe("too-short");
    expect(newPasswordIssue("😀".repeat(11), "/password")?.code).toBe("too-short");
    expect(newPasswordIssue("é".repeat(12), "/password")).toBeUndefined();
    expect(newPasswordIssue("😀".repeat(12), "/password")).toBeUndefined();
    expect(newPasswordIssue("é".repeat(1024), "/password")).toBeUndefined();
  });

  it("never normalises a password of more UTF-16 units than six to each of 1024 characters, and counts it as too long", async () => {
    // A long run of combining marks of two classes in turn makes NFC take quadratic time, so such a password never reaches normalize().
    const below = String.fromCodePoint(0x316);
    const above = String.fromCodePoint(0x301);
    const attack = `a${`${below}${above}`.repeat(32 * 1024)}`;
    expect(PASSWORD_MAX_UNITS).toBe(6 * PASSWORD_MAX_LENGTH);
    const { hasher, calls } = watched();
    const normalize = vi.spyOn(String.prototype, "normalize");
    try {
      expect(passwordLength(attack)).toBe(Number.POSITIVE_INFINITY);
      expect(newPasswordIssue(attack, "/password")?.code).toBe("too-long");
      expect(await hasher.hash(attack, "/password")).toMatchObject({ ok: false, issue: { code: "too-long" } });
      expect(await hasher.verify(attack, undefined)).toBe(false);
      expect(normalize.mock.contexts.filter((text) => String(text).length > PASSWORD_MAX_UNITS)).toEqual([]);
    } finally {
      normalize.mockRestore();
    }
    // It was checked as the empty password, against the dummy.
    expect(calls.map((call) => Buffer.from(call.message as Uint8Array).length)).toEqual([0]);
    // NFC makes at most six units one character, such as U+16126 written as its three vowel signs. A starter and ten of
    // them, which is 30 marks in a row, are 11 characters in 61 units: 93 such groups are 1023 characters in 5673 units.
    const sixToOne = String.fromCodePoint(0x16126);
    expect(sixToOne.normalize("NFD")).toHaveLength(6);
    const group = `x${sixToOne.repeat(10)}`;
    const decomposed = group.normalize("NFD").repeat(93);
    expect(decomposed).toHaveLength(5673);
    expect(passwordLength(decomposed)).toBe(1023);
    expect(newPasswordIssue(decomposed, "/password")).toBeUndefined();
    expect(passwordLength(`${decomposed}${"y".repeat(PASSWORD_MAX_UNITS - decomposed.length + 1)}`)).toBe(Number.POSITIVE_INFINITY);
  });

  it("takes either way of writing a character of six units as one password", async () => {
    const { hasher } = watched();
    const composed = `x${String.fromCodePoint(0x16126).repeat(10)}`.repeat(93);
    const decomposed = composed.normalize("NFD");
    expect(decomposed.length).toBeGreaterThan(4 * PASSWORD_MAX_LENGTH);
    const stored = hashOf(await hasher.hash(composed, "/password"));
    expect(await hasher.verify(decomposed, stored)).toBe(true);
    expect(await hasher.verify(composed, hashOf(await hasher.hash(decomposed, "/password")))).toBe(true);
  });

  it("bounds a password's units by the longest canonical decomposition of any character, in this Node's Unicode", () => {
    // A later Unicode with a longer decomposition fails here, so the bound grows with it.
    let longest = 0;
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint < 0xd800 || codePoint > 0xdfff) {
        longest = Math.max(longest, String.fromCodePoint(codePoint).normalize("NFD").length);
      }
    }
    expect(longest).toBe(6);
    expect(longest * PASSWORD_MAX_LENGTH).toBeLessThanOrEqual(PASSWORD_MAX_UNITS);
  });

  it("counts every character whose decomposition starts with a mark that NFC reorders as a mark, so the run of marks bounds the reordering", () => {
    // U+0334 has the lowest combining class, 1, and U+0345 the highest, 240: a mark of any other class moves past one of them.
    const reorders = (mark: string): boolean => `a${mark}\u0334`.normalize("NFD") !== `a${mark}\u0334` || `a\u0345${mark}`.normalize("NFD") !== `a\u0345${mark}`;
    const unmarked: number[] = [];
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
        continue;
      }
      const character = String.fromCodePoint(codePoint);
      const first = String.fromCodePoint(character.normalize("NFD").codePointAt(0) ?? 0);
      if (reorders(first) && !/^\p{M}$/u.test(character)) {
        unmarked.push(codePoint);
      }
    }
    expect(reorders("\u0301")).toBe(true);
    expect(reorders("a")).toBe(false);
    expect(unmarked).toEqual([]);
  });

  it("refuses a run of more than 30 combining marks before it normalises it, and never takes one as right", async () => {
    const pointer = "/password";
    expect(PASSWORD_MAX_MARK_RUN).toBe(30);
    const thirty = `a${"\u0301".repeat(30)}bcdefghijkl`;
    const thirtyOne = `a${"\u0301".repeat(31)}bcdefghijkl`;
    expect(newPasswordIssue(thirty, pointer)).toBeUndefined();
    expect(newPasswordIssue(thirtyOne, pointer)).toEqual({
      code: "invalid-value",
      detail: "The field /password holds more than 30 combining marks in a row.",
      pointer,
      data: {},
    });
    const { hasher, calls } = watched();
    const stored = hashOf(await hasher.hash(thirty, pointer));
    // The worst case inside the bound: marks of two classes in turn, in 6143 units.
    const attack = `a${"\u0316\u0301".repeat(3071)}`;
    calls.length = 0;
    const normalize = vi.spyOn(String.prototype, "normalize");
    try {
      const started = performance.now();
      expect(newPasswordIssue(attack, pointer)?.code).toBe("invalid-value");
      expect(await hasher.verify(attack, stored)).toBe(false);
      expect(await hasher.verify(thirtyOne, stored)).toBe(false);
      expect(performance.now() - started).toBeLessThan(500);
      expect(normalize.mock.contexts.filter((text) => /\p{M}{31}/u.test(String(text)))).toEqual([]);
    } finally {
      normalize.mockRestore();
    }
    // Each was checked as the empty password, against the dummy.
    expect(calls.map((call) => [Buffer.from(call.message as Uint8Array).length, Buffer.from(call.nonce as Uint8Array).equals(Buffer.alloc(SALT_BYTES))])).toEqual([
      [0, true],
      [0, true],
    ]);
    expect(await hasher.verify(thirty, stored)).toBe(true);
  });

  it("refuses a password with a lone surrogate, and never takes one as right, so no two such passwords are one", async () => {
    const pointer = "/password";
    const lone = "Lösenordet-ok-\uD800\uD801\uD802";
    expect(newPasswordIssue(lone, pointer)).toEqual({
      code: "invalid-value",
      detail: "The field /password holds a lone surrogate, which is not a character.",
      pointer,
      data: {},
    });
    const { hasher, calls } = watched();
    expect(await hasher.hash(lone, pointer)).toMatchObject({ ok: false, issue: { code: "invalid-value" } });
    // A JSON body can carry a lone surrogate as an escape, and UTF-8 would write each one as U+FFFD.
    const replaced = "Lösenordet-ok-\uFFFD\uFFFD\uFFFD";
    const stored = hashOf(await hasher.hash(replaced, pointer));
    calls.length = 0;
    expect(await hasher.verify(lone, stored)).toBe(false);
    expect(await hasher.verify("Lösenordet-ok-\uDC00\uDBFF\uD83D", stored)).toBe(false);
    expect(calls.map((call) => [Buffer.from(call.message as Uint8Array).length, Buffer.from(call.nonce as Uint8Array).equals(Buffer.alloc(SALT_BYTES))])).toEqual([
      [0, true],
      [0, true],
    ]);
    expect(await hasher.verify(replaced, stored)).toBe(true);
  });

  it("answers a password of combining marks quickly, however long it is", async () => {
    const attack = `a${`${String.fromCodePoint(0x316)}${String.fromCodePoint(0x301)}`.repeat(32 * 1024)}`;
    const { hasher } = watched();
    const started = performance.now();
    expect(await hasher.verify(attack, undefined)).toBe(false);
    expect(newPasswordIssue(attack, "/password")?.code).toBe("too-long");
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("is hashed in its NFC form, so either way of writing é gives the same password", async () => {
    const { hasher, calls } = watched();
    const decomposed = "Skrivévbord-12";
    const composed = "Skrivévbord-12";
    const stored = hashOf(await hasher.hash(decomposed, "/password"));
    expect(Buffer.from(calls[0]?.message as Uint8Array).toString("utf8")).toBe(composed);
    expect(await hasher.verify(composed, stored)).toBe(true);
    expect(await hasher.verify(decomposed, stored)).toBe(true);
  });

  it("gives a refusal that never holds the password", async () => {
    const { hasher, calls } = watched();
    const result = await hasher.hash("hemligt-ord", "/password");
    expect(JSON.stringify(result)).not.toContain("hemligt");
    expect(calls).toEqual([]);
  });

  it("gets a fresh salt each time, so the same password gives two hashes", async () => {
    const { hasher, calls } = watched();
    const first = hashOf(await hasher.hash("samma-lösenord", "/password"));
    const second = hashOf(await hasher.hash("samma-lösenord", "/password"));
    expect(first).not.toBe(second);
    expect(calls.map((call) => [Buffer.from(call.nonce as Uint8Array).length, call.tagLength, call.memory, call.passes, call.parallelism])).toEqual([
      [16, 32, 64, 1, 1],
      [16, 32, 64, 1, 1],
    ]);
  });
});

describe("checking a password", () => {
  it("compares the hashes with timingSafeEqual", async () => {
    const { hasher } = watched();
    const stored = hashOf(await hasher.hash("jämför-i-konstant-tid", "/password"));
    timingSafeEqual.calls.length = 0;
    expect(await hasher.verify("jämför-i-konstant-tid", stored)).toBe(true);
    expect(await hasher.verify("jämför-i-annan-tid", stored)).toBe(false);
    expect(timingSafeEqual.calls.map(([a, b]) => [a.length, b.length])).toEqual([
      [32, 32],
      [32, 32],
    ]);
  });

  it("checks a stored hash with its own parameters, made at another cost", async () => {
    const older = new PasswordHasher({ cost: { memory: 128, passes: 2, parallelism: 2 } });
    const stored = hashOf(await older.hash("ett-äldre-lösenord", "/password"));
    const { hasher, calls } = watched();
    expect(await hasher.verify("ett-äldre-lösenord", stored)).toBe(true);
    expect(calls.map((call) => [call.memory, call.passes, call.parallelism])).toEqual([[128, 2, 2]]);
  });

  it("runs against the dummy hash, at the hasher's own cost, when there is no stored hash, and gives false", async () => {
    const { hasher, calls } = watched();
    expect(await hasher.verify("vilket-lösenord-som-helst", undefined)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls.map((call) => [Buffer.from(call.nonce as Uint8Array).length, call.tagLength, call.memory, call.passes, call.parallelism])).toEqual([[16, 32, 64, 1, 1]]);
    expect(Buffer.from(calls[0]?.message as Uint8Array).toString("utf8")).toBe("vilket-lösenord-som-helst");
  });

  it("checks a password longer than any new one can be against the dummy, without hashing it, and gives false", async () => {
    const { hasher, calls } = watched();
    const long = "å".repeat(PASSWORD_MAX_LENGTH + 1);
    // Even a stored hash of that password, made elsewhere, is not checked against it.
    const stored = phcString(SMALL, Buffer.alloc(SALT_BYTES, 1), await nodeArgon2id({ message: Buffer.from(long), nonce: Buffer.alloc(SALT_BYTES, 1), ...SMALL, tagLength: HASH_BYTES }));
    expect(await hasher.verify(long, stored)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(Buffer.from(calls[0]?.message as Uint8Array).length).toBe(0);
    expect(Buffer.from(calls[0]?.nonce as Uint8Array)).toEqual(Buffer.alloc(SALT_BYTES));
    // 1024 characters is checked as it is.
    const longest = "å".repeat(PASSWORD_MAX_LENGTH);
    expect(await hasher.verify(longest, hashOf(await hasher.hash(longest, "/password")))).toBe(true);
  });

  it("gives false for the dummy hash even when the password gives its hash", async () => {
    const zeros: Argon2id = () => Promise.resolve(Buffer.alloc(HASH_BYTES));
    const hasher = new PasswordHasher({ cost: SMALL, argon2id: zeros });
    expect(await hasher.verify("vad-som-helst-här", undefined)).toBe(false);
  });

  it("throws on a stored value that is not its PHC form, which the database never holds", async () => {
    const { hasher } = watched();
    for (const stored of ["", "$argon2i$v=19$m=64,t=1,p=1$AAAA$AAAA", "$argon2id$v=16$m=64,t=1,p=1$AAAA$AAAA", "$argon2id$v=19$m=64,t=1$AAAA$AAAA"]) {
      await expect(hasher.verify("ett-lösenord-här", stored)).rejects.toThrow("The stored password hash is not an Argon2id PHC string.");
    }
  });

  it("writes the PHC string as Argon2's reference does: base64 without padding", () => {
    expect(phcString({ memory: 19456, passes: 2, parallelism: 1 }, Buffer.alloc(16, 0xff), Buffer.alloc(32, 0))).toBe(
      `$argon2id$v=19$m=19456,t=2,p=1$${"/".repeat(21)}w$${"A".repeat(43)}`,
    );
  });
});

describe("the hashes at once", () => {
  /** An Argon2id whose calls wait until the test lets each one go, or opens it for all. */
  function held(): { argon2id: Argon2id; started: number; release: () => void; open: () => void } {
    const waiting: (() => void)[] = [];
    let opened = false;
    const state = {
      started: 0,
      argon2id: (() => {
        state.started += 1;
        if (opened) {
          return Promise.resolve(Buffer.alloc(HASH_BYTES));
        }
        return new Promise<Buffer>((resolve) => {
          waiting.push(() => {
            resolve(Buffer.alloc(HASH_BYTES));
          });
        });
      }) as Argon2id,
      release: () => {
        waiting.shift()?.();
      },
      open: () => {
        opened = true;
        for (const go of waiting.splice(0)) {
          go();
        }
      },
    };
    return state;
  }

  it("queue as many as run, and past that the hasher refuses with server-busy, Retry-After 1 second", async () => {
    const argon = held();
    const hasher = new PasswordHasher({ cost: SMALL, argon2id: argon.argon2id, concurrency: 2 });
    const running = [hasher.verify("ett-lösenord-här", undefined), hasher.verify("ett-lösenord-här", undefined)];
    const queued = [hasher.verify("ett-lösenord-här", undefined), hasher.hash("ett-lösenord-här", "/password")];
    const refused = hasher.verify("ett-lösenord-här", undefined);
    await expect(refused).rejects.toBeInstanceOf(ServerBusy);
    await expect(refused).rejects.toMatchObject({ code: "server-busy", retryAfterSeconds: 1 });
    await expect(hasher.hash("ett-lösenord-här", "/password")).rejects.toBeInstanceOf(ServerBusy);
    expect(argon.started).toBe(2);

    argon.release();
    await running[0];
    // The first in the queue starts as one ends, and a new one may queue again.
    await vi.waitFor(() => {
      expect(argon.started).toBe(3);
    });
    const later = hasher.verify("ett-lösenord-här", undefined);
    argon.open();
    expect(await Promise.all([...running, ...queued, later])).toEqual([false, false, false, { ok: true, hash: expect.stringMatching(DATABASE_FORM) as unknown }, false]);
    expect(argon.started).toBe(5);
  });

  it("lets a hash go when its Argon2id fails, so the next one runs", async () => {
    let fail = true;
    const argon2id: Argon2id = (parameters) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error("Argon2id failed."));
      }
      return nodeArgon2id(parameters);
    };
    const hasher = new PasswordHasher({ cost: SMALL, argon2id, concurrency: 1 });
    await expect(hasher.verify("ett-lösenord-här", undefined)).rejects.toThrow("Argon2id failed.");
    expect((await hasher.hash("ett-lösenord-här", "/password")).ok).toBe(true);
  });

  it("refuses a concurrency that is not a whole number of at least 1", () => {
    for (const concurrency of [0, -1, 1.5, Number.NaN]) {
      expect(() => new PasswordHasher({ concurrency })).toThrow("The hashes at once must be a whole number of at least 1.");
    }
  });
});
