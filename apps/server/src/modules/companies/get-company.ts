// SPDX-License-Identifier: AGPL-3.0-only

import { getCompany, type Company } from "@nortfox/contract";
import { handleData, ok } from "../../api/operation.ts";
import type { Queryable } from "../../db/database.ts";

/** The company's details as the API names them, each with its column. */
export const COMPANY_DETAIL_COLUMNS = {
  address: "address",
  zipCode: "zip_code",
  city: "city",
  countryCode: "country_code",
  visitAddress: "visit_address",
  visitZipCode: "visit_zip_code",
  visitCity: "visit_city",
  visitCountryCode: "visit_country_code",
  phone: "phone",
  email: "email",
} as const;

export type CompanyDetail = keyof typeof COMPANY_DETAIL_COLUMNS;

const DETAILS = Object.keys(COMPANY_DETAIL_COLUMNS) as CompanyDetail[];

type CompanyRow = { readonly id: string; readonly name: string; readonly organization_number: string; readonly database_number: number } & Readonly<
  Record<CompanyDetail, string | null>
>;

/** The columns of a company, each detail by its name in the API. */
const COLUMNS = [
  "company_id AS id",
  "name",
  "organization_number",
  "database_number",
  ...DETAILS.map((detail) => `${COMPANY_DETAIL_COLUMNS[detail]} AS "${detail}"`),
].join(", ");

/**
 * The transaction's company from 2a's company table, with the details that
 * are set. The query has no company condition: row level security, by the
 * transaction's company, keeps it to that one row (decision 9). A company
 * the database does not hold is a fault of the server, since the credential
 * or the one membership function named it.
 */
export async function readCompany(tx: Queryable): Promise<Company> {
  const found = await tx.query<CompanyRow>(`SELECT ${COLUMNS} FROM ledger.companies`);
  const [row] = found.rows;
  if (row === undefined) {
    throw new Error("The request's company is not in ledger.companies.");
  }
  const details = Object.fromEntries(DETAILS.flatMap((detail) => (row[detail] === null ? [] : [[detail, row[detail]]])));
  return { id: row.id, name: row.name, organizationNumber: row.organization_number, databaseNumber: row.database_number, ...details };
}

/** Serves getCompany: the request's own company. */
export const getCompanyHandler = handleData(getCompany, async ({ tx }) => ok(await readCompany(tx)));
