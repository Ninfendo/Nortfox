// SPDX-License-Identifier: AGPL-3.0-only

// The database's half of the owner's rule of 2026-11-09 for an address that
// can become an identity's: it holds no character whose case fold is not its
// lower case, in NFC, so no two mailboxes share an identity's place under
// the fold of identities_email_key and find_login. The check
// access.folds_as_lower_case(address) holds on an invitation's address, an
// identity's address and a member's work e-mail, for every role, tested as
// nortfox_app with the settings the server sets, and as the owner. It finds
// the characters from PostgreSQL's own Unicode data, casefold() and lower(),
// and finds the same ones as the contract's check, which reads JavaScript's,
// for every code point. Migration 0009 stops on an install that holds such
// an address already, and changes nothing.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { foldsAsLowerCase } from "@nortfox/contract";
import { CHECK_VIOLATION, emptyDatabase, expectError, failureOf, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { addIdentity, anonymously, asPerson, phcString, sealedSecret, tokenHash } from "../../../test/identities.ts";
import { aCompany, addMembership, asMember, type Company } from "../../../test/memberships.ts";
import { migrate, readMigrations } from "../../db/migrate.ts";

/** Addresses with a character whose case fold is not its lower case. */
const FOLD_TWINS = [
  "karin.lund@straße.example",
  "karin.lund@παράδειγμας.example",
  "KARIN.STRA\u{1E9E}E@example.com",
  "\u{17F}ven.ek@example.com",
  "\u{B5}@example.com",
  "\u{FB01}a.strand@example.com",
  "\u{AB70}@example.com",
  "\u{13A0}@example.com",
  "\u{3B1}\u{345}@example.com",
];

/** Addresses whose every character folds as its lower case does, in NFC. */
const FOLDS_AS_LOWER = [
  "karin.strasse@example.com",
  "Karin.Lund@Example.COM",
  "A\u{30A}sa@example.com",
  "ΣΟΦΙΑ@example.com",
  // A final capital sigma: lower() of the whole text gives ς, but the check reads each character alone.
  "ΟΔΥΣΣΕΥΣ@example.com",
  "\u{212A}arin@example.com",
  "\u{130}lker@example.com",
];

/** The highest code point. */
const LAST_CODE_POINT = 0x10ffff;

describe("an address with a fold twin, in the database", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let alfa: Company;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    alfa = await aCompany(app, "Testbolaget Alfa AB");
  });

  afterAll(async () => {
    await db.close();
  });

  it("is refused as an invitation's address, for the app and for the owner", async () => {
    const member = await addMembership(app, owner, alfa, { status: "invited" });
    const insert = "INSERT INTO access.invitations (company_id, membership_id, name, email) VALUES ($1, $2, 'Karin Lund', $3)";
    for (const email of FOLD_TWINS) {
      await expectError(asMember(app, alfa.id, alfa.asOwner, insert, [alfa.id, member, email]), CHECK_VIOLATION, /invitations_email_folds_as_lower_case/);
      await expectError(
        inTransaction(owner, { company: alfa.id, ...alfa.asOwner, channel: "rest" }, () => owner.query(insert, [alfa.id, member, email])),
        CHECK_VIOLATION,
        /invitations_email_folds_as_lower_case/,
      );
    }
    for (const email of FOLDS_AS_LOWER) {
      await asMember(app, alfa.id, alfa.asOwner, insert, [alfa.id, member, email]);
    }
  });

  it("is refused as a work e-mail, at an insert and at a change", async () => {
    const insert = "INSERT INTO access.membership_contacts (contact_company_id, membership_id, work_email) VALUES ($1, $2, $3)";
    const update = "UPDATE access.membership_contacts SET work_email = $2 WHERE membership_id = $1";
    for (const email of FOLD_TWINS) {
      await expectError(asMember(app, alfa.id, alfa.asOwner, insert, [alfa.id, alfa.membership, email]), CHECK_VIOLATION, /membership_contacts_work_email_folds_as_lower_case/);
    }
    await asMember(app, alfa.id, alfa.asOwner, insert, [alfa.id, alfa.membership, "alva.arbete@example.org"]);
    for (const email of FOLD_TWINS) {
      await expectError(asMember(app, alfa.id, alfa.asOwner, update, [alfa.membership, email]), CHECK_VIOLATION, /membership_contacts_work_email_folds_as_lower_case/);
      await expectError(
        inTransaction(owner, { company: alfa.id, ...alfa.asOwner, channel: "rest" }, () => owner.query(update, [alfa.membership, email])),
        CHECK_VIOLATION,
        /membership_contacts_work_email_folds_as_lower_case/,
      );
    }
    for (const email of FOLDS_AS_LOWER) {
      await asMember(app, alfa.id, alfa.asOwner, update, [alfa.membership, email]);
    }
  });

  it("is refused as an identity's address: the person's own change, and the owner's insert", async () => {
    const person = await addIdentity(owner, { email: "nils.ny@example.com" });
    const update = "UPDATE access.identities SET email = $2 WHERE id = $1";
    for (const email of FOLD_TWINS) {
      await expectError(asPerson(app, person, () => app.query(update, [person, email])), CHECK_VIOLATION, /identities_email_folds_as_lower_case/);
      await expectError(addIdentity(owner, { email }), CHECK_VIOLATION, /identities_email_folds_as_lower_case/);
    }
    for (const email of FOLDS_AS_LOWER) {
      await asPerson(app, person, () => app.query(update, [person, email]));
    }
  });

  it("is found by the database's check exactly as by the contract's, for every code point", async () => {
    // The database reads PostgreSQL's Unicode data, the contract JavaScript's: both find the same characters.
    const found = await inTransaction(app, { channel: "rest" }, async () =>
      (
        await app.query<{ c: number }>(
          `SELECT c FROM generate_series(1, $1::integer) AS c
           WHERE c NOT BETWEEN 55296 AND 57343 AND NOT access.folds_as_lower_case(chr(c))
           ORDER BY c`,
          [LAST_CODE_POINT],
        )
      ).rows.map((row) => row.c),
    );
    const contract: number[] = [];
    for (let c = 1; c <= LAST_CODE_POINT; c += 1) {
      if ((c < 0xd800 || c > 0xdfff) && !foldsAsLowerCase(String.fromCodePoint(c))) {
        contract.push(c);
      }
    }
    expect(found).toEqual(contract);
    // ß, ẞ, ς, ſ, µ, the ligatures and the Cherokee letters are among them; Σ, K, İ and the dotless i are not.
    for (const c of [0xdf, 0x1e9e, 0x3c2, 0x17f, 0xb5, 0xfb01, 0xab70, 0x13a0]) {
      expect(found, c.toString(16)).toContain(c);
    }
    for (const c of [0x73, 0x3a3, 0x3c3, 0x212a, 0x130, 0x131]) {
      expect(found, c.toString(16)).not.toContain(c);
    }
  }, 120_000);
});

