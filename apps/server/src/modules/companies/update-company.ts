// SPDX-License-Identifier: AGPL-3.0-only

// updateCompany (issue 12, Companies 3): a system administrator changes the
// request's company: its name, its postal and visiting addresses and its
// contact details. A field left out stays as it is, and null takes a detail
// away. The organisation number is not part of the operation, and the
// database refuses its change from every role. The company's row is a
// company table's, so each change is in the behandlingshistorik; a change
// that changes nothing writes none.
//
// The row is locked first, FOR NO KEY UPDATE, and read after the lock, so
// two changes at once take turns, and each keeps the fields the other gave.

import { updateCompany, type Company } from "@nortfox/contract";
import { handleData, ok } from "../../api/operation.ts";
import { COMPANY_DETAIL_COLUMNS, readCompany, type CompanyDetail } from "./get-company.ts";

const DETAILS = Object.keys(COMPANY_DETAIL_COLUMNS) as CompanyDetail[];

/** The statement that writes the name and every detail: $1 is the name, and each detail follows in its order. */
const WRITE = `UPDATE ledger.companies SET name = $1, ${DETAILS.map((detail, index) => `${COMPANY_DETAIL_COLUMNS[detail]} = $${String(index + 2)}`).join(", ")}`;

export const updateCompanyHandler = handleData(updateCompany, async ({ tx }, { body }) => {
  await tx.query("SELECT 1 FROM ledger.companies FOR NO KEY UPDATE");
  const current = await readCompany(tx);
  const name = body.name ?? current.name;
  const values = DETAILS.map((detail) => (body[detail] === undefined ? (current[detail] ?? null) : body[detail]));
  if (name === current.name && DETAILS.every((detail, index) => values[index] === (current[detail] ?? null))) {
    return ok(current);
  }
  await tx.query(WRITE, [name, ...values]);
  const changed: Company = await readCompany(tx);
  return ok(changed);
});
