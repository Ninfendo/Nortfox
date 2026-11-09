// SPDX-License-Identifier: AGPL-3.0-only

// The body of a write on /v1, through the test-only write, on PostgreSQL as
// the app role. Money travels as a decimal string with its currency: a JSON
// number, too many decimals, an unknown currency and an amount past the
// bigint range of öre are each refused with 400 and a pointer to the field.
// An unknown field is named, a wrong type points to its field, a body that is
// not JSON gets 400, one that is not application/json 415 and one over 1 MiB
// 413. A rule that concerns a field answers 422 with its pointer, and the
// ledger's own rules answer 422 with their facts. Every /v1 error is problem
// details. Nothing is written for a refused request.

import { randomUUID } from "node:crypto";
import { PROBLEM_CODES } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appPool,
  bearer,
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
  writeHeaders,
  writtenIn,
  type AppPool,
  type BookingControls,
  type Written,
} from "../../test/api.ts";
import { freshDatabase, inTransaction, type TestDatabase } from "../../test/database.ts";
import { addBooks, setLock, someUser, type Books } from "../../test/ledger.ts";
import { SHAPES_REGISTRY, shapeLog, shapesHandlers } from "../../test/shapes.ts";
import type { ServerApp } from "../app.ts";

const MIB = 1024 * 1024;

const RANGE = { minimum: "-92233720368547758.08", maximum: "92233720368547758.07" };

