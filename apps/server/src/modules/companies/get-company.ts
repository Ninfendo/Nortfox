// SPDX-License-Identifier: AGPL-3.0-only

import { getCompany, type Company } from "@nortfox/contract";
import { handleData, ok } from "../../api/operation.ts";
import type { Queryable } from "../../db/database.ts";

interface CompanyRow {
  readonly id: string;
  readonly name: string;
  readonly organization_number: string;
  readonly database_number: number;
}

/**
 * The transaction's company from 2a's company table. The query has no
 * company condition: row level security, by the transaction's company, keeps
 * it to that one row (decision 9). A company the database does not hold is a
 * fault of the server, since the credential or the one membership function
 * named it.
 */
export async function readCompany(tx: Queryable): Promise<Company> {
  const found = await tx.query<CompanyRow>("SELECT company_id AS id, name, organization_number, database_number FROM ledger.companies");
  const [row] = found.rows;
  if (row === undefined) {
    throw new Error("The request's company is not in ledger.companies.");
  }
  return { id: row.id, name: row.name, organizationNumber: row.organization_number, databaseNumber: row.database_number };
}

/** Serves getCompany: the request's own company. */
export const getCompanyHandler = handleData(getCompany, async ({ tx }) => ok(await readCompany(tx)));
