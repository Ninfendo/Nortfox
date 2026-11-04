// SPDX-License-Identifier: AGPL-3.0-only

// Work that runs after the answer, in the same process. A handler queues it
// while its call runs: the entries of a failed sign-in, or a letter that must
// not make the answer slower for one address than for another. The surface
// gives each call a batch, and releases it once it has built the answer.
// The released tasks then run one at a time, in the order queued, each
// starting on a later turn of the event loop than the one that released it,
// so the answer goes out first.
//
// A task that fails goes to the reporter, and the next task still runs. A
// crash of the process after the answer loses the tasks not yet run. That is
// accepted for what goes here: a failure entry or a letter, which the person
// can ask for again.

/** One piece of work for after the answer. */
export type AfterAnswerTask = () => Promise<void>;

/** The work of one call: queued while the call runs, released once the answer is built. */
export interface AnswerBatch {
  /** Queues a task. After the release, the task goes to the queue at once. */
  readonly later: (task: AfterAnswerTask) => void;
  /** Hands the batch's tasks to the queue. A second release does nothing. */
  readonly release: () => void;
}

/** A turn of the event loop after this one, so the answer is written first. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export class AfterAnswerQueue {
  readonly #report: (error: unknown) => void;
  #tail: Promise<void> = Promise.resolve();

  constructor(report: (error: unknown) => void) {
    this.#report = report;
  }

  /** A batch for one call. */
  batch(): AnswerBatch {
    const waiting: AfterAnswerTask[] = [];
    let released = false;
    return {
      later: (task) => {
        if (released) {
          this.#enqueue(task);
        } else {
          waiting.push(task);
        }
      },
      release: () => {
        if (!released) {
          released = true;
          for (const task of waiting.splice(0)) {
            this.#enqueue(task);
          }
        }
      },
    };
  }

  /** Resolves once every task released so far has run: the tests wait here. */
  idle(): Promise<void> {
    return this.#tail;
  }

  #enqueue(task: AfterAnswerTask): void {
    this.#tail = this.#tail.then(async () => {
      await nextTurn();
      try {
        await task();
      } catch (error) {
        this.#tell(error);
      }
    });
  }

  #tell(error: unknown): void {
    try {
      this.#report(error);
    } catch {
      // The reporter failed too, and nothing is left to tell. The next task runs.
    }
  }
}
