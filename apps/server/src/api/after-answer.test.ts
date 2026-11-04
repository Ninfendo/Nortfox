// SPDX-License-Identifier: AGPL-3.0-only

// The work that a handler queues for after its answer. A call's tasks wait
// in its batch until the surface releases it, once the answer is built; then
// they run in the process, one at a time, in the order queued. A task that
// fails goes to the reporter, and the next task still runs. The tests wait
// for the queue with idle().

import { describe, expect, it } from "vitest";
import { gate } from "../../test/api.ts";
import { AfterAnswerQueue } from "./after-answer.ts";

/** Waits a few turns of the event loop: more than a queued task waits before it starts. */
async function someTurns(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** Whether a promise has settled, after a few turns. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await someTurns();
  return done;
}

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
    // A queued task waits a turn before it starts, so the check waits several: the batch holds its tasks.
    await someTurns();
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

  it("runs no task of a batch that is never released", async () => {
    const queue = new AfterAnswerQueue(() => undefined);
    const ran: string[] = [];
    const batch = queue.batch();
    batch.later(() => Promise.resolve(void ran.push("held")));
    await someTurns();
    expect(ran).toEqual([]);
  });

  it("is idle only once no batch is open: a call still running is waited for, and so is its work after the answer", async () => {
    const queue = new AfterAnswerQueue(() => undefined);
    const ran: string[] = [];
    const one = queue.batch();
    const two = queue.batch();
    const idle = queue.idle();
    expect(await settled(idle)).toBe(false);
    // A call that ends with work for after its answer: the queue runs it, and still waits for the other call.
    one.later(() => Promise.resolve(void ran.push("one")));
    one.release();
    one.release();
    expect(await settled(idle)).toBe(false);
    expect(ran).toEqual(["one"]);
    two.later(() => Promise.resolve(void ran.push("two")));
    two.release();
    await idle;
    expect(ran).toEqual(["one", "two"]);
    // A batch made after the queue was idle is waited for in turn.
    const three = queue.batch();
    const again = queue.idle();
    expect(await settled(again)).toBe(false);
    three.release();
    await again;
  });

  it("waits for a call that starts, and for a task that is queued, while it waits for a task", async () => {
    const queue = new AfterAnswerQueue(() => undefined);
    const ran: string[] = [];
    const held = gate();
    const first = queue.batch();
    first.later(async () => {
      await held.pass();
      ran.push("first");
    });
    first.release();
    const idle = queue.idle();
    await held.reached;
    // While the first task runs, a new call starts, and the released batch queues one more task.
    const call = queue.batch();
    first.later(() => Promise.resolve(void ran.push("queued while waiting")));
    held.open();
    expect(await settled(idle)).toBe(false);
    expect(ran).toEqual(["first", "queued while waiting"]);
    call.later(() => Promise.resolve(void ran.push("the new call's")));
    call.release();
    await idle;
    expect(ran).toEqual(["first", "queued while waiting", "the new call's"]);
  });

  it("waits for a task queued while it waits, when no call is open", async () => {
    const queue = new AfterAnswerQueue(() => undefined);
    const ran: string[] = [];
    const held = gate();
    const batch = queue.batch();
    batch.later(async () => {
      await held.pass();
      ran.push("first");
    });
    batch.release();
    const idle = queue.idle();
    await held.reached;
    const second = gate();
    batch.later(async () => {
      await second.pass();
      ran.push("second");
    });
    held.open();
    await second.reached;
    expect(await settled(idle)).toBe(false);
    second.open();
    await idle;
    expect(ran).toEqual(["first", "second"]);
  });
});
