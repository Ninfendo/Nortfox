// SPDX-License-Identifier: AGPL-3.0-only

// Idempotency by REST, on PostgreSQL as the app role, through the test-only
// write. The same key and request give the first answer and write once; the
// same key with another request gets 422; a second request while the first
// runs gets 409 and writes nothing; no key gets 400; the same key in another
// company, or from another actor, replays nothing; and a write that fails
// stores no key, so a retry with that key runs again. Two server processes
// with one key write once.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appPool,
  bookingControls,
  buildTestApp,
  gate,
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

describe("idempotency by REST", () => {
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

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    observer = await db.connect("app");
    books = await addBooks(app);
    other = await addBooks(app);
    tokens = {
      writer: principalOf(books.company, { actorId: writer }),
      colleague: principalOf(books.company),
      elsewhere: principalOf(other.company, { actorId: writer }),
    };
    pool = appPool(db, 3);
    controls = bookingControls();
    server = buildTestApp({ database: pool.database, resolve: testResolver(tokens), handlers: testHandlers(controls), report: (error) => reported.push(error) });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** What `work` added to the company of `inBooks`. */
  async function addedBy(work: () => Promise<unknown>, inBooks: Books = books): Promise<Written> {
    const before = await writtenIn(app, inBooks.company);
    await work();
    return added(before, await writtenIn(app, inBooks.company));
  }

  it("gives the first answer again for the same key and request, the header's quoted form too, and writes once", async () => {
    const key = randomUUID();
    let answers: unknown[] = [];
    const written = await addedBy(async () => {
      const responses = [
        await postVoucher(server.hono, "writer", key),
        await postVoucher(server.hono, "writer", key),
        await postVoucher(server.hono, "writer", `"${key}"`),
      ];
      expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
      expect(responses.map((response) => response.headers.get("content-type"))).toEqual(["application/json", "application/json", "application/json"]);
      answers = await Promise.all(responses.map((response) => response.json()));
    });
    const [first] = answers as [{ id: string; number: number; amount: unknown }];
    expect(Object.keys(first).sort()).toEqual(["amount", "id", "number"]);
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isInteger(first.number)).toBe(true);
    expect(first.amount).toEqual({ amount: "125.00", currency: "SEK" });
    expect(answers).toEqual([first, first, first]);
    expect(written.vouchers).toEqual([{ id: first.id, number: first.number, debit: 12500n, credit: 12500n }]);
    expect(written.keys).toEqual([{ actor_id: writer, idempotency_key: key, response_status: 201, response_body: first }]);
  });

  it("refuses the same key with another request with 422 idempotency-key-reused, and writes nothing for it", async () => {
    const key = randomUUID();
    const written = await addedBy(async () => {
      expect((await postVoucher(server.hono, "writer", key)).status).toBe(201);
      for (const body of [voucherBody("125.0"), voucherBody("99.00"), voucherBody("125.00", "Pennor")]) {
        const response = await postVoucher(server.hono, "writer", key, body);
        expect(response.status).toBe(422);
        expect(await problemIn(response)).toEqual({
          type: "about:blank",
          title: "Unprocessable Content",
          status: 422,
          detail: "This idempotency key belongs to another request. A new request takes a new key.",
          code: "idempotency-key-reused",
        });
      }
    });
    expect(written.vouchers).toHaveLength(1);
    expect(written.keys).toHaveLength(1);
  });

  it("refuses a second request with the key while the first runs with 409 idempotency-key-in-use, and writes nothing for it", async () => {
    const key = randomUUID();
    let first: unknown;
    const written = await addedBy(async () => {
      const held = gate();
      controls.gate = held;
      const running = postVoucher(server.hono, "writer", key);
      await untilAtGate(held, running);
      for (const body of [voucherBody(), voucherBody("1.00")]) {
        const second = await postVoucher(server.hono, "writer", key, body);
        expect(second.status).toBe(409);
        expect(await problemIn(second)).toEqual({
          type: "about:blank",
          title: "Conflict",
          status: 409,
          detail: "Another request with this idempotency key is still running. Send the request again when it has ended.",
          code: "idempotency-key-in-use",
        });
      }
      held.open();
      const response = await running;
      expect(response.status).toBe(201);
      first = await response.json();
      const replay = await postVoucher(server.hono, "writer", key);
      expect(await replay.json()).toEqual(first);
    });
    expect(written.vouchers).toHaveLength(1);
    expect(written.keys.map((stored) => stored.response_body)).toEqual([first]);
  });

  it("refuses a write with no key with 400 invalid-request and one field problem, idempotency-key-missing at /idempotencyKey", async () => {
    const written = await addedBy(async () => {
      const response = await postVoucher(server.hono, "writer", undefined);
      expect(response.status).toBe(400);
      expect(await problemIn(response)).toEqual({
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
      });
    });
    expect(written).toEqual({ vouchers: [], keys: [] });
  });

  it.each(["", "two words", '"unterminated', 'trailing"', '"esc\\"aped"', '"back\\\\slash"', '""', "a".repeat(256), "nyckel-å"])(
    "refuses the key %j with idempotency-key-invalid at /idempotencyKey, and writes nothing",
    async (key) => {
      const written = await addedBy(async () => {
        const response = await postVoucher(server.hono, "writer", key);
        expect(response.status).toBe(400);
        expect((await problemIn(response)).errors).toEqual([INVALID_KEY]);
      });
      expect(written).toEqual({ vouchers: [], keys: [] });
    },
  );

  it("replays nothing for the same key from another actor of the company, or from the same actor in another company", async () => {
    const key = randomUUID();
    const answers: { id: string }[] = [];
    const written = await addedBy(async () => {
      for (const token of ["writer", "colleague"]) {
        const response = await postVoucher(server.hono, token, key);
        expect(response.status).toBe(201);
        answers.push((await response.json()) as { id: string });
      }
    });
    const elsewhere = await addedBy(async () => {
      const response = await postVoucher(server.hono, "elsewhere", key);
      expect(response.status).toBe(201);
      answers.push((await response.json()) as { id: string });
    }, other);
    expect(new Set(answers.map((answer) => answer.id)).size).toBe(3);
    expect(written.vouchers.map((voucher) => voucher.id)).toEqual([answers[0]?.id, answers[1]?.id]);
    expect(written.keys.map((stored) => [stored.actor_id, stored.idempotency_key])).toEqual([
      [writer, key],
      [tokens["colleague"]?.actorId, key],
    ]);
    expect(elsewhere.vouchers.map((voucher) => voucher.id)).toEqual([answers[2]?.id]);
    expect(elsewhere.keys.map((stored) => [stored.actor_id, stored.idempotency_key])).toEqual([[writer, key]]);
  });

  it("stores no key for a write that fails, so a retry with the key runs again", async () => {
    const key = randomUUID();
    const failed = await addedBy(async () => {
      controls.failOnce = true;
      const response = await postVoucher(server.hono, "writer", key);
      expect(response.status).toBe(500);
      expect(await problemIn(response)).toMatchObject({ code: "internal-error" });
      expect(String(reported.at(-1))).toContain("The test made the booking fail after it booked.");
    });
    expect(failed).toEqual({ vouchers: [], keys: [] });
    const retried = await addedBy(async () => {
      expect((await postVoucher(server.hono, "writer", key)).status).toBe(201);
    });
    expect(retried.vouchers).toHaveLength(1);
    expect(retried.keys).toHaveLength(1);
  });

  it("answers a write whose output does not fit its schema with 500, stores no voucher and no key, and a retry runs again", async () => {
    const key = randomUUID();
    const failed = await addedBy(async () => {
      controls.badOutput = true;
      const response = await postVoucher(server.hono, "writer", key);
      expect(response.status).toBe(500);
      expect(await problemIn(response)).toMatchObject({ code: "internal-error" });
      expect(String(reported.at(-1))).toContain("The output of testBookVoucher does not fit its schema: /amount");
    });
    expect(failed).toEqual({ vouchers: [], keys: [] });
    const retried = await addedBy(async () => {
      expect((await postVoucher(server.hono, "writer", key)).status).toBe(201);
    });
    expect(retried.vouchers).toHaveLength(1);
  });

  it("stores no key for a write that a rule refuses, so the key can carry another request after it", async () => {
    const key = randomUUID();
    const written = await addedBy(async () => {
      const refused = await postVoucher(server.hono, "writer", key, voucherBody("0.00"));
      expect(refused.status).toBe(422);
      expect(await problemIn(refused)).toMatchObject({ code: "amount-not-positive" });
      expect((await postVoucher(server.hono, "writer", key, voucherBody("1.00"))).status).toBe(201);
    });
    expect(written.vouchers.map((voucher) => voucher.debit)).toEqual([100n]);
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
