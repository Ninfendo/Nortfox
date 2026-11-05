// SPDX-License-Identifier: AGPL-3.0-only

// What resolve.ts makes of the one membership function's answer, with a
// transaction that answers its query (resolve.db.test.ts asks PostgreSQL).
// Only this module makes a membership or a company access: their
// constructors refuse every caller without its token. A company access holds
// its own copy of the permissions, and neither object nor that copy changes. An answer
// that breaks the function's promise is a fault of the server.

import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import type { Queryable } from "../../db/database.ts";
import { CompanyAccess, ResolvedMembership, activeMemberships, resolveActive, type MembershipRow } from "./resolve.ts";

const COMPANY = "0b7c9d2e-4f61-4a8b-9c3d-2e1f0a9b8c7d";
const PERSON = "6c5b4a39-2817-4f6e-8d5c-4b3a29180f7e";

const ROW: MembershipRow = {
  membership_id: "9e8d7c6b-5a49-4382-a716-05f4e3d2c1b0",
  company_id: COMPANY,
  status: "active",
  admin_level: null,
  idle_timeout_minutes: 60,
  company_name: "Testbolaget Alfa AB",
  organization_number: "556000-0167",
  database_number: 12,
  person_id: PERSON,
};

/** A transaction that answers every query with `rows`, and records what it was asked. */
function answering(rows: readonly MembershipRow[]): Queryable & { readonly asked: { text: string; values: readonly unknown[] | undefined }[] } {
  const asked: { text: string; values: readonly unknown[] | undefined }[] = [];
  return {
    asked,
    query: <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
      asked.push({ text, values });
      return Promise.resolve({ rows } as unknown as QueryResult<Row>);
    },
  };
}

/** An object's own fields, as a plain object. */
function fieldsOf(value: object | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value ?? {}));
}

/** The membership that resolve.ts makes of `row`. */
async function membershipOf(row: MembershipRow = ROW): Promise<ResolvedMembership> {
  const found = await resolveActive(answering([row]), COMPANY);
  if (found === undefined) {
    throw new Error("The transaction answered a row.");
  }
  return found;
}

describe("resolveActive", () => {
  it("asks the one function about the company, and makes the membership of its row", async () => {
    const tx = answering([ROW]);
    const found = await resolveActive(tx, COMPANY);
    expect(tx.asked).toEqual([
      {
        text: `SELECT m.membership_id, m.company_id, m.status, m.admin_level, m.idle_timeout_minutes, m.company_name, m.organization_number,
  m.database_number, access.current_person_id() AS person_id FROM access.active_membership($1) AS m`,
        values: [COMPANY],
      },
    ]);
    expect(found).toBeInstanceOf(ResolvedMembership);
    expect(fieldsOf(found)).toEqual({
      personId: PERSON,
      membershipId: ROW.membership_id,
      companyId: COMPANY,
      adminLevel: null,
      idleTimeoutMinutes: 60,
      company: { name: "Testbolaget Alfa AB", organizationNumber: "556000-0167", databaseNumber: 12 },
    });
    expect(found?.resolvedIn(tx)).toBe(true);
    expect(found?.resolvedIn(answering([ROW]))).toBe(false);
  });

  it("gives nothing when the function gives no row", async () => {
    expect(await resolveActive(answering([]), COMPANY)).toBeUndefined();
  });

  it.each(["owner", "admin"] as const)("keeps the admin level %s", async (level) => {
    expect((await membershipOf({ ...ROW, admin_level: level })).adminLevel).toBe(level);
  });

  it.each([
    ["two rows for one company", [ROW, ROW], "The one membership function gave 2 memberships in one company."],
    ["an inactive membership", [{ ...ROW, status: "inactive" }], "The one membership function gave a membership that is inactive, not active."],
    ["an unknown admin level", [{ ...ROW, admin_level: "boss" }], "The one membership function gave the unknown admin level boss."],
    ["no person", [{ ...ROW, person_id: null }], "The one membership function gave a membership with no person."],
  ])("throws on %s, which breaks the function's promise", async (_case, rows, message) => {
    await expect(resolveActive(answering(rows), COMPANY)).rejects.toThrow(new Error(message));
  });
});

describe("activeMemberships", () => {
  it("asks the one function about every company, and makes a membership of each row, in its order", async () => {
    const other = { ...ROW, membership_id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", company_id: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e", company_name: "Testbolaget Beta AB" };
    const tx = answering([ROW, other]);
    const found = await activeMemberships(tx);
    expect(tx.asked.map((asked) => [asked.text.endsWith("FROM access.active_membership() AS m"), asked.values])).toEqual([[true, undefined]]);
    expect(found.map((membership) => [membership.membershipId, membership.company.name, membership.resolvedIn(tx)])).toEqual([
      [ROW.membership_id, "Testbolaget Alfa AB", true],
      [other.membership_id, "Testbolaget Beta AB", true],
    ]);
  });

  it("throws on a row that breaks the function's promise", async () => {
    await expect(activeMemberships(answering([ROW, { ...ROW, status: "invited" }]))).rejects.toThrow(
      new Error("The one membership function gave a membership that is invited, not active."),
    );
  });
});

describe("a company access", () => {
  it("is made from a membership, with the membership's company and admin level and its own copy of the permissions", async () => {
    const membership = await membershipOf({ ...ROW, admin_level: "admin" });
    const given = new Set(["company:read"]);
    const access = membership.access(given);
    expect(access).toBeInstanceOf(CompanyAccess);
    expect(fieldsOf(access)).toEqual({ companyId: COMPANY, membershipId: ROW.membership_id, personId: PERSON, adminLevel: "admin", permissions: ["company:read"] });
    given.add("test:write");
    expect(access.permissions).toEqual(["company:read"]);
    // Each permission once, in order.
    expect(membership.access(["test:write", "company:read", "test:write"]).permissions).toEqual(["company:read", "test:write"]);
  });

  it("and the membership never change", async () => {
    const membership = await membershipOf();
    const access = membership.access(["company:read"]);
    expect(Object.isFrozen(membership)).toBe(true);
    expect(Object.isFrozen(membership.company)).toBe(true);
    expect(Object.isFrozen(access)).toBe(true);
    expect(() => {
      (access as { companyId: string }).companyId = "another company";
    }).toThrow(TypeError);
    // Its permissions neither: no cast adds one, so authorize never grants what the session did not get.
    expect(Object.isFrozen(access.permissions)).toBe(true);
    expect(() => {
      (access.permissions as string[]).push("test:write");
    }).toThrow(TypeError);
    expect(access.permissions).toEqual(["company:read"]);
  });
});

describe("the constructors", () => {
  it("refuse every caller but resolve.ts", async () => {
    const membership = await membershipOf();
    expect(() => new ResolvedMembership(Symbol("made by resolve.ts"), ROW, answering([]))).toThrow(
      new Error("Only modules/memberships/resolve.ts makes a ResolvedMembership, from the one membership function's answer."),
    );
    expect(() => new CompanyAccess(Symbol("made by resolve.ts"), membership, ["company:read"])).toThrow(
      new Error("Only modules/memberships/resolve.ts makes a CompanyAccess, from a membership that the one membership function gave."),
    );
    expect(() => {
      Reflect.construct(CompanyAccess, [undefined, membership, []]);
    }).toThrow(Error);
  });
});
