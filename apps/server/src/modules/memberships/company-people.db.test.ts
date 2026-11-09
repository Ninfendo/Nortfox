// SPDX-License-Identifier: AGPL-3.0-only

// The people of a company (db/README.md, the schema access).
// access.company_people(ids) gives the id, the name and the e-mail address,
// never the personnummer or the mobile number, of each identity among `ids`
// that holds a membership of any status in the transaction's company:
// removed and left members too, so the history keeps its names. It gives
// nothing for a person outside the company, whatever person the transaction
// acts as, and nothing with no company set. It runs as the owner, and reads
// the memberships only in the transaction's company, by a rule of its own
// that the catalog check of one-function.db.test.ts pins.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, inTransaction, type Settings, type TestDatabase } from "../../../test/database.ts";
import { PERSONAL_IDENTITY_NUMBERS, addIdentity, deleteIdentity, someEmail } from "../../../test/identities.ts";
import { aCompany, addMembership, changeMembership, type Company } from "../../../test/memberships.ts";

/** A person as the function gives one. */
interface Person {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
}

describe("the people of a company", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let alfa: Company;
  let beta: Company;
  /** The people, by name, with their identities' e-mail addresses. */
  const people = new Map<string, Person>();

  /** Adds an identity with a made-up address of its own at example.com, and notes it. */
  async function person(name: string, extra: { personalIdentityNumber?: string; mobile?: string } = {}): Promise<string> {
    const email = someEmail();
    const id = await addIdentity(owner, { name, email, ...extra });
    people.set(name, { id, name, email });
    return id;
  }

  /** The id of a person, by name. */
  function idOf(name: string): string {
    const found = people.get(name);
    if (found === undefined) {
      throw new Error(`The test made no person ${name}.`);
    }
    return found.id;
  }

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    alfa = await aCompany(app, "Testbolaget Alfa AB");
    beta = await aCompany(app, "Testbolaget Beta AB");
    const [alfaOwner] = (
      await inTransaction(owner, {}, () =>
        owner.query<{ name: string; email: string }>("SELECT name, email FROM access.identities WHERE id = $1", [alfa.owner]),
      )
    ).rows;
    people.set("Alfa's owner", { id: alfa.owner, name: alfaOwner?.name ?? "", email: alfaOwner?.email ?? "" });
    // Alfa: an active member with a personnummer and a mobile number, an
    // inactive one, a removed one, one who left, one whose identity was
    // deleted, and an invitation that holds no person yet.
    await addMembership(app, owner, alfa, {
      user: await person("Gunnar Holm", { personalIdentityNumber: PERSONAL_IDENTITY_NUMBERS[0], mobile: "070-174 06 07" }),
    });
    await changeMembership(app, alfa, await addMembership(app, owner, alfa, { user: await person("Hedda Sjö") }), "status = 'inactive'");
    await changeMembership(app, alfa, await addMembership(app, owner, alfa, { user: await person("Ivar Lund") }), "status = 'removed'");
    await changeMembership(app, alfa, await addMembership(app, owner, alfa, { user: await person("Jonna Ek") }), "status = 'left'", [], {
      actor: idOf("Jonna Ek"),
      kind: "user",
    });
    await addMembership(app, owner, alfa, { user: await person("Karl Berg") });
    await deleteIdentity(app, idOf("Karl Berg"));
    people.set("Karl Berg", { id: idOf("Karl Berg"), name: "Karl Berg", email: null });
    await addMembership(app, owner, alfa, { status: "invited" });
    // Beta: its owner, Gunnar too, and a member of Beta only.
    await addMembership(app, owner, beta, { user: idOf("Gunnar Holm") });
    await addMembership(app, owner, beta, { user: await person("Mats Ström") });
    const [betaOwner] = (
      await inTransaction(owner, {}, () =>
        owner.query<{ name: string; email: string }>("SELECT name, email FROM access.identities WHERE id = $1", [beta.owner]),
      )
    ).rows;
    people.set("Beta's owner", { id: beta.owner, name: betaOwner?.name ?? "", email: betaOwner?.email ?? "" });
  });

  afterAll(async () => {
    await db.close();
  });

  /** What the function gives for `ids`, called as the app with `settings`. */
  async function companyPeople(settings: Settings, ids: readonly string[] | null): Promise<Record<string, unknown>[]> {
    return inTransaction(app, settings, async () => (await app.query<Record<string, unknown>>("SELECT * FROM access.company_people($1)", [ids])).rows);
  }

  /** The people, by name, as the function gives them, in its order: by id. */
  function expected(...names: string[]): Person[] {
    return names
      .map((name) => people.get(name))
      .filter((found): found is Person => found !== undefined)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** Every person the test made. */
  function everyone(): string[] {
    return [...people.values()].map((found) => found.id);
  }

  it("gives the id, the name and the e-mail of each person with a membership of any status in the company, removed and left ones too", async () => {
    const found = await companyPeople({ company: alfa.id, ...alfa.asOwner, channel: "rest" }, everyone());
    expect(found).toEqual(expected("Alfa's owner", "Gunnar Holm", "Hedda Sjö", "Ivar Lund", "Jonna Ek", "Karl Berg"));
  });

  it("never gives the personnummer or the mobile number: it gives three columns", async () => {
    const [gunnar] = await companyPeople({ company: alfa.id, ...alfa.asOwner }, [idOf("Gunnar Holm")]);
    expect(Object.keys(gunnar ?? {})).toEqual(["id", "name", "email"]);
    expect(JSON.stringify(gunnar)).not.toContain(PERSONAL_IDENTITY_NUMBERS[0]);
    expect(JSON.stringify(gunnar)).not.toContain("070-174");
  });

  it("gives a deleted identity's name, which it keeps, and no e-mail, which it has not", async () => {
    expect(await companyPeople({ company: alfa.id, ...alfa.asOwner }, [idOf("Karl Berg")])).toEqual([
      { id: idOf("Karl Berg"), name: "Karl Berg", email: null },
    ]);
  });

  it("gives only the people asked for, and nothing for none", async () => {
    expect(await companyPeople({ company: alfa.id, ...alfa.asOwner }, [idOf("Hedda Sjö"), idOf("Ivar Lund")])).toEqual(expected("Hedda Sjö", "Ivar Lund"));
    expect(await companyPeople({ company: alfa.id, ...alfa.asOwner }, [])).toEqual([]);
    expect(await companyPeople({ company: alfa.id, ...alfa.asOwner }, null)).toEqual([]);
  });

  it("gives nothing for a person outside the company, whatever person the transaction acts as", async () => {
    const outside = [idOf("Mats Ström"), idOf("Beta's owner")];
    expect(await companyPeople({ company: alfa.id, ...alfa.asOwner }, outside)).toEqual([]);
    // Gunnar is a member of both: in Alfa he reads none of Beta's people.
    expect(await companyPeople({ company: alfa.id, actor: idOf("Gunnar Holm"), kind: "user" }, outside)).toEqual([]);
    // The owner reads a person's own memberships in every company, but the function reads only the company's.
    expect(await companyPeople({ company: alfa.id, actor: idOf("Mats Ström"), kind: "user" }, outside)).toEqual([]);
    expect(await companyPeople({ company: alfa.id, actor: idOf("Mats Ström"), kind: "integration" }, outside)).toEqual([]);
  });

  it("gives each company its own people, so a person in two companies is in both", async () => {
    expect(await companyPeople({ company: beta.id, ...beta.asOwner }, everyone())).toEqual(expected("Beta's owner", "Gunnar Holm", "Mats Ström"));
  });

  it("gives nothing with no company set, whatever person is set", async () => {
    expect(await companyPeople({}, everyone())).toEqual([]);
    expect(await companyPeople({ channel: "rest" }, everyone())).toEqual([]);
    expect(await companyPeople({ ...alfa.asOwner }, everyone())).toEqual([]);
    expect(await companyPeople({ actor: idOf("Gunnar Holm"), kind: "integration" }, everyone())).toEqual([]);
  });

  it("takes only the ids, gives three columns, and runs as the owner", async () => {
    const found = await owner.query<{ args: string; result: string; definer: boolean; volatility: string }>(
      `SELECT pg_catalog.pg_get_function_identity_arguments(p.oid) AS args, pg_catalog.pg_get_function_result(p.oid) AS result,
         p.prosecdef AS definer, p.provolatile AS volatility
       FROM pg_catalog.pg_proc AS p WHERE p.oid = 'access.company_people'::pg_catalog.regproc`,
    );
    expect(found.rows).toEqual([{ args: "ids uuid[]", result: "TABLE(id uuid, name text, email text)", definer: true, volatility: "s" }]);
  });
});
