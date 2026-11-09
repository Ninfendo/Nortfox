// SPDX-License-Identifier: AGPL-3.0-only

// The turns of the companies' writes in this process: a turn taken alone
// waits for every holder, one taken with the others only for one taken
// alone, each company's and each name's apart, in the order they were asked
// for, and a turn that no one holds or waits for is forgotten.

import { describe, expect, it } from "vitest";
import { CompanyTurns, type Turn } from "./turns.ts";

const ALONE: Turn = { name: "administrators", alone: true };
const SHARED: Turn = { name: "administrators", alone: false };
const INVITATIONS: Turn = { name: "invitations", alone: true };

/** A turn being taken: whether it started, and the function that lets it go once it has. */
function taking(turns: CompanyTurns, company: string, turn: Turn): { readonly started: () => boolean; readonly release: () => Promise<void> } {
  let started = false;
  const taken = turns.take(company, turn).then((release) => {
    started = true;
    return release;
  });
  return {
    started: () => started,
    release: async () => {
      (await taken)();
    },
  };
}

/** Lets the promises that can settle settle. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await Promise.resolve();
  }
}

describe("the turns of the companies' writes", () => {
  it("lets one taken alone wait for the one that holds it, and start when it is let go", async () => {
    const turns = new CompanyTurns();
    const first = taking(turns, "alfa", INVITATIONS);
    const second = taking(turns, "alfa", INVITATIONS);
    await settle();
    expect([first.started(), second.started()]).toEqual([true, false]);
    await first.release();
    await settle();
    expect(second.started()).toBe(true);
    await second.release();
    expect(turns.size).toBe(0);
  });

  it("lets many hold it with the others, and one alone wait for them all", async () => {
    const turns = new CompanyTurns();
    const shared = [taking(turns, "alfa", SHARED), taking(turns, "alfa", SHARED)];
    const alone = taking(turns, "alfa", ALONE);
    await settle();
    expect([...shared.map((each) => each.started()), alone.started()]).toEqual([true, true, false]);
    await shared[0]?.release();
    await settle();
    expect(alone.started()).toBe(false);
    await shared[1]?.release();
    await settle();
    expect(alone.started()).toBe(true);
    await alone.release();
    expect(turns.size).toBe(0);
  });

  it("goes in the order asked for: one with the others that comes after one alone waits for it", async () => {
    const turns = new CompanyTurns();
    const shared = taking(turns, "alfa", SHARED);
    const alone = taking(turns, "alfa", ALONE);
    const later = [taking(turns, "alfa", SHARED), taking(turns, "alfa", SHARED)];
    const last = taking(turns, "alfa", ALONE);
    await settle();
    expect([shared.started(), alone.started(), ...later.map((each) => each.started()), last.started()]).toEqual([true, false, false, false, false]);
    await shared.release();
    await settle();
    expect([alone.started(), ...later.map((each) => each.started())]).toEqual([true, false, false]);
    await alone.release();
    await settle();
    // Each with the others up to the next one alone.
    expect([...later.map((each) => each.started()), last.started()]).toEqual([true, true, false]);
    await later[0]?.release();
    await later[1]?.release();
    await settle();
    expect(last.started()).toBe(true);
    await last.release();
    expect(turns.size).toBe(0);
  });

  it("keeps each company's turn and each name's apart", async () => {
    const turns = new CompanyTurns();
    const alfa = taking(turns, "alfa", ALONE);
    const beta = taking(turns, "beta", ALONE);
    const invitations = taking(turns, "alfa", INVITATIONS);
    await settle();
    expect([alfa.started(), beta.started(), invitations.started()]).toEqual([true, true, true]);
    expect(turns.size).toBe(3);
    await alfa.release();
    await beta.release();
    await invitations.release();
    expect(turns.size).toBe(0);
  });

  it("lets a turn go once, however often its function is called", async () => {
    const turns = new CompanyTurns();
    const first = await turns.take("alfa", SHARED);
    const second = await turns.take("alfa", SHARED);
    const alone = taking(turns, "alfa", ALONE);
    first();
    first();
    await settle();
    expect(alone.started()).toBe(false);
    second();
    await settle();
    expect(alone.started()).toBe(true);
    await alone.release();
    expect(turns.size).toBe(0);
  });
});
