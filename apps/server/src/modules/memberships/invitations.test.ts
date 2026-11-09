// SPDX-License-Identifier: AGPL-3.0-only

// Two faults of the server that no request meets: a link that the database
// does not make for an invitation that the request has just made, and an
// active member with no work e-mail address to invite again after a
// disconnect. Each throws, so the request answers 500 and nothing commits.
// The transactions here are made up and answer by statement;
// invitations.db.test.ts and disconnect.db.test.ts run on PostgreSQL.

import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import type { Queryable } from "../../db/database.ts";
import { addInvitation } from "./invitations.ts";
import { invitedAgain } from "./members.ts";

/** A transaction that answers each statement with the rows of the first text it holds, and none for any other. */
function answering(rows: Readonly<Record<string, readonly unknown[]>>): Queryable {
  return {
    query: <Row extends QueryResultRow>(statement: string) => {
      const found = Object.entries(rows).find(([text]) => statement.includes(text));
      return Promise.resolve({ rows: found?.[1] ?? [] } as unknown as QueryResult<Row>);
    },
  };
}

describe("an invitation's link", () => {
  it("throws when the database makes none for the invitation the request just made", async () => {
    const tx = answering({
      "INSERT INTO access.invitations": [{ id: "6f1e2d3c-4b5a-4987-a654-3210fedcba98" }],
      "FROM ledger.companies": [{ name: "Testbolaget Alfa AB" }],
      "FROM access.identities": [{ name: "Alva Berg" }],
      issue_invitation_link: [{ made: false }],
    });
    await expect(
      addInvitation(tx, "5d1e7c3a-9b2f-4e8d-a6c4-1f0e2d3c4b5a", "4f3e2d1c-0b9a-4876-9543-210fedcba987", { name: "Karin Lund", email: "karin.lund@example.com" }, new Date()),
    ).rejects.toThrow("The database made no link of the invitation that the request just made.");
  });
});

describe("a disconnect", () => {
  it("throws for a member with no work e-mail address, and changes nothing", async () => {
    const statements: string[] = [];
    const tx: Queryable = {
      query: <Row extends QueryResultRow>(statement: string) => {
        statements.push(statement);
        return Promise.resolve({ rows: [] } as unknown as QueryResult<Row>);
      },
    };
    const member = {
      id: "4f3e2d1c-0b9a-4876-9543-210fedcba987",
      companyId: "5d1e7c3a-9b2f-4e8d-a6c4-1f0e2d3c4b5a",
      userId: "7a6b5c4d-3e2f-4109-8877-665544332211",
      status: "active",
      adminLevel: null,
      idleTimeoutMinutes: 120,
    } as const;
    await expect(invitedAgain(tx, member)).rejects.toThrow(
      "The member 4f3e2d1c-0b9a-4876-9543-210fedcba987 has no person with a work e-mail address in the company to invite again.",
    );
    expect(statements).toHaveLength(1);
  });
});
