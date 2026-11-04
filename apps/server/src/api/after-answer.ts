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
//
// The queue knows which batches are open, so idle() waits for the calls that
// still run as well as for their tasks. A graceful stop waits there before
// it ends the database pool: a call whose client has left still runs, and
// still writes, after the listener has closed.

/** One piece of work for after the answer. */
export type AfterAnswerTask = () => Promise<void>;

/** The work of one call: queued while the call runs, released once the answer is built. */
export interface AnswerBatch {
  /** Queues a task. After the release, the task goes to the queue at once. */
  readonly later: (task: AfterAnswerTask) => void;
  /** Hands the batch's tasks to the queue, and ends the call's hold on idle(). A second release does nothing. */
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
  /** The batches made and not yet released: the calls that still run. */
  #open = 0;
  /** The idle() calls that wait for the next release. */
  #waiting: (() => void)[] = [];

  constructor(report: (error: unknown) => void) {
    this.#report = report;
  }

  /** A batch for one call. It is open until its release. */
  batch(): AnswerBatch {
    const waiting: AfterAnswerTask[] = [];
    let released = false;
    this.#open += 1;
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
          this.#open -= 1;
          for (const task of waiting.splice(0)) {
            this.#enqueue(task);
          }
          for (const wake of this.#waiting.splice(0)) {
            wake();
          }
        }
      },
    };
  }

  /**
   * Resolves once no batch is open and every task released has run. It waits
   * again after each release, and for a task queued while it waits. A graceful
   * stop waits here, and so do the tests.
   */
  async idle(): Promise<void> {
    let tail: Promise<void> | undefined;
    while (this.#open > 0 || this.#tail !== tail) {
      if (this.#open > 0) {
        await new Promise<void>((resolve) => {
          this.#waiting.push(resolve);
        });
      } else {
        tail = this.#tail;
        await tail;
      }
    }
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
