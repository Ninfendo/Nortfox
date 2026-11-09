// SPDX-License-Identifier: AGPL-3.0-only

// The turns of a company's writes in this process. A write that takes a turn
// of the database, a company's turn of its invitations or of its
// administrators (access.take_invitations_turn and
// access.take_administrators_turn, db/README.md), waits for the same turn
// here first, before it asks the pool for a connection, and holds it until
// its transaction has ended. So a write that waits for another's turn, such
// as an invitation behind one that waits for its mail, holds no connection
// while it waits, and a burst of them in one company never takes the pool
// from the other companies' requests.
//
// A turn is taken alone or with the others. One taken alone waits for every
// holder, and one taken with the others only for one taken alone. The turns
// go in the order they were asked for, so a turn taken alone is never kept
// waiting by later ones. NortFox runs one server process (decision 3); across
// processes, and for two companies whose ids the database hashes alike, the
// database's turn still decides.

/** The turn that a write of a company takes: its name, and whether alone or with the others. */
export interface Turn {
  readonly name: string;
  readonly alone: boolean;
}

/** One turn of one company: who holds it, and who waits for it, in order. */
interface TurnState {
  holders: number;
  heldAlone: boolean;
  readonly waiting: { readonly alone: boolean; readonly start: () => void }[];
}

/** The turns of the companies' writes in this process. */
export class CompanyTurns {
  readonly #turns = new Map<string, TurnState>();

  /** Waits for the company's turn, and gives the function that lets it go. */
  async take(companyId: string, turn: Turn): Promise<() => void> {
    const slot = JSON.stringify([turn.name, companyId]);
    let state = this.#turns.get(slot);
    if (state === undefined) {
      state = { holders: 0, heldAlone: false, waiting: [] };
      this.#turns.set(slot, state);
    }
    const held = state;
    if (held.waiting.length === 0 && CompanyTurns.#free(held, turn.alone)) {
      CompanyTurns.#hold(held, turn.alone);
    } else {
      await new Promise<void>((start) => held.waiting.push({ alone: turn.alone, start }));
    }
    let holding = true;
    return () => {
      if (!holding) {
        return;
      }
      holding = false;
      held.holders -= 1;
      held.heldAlone = false;
      // The ones that wait next, in order: one alone, or each with the others up to the next one alone.
      for (let next = held.waiting[0]; next !== undefined && CompanyTurns.#free(held, next.alone); next = held.waiting[0]) {
        held.waiting.shift();
        CompanyTurns.#hold(held, next.alone);
        next.start();
      }
      if (held.holders === 0 && held.waiting.length === 0) {
        this.#turns.delete(slot);
      }
    };
  }

  /** How many turns are held or waited for now, for the tests. */
  get size(): number {
    return this.#turns.size;
  }

  /** Whether the turn may be taken now: alone when no one holds it, with the others when no one holds it alone. */
  static #free(state: TurnState, alone: boolean): boolean {
    return alone ? state.holders === 0 : !state.heldAlone;
  }

  static #hold(state: TurnState, alone: boolean): void {
    state.holders += 1;
    state.heldAlone = alone;
  }
}
