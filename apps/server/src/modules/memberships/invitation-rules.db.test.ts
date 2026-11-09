// SPDX-License-Identifier: AGPL-3.0-only

// What the database holds of the invitations and their links (issue 12,
// "Users in a company" 2; open point 5; plan 2.6 and 2.7), tested as
// nortfox_app with the settings the server sets, and as the owner where a
// rule holds for every role:
//
// - An invitation is never deleted. The database stamps who sent it, the
//   transaction's actor, when, and its end 14 days later, and refuses each
//   when it is given; it refuses an acceptance or a stop given with a new
//   invitation. Nothing changes but the acceptance and the stop, each once,
//   and never both.
// - A new invitation of a member stops the member's open one, and an invited
//   member's removal stops theirs; a stopped invitation stops its link.
// - A link is a secret: the app reads none, and reaches them only through
//   the four functions. A link is made for an open invitation of the
//   transaction's company only, holds the invitation's name, address and
//   end, and is found by its hash only while it is live. It is used once,
//   also by two parallel calls, only in its company, and only by an active
//   identity; its use with a new identity makes the identity with the link's
//   address, its password and a pending TOTP secret. The purge deletes a
//   link at its end.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  INSUFFICIENT_PRIVILEGE,
  UNIQUE_VIOLATION,
  expectError,
  expectRefusal,
  freshDatabase,
  inTransaction,
  type TestDatabase,
} from "../../../test/database.ts";
import { addIdentity, deleteIdentity, phcString, sealedSecret, tokenHash } from "../../../test/identities.ts";
import { aCompany, addMembership, asMember, changeMembership, type Company } from "../../../test/memberships.ts";

/** An invitation as the database holds it, with its times as text. */
interface InvitationRow {
  readonly id: string;
  readonly invited_by: string;
  readonly days: number;
  readonly accepted_at: string | null;
  readonly superseded_at: string | null;
}

