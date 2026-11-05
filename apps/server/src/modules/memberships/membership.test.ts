// SPDX-License-Identifier: AGPL-3.0-only

// A membership that a request names is in its company: the one membership
// function or the credential gave it. One the transaction's company does not
// hold is a fault of the server, which throws and names the membership.
// update-my-membership.db.test.ts and company-choice.db.test.ts read and
// change memberships on PostgreSQL.

import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import type { Queryable } from "../../db/database.ts";
import { readMembership } from "./membership.ts";

describe("readMembership", () => {
  it("gives an invited membership with no person, no admin level and no work contacts", async () => {
    const row = {
      company_id: "5d1e7c3a-9b2f-4e8d-a6c4-1f0e2d3c4b5a",
      user_id: null,
      status: "invited",
      admin_level: null,
      idle_timeout_minutes: 120,
      work_email: null,
      work_phone: null,
    };
    const answering: Queryable = { query: <Row extends QueryResultRow>() => Promise.resolve({ rows: [row] } as unknown as QueryResult<Row>) };
    expect(await readMembership(answering, "4f3e2d1c-0b9a-4876-9543-210fedcba987")).toEqual({ companyId: row.company_id, status: "invited", idleTimeout: 120 });
  });

  it("throws for a membership that the transaction's company does not hold", async () => {
    const empty: Queryable = { query: <Row extends QueryResultRow>() => Promise.resolve({ rows: [] } as unknown as QueryResult<Row>) };
    await expect(readMembership(empty, "4f3e2d1c-0b9a-4876-9543-210fedcba987")).rejects.toThrow(
      "The membership 4f3e2d1c-0b9a-4876-9543-210fedcba987 is not in the transaction's company.",
    );
  });
});