describe("the body of a write on /v1", () => {
  let db: TestDatabase;
  let app: Client;
  let books: Books;
  let locked: Books;
  let pool: AppPool;
  let controls: BookingControls;
  let server: ServerApp;
  let nothing: Written;
  const setter = someUser();

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    books = await addBooks(app);
    locked = await addBooks(app);
    await setLock(app, locked.company, "integration", "2090-12-31", { who: setter });
    pool = appPool(db, 2);
    controls = bookingControls();
    server = buildTestApp({
      database: pool.database,
      resolve: testResolver({
        writer: await principalOf(books.company),
        reader: await principalOf(books.company, { permissions: ["company:read"] }),
        lockedOut: await principalOf(locked.company, { kind: "integration" }),
      }),
      handlers: testHandlers(controls),
      report: () => undefined,
    });
    nothing = await writtenIn(app, books.company);
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** Posts a body of raw text, with the headers given, to the test-only write. */
  function postText(text: string, headers: Record<string, string> = writeHeaders("writer", randomUUID())): Promise<Response> {
    return Promise.resolve(server.hono.request("/v1/test-vouchers", { method: "POST", headers, body: text }));
  }

  /** The field problems of a 400 answer, after checking its frame, and that nothing was written. */
  async function fieldProblems(response: Response): Promise<unknown> {
    expect(response.status).toBe(400);
    const problem = await problemIn(response);
    expect(problem).toMatchObject({ type: "about:blank", title: "Bad Request", status: 400, code: "invalid-request" });
    expect(await writtenIn(app, books.company)).toEqual(nothing);
    return problem.errors;
  }

  describe("money", () => {
    it("refuses a JSON number for an amount with 400 at /amount/amount", async () => {
      for (const amount of [125.5, 125, 0]) {
        const response = await postVoucher(server.hono, "writer", randomUUID(), { description: "Kontorsmaterial", amount: { amount, currency: "SEK" } });
        expect(await fieldProblems(response)).toEqual([
          { code: "invalid-type", detail: "The field /amount/amount must be a string.", pointer: "/amount/amount", data: { expected: "string" } },
        ]);
      }
    });

    it("refuses a JSON number in place of the whole amount with 400 at /amount", async () => {
      const response = await postVoucher(server.hono, "writer", randomUUID(), { description: "Kontorsmaterial", amount: 125.5 });
      expect(await fieldProblems(response)).toEqual([
        { code: "invalid-type", detail: "The field /amount must be an object.", pointer: "/amount", data: { expected: "object" } },
      ]);
    });

    it("refuses more decimals than the currency has with fraction-of-ore at /amount/amount", async () => {
      for (const amount of ["1.234", "0.001", "125.500"]) {
        const response = await postVoucher(server.hono, "writer", randomUUID(), voucherBody(amount));
        expect(await fieldProblems(response)).toEqual([
          {
            code: "fraction-of-ore",
            detail: "The field /amount/amount has more decimals than its currency has. SEK has 2.",
            pointer: "/amount/amount",
            data: { maximum: 2 },
          },
        ]);
      }
    });

    it("refuses a currency the install does not know with unknown-currency at /amount/currency", async () => {
      for (const currency of ["EUR", "sek", "XYZ", ""]) {
        const response = await postVoucher(server.hono, "writer", randomUUID(), { description: "Kontorsmaterial", amount: { amount: "125.00", currency } });
        expect(await fieldProblems(response)).toEqual([
          {
            code: "unknown-currency",
            detail: "The field /amount/currency is not a currency this install knows. It knows SEK.",
            pointer: "/amount/currency",
            data: { allowed: ["SEK"] },
          },
        ]);
      }
    });

    it("refuses an amount that is not a decimal string with bad-format at /amount/amount", async () => {
      for (const amount of ["1,50", "1e3", "+1", "01.5", "", " 1.50"]) {
        const response = await postVoucher(server.hono, "writer", randomUUID(), voucherBody(amount));
        expect(await fieldProblems(response)).toEqual([
          {
            code: "bad-format",
            detail: 'The field /amount/amount is not a decimal amount such as "1234.50": digits, then a point and the decimals.',
            pointer: "/amount/amount",
          },
        ]);
      }
    });

    it("refuses an amount past the bigint range of öre with 400 out-of-range, not 500", async () => {
      for (const amount of ["92233720368547758.08", "-92233720368547758.09", "99999999999999999999.00", `${"9".repeat(400)}.00`]) {
        const response = await postVoucher(server.hono, "writer", randomUUID(), voucherBody(amount));
        expect(await fieldProblems(response)).toEqual([
          {
            code: "out-of-range",
            detail: "The field /amount/amount is outside the range of an amount, -92233720368547758.08 to 92233720368547758.07.",
            pointer: "/amount/amount",
            data: RANGE,
          },
        ]);
      }
    });
  });

  describe("the fields", () => {
    it("names each unknown field at its pointer, nested too", async () => {
      const response = await postVoucher(server.hono, "writer", randomUUID(), {
        description: "Kontorsmaterial",
        amount: { amount: "125.00", currency: "SEK", Currency: "SEK" },
        note: "x",
        "a/b~c": 1,
      });
      expect(await fieldProblems(response)).toEqual([
        { code: "unknown-field", detail: "The field /amount/Currency is not part of this operation.", pointer: "/amount/Currency" },
        { code: "unknown-field", detail: "The field /note is not part of this operation.", pointer: "/note" },
        { code: "unknown-field", detail: "The field /a~1b~0c is not part of this operation.", pointer: "/a~1b~0c" },
      ]);
    });

    it("points a wrong type to its field, with the type it takes", async () => {
      const response = await postVoucher(server.hono, "writer", randomUUID(), { description: 5, amount: { amount: "125.00", currency: "SEK" } });
      expect(await fieldProblems(response)).toEqual([
        { code: "invalid-type", detail: "The field /description must be a string.", pointer: "/description", data: { expected: "string" } },
      ]);
    });

    it("names each missing field, and a description that is too short or too long", async () => {
      expect(await fieldProblems(await postVoucher(server.hono, "writer", randomUUID(), {}))).toEqual([
        { code: "missing-field", detail: "The field /description is missing.", pointer: "/description", data: { expected: "string" } },
        { code: "missing-field", detail: "The field /amount is missing.", pointer: "/amount", data: { expected: "object" } },
      ]);
      expect(await fieldProblems(await postVoucher(server.hono, "writer", randomUUID(), voucherBody("1.00", "")))).toEqual([
        { code: "too-short", detail: "The field /description must be at least 1 character long.", pointer: "/description", data: { minimum: 1 } },
      ]);
      expect(await fieldProblems(await postVoucher(server.hono, "writer", randomUUID(), voucherBody("1.00", "x".repeat(201))))).toEqual([
        { code: "too-long", detail: "The field /description must be at most 200 characters long.", pointer: "/description", data: { maximum: 200 } },
      ]);
    });

    it("puts a body that is not a JSON object at the root pointer", async () => {
      for (const body of ["[]", "5", "null", '"text"', "true"]) {
        expect(await fieldProblems(await postText(body)), body).toEqual([
          { code: "invalid-type", detail: "The input must be an object.", pointer: "", data: { expected: "object" } },
        ]);
      }
    });

    it("gives the body's problems and the key's in one answer", async () => {
      const response = await postVoucher(server.hono, "writer", undefined, { description: 5, amount: { amount: 1, currency: "SEK" } });
      expect(await fieldProblems(response)).toEqual([
        { code: "invalid-type", detail: "The field /description must be a string.", pointer: "/description", data: { expected: "string" } },
        { code: "invalid-type", detail: "The field /amount/amount must be a string.", pointer: "/amount/amount", data: { expected: "string" } },
        {
          code: "idempotency-key-missing",
          detail: "The field /idempotencyKey is missing. A write takes an idempotency key.",
          pointer: "/idempotencyKey",
          data: { expected: "string" },
        },
      ]);
    });
  });

  describe("the body as a whole", () => {
    const MALFORMED = { type: "about:blank", title: "Bad Request", status: 400, detail: "The body is not valid JSON in UTF-8.", code: "malformed-json" };

    it("refuses a body that is not JSON with 400 malformed-json", async () => {
      for (const text of ['{"description": ', "", "{'description': 'x'}", "{} {}", "NaN"]) {
        const response = await postText(text);
        expect(response.status, text).toBe(400);
        expect(await problemIn(response)).toEqual(MALFORMED);
      }
      expect(await writtenIn(app, books.company)).toEqual(nothing);
    });

    it("refuses a body that is not UTF-8 with 400 malformed-json", async () => {
      const bytes = new Uint8Array([0x7b, 0x22, 0x64, 0xff, 0x22, 0x3a, 0x31, 0x7d]);
      const response = await server.hono.request("/v1/test-vouchers", { method: "POST", headers: writeHeaders("writer", randomUUID()), body: bytes });
      expect(response.status).toBe(400);
      expect(await problemIn(response)).toEqual(MALFORMED);
    });

    it("refuses a body that is not application/json with 415 unsupported-media-type, also one with no Content-Type", async () => {
      const text = JSON.stringify(voucherBody());
      const UNSUPPORTED = {
        type: "about:blank",
        title: "Unsupported Media Type",
        status: 415,
        detail: "The body must be application/json.",
        code: "unsupported-media-type",
      };
      for (const type of ["text/plain", "application/xml", "application/json-seq", "application/problem+json", "multipart/form-data", undefined]) {
        // A text body with no Content-Type of its own goes as text/plain.
        const headers: Record<string, string> = { ...bearer("writer"), "idempotency-key": randomUUID(), ...(type === undefined ? {} : { "content-type": type }) };
        const response = await postText(text, headers);
        expect(response.status, String(type)).toBe(415);
        expect(await problemIn(response)).toEqual(UNSUPPORTED);
      }
      // A body of bytes goes with no Content-Type at all.
      const bytes = new TextEncoder().encode(text);
      const response = await server.hono.request("/v1/test-vouchers", {
        method: "POST",
        headers: { ...bearer("writer"), "idempotency-key": randomUUID() },
        body: bytes,
      });
      expect(response.status).toBe(415);
      expect(await problemIn(response)).toEqual(UNSUPPORTED);
      expect(await writtenIn(app, books.company)).toEqual(nothing);
    });

    it("takes application/json with parameters and in any case", async () => {
      const before = await writtenIn(app, books.company);
      for (const type of ["application/json; charset=utf-8", "Application/JSON", "application/json;charset=UTF-8", "application/json ; x=y"]) {
        const response = await postText(JSON.stringify(voucherBody("1.00")), { ...bearer("writer"), "idempotency-key": randomUUID(), "content-type": type });
        expect(response.status, type).toBe(201);
      }
      nothing = await writtenIn(app, books.company);
      expect(nothing.vouchers).toHaveLength(before.vouchers.length + 4);
    });

    it("refuses a body over 1 MiB with 413 payload-too-large, and takes one of exactly 1 MiB", async () => {
      const TOO_LARGE = {
        type: "about:blank",
        title: "Content Too Large",
        status: 413,
        detail: "The body is larger than 1 MiB.",
        code: "payload-too-large",
      };
      const json = JSON.stringify(voucherBody("2.00"));
      const over = await postText(json + " ".repeat(MIB + 1 - json.length));
      expect(over.status).toBe(413);
      expect(await problemIn(over)).toEqual(TOO_LARGE);
      // A body sent in chunks, with no Content-Length, is counted as it comes.
      const chunks = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let sent = 0; sent <= MIB; sent += 64 * 1024) {
            controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
          }
          controller.close();
        },
      });
      const streamed = await server.hono.request("/v1/test-vouchers", { method: "POST", headers: writeHeaders("writer", randomUUID()), body: chunks, duplex: "half" });
      expect(streamed.status).toBe(413);
      expect(await problemIn(streamed)).toEqual(TOO_LARGE);
      expect(await writtenIn(app, books.company)).toEqual(nothing);
      const exact = await postText(json + " ".repeat(MIB - json.length));
      expect(exact.status).toBe(201);
      nothing = await writtenIn(app, books.company);
    });
  });

  describe("the refusals of the rules", () => {
    it("answers an amount of zero or less with 422 amount-not-positive at /amount, with the amount, and writes nothing", async () => {
      for (const [amount, stated] of [
        ["0.00", "0.00"],
        ["0", "0.00"],
        ["-5.5", "-5.50"],
      ]) {
        const response = await postVoucher(server.hono, "writer", randomUUID(), voucherBody(amount));
        expect(response.status).toBe(422);
        expect(await problemIn(response)).toEqual({
          type: "about:blank",
          title: "Unprocessable Content",
          status: 422,
          detail: "The field /amount must be more than zero.",
          code: "amount-not-positive",
          pointer: "/amount",
          data: { amount: { amount: stated, currency: "SEK" } },
        });
      }
      expect(await writtenIn(app, books.company)).toEqual(nothing);
    });

    it("answers a booking in a period locked for the actor with 422 period-locked-manual and the lock's facts, and stores no key, no voucher and no history row", async () => {
      const lock = await inTransaction(app, { company: locked.company }, async () => {
        const found = await app.query<{ set_at: string }>("SELECT pg_catalog.to_jsonb(set_at) #>> '{}' AS set_at FROM ledger.period_locks WHERE scope = 'integration'");
        return found.rows[0];
      });
      const historyCount = async (): Promise<bigint | undefined> =>
        (await inTransaction(app, { company: locked.company }, () => app.query<{ count: bigint }>("SELECT count(*) AS count FROM audit.history"))).rows[0]?.count;
      const before = await historyCount();
      const response = await postVoucher(server.hono, "lockedOut", randomUUID());
      expect(response.status).toBe(422);
      expect(await problemIn(response)).toEqual({
        type: "about:blank",
        title: "Unprocessable Content",
        status: 422,
        detail: "The date is in a locked period.",
        code: "period-locked-manual",
        data: { endDate: "2090-12-31", source: "integration", userId: null, setBy: setter.actor, setByKind: "user", setAt: lock?.set_at },
      });
      expect(await writtenIn(app, locked.company)).toEqual({ vouchers: [], keys: [] });
      expect(await historyCount()).toBe(before);
    });
  });

  it("answers every /v1 error with application/problem+json: type, title, status, detail and a code", async () => {
    const send = (path: string, init: RequestInit) => Promise.resolve(server.hono.request(path, init));
    const held = gate();
    const key = randomUUID();
    const answers: Response[] = [
      await postVoucher(server.hono, "writer", randomUUID(), { description: 5 }),
      await postText("{"),
      await send("/v1/test-vouchers", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      await postVoucher(server.hono, "reader", randomUUID()),
      await send("/v1/test-voucher", { method: "POST", headers: writeHeaders("writer", randomUUID()), body: "{}" }),
      await send("/v1/test-vouchers", { method: "GET", headers: bearer("writer") }),
      await postText(" ".repeat(MIB + 1)),
      await postText("{}", { ...bearer("writer"), "content-type": "text/plain", "idempotency-key": randomUUID() }),
      await postVoucher(server.hono, "writer", randomUUID(), voucherBody("0.00")),
      await postVoucher(server.hono, "lockedOut", randomUUID()),
    ];
    controls.gate = held;
    const running = postVoucher(server.hono, "writer", key);
    await untilAtGate(held, running);
    answers.push(await postVoucher(server.hono, "writer", key));
    held.open();
    expect((await running).status).toBe(201);
    answers.push(await postVoucher(server.hono, "writer", key, voucherBody("9.00")));
    controls.failOnce = true;
    answers.push(await postVoucher(server.hono, "writer", randomUUID()));

    expect(answers.map((response) => response.status)).toEqual([400, 400, 401, 403, 404, 405, 413, 415, 422, 422, 409, 422, 500]);
    for (const response of answers) {
      expect(response.headers.get("content-type")).toBe("application/problem+json");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const problem = await problemIn(response);
      expect(problem.type).toBe("about:blank");
      expect(problem.status).toBe(response.status);
      expect(problem.title).toMatch(/^[A-Z][A-Za-z ]+$/);
      expect(problem.detail).toMatch(/^[A-Z].*\.$/);
      expect(problem.code).toMatch(/^[a-z]+(-[a-z]+)*$/);
      if (problem.code !== "amount-not-positive") {
        expect(PROBLEM_CODES[problem.code as keyof typeof PROBLEM_CODES]).toBe(response.status);
      }
    }
  });

  describe("the shapes of slice 2c", () => {
    const THING = "1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b";
    const OTHER_THING = "2f3e4d5c-6b7a-4899-8a1b-2c3d4e5f6a7b";
    let shapes: ServerApp;

    beforeAll(async () => {
      shapes = buildTestApp({
        database: pool.database,
        resolve: testResolver({ writer: await principalOf(books.company) }),
        registry: SHAPES_REGISTRY,
        handlers: shapesHandlers(shapeLog()),
        report: () => undefined,
      });
    });

    function remove(thing: string, key: string): Promise<Response> {
      return Promise.resolve(shapes.hono.request(`/v1/test-things/${thing}`, { method: "DELETE", headers: { ...bearer("writer"), "idempotency-key": key } }));
    }

    it("answers a write in a company with 204 and no body, keeps its key with the empty answer, and replays it so", async () => {
      const key = randomUUID();
      const first = await remove(THING, key);
      expect(first.status).toBe(204);
      expect(await first.text()).toBe("");
      expect(first.headers.get("cache-control")).toBe("no-store");
      const kept = (await writtenIn(app, books.company)).keys.filter((stored) => stored.idempotency_key === key);
      expect(kept).toEqual([{ actor_id: expect.any(String) as unknown, idempotency_key: key, response_status: 204, response_body: {} }]);
      const again = await remove(THING, key);
      expect(again.status).toBe(204);
      expect(await again.text()).toBe("");
      expect((await writtenIn(app, books.company)).keys.filter((stored) => stored.idempotency_key === key)).toHaveLength(1);
      nothing = await writtenIn(app, books.company);
    });

    it("takes the path into the fingerprint: the same key on another path is another request", async () => {
      const key = randomUUID();
      expect((await remove(THING, key)).status).toBe(204);
      const elsewhere = await remove(OTHER_THING, key);
      expect(elsewhere.status).toBe(422);
      expect(await problemIn(elsewhere)).toMatchObject({ code: "idempotency-key-reused" });
      nothing = await writtenIn(app, books.company);
    });

    it("names a bad path parameter at its pointer, and writes nothing", async () => {
      const response = await remove("not-a-uuid", randomUUID());
      expect(await fieldProblems(response)).toEqual([
        { code: "bad-format", detail: "The field /thingId does not have the format uuid.", pointer: "/thingId", data: { format: "uuid" } },
      ]);
    });

    it("answers 303 with the Location header and the same location as JSON", async () => {
      const response = await shapes.hono.request("/v1/test-redirects?provider=beta");
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("https://beta.example.com/authorize?state=test-state");
      expect(await response.json()).toEqual({ location: "https://beta.example.com/authorize?state=test-state" });
      expect(response.headers.get("cache-control")).toBe("no-store");
    });
  });
});
