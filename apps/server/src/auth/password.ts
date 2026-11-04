// SPDX-License-Identifier: AGPL-3.0-only

// Passwords (docs/decisions/0008-authentication.md). Every operation that
// sets a password, and every check of one, goes through this one wrapper.
//
// - A new password is 12 to 1024 characters, counted in code points after
//   NFC normalisation, and hashed in that form. So é written as one code
//   point or as e and a combining accent is the same password, and an emoji
//   counts once. The upper bound is NortFox's own: no request makes the
//   server hash a megabyte.
// - Argon2id through Node's own crypto.argon2, at OWASP's first Argon2id
//   setting: 19 MiB (19456 KiB), 2 passes, 1 lane, a 16-byte salt and a
//   32-byte hash. It is kept as a PHC string,
//   $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>, in base64 without
//   padding, and a check uses the parameters the string holds. The hashes
//   are compared with timingSafeEqual.
// - With no stored hash, as for an unknown identifier or an identity without
//   a password, the check runs against a fixed dummy string at the hasher's
//   own cost, and gives false. So the time does not tell the cases apart.
// - At most as many hashes run at once as the host has cores, with a queue
//   of the same length. 19 MiB each would otherwise let a few hundred
//   requests take gigabytes. When both are full, the hasher refuses with
//   ServerBusy, which the API answers with 503 server-busy and
//   Retry-After: 1.
//
// The tests that only need some password pass a small cost. The production
// cost has its own test.

import { argon2, randomBytes, timingSafeEqual, type Argon2Parameters } from "node:crypto";
import { availableParallelism } from "node:os";
import { promisify } from "node:util";
import type { FieldIssue } from "@nortfox/contract";

/** What a hash costs: Argon2id's memory in KiB, its passes and its lanes. */
export interface PasswordCost {
  readonly memory: number;
  readonly passes: number;
  readonly parallelism: number;
}

/** OWASP's first Argon2id setting. */
export const PRODUCTION_PASSWORD_COST: PasswordCost = { memory: 19456, passes: 2, parallelism: 1 };

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;
export const SALT_BYTES = 16;
export const HASH_BYTES = 32;

/** Argon2id with Node's parameters. */
export type Argon2id = (parameters: Argon2Parameters) => Promise<Buffer>;

const argon2Async = promisify(argon2);

/** Node's own Argon2id, which runs off the main thread. */
export const nodeArgon2id: Argon2id = (parameters) => argon2Async("argon2id", parameters);

/** The hasher runs as many hashes as it may, and its queue is full. */
export class ServerBusy extends Error {
  readonly code = "server-busy";
  readonly retryAfterSeconds = 1;

  constructor() {
    super("The server runs as many password hashes as it can at once, and its queue is full.");
    this.name = "ServerBusy";
  }
}

/** A password's length: its code points after NFC normalisation. */
export function passwordLength(password: string): number {
  // A string's iterator gives its code points, which is what the rule counts.
  return Array.from(password.normalize("NFC")).length;
}

/** What is wrong with a new password, as a field problem at `pointer`; undefined when nothing is. It never holds the password. */
export function newPasswordIssue(password: string, pointer: string): FieldIssue | undefined {
  const length = passwordLength(password);
  if (length < PASSWORD_MIN_LENGTH) {
    return {
      code: "too-short",
      detail: `The field ${pointer} must be at least ${String(PASSWORD_MIN_LENGTH)} characters long.`,
      pointer,
      data: { minimum: PASSWORD_MIN_LENGTH },
    };
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return {
      code: "too-long",
      detail: `The field ${pointer} must be at most ${String(PASSWORD_MAX_LENGTH)} characters long.`,
      pointer,
      data: { maximum: PASSWORD_MAX_LENGTH },
    };
  }
  return undefined;
}

/** Base64 without its padding, as the PHC string format writes it. */
function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/=+$/, "");
}

/** The PHC string of an Argon2id hash. */
export function phcString(cost: PasswordCost, salt: Uint8Array, hash: Uint8Array): string {
  return `$argon2id$v=19$m=${String(cost.memory)},t=${String(cost.passes)},p=${String(cost.parallelism)}$${b64(salt)}$${b64(hash)}`;
}

