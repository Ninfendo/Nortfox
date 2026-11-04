// SPDX-License-Identifier: AGPL-3.0-only

// The work that a handler queues for after its answer. A call's tasks wait
// in its batch until the surface releases it, once the answer is built; then
// they run in the process, one at a time, in the order queued. A task that
// fails goes to the reporter, and the next task still runs. The tests wait
// for the queue with idle().

import { describe, expect, it } from "vitest";
import { gate } from "../../test/api.ts";
import { AfterAnswerQueue } from "./after-answer.ts";

describe("AfterAnswerQueue", () => {
  it("runs nothing before the batch is released, then each task once, in order, one at a time", async () => {
    const reported: unknown[] = [];
    const queue = new AfterAnswerQueue((error) => reported.push(error));
    const ran: string[] = [];
    const held = gate();
    const batch = queue.batch();
    batch.later(async () => {
      ran.push("first starts");
      await held.pass();
      ran.push("first ends");
    });
    batch.later(() => {
      ran.push("second");
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(ran).toEqual([]);
    batch.release();
    // A released batch waits for the answer to go out: its first task starts on a later turn.
    expect(ran).toEqual([]);
    await held.reached;
    expect(ran).toEqual(["first starts"]);
    held.open();
    await queue.idle();
    expect(ran).toEqual(["first starts", "first ends", "second"]);
    expect(reported).toEqual([]);
  });

  it("runs the batches of two calls one task at a time, in the order they were released", async () => {
    const queue = new AfterAnswerQueue(() => undefined);
    const ran: string[] = [];
    const one = queue.batch();
    const two = queue.batch();
    two.later(() => Promise.resolve(void ran.push("two")));
    one.later(() => Promise.resolve(void ran.push("one")));
    two.release();
    one.release();
    await queue.idle();
    expect(ran).toEqual(["two", "one"]);
  });

  it("reports a task that fails, and runs the next", async () => {
    const reported: unknown[] = [];
    const queue = new AfterAnswerQueue((error) => reported.push(error));
    const ran: string[] = [];
    const batch = queue.batch();
    const failure = new Error("The letter could not be sent.");
    batch.later(() => Promise.reject(failure));
    batch.later(() => {
      throw new Error("A task that throws before it gives a promise.");
    });
    batch.later(() => Promise.resolve(void ran.push("after the failures")));
    batch.release();
    await queue.idle();
    expect(reported).toEqual([failure, new Error("A task that throws before it gives a promise.")]);
    expect(ran).toEqual(["after the failures"]);
  });

  it("keeps running when the reporter itself fails", async () => {
    const queue = new AfterAnswerQueue(() => {
      throw new Error("The reporter failed.");
    });
    const ran: string[] = [];
    const batch = queue.batch();
    batch.later(() => Promise.reject(new Error("The task failed.")));
    batch.later(() => Promise.resolve(void ran.push("next")));
    batch.release();
    await queue.idle();
    expect(ran).toEqual(["next"]);
  });

  it("releases a batch once, and queues a task given after the release at once", async () => {
    const queue = new AfterAnswerQueue(() => undefined);
    const ran: string[] = [];
    const batch = queue.batch();
    batch.later(() => Promise.resolve(void ran.push("before")));
    batch.release();
    batch.release();
    batch.later(() => Promise.resolve(void ran.push("after")));
    await queue.idle();
    expect(ran).toEqual(["before", "after"]);
  });

  it("is idle at once when nothing was queued, and after an empty batch", async () => {
    const queue = new AfterAnswerQueue(() => undefined);
    await queue.idle();
    queue.batch().release();
    await queue.idle();
  });
});
