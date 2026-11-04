// SPDX-License-Identifier: AGPL-3.0-only

// The login identities (issue 12: I10, and the database's half of I9). The
// database keeps one identity per e-mail address, in any letter case, and
// one per personnummer. A personnummer is set once and never changed. No
// identity is ever deleted: a deleted identity keeps its row, its id and its
// name, so it stays the actor on its entries, and holds no e-mail address,
// personnummer or mobile number. The app works as the person, on the
// person's own row. The owner stands for the database's own functions, which
// make the identities.

import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CHECK_VIOLATION, INSUFFICIENT_PRIVILEGE, UNIQUE_VIOLATION, expectError, expectRefusal, freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { DELETE_IDENTITY, PERSONAL_IDENTITY_NUMBERS, addIdentity, asPerson, deleteIdentity, someEmail } from "../../../test/identities.ts";

const [FIRST_NUMBER, SECOND_NUMBER, THIRD_NUMBER] = PERSONAL_IDENTITY_NUMBERS;

/** An identity's row as the tests read it, with its times as text. */
interface IdentityRow {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly personal_identity_number: string | null;
  readonly mobile: string | null;
  readonly language: string;
  readonly two_step: string;
  readonly status: string;
  readonly created_at: string | null;
  readonly deleted_at: string | null;
}