/** A PHC string of Argon2id, version 19, as the database's check password_credentials_argon2id takes it. */
const PHC = /^\$argon2id\$v=19\$m=([0-9]+),t=([0-9]+),p=([0-9]+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

interface StoredHash {
  readonly cost: PasswordCost;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

function parsePhc(stored: string): StoredHash {
  const parts = PHC.exec(stored);
  if (parts === null) {
    throw new Error("The stored password hash is not an Argon2id PHC string.");
  }
  const [, memory, passes, parallelism, salt, hash] = parts as unknown as [string, string, string, string, string, string];
  return {
    cost: { memory: Number(memory), passes: Number(passes), parallelism: Number(parallelism) },
    salt: Buffer.from(salt, "base64"),
    hash: Buffer.from(hash, "base64"),
  };
}

/** Runs at most `limit` works at once, with a queue of `limit`; past that, refuses with ServerBusy. */
class Gate {
  readonly #limit: number;
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#running < this.#limit) {
      this.#running += 1;
    } else if (this.#waiting.length < this.#limit) {
      // The work that ends next hands its place to this one.
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    } else {
      throw new ServerBusy();
    }
    try {
      return await work();
    } finally {
      const next = this.#waiting.shift();
      if (next === undefined) {
        this.#running -= 1;
      } else {
        next();
      }
    }
  }
}

export interface PasswordHasherOptions {
  /** By default the production cost. */
  readonly cost?: PasswordCost;
  /** By default Node's own. */
  readonly argon2id?: Argon2id;
  /** The hashes that run at once, and the length of the queue. By default the host's cores. */
  readonly concurrency?: number;
}

/** A new password's hash, or what is wrong with the password. */
export type NewPassword = { readonly ok: true; readonly hash: string } | { readonly ok: false; readonly issue: FieldIssue };

/** The one wrapper of passwords: it checks a new one, hashes it, and checks a password against a stored hash. */
export class PasswordHasher {
  readonly cost: PasswordCost;
  readonly concurrency: number;
  readonly #argon2id: Argon2id;
  readonly #gate: Gate;
  /** The PHC string a check runs against when there is no stored hash: the hasher's cost, a zero salt and a zero hash. */
  readonly #dummy: string;

  constructor(options: PasswordHasherOptions = {}) {
    const concurrency = options.concurrency ?? availableParallelism();
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("The hashes at once must be a whole number of at least 1.");
    }
    this.cost = options.cost ?? PRODUCTION_PASSWORD_COST;
    this.concurrency = concurrency;
    this.#argon2id = options.argon2id ?? nodeArgon2id;
    this.#gate = new Gate(concurrency);
    this.#dummy = phcString(this.cost, Buffer.alloc(SALT_BYTES), Buffer.alloc(HASH_BYTES));
  }

  /** The hash of a new password, or the field problem at `pointer` when it is too short or too long. */
  async hash(password: string, pointer: string): Promise<NewPassword> {
    const issue = newPasswordIssue(password, pointer);
    if (issue !== undefined) {
      return { ok: false, issue };
    }
    const salt = randomBytes(SALT_BYTES);
    const hash = await this.#derive(password, this.cost, salt, HASH_BYTES);
    return { ok: true, hash: phcString(this.cost, salt, hash) };
  }

  /** Whether `password` is the one that `stored` holds. With no stored hash, it runs against the dummy and gives false. */
  async verify(password: string, stored: string | undefined): Promise<boolean> {
    const known = parsePhc(stored ?? this.#dummy);
    const derived = await this.#derive(password, known.cost, known.salt, known.hash.length);
    const same = timingSafeEqual(derived, known.hash);
    return same && stored !== undefined;
  }

  #derive(password: string, cost: PasswordCost, salt: Uint8Array, tagLength: number): Promise<Buffer> {
    const message = Buffer.from(password.normalize("NFC"), "utf8");
    return this.#gate.run(() => this.#argon2id({ message, nonce: salt, memory: cost.memory, passes: cost.passes, parallelism: cost.parallelism, tagLength }));
  }
}