describe("the first identity's address with a fold twin, in the database", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
  });

  afterAll(async () => {
    await db.close();
  });

  it("is refused by complete_setup as the app, and the link still works", async () => {
    const hash = tokenHash();
    const at = new Date();
    await anonymously(app, "SELECT access.create_setup_token($1, $2, $3)", [hash, at, new Date(at.getTime() + 86_400_000)]);
    const complete = (person: string, email: string): Promise<{ done: boolean }[]> =>
      anonymously<{ done: boolean }>(app, "SELECT access.complete_setup($1, $2, $3, 'Alva Berg', $4, $5, $6, $7) AS done", [
        hash,
        at,
        person,
        email,
        phcString(),
        randomUUID(),
        sealedSecret(),
      ]);
    for (const email of FOLD_TWINS) {
      await expectError(complete(randomUUID(), email), CHECK_VIOLATION, /identities_email_folds_as_lower_case/);
    }
    expect((await owner.query("SELECT 1 FROM access.identities")).rowCount).toBe(0);
    expect(await complete(randomUUID(), "alva.strasse@example.com")).toEqual([{ done: true }]);
  });
});

describe("migration 0009 on an install that holds an address with a fold twin", () => {
  const databases: TestDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  /** An install migrated up to 0008, with the app and the owner to add what it held then. */
  async function before0009(): Promise<{ readonly migrator: Client; readonly app: Client; readonly owner: Client }> {
    const database = await emptyDatabase();
    databases.push(database);
    const migrator = await database.connect("owner");
    await migrate(
      migrator,
      readMigrations().filter((migration) => migration.name < "0009"),
    );
    return { migrator, app: await database.connect("app"), owner: await database.connect("owner") };
  }

  /** Expects 0009 to stop with the check `constraint`, as PostgreSQL's 23514, and to leave the install at 0008 with nothing of 0009. */
  async function expectMigrationStops(migrator: Client, constraint: RegExp): Promise<void> {
    const failure = await failureOf(migrate(migrator, readMigrations()));
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(constraint);
    expect(((failure as Error).cause as { code?: unknown } | undefined)?.code).toBe(CHECK_VIOLATION);
    const applied = await migrator.query<{ name: string }>("SELECT name FROM meta.schema_migrations ORDER BY name");
    expect(applied.rows.at(-1)?.name).toBe("0008_setup_new_link.sql");
    const left = await migrator.query<{ fold: string | null; invitations: string | null }>(
      "SELECT pg_catalog.to_regprocedure('access.folds_as_lower_case(text)')::text AS fold, pg_catalog.to_regclass('access.invitations')::text AS invitations",
    );
    expect(left.rows).toEqual([{ fold: null, invitations: null }]);
  }

  it("stops at an identity's address, and applies nothing of it", async () => {
    const install = await before0009();
    await addIdentity(install.owner, { email: "anna.lind@straße.example" });
    await expectMigrationStops(install.migrator, /identities_email_folds_as_lower_case/);
  });

  it("stops at a work e-mail, and applies nothing of it", async () => {
    const install = await before0009();
    const company = await aCompany(install.app, "Testbolaget Alfa AB");
    await asMember(install.app, company.id, company.asOwner, "INSERT INTO access.membership_contacts (contact_company_id, membership_id, work_email) VALUES ($1, $2, $3)", [
      company.id,
      company.membership,
      "\u{17F}ven.ek@example.com",
    ]);
    await expectMigrationStops(install.migrator, /membership_contacts_work_email_folds_as_lower_case/);
  });
});
