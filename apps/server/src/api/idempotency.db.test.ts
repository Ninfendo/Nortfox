// SPDX-License-Identifier: AGPL-3.0-only

// Idempotency by REST and by MCP, on PostgreSQL as the app role, through the
// test-only write. On REST the key is the Idempotency-Key header; on MCP it
// is the idempotencyKey argument. On both, the same key and request give the
// first answer and write once; the same key with another request gets 422; a
// second request while the first runs gets 409 and writes nothing; no key
// gets 400; the same key in another company, or from another actor, replays
// nothing; and a write that fails stores no key, so a retry with that key
// runs again. The two surfaces share the keys: the same input gives the same
// fingerprint on both, and a key that one surface holds gives 409 on the
// other. Two server processes with one key write once.

import type { Client as McpClient } from "@modelcontextprotocol/client";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appPool,
  bookingControls,
  buildTestApp,
  callTool,
  gate,
  mcpClient,
  postVoucher,
  principalOf,
  problemIn,
  testHandlers,
  testResolver,
  untilAtGate,
  voucherBody,
  writtenIn,
  type AppPool,
  type BookingControls,
  type Written,
} from "../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../test/database.ts";
import { addBooks, type Books } from "../../test/ledger.ts";
import type { ServerApp } from "../app.ts";

/** What a write added to a company: the vouchers and keys after it, past those before it. */
function added(before: Written, after: Written): Written {
  return { vouchers: after.vouchers.slice(before.vouchers.length), keys: after.keys.slice(before.keys.length) };
}

const INVALID_KEY = {
  code: "idempotency-key-invalid",
  detail: 'The field /idempotencyKey must be 1 to 255 characters of visible ASCII without " and \\.',
  pointer: "/idempotencyKey",
  data: { expected: "string" },
};

const SURFACES = ["rest", "mcp"] as const;
type Surface = (typeof SURFACES)[number];

/** A write's answer on either surface: its output, or its problem details. */
interface Booked {
  readonly ok: boolean;
  readonly body: Readonly<Record<string, unknown>>;
}

/** The ways to send the key: the header's forms on REST, the argument as it is on MCP. */
const KEY_FORMS: Readonly<Record<Surface, (key: string) => readonly string[]>> = {
  rest: (key) => [key, key, `"${key}"`],
  mcp: (key) => [key, key, key],
};

/** Keys that are refused on both surfaces. MCP may also send a key that is not a string. */
const BROKEN_KEYS: Readonly<Record<Surface, readonly unknown[]>> = {
  rest: ["", "two words", '"unterminated', 'trailing"', '"esc\\"aped"', '"back\\\\slash"', '""', "a".repeat(256), "nyckel-å"],
  mcp: ["", "two words", '"unterminated', 'trailing"', '"quoted"', "back\\slash", "a".repeat(256), "nyckel-å", 5, null, true, ["k"], { key: "k" }],
};

