// SPDX-License-Identifier: AGPL-3.0-only

// What the companies' operations say they give. getCompany gives the
// company's addresses and contact details when they are set, and its texts
// say so, in the API's description and to an MCP client. The company lists
// give each company's id, name, organisation number and tenant id, and
// their schema names those alone, so a detail that is not in a list is not
// read as one that is not set.

import { describe, expect, it } from "vitest";
import { Company, CompanyChoice, CompanySummary, getCompany } from "./companies.ts";

describe("the companies' operations", () => {
  it("say that getCompany gives the addresses and the contact details", () => {
    for (const text of [getCompany.description, getCompany["x-nortfox"].tool]) {
      expect(text).toContain("postal and visiting addresses");
      expect(text).toContain("phone number and e-mail address");
    }
  });

  it("give the company lists a company's id, name, organisation number and tenant id, and no detail", () => {
    expect(Object.keys(CompanyChoice.shape.company.shape)).toEqual(["id", "name", "organizationNumber", "databaseNumber"]);
    expect(CompanyChoice.shape.company).toBe(CompanySummary);
    expect(Object.keys(Company.shape).slice(0, 4)).toEqual(Object.keys(CompanySummary.shape));
  });
});