describe("the login identities", () => {
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

  // The fixture guard's list has three personnummer, and each is held once.
  // So each test starts with all three free: the owner deletes every
  // identity that holds one, which frees it, as a deletion frees it.
  beforeEach(async () => {
    await owner.query(DELETE_IDENTITY.replace("WHERE id = $1", "WHERE personal_identity_number IS NOT NULL"));
  });

  async function identityOf(id: string): Promise<IdentityRow | undefined> {
    const found = await owner.query<IdentityRow>(
      "SELECT id, name, email, personal_identity_number, mobile, language, two_step, status, created_at::text, deleted_at::text FROM access.identities WHERE id = $1",
      [id],
    );
    return found.rows[0];
  }

  /** Runs one update of the person's own row as the app, as the person. */
  function update(person: string, set: string, values: readonly unknown[] = []): Promise<unknown> {
    return asPerson(app, person, () => app.query(`UPDATE access.identities SET ${set} WHERE id = $1`, [person, ...values]));
  }

  it("refuses a second identity with the same e-mail in any case", async () => {
    await addIdentity(owner, { email: "Alva.Berg@example.com" });
    await expectError(addIdentity(owner, { email: "alva.berg@EXAMPLE.COM" }), UNIQUE_VIOLATION, /identities_email_key/);
    // Å and å are one letter in two cases: a fold of ASCII alone would let the second in.
    await addIdentity(owner, { email: "Åsa.Lind@example.com" });
    await expectError(addIdentity(owner, { email: "åsa.lind@example.com" }), UNIQUE_VIOLATION, /identities_email_key/);
    // Å written as A and a combining ring is the same address too.
    await expectError(addIdentity(owner, { email: "A\u030asa.Lind@example.com" }), UNIQUE_VIOLATION, /identities_email_key/);
    // The capital of ΐ, in NFC, is Ϊ and an acute. It folds to ϊ and an acute, and ΐ folds to ι, a diaeresis and an acute:
    // the same letters in canonical terms, but not the same text. A fold that is not normalised again would let the second in.
    await addIdentity(owner, { email: "\u0390rene.Berg@example.com" });
    await expectError(addIdentity(owner, { email: "\u03aa\u0301RENE.BERG@EXAMPLE.COM" }), UNIQUE_VIOLATION, /identities_email_key/);
    // The app, as a person, takes another identity's address in another case.
    const person = await addIdentity(owner);
    await expectError(update(person, "email = $2", ["ÅSA.LIND@EXAMPLE.COM"]), UNIQUE_VIOLATION, /identities_email_key/);
    await expectError(update(person, "email = $2", ["ALVA.BERG@example.com"]), UNIQUE_VIOLATION, /identities_email_key/);
    // An address of its own passes, and keeps the case it was given in.
    await update(person, "email = $2", ["Åsa.Lindqvist@example.com"]);
    expect((await identityOf(person))?.email).toBe("Åsa.Lindqvist@example.com");
  });

  it("refuses a second identity with the same personnummer", async () => {
    await addIdentity(owner, { personalIdentityNumber: FIRST_NUMBER });
    await expectError(addIdentity(owner, { personalIdentityNumber: FIRST_NUMBER }), UNIQUE_VIOLATION, /identities_personal_identity_number_key/);
    // The app, as a person with none, sets another identity's.
    const person = await addIdentity(owner);
    await expectError(update(person, "personal_identity_number = $2", [FIRST_NUMBER]), UNIQUE_VIOLATION, /identities_personal_identity_number_key/);
    await update(person, "personal_identity_number = $2", [SECOND_NUMBER]);
    expect((await identityOf(person))?.personal_identity_number).toBe(SECOND_NUMBER);
  });

  it("takes a personnummer only in its twelve digits with the hyphen", async () => {
    const person = await addIdentity(owner);
    for (const other of ["900101-2385", "199001012385", `${THIRD_NUMBER}0`, ` ${THIRD_NUMBER}`]) {
      await expectError(update(person, "personal_identity_number = $2", [other]), CHECK_VIOLATION, /identities_personal_identity_number_form/);
      await expectError(addIdentity(owner, { personalIdentityNumber: other }), CHECK_VIOLATION, /identities_personal_identity_number_form/);
    }
  });

  it("the database refuses a change of a set personnummer", async () => {
    const person = await addIdentity(owner);
    await update(person, "personal_identity_number = $2", [THIRD_NUMBER]);
    const facts = { field: "personal_identity_number", operation: "update" };
    // Not to another number, not taken away while the identity is active, by the app or by the owner.
    await expectRefusal(update(person, "personal_identity_number = $2", [FIRST_NUMBER]), "immutable_field", facts);
    await expectRefusal(update(person, "personal_identity_number = NULL"), "immutable_field", facts);
    await expectRefusal(owner.query("UPDATE access.identities SET personal_identity_number = NULL WHERE id = $1", [person]), "immutable_field", facts);
    // The same number again is no change.
    await update(person, "personal_identity_number = $2", [THIRD_NUMBER]);
    expect((await identityOf(person))?.personal_identity_number).toBe(THIRD_NUMBER);
    // Only the update that deletes the identity takes it away.
    await deleteIdentity(app, person);
    expect((await identityOf(person))?.personal_identity_number).toBeNull();
  });

  it("deletes no identity, for any role, and lets no role empty the table", async () => {
    const person = await addIdentity(owner);
    await expectError(asPerson(app, person, () => app.query("DELETE FROM access.identities WHERE id = $1", [person])), INSUFFICIENT_PRIVILEGE);
    await expectRefusal(owner.query("DELETE FROM access.identities WHERE id = $1", [person]), "append_only", { table: "access.identities", operation: "DELETE" });
    await expectRefusal(owner.query("TRUNCATE access.identities CASCADE"), "append_only", { table: "access.identities", operation: "TRUNCATE" });
    expect(await identityOf(person)).toBeDefined();
  });

  it("a deleted identity stays deleted and holds no e-mail, personnummer or mobile number", async () => {
    const email = someEmail();
    const person = await addIdentity(owner, { name: "Bodil Ek", email, personalIdentityNumber: FIRST_NUMBER, mobile: "070-174 06 05" });
    const before = await identityOf(person);
    await deleteIdentity(app, person);
    const deleted = await identityOf(person);
    // Its id, name and time of making stay, so it stays the actor on its entries; the time it was deleted is stamped.
    expect(deleted).toMatchObject({ id: person, name: "Bodil Ek", email: null, personal_identity_number: null, mobile: null, status: "deleted", created_at: before?.created_at });
    expect(deleted?.deleted_at).not.toBeNull();
    // It never comes back, by the app or by the owner.
    await expectRefusal(update(person, "status = 'active', email = $2", [email]), "immutable_field", { field: "status", operation: "update" });
    await expectRefusal(owner.query("UPDATE access.identities SET status = 'active', email = $2 WHERE id = $1", [person, email]), "immutable_field", {
      field: "status",
      operation: "update",
    });
    // A deleted identity holds no e-mail address, personnummer or mobile number.
    const keeping = await addIdentity(owner, { personalIdentityNumber: SECOND_NUMBER, mobile: "070-174 06 06" });
    await expectError(update(keeping, "status = 'deleted', personal_identity_number = NULL, mobile = NULL"), CHECK_VIOLATION, /identities_email_while_active/);
    await expectError(update(keeping, "status = 'deleted', email = NULL, mobile = NULL"), CHECK_VIOLATION, /identities_deleted_holds_nothing/);
    await expectError(update(keeping, "status = 'deleted', email = NULL, personal_identity_number = NULL"), CHECK_VIOLATION, /identities_deleted_holds_nothing/);
    expect((await identityOf(keeping))?.status).toBe("active");
    // An active identity always has an address.
    await expectError(update(keeping, "email = NULL"), CHECK_VIOLATION, /identities_email_while_active/);
    await expectError(addIdentity(owner, { email: null }), CHECK_VIOLATION, /identities_email_while_active/);
    // The deleted identity's address and personnummer are free again.
    await addIdentity(owner, { email: email.toUpperCase(), personalIdentityNumber: FIRST_NUMBER });
  });

  it("stamps when an identity was made and when it was deleted, and refuses a stamp or a status that is given", async () => {
    const insert = (columns: string, values: string): Promise<unknown> =>
      owner.query(`INSERT INTO access.identities (name, email, ${columns}) VALUES ('Cecilia Holm', $1, ${values})`, [someEmail()]);
    await expectRefusal(insert("created_at", "pg_catalog.now()"), "immutable_field", { field: "created_at", operation: "create" });
    await expectRefusal(insert("deleted_at", "pg_catalog.now()"), "immutable_field", { field: "deleted_at", operation: "create" });
    await expectRefusal(
      owner.query("INSERT INTO access.identities (name, email, status) VALUES ('Cecilia Holm', NULL, 'deleted')"),
      "immutable_field",
      { field: "status", operation: "create" },
    );
    const person = await addIdentity(owner);
    const made = await identityOf(person);
    expect(made?.created_at).not.toBeNull();
    expect(made?.deleted_at).toBeNull();
    const other = await addIdentity(owner);
    await expectRefusal(update(person, "id = $2", [other]), "immutable_field", { field: "id", operation: "update" });
    await expectRefusal(update(person, "created_at = created_at - interval '1 day'"), "immutable_field", { field: "created_at", operation: "update" });
    await expectRefusal(update(person, "deleted_at = pg_catalog.now()"), "immutable_field", { field: "deleted_at", operation: "update" });
    await expectRefusal(asPerson(app, person, () => app.query(DELETE_IDENTITY.replace("mobile = NULL", "mobile = NULL, deleted_at = pg_catalog.now()"), [person])), "immutable_field", {
      field: "deleted_at",
      operation: "update",
    });
    expect(await identityOf(person)).toEqual(made);
  });

  it("starts a new identity in Swedish, with a TOTP step on each new device and every 90 days, and takes only the known values", async () => {
    const person = await addIdentity(owner);
    expect(await identityOf(person)).toMatchObject({ language: "sv", two_step: "new_device_90_days", status: "active" });
    await update(person, "language = 'en', two_step = 'every_login'");
    expect(await identityOf(person)).toMatchObject({ language: "en", two_step: "every_login" });
    await expectError(update(person, "language = 'de'"), CHECK_VIOLATION, /identities_language_known/);
    await expectError(update(person, "two_step = 'never'"), CHECK_VIOLATION, /identities_two_step_known/);
    await expectError(update(person, "status = 'paused'"), CHECK_VIOLATION, /identities_status_known/);
    await expectError(addIdentity(owner, { twoStep: "sometimes" }), CHECK_VIOLATION, /identities_two_step_known/);
  });
});