describe("idempotency", () => {
  let db: TestDatabase;
  let app: Client;
  let observer: Client;
  let books: Books;
  let other: Books;
  let pool: AppPool;
  let controls: BookingControls;
  let server: ServerApp;
  const reported: unknown[] = [];
  const writer = randomUUID();
  let tokens: Parameters<typeof testResolver>[0];
  const clients = new Map<string, McpClient>();

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    observer = await db.connect("app");
    books = await addBooks(app);
    other = await addBooks(app);
    tokens = {
      writer: principalOf(books.company, { personId: writer }),
      colleague: principalOf(books.company),
      elsewhere: principalOf(other.company, { personId: writer }),
    };
    pool = appPool(db, 3);
    controls = bookingControls();
    server = buildTestApp({ database: pool.database, resolve: testResolver(tokens), handlers: testHandlers(controls), report: (error) => reported.push(error) });
    for (const token of Object.keys(tokens)) {
      clients.set(token, await mcpClient(server, { token }));
    }
  });

  afterAll(async () => {
    for (const client of clients.values()) {
      await client.close();
    }
    await pool.pool.end();
    await db.close();
  });

  /** Books the test voucher by `surface` as the token's actor, with the key when one is given. */
  async function book(surface: Surface, token: string, key: unknown, body: Readonly<Record<string, unknown>> = voucherBody()): Promise<Booked> {
    if (surface === "rest") {
      if (key !== undefined && typeof key !== "string") {
        throw new Error("A header holds only text.");
      }
      const response = await postVoucher(server.hono, token, key, body);
      if (response.ok) {
        expect(response.status).toBe(201);
        expect(response.headers.get("content-type")).toBe("application/json");
        return { ok: true, body: (await response.json()) as Record<string, unknown> };
      }
      const problem = await problemIn(response);
      expect(problem.status).toBe(response.status);
      return { ok: false, body: { ...problem } };
    }
    const client = clients.get(token);
    if (client === undefined) {
      throw new Error(`No MCP client for ${token}.`);
    }
    const answer = await callTool(client, "testBookVoucher", { ...body, ...(key === undefined ? {} : { idempotencyKey: key }) });
    return { ok: !answer.isError, body: answer.structured as Record<string, unknown> };
  }

  /** What `work` added to the company of `inBooks`. */
  async function addedBy(work: () => Promise<unknown>, inBooks: Books = books): Promise<Written> {
    const before = await writtenIn(app, inBooks.company);
    await work();
    return added(before, await writtenIn(app, inBooks.company));
  }

  describe.each(SURFACES)("by %s", (surface) => {
    it("gives the first answer again for the same key and request, and writes once", async () => {
      const key = randomUUID();
      const answers: Booked[] = [];
      const written = await addedBy(async () => {
        for (const form of KEY_FORMS[surface](key)) {
          answers.push(await book(surface, "writer", form));
        }
      });
      const [first] = answers as [Booked];
      expect(first.ok).toBe(true);
      expect(Object.keys(first.body).sort()).toEqual(["amount", "id", "number"]);
      expect(first.body["id"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(Number.isInteger(first.body["number"])).toBe(true);
      expect(first.body["amount"]).toEqual({ amount: "125.00", currency: "SEK" });
      expect(answers).toEqual([first, first, first]);
      expect(written.vouchers).toEqual([{ id: first.body["id"], number: first.body["number"], debit: 12500n, credit: 12500n }]);
      expect(written.keys).toEqual([{ actor_id: writer, idempotency_key: key, response_status: 201, response_body: first.body }]);
    });

    it("refuses the same key with another request with 422 idempotency-key-reused, and writes nothing for it", async () => {
      const key = randomUUID();
      const written = await addedBy(async () => {
        expect((await book(surface, "writer", key)).ok).toBe(true);
        for (const body of [voucherBody("125.0"), voucherBody("99.00"), voucherBody("125.00", "Pennor")]) {
          expect(await book(surface, "writer", key, body)).toEqual({
            ok: false,
            body: {
              type: "about:blank",
              title: "Unprocessable Content",
              status: 422,
              detail: "This idempotency key belongs to another request. A new request takes a new key.",
              code: "idempotency-key-reused",
            },
          });
        }
      });
      expect(written.vouchers).toHaveLength(1);
      expect(written.keys).toHaveLength(1);
    });

    it("refuses a second request with the key while the first runs with 409 idempotency-key-in-use, and writes nothing for it", async () => {
      const key = randomUUID();
      let first: Booked | undefined;
      const written = await addedBy(async () => {
        const held = gate();
        controls.gate = held;
        const running = book(surface, "writer", key);
        await untilAtGate(held, running);
        for (const body of [voucherBody(), voucherBody("1.00")]) {
          expect(await book(surface, "writer", key, body)).toEqual({
            ok: false,
            body: {
              type: "about:blank",
              title: "Conflict",
              status: 409,
              detail: "Another request with this idempotency key is still running. Send the request again when it has ended.",
              code: "idempotency-key-in-use",
            },
          });
        }
        held.open();
        first = await running;
        expect(first.ok).toBe(true);
        expect(await book(surface, "writer", key)).toEqual(first);
      });
      expect(written.vouchers).toHaveLength(1);
      expect(written.keys.map((stored) => stored.response_body)).toEqual([first?.body]);
    });

    it("refuses a write with no key with 400 invalid-request and one field problem, idempotency-key-missing at /idempotencyKey", async () => {
      const written = await addedBy(async () => {
        expect(await book(surface, "writer", undefined)).toEqual({
          ok: false,
          body: {
            type: "about:blank",
            title: "Bad Request",
            status: 400,
            detail: "The request does not fit the operation. Each field problem names its field.",
            code: "invalid-request",
            errors: [
              {
                code: "idempotency-key-missing",
                detail: "The field /idempotencyKey is missing. A write takes an idempotency key.",
                pointer: "/idempotencyKey",
                data: { expected: "string" },
              },
            ],
          },
        });
      });
      expect(written).toEqual({ vouchers: [], keys: [] });
    });

    it.each(BROKEN_KEYS[surface])("refuses the key %j with idempotency-key-invalid at /idempotencyKey, and writes nothing", async (key) => {
      const written = await addedBy(async () => {
        const answer = await book(surface, "writer", key);
        expect(answer.ok).toBe(false);
        expect(answer.body).toMatchObject({ status: 400, code: "invalid-request", errors: [INVALID_KEY] });
      });
      expect(written).toEqual({ vouchers: [], keys: [] });
    });

    it("replays nothing for the same key from another actor of the company, or from the same actor in another company", async () => {
      const key = randomUUID();
      const answers: Booked[] = [];
      const written = await addedBy(async () => {
        for (const token of ["writer", "colleague"]) {
          answers.push(await book(surface, token, key));
        }
      });
      const elsewhere = await addedBy(async () => {
        answers.push(await book(surface, "elsewhere", key));
      }, other);
      expect(answers.map((answer) => answer.ok)).toEqual([true, true, true]);
      const ids = answers.map((answer) => answer.body["id"]);
      expect(new Set(ids).size).toBe(3);
      expect(written.vouchers.map((voucher) => voucher.id)).toEqual(ids.slice(0, 2));
      expect(written.keys.map((stored) => [stored.actor_id, stored.idempotency_key])).toEqual([
        [writer, key],
        [tokens["colleague"]?.personId, key],
      ]);
      expect(elsewhere.vouchers.map((voucher) => voucher.id)).toEqual(ids.slice(2));
      expect(elsewhere.keys.map((stored) => [stored.actor_id, stored.idempotency_key])).toEqual([[writer, key]]);
    });

    it("stores no key for a write that fails, so a retry with the key runs again", async () => {
      const key = randomUUID();
      const failed = await addedBy(async () => {
        controls.failOnce = true;
        const answer = await book(surface, "writer", key);
        expect(answer).toMatchObject({ ok: false, body: { status: 500, code: "internal-error" } });
        expect(String(reported.at(-1))).toContain("The test made the booking fail after it booked.");
      });
      expect(failed).toEqual({ vouchers: [], keys: [] });
      const retried = await addedBy(async () => {
        expect((await book(surface, "writer", key)).ok).toBe(true);
      });
      expect(retried.vouchers).toHaveLength(1);
      expect(retried.keys).toHaveLength(1);
    });

    it("answers a write whose output does not fit its schema with 500, stores no voucher and no key, and a retry runs again", async () => {
      const key = randomUUID();
      const failed = await addedBy(async () => {
        controls.badOutput = true;
        const answer = await book(surface, "writer", key);
        expect(answer).toMatchObject({ ok: false, body: { status: 500, code: "internal-error" } });
        expect(String(reported.at(-1))).toContain("The output of testBookVoucher does not fit its schema: /amount");
      });
      expect(failed).toEqual({ vouchers: [], keys: [] });
      const retried = await addedBy(async () => {
        expect((await book(surface, "writer", key)).ok).toBe(true);
      });
      expect(retried.vouchers).toHaveLength(1);
    });

    it("stores no key for a write that a rule refuses, so the key can carry another request after it", async () => {
      const key = randomUUID();
      const written = await addedBy(async () => {
        expect(await book(surface, "writer", key, voucherBody("0.00"))).toMatchObject({ ok: false, body: { status: 422, code: "amount-not-positive" } });
        expect((await book(surface, "writer", key, voucherBody("1.00"))).ok).toBe(true);
      });
      expect(written.vouchers.map((voucher) => voucher.debit)).toEqual([100n]);
    });
  });

  describe("across REST and MCP", () => {
    it.each([
      ["rest", "mcp"],
      ["mcp", "rest"],
    ] as const)("replays a key used by %s on %s: the same input has the same fingerprint, and another input gets 422", async (first, then) => {
      const key = randomUUID();
      const written = await addedBy(async () => {
        const answer = await book(first, "writer", key);
        expect(answer.ok).toBe(true);
        expect(await book(then, "writer", key)).toEqual(answer);
        expect(await book(then, "writer", key, voucherBody("1.00"))).toMatchObject({ ok: false, body: { status: 422, code: "idempotency-key-reused" } });
      });
      expect(written.vouchers).toHaveLength(1);
      expect(written.keys).toHaveLength(1);
    });

    it.each([
      ["rest", "mcp"],
      ["mcp", "rest"],
    ] as const)("refuses a key that a running %s request holds with 409 on %s", async (first, then) => {
      const key = randomUUID();
      const written = await addedBy(async () => {
        const held = gate();
        controls.gate = held;
        const running = book(first, "writer", key);
        await untilAtGate(held, running);
        expect(await book(then, "writer", key)).toMatchObject({ ok: false, body: { status: 409, code: "idempotency-key-in-use" } });
        held.open();
        expect((await running).ok).toBe(true);
      });
      expect(written.vouchers).toHaveLength(1);
    });
  });

  /** Waits until a backend of this database waits for a lock that another transaction holds. */
  async function untilOneWaits(): Promise<void> {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const found = await observer.query<{ waiting: number }>(
        "SELECT count(*)::integer AS waiting FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database() AND wait_event_type = 'Lock'",
      );
      if ((found.rows[0]?.waiting ?? 0) > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("No backend waited for a lock.");
  }

  it("writes once when two server processes get one key at once: the second gives the first's answer", async () => {
    const second = appPool(db, 2);
    try {
      const otherServer = buildTestApp({ database: second.database, resolve: testResolver(tokens) });
      const key = randomUUID();
      const answers: unknown[] = [];
      const written = await addedBy(async () => {
        const held = gate();
        controls.gate = held;
        const first = postVoucher(server.hono, "writer", key);
        await untilAtGate(held, first);
        const later = postVoucher(otherServer.hono, "writer", key);
        await untilOneWaits();
        held.open();
        for (const response of await Promise.all([first, later])) {
          expect(response.status).toBe(201);
          answers.push(await response.json());
        }
      });
      expect(answers[1]).toEqual(answers[0]);
      expect(written.vouchers).toHaveLength(1);
      expect(written.keys.map((stored) => stored.response_body)).toEqual([answers[0]]);
    } finally {
      await second.pool.end();
    }
  });
});
