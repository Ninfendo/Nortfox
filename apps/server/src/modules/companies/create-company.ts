// SPDX-License-Identifier: AGPL-3.0-only

// createCompany (issue 12, Companies 1 and 2; open point 12): any signed-in
// person makes a company, and becomes its owner, a system administrator, in
// the same transaction. The runner works in a new company for the handler,
// whose id the database layer picks (company source new), so the company's
// rows pass their company policies. The database gives the company its
// tenant id from one sequence, which never gives a number out again, also
// when the transaction rolls back, and refuses the commit of a company
// without an active system administrator. The person's Kontoaktivitet gets
// the company made. The idempotency key is kept per person, since the
// company is new on each try.

import { createCompany, type Company } from "@nortfox/contract";
import { handlePerson, newCompanyId, ok } from "../../api/operation.ts";
import { addAccountEvent } from "../auth/account-events.ts";
import { addOwner } from "../memberships/membership.ts";

export const createCompanyHandler = handlePerson(createCompany, async ({ context, tx, company }, { body }) => {
  const companyId = newCompanyId(company);
  const made = await tx.query<{ database_number: number }>(
    "INSERT INTO ledger.companies (company_id, name, organization_number) VALUES ($1, $2, $3) RETURNING database_number",
    [companyId, body.name, body.organizationNumber],
  );
  // An insert gives its one row.
  const [row] = made.rows as [{ readonly database_number: number }];
  await addOwner(tx, companyId, context.personId);
  await addAccountEvent(tx, context.personId, { kind: "company-created", details: { companyId, name: body.name } });
  const answer: Company = { id: companyId, name: body.name, organizationNumber: body.organizationNumber, databaseNumber: row.database_number };
  return ok(answer);
});