describe("the invitations and their links in the database", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let superuser: Client;
  let alfa: Company;
  let beta: Company;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    superuser = await db.admin();
    alfa = await aCompany(app, "Testbolaget Alfa AB");
    beta = await aCompany(app, "Testbolaget Beta AB");
  });

  afterAll(async () => {
    await db.close();
  });

  /** An invited member of `company` and an invitation of it, as the server makes them: the invitation's id and the member's. */
  async function invited(company: Company = alfa, email = "karin.lund@example.com"): Promise<{ id: string; member: string }> {
    const member = await addMembership(app, owner, company, { status: "invited" });
    return { id: await invitationOf(company, member, email), member };
  }

  /** A new invitation of `member`, as its company's owner: its id. */
  async function invitationOf(company: Company, member: string, email = "karin.lund@example.com"): Promise<string> {
    const [row] = await asMember<{ id: string }>(
      app,
      company.id,
      company.asOwner,
      "INSERT INTO access.invitations (company_id, membership_id, name, email) VALUES ($1, $2, 'Karin Lund', $3) RETURNING id",
      [company.id, member, email],
    );
    if (row === undefined) {
      throw new Error("The invitation was not added.");
    }
    return row.id;
  }

  async function rowOf(id: string): Promise<InvitationRow | undefined> {
    const found = await superuser.query<InvitationRow>(
      `SELECT id, invited_by, extract(epoch FROM expires_at - created_at)::integer AS days, accepted_at::text AS accepted_at, superseded_at::text AS superseded_at
       FROM access.invitations WHERE id = $1`,
      [id],
    );
    const [row] = found.rows;
    return row === undefined ? undefined : { ...row, days: row.days / 86400 };
  }

  /** Makes the link of `invitation`, as its company's owner: whether the function made one. */
  async function issue(company: Company, invitation: string, hash: Buffer, at = new Date()): Promise<boolean> {
    const [row] = await asMember<{ made: boolean }>(app, company.id, company.asOwner, "SELECT access.issue_invitation_link($1, $2, 'Testbolaget Alfa AB', 'Alva Berg', $3) AS made", [
      hash,
      invitation,
      at,
    ]);
    return row?.made === true;
  }

  /** A live link of a new invited member of `company`: its hash, the invitation and the member. */
  async function liveLink(company: Company = alfa, email = "karin.lund@example.com"): Promise<{ hash: Buffer; id: string; member: string }> {
    const made = await invited(company, email);
    const hash = tokenHash();
    expect(await issue(company, made.id, hash)).toBe(true);
    return { hash, ...made };
  }

  async function linkOf(hash: Buffer): Promise<{ used: boolean; superseded: boolean; email: string } | undefined> {
    const found = await superuser.query<{ used: boolean; superseded: boolean; email: string }>(
      "SELECT used_at IS NOT NULL AS used, superseded_at IS NOT NULL AS superseded, email FROM access.invitation_links WHERE token_hash = $1",
      [hash],
    );
    return found.rows[0];
  }

  /** The live link of `hash` at `at`, as a request with no settings but the channel finds it. */
  async function found(hash: Buffer, at = new Date()): Promise<Record<string, unknown>[]> {
    return inTransaction(app, { channel: "rest" }, async () => (await app.query<Record<string, unknown>>("SELECT * FROM access.invitation_by_token($1, $2)", [hash, at])).rows);
  }

  /** Uses the link of `hash` as `person`, in `company`: whether it was used. */
  async function use(company: Company, person: string, hash: Buffer, at = new Date(), client: Client = app): Promise<boolean> {
    const result = await inTransaction(client, { company: company.id, actor: person, kind: "user", channel: "rest" }, async () =>
      (await client.query<{ used: boolean }>("SELECT access.use_invitation_link($1, $2) AS used", [hash, at])).rows,
    );
    return result[0]?.used === true;
  }

  describe("an invitation", () => {
    it("is stamped by the database: who sent it, when, to the millisecond, and its end 14 days later", async () => {
      const { id } = await invited();
      expect(await rowOf(id)).toEqual({ id, invited_by: alfa.owner, days: 14, accepted_at: null, superseded_at: null });
      const whole = await superuser.query<{ whole: boolean }>("SELECT created_at = date_trunc('milliseconds', created_at) AS whole FROM access.invitations WHERE id = $1", [id]);
      expect(whole.rows).toEqual([{ whole: true }]);
    });

    it.each(["invited_by", "created_at", "expires_at", "accepted_at", "superseded_at"])("refuses %s when it is given", async (field) => {
      const member = await addMembership(app, owner, alfa, { status: "invited" });
      const value = field === "invited_by" ? alfa.owner : new Date().toISOString();
      await expectRefusal(
        asMember(app, alfa.id, alfa.asOwner, `INSERT INTO access.invitations (company_id, membership_id, name, email, ${field}) VALUES ($1, $2, 'Karin Lund', 'k@example.com', $3)`, [
          alfa.id,
          member,
          value,
        ]),
        "immutable_field",
        { field, operation: "create" },
      );
    });

    it.each(["id", "company_id", "membership_id", "name", "email", "invited_by", "created_at", "expires_at"])("never changes %s, for the app and for the owner", async (field) => {
      const { id } = await invited();
      const other = await addMembership(app, owner, alfa, { status: "invited" });
      const values: Readonly<Record<string, unknown>> = {
        id: randomUUID(),
        company_id: beta.id,
        membership_id: other,
        name: "Karin Annan",
        email: "annan@example.com",
        invited_by: beta.owner,
        created_at: new Date(Date.now() - 86_400_000),
        expires_at: new Date(Date.now() + 30 * 86_400_000),
      };
      const update = `UPDATE access.invitations SET ${field} = $2 WHERE id = $1`;
      await expectRefusal(asMember(app, alfa.id, alfa.asOwner, update, [id, values[field]]), "immutable_field", { field, operation: "update" });
      await expectRefusal(
        inTransaction(owner, { company: alfa.id, actor: alfa.owner, kind: "user", channel: "rest" }, () => owner.query(update, [id, values[field]])),
        "immutable_field",
        { field, operation: "update" },
      );
    });

    it("is accepted or stopped once, never both, and never deleted", async () => {
      const { id } = await invited();
      await asMember(app, alfa.id, alfa.asOwner, "UPDATE access.invitations SET accepted_at = pg_catalog.clock_timestamp() WHERE id = $1", [id]);
      await expectRefusal(
        asMember(app, alfa.id, alfa.asOwner, "UPDATE access.invitations SET accepted_at = pg_catalog.clock_timestamp() + interval '1 hour' WHERE id = $1", [id]),
        "immutable_field",
        { field: "accepted_at", operation: "update" },
      );
      await expectError(
        asMember(app, alfa.id, alfa.asOwner, "UPDATE access.invitations SET superseded_at = pg_catalog.clock_timestamp() WHERE id = $1", [id]),
        "23514",
        /invitations_accepted_or_superseded/,
      );
      await expectError(asMember(app, alfa.id, alfa.asOwner, "DELETE FROM access.invitations WHERE id = $1", [id]), INSUFFICIENT_PRIVILEGE);
      await expectRefusal(
        inTransaction(owner, { company: alfa.id, actor: alfa.owner, kind: "user", channel: "rest" }, () => owner.query("DELETE FROM access.invitations WHERE id = $1", [id])),
        "append_only",
        { table: "access.invitations", operation: "DELETE" },
      );
    });

    it("stops the member's open invitation when a new one comes, and the old link with it", async () => {
      const first = await liveLink();
      const second = await invitationOf(alfa, first.member);
      expect((await rowOf(first.id))?.superseded_at).not.toBeNull();
      expect((await rowOf(second))?.superseded_at).toBeNull();
      expect(await linkOf(first.hash)).toMatchObject({ used: false, superseded: true });
      expect(await found(first.hash)).toEqual([]);
      // An accepted one stays as it is.
      const accepted = await liveLink();
      await asMember(app, alfa.id, alfa.asOwner, "UPDATE access.invitations SET accepted_at = pg_catalog.clock_timestamp() WHERE id = $1", [accepted.id]);
      await invitationOf(alfa, accepted.member);
      expect(await rowOf(accepted.id)).toMatchObject({ superseded_at: null });
    });

    it("stops when its invited member is removed, and its link with it", async () => {
      const link = await liveLink();
      await changeMembership(app, alfa, link.member, "status = 'removed'");
      expect((await rowOf(link.id))?.superseded_at).not.toBeNull();
      expect(await linkOf(link.hash)).toMatchObject({ used: false, superseded: true });
    });

    it("is a company's own: another company neither reads nor writes it, and the history holds it", async () => {
      const { id } = await invited();
      expect(await asMember(app, beta.id, beta.asOwner, "SELECT id FROM access.invitations WHERE id = $1", [id])).toEqual([]);
      expect(await asMember(app, beta.id, beta.asOwner, "UPDATE access.invitations SET accepted_at = pg_catalog.clock_timestamp() WHERE id = $1 RETURNING id", [id])).toEqual([]);
      const member = await addMembership(app, owner, alfa, { status: "invited" });
      await expectError(
        asMember(app, beta.id, beta.asOwner, "INSERT INTO access.invitations (company_id, membership_id, name, email) VALUES ($1, $2, 'Karin Lund', 'k@example.com')", [alfa.id, member]),
        INSUFFICIENT_PRIVILEGE,
      );
      const history = await superuser.query<{ actor_id: string }>("SELECT actor_id FROM audit.history WHERE table_name = 'access.invitations' AND row_id = $1", [id]);
      expect(history.rows).toEqual([{ actor_id: alfa.owner }]);
    });
  });

  describe("a link", () => {
    it("is a secret table: the app reads and writes none of it", async () => {
      await liveLink();
      await expectError(asMember(app, alfa.id, alfa.asOwner, "SELECT * FROM access.invitation_links"), INSUFFICIENT_PRIVILEGE);
      await expectError(
        asMember(app, alfa.id, alfa.asOwner, "UPDATE access.invitation_links SET used_at = pg_catalog.clock_timestamp()"),
        INSUFFICIENT_PRIVILEGE,
      );
    });

    it("is made only for an open invitation of the transaction's company, with the invitation's name, address and end", async () => {
      const { id } = await invited();
      expect(await issue(beta, id, tokenHash())).toBe(false);
      const hash = tokenHash();
      expect(await issue(alfa, id, hash)).toBe(true);
      const [row] = (
        await superuser.query<{ name: string; email: string; same_end: boolean; company: string }>(
          `SELECT l.name, l.email, l.expires_at = i.expires_at AS same_end, l.invited_company_id AS company
           FROM access.invitation_links AS l JOIN access.invitations AS i ON i.id = l.invitation_id WHERE l.token_hash = $1`,
          [hash],
        )
      ).rows;
      expect(row).toEqual({ name: "Karin Lund", email: "karin.lund@example.com", same_end: true, company: alfa.id });
      // One link for an invitation.
      await expectError(issue(alfa, id, tokenHash()), UNIQUE_VIOLATION, /invitation_links_once/);
      const accepted = await invited();
      await asMember(app, alfa.id, alfa.asOwner, "UPDATE access.invitations SET accepted_at = pg_catalog.clock_timestamp() WHERE id = $1", [accepted.id]);
      expect(await issue(alfa, accepted.id, tokenHash())).toBe(false);
      const stopped = await invited();
      await invitationOf(alfa, stopped.member);
      expect(await issue(alfa, stopped.id, tokenHash())).toBe(false);
    });

    it("is found by its hash only while it is live", async () => {
      const link = await liveLink(alfa, "lisa.live@example.com");
      expect(await found(link.hash)).toEqual([
        {
          invited_company_id: alfa.id,
          invitation_id: link.id,
          name: "Karin Lund",
          email: "lisa.live@example.com",
          company_name: "Testbolaget Alfa AB",
          inviter_name: "Alva Berg",
          expires_at: expect.any(Date) as unknown,
        },
      ]);
      expect(await found(tokenHash())).toEqual([]);
      const end = (await found(link.hash))[0]?.["expires_at"] as Date;
      expect(await found(link.hash, new Date(end.getTime() - 1))).toHaveLength(1);
      expect(await found(link.hash, end)).toEqual([]);
    });

    it("is used once, also by two parallel calls, only in its company, and only by an active identity", async () => {
      const link = await liveLink();
      const person = await addIdentity(owner);
      expect(await use(beta, person, link.hash)).toBe(false);
      expect(await use(alfa, person, tokenHash())).toBe(false);
      const deleted = await addIdentity(owner);
      await deleteIdentity(app, deleted);
      expect(await use(alfa, deleted, link.hash)).toBe(false);
      const end = (await found(link.hash))[0]?.["expires_at"] as Date;
      expect(await use(alfa, person, link.hash, end)).toBe(false);
      const second = await db.connect("app");
      const results = await Promise.all([use(alfa, person, link.hash), use(alfa, person, link.hash, new Date(), second)]);
      await second.end();
      expect(results.sort()).toEqual([false, true]);
      expect(await linkOf(link.hash)).toMatchObject({ used: true, superseded: false });
      expect(await found(link.hash)).toEqual([]);
      await expectRefusal(
        inTransaction(owner, {}, () => owner.query("UPDATE access.invitation_links SET used_at = pg_catalog.clock_timestamp() + interval '1 hour' WHERE token_hash = $1", [link.hash])),
        "immutable_field",
        { field: "used_at", operation: "update" },
      );
    });

    it("makes a new identity with the link's address, once, as the transaction's person", async () => {
      const link = await liveLink(alfa, "nils.ny@example.com");
      const asNew = (person: string | undefined, hash: Buffer, client: Client = app): Promise<boolean> =>
        inTransaction(client, person === undefined ? { company: alfa.id, channel: "rest" } : { company: alfa.id, actor: person, kind: "user", channel: "rest" }, async () => {
          const made = await client.query<{ made: boolean }>("SELECT access.accept_invitation_as_new($1, pg_catalog.clock_timestamp(), 'Nils Ny', $2, $3, $4) AS made", [
            hash,
            phcString(),
            randomUUID(),
            sealedSecret(),
          ]);
          return made.rows[0]?.made === true;
        });
      expect(await asNew(undefined, link.hash)).toBe(false);
      expect(await asNew(randomUUID(), tokenHash())).toBe(false);
      const [first, second] = [randomUUID(), randomUUID()];
      const other = await db.connect("app");
      const results = await Promise.all([asNew(first, link.hash), asNew(second, link.hash, other)]);
      await other.end();
      expect([...results].sort()).toEqual([false, true]);
      const made = await superuser.query<{ id: string; name: string; email: string; state: string; hashed: boolean }>(
        `SELECT i.id, i.name, i.email, t.state, p.password_hash LIKE '$argon2id$%' AS hashed
         FROM access.identities AS i JOIN access.totp_secrets AS t ON t.identity_id = i.id JOIN access.password_credentials AS p ON p.identity_id = i.id
         WHERE i.email = 'nils.ny@example.com'`,
      );
      expect(made.rows).toEqual([{ id: results[0] ? first : second, name: "Nils Ny", email: "nils.ny@example.com", state: "pending", hashed: true }]);
      // An address that another identity has is refused by the unique index, in any letter case.
      await addIdentity(owner, { email: "Olle.Tagen@example.com" });
      const taken = await liveLink(alfa, "olle.tagen@example.com");
      await expectError(asNew(randomUUID(), taken.hash), UNIQUE_VIOLATION, /identities_email_key/);
      expect(await linkOf(taken.hash)).toMatchObject({ used: false });
    });

    it("is deleted by the purge at its end, used or not", async () => {
      const live = await liveLink();
      const used = await liveLink();
      expect(await use(alfa, await addIdentity(owner), used.hash)).toBe(true);
      const end = (await found(live.hash))[0]?.["expires_at"] as Date;
      await inTransaction(app, { channel: "rest" }, () => app.query("SELECT access.purge_expired($1)", [new Date(end.getTime() - 60_000)]));
      expect(await linkOf(live.hash)).toBeDefined();
      await inTransaction(app, { channel: "rest" }, () => app.query("SELECT access.purge_expired($1)", [new Date(end.getTime() + 60_000)]));
      expect(await linkOf(live.hash)).toBeUndefined();
      expect(await linkOf(used.hash)).toBeUndefined();
      // The invitations stay: the rights history holds them.
      expect(await rowOf(live.id)).toBeDefined();
    });
  });
});
