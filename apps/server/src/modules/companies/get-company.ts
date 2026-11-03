// SPDX-License-Identifier: AGPL-3.0-only

import { getCompany } from "@nortfox/contract";
import { handleData, ok } from "../../api/operation.ts";

interface CompanyRow {
  readonly id: string;
  readonly name: string;
  readonly organization_number: string;
  readonly database_number: number;
}

/**
 * Serves getCompany: the request's own company from 2a's company table. The
 * query has no company condition: row level security, by the transaction's
 * company, keeps it to that one row (decision 9). A company the database
 * does not hold is a fault of the server, since the credential named it.
 */
export const getCompanyHandler = handleData(getCompany, async ({ tx }) => {
  const found = await tx.query<CompanyRow>("SELECT company_id AS id, name, organization_number, database_number FROM ledger.companies");
  const [row] = found.rows;
  if (row === undefined) {
    throw new Error("The request's company is not in ledger.companies.");
  }
  return ok({ id: row.id, name: row.name, organizationNumber: row.organization_number, databaseNumber: row.database_number });
});
