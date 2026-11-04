// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import * as contract from "./index.ts";
import { PERMISSIONS } from "./operation.ts";
import { REGISTRY } from "./registry.ts";
import { registryProblems } from "./registry-guard.ts";

describe("REGISTRY", () => {
  it("passes the registry guard", () => {
    expect(registryProblems(REGISTRY, Object.keys(PERMISSIONS))).toEqual([]);
  });

  it("holds getHealth and getCompany, the browser's sign-in, the person's own operations, and the companies", () => {
    expect(
      REGISTRY.map((entry) => {
        const { permission, assistant, writes, list, session, company, personalOutput } = entry["x-nortfox"];
        return [entry.operationId, `${entry.method.toUpperCase()} ${entry.path}`, permission, { assistant, writes, list, session, company, personalOutput }];
      }),
    ).toEqual([
      ["getHealth", "GET /v1/health", "public", { assistant: false, writes: false, list: false, session: null, company: "none", personalOutput: [] }],
      ["getCompany", "GET /v1/company", "company:read", { assistant: true, writes: false, list: false, session: null, company: "credential", personalOutput: [] }],
      [
        "completeSetup",
        "POST /v1/setup/{token}",
        "none",
        { assistant: false, writes: true, list: false, session: "flow", company: "none", personalOutput: ["/user/name", "/user/email"] },
      ],
      ["loginWithPassword", "POST /v1/auth/password", "none", { assistant: false, writes: true, list: false, session: "flow", company: "none", personalOutput: [] }],
      ["verifyTotp", "POST /v1/auth/totp", "none", { assistant: false, writes: true, list: false, session: "flow", company: "none", personalOutput: [] }],
      ["logout", "POST /v1/auth/logout", "signed-in", { assistant: false, writes: true, list: false, session: "flow", company: "none", personalOutput: [] }],
      [
        "getSession",
        "GET /v1/session",
        "signed-in",
        { assistant: false, writes: false, list: false, session: "flow", company: "current", personalOutput: ["/user/name", "/user/email"] },
      ],
      [
        "getMe",
        "GET /v1/me",
        "signed-in",
        {
          assistant: false,
          writes: false,
          list: false,
          session: null,
          company: "current",
          personalOutput: ["/user/name", "/user/email", "/personalIdentityNumber", "/mobile", "/membership/workEmail", "/membership/workPhone"],
        },
      ],
      ["createCompany", "POST /v1/companies", "signed-in", { assistant: false, writes: true, list: false, session: null, company: "new", personalOutput: [] }],
      ["listCompanies", "GET /v1/companies", "signed-in", { assistant: false, writes: false, list: true, session: null, company: "none", personalOutput: [] }],
      [
        "listRecentCompanies",
        "GET /v1/me/companies/recent",
        "signed-in",
        { assistant: false, writes: false, list: false, session: null, company: "none", personalOutput: [] },
      ],
      [
        "selectCompany",
        "POST /v1/session/company",
        "signed-in",
        { assistant: false, writes: true, list: false, session: "flow", company: { input: "companyId" }, personalOutput: ["/user/name", "/user/email"] },
      ],
      [
        "updateMyMembership",
        "PATCH /v1/me/companies/{companyId}",
        "signed-in",
        { assistant: false, writes: true, list: false, session: null, company: { input: "companyId" }, personalOutput: ["/workEmail", "/workPhone"] },
      ],
    ]);
  });

  it("gives each operation its MCP tool text", () => {
    expect(Object.fromEntries(REGISTRY.map((entry) => [entry.operationId, entry["x-nortfox"].tool]))).toEqual({
      getHealth: "Checks that the NortFox server is up, and gives its version. It reads no data.",
      getCompany: "Gives the company you work in: its id, name, organisation number and database number. Every other tool works in this company too.",
      completeSetup: "Makes the first identity of an empty install. It serves the browser's sign-in, so this tool refuses every call.",
      loginWithPassword: "Signs a browser in with a password. It serves the browser's sign-in, so this tool refuses every call: an MCP client signs in through OAuth.",
      verifyTotp: "Gives the TOTP code of a browser's sign-in. It serves the browser's sign-in, so this tool refuses every call: an MCP client signs in through OAuth.",
      logout: "Signs a browser out. It serves the browser's session, so this tool refuses every call.",
      getSession: "Reads the browser's session. It serves the browser's sign-in, so this tool refuses every call: an MCP client signs in through OAuth.",
      getMe:
        "Gives the person you act as: their name, e-mail address, language, personnummer and mobile number when set, and how often a sign-in asks for a TOTP code; " +
        "and the company you work in, with your membership and permissions there.",
      createCompany: "Creates a company and makes you its owner. Its organisation number never changes.",
      listCompanies: "Lists the companies where you are an active member, with your system administrator's level in each.",
      listRecentCompanies: "Gives the three companies you chose last, where you are still an active member.",
      selectCompany:
        "Chooses the browser session's company. It serves the browser's sign-in, so this tool refuses every call: an MCP client signs in through OAuth.",
      updateMyMembership: "Changes your own work e-mail address, work phone number and idle logout in a company where you are an active member.",
    });
  });

  it("uses every permission on the list, so none is dead", () => {
    const used = new Set(REGISTRY.map((entry) => entry["x-nortfox"].permission));
    for (const permission of Object.keys(PERMISSIONS)) {
      expect(used).toContain(permission);
    }
  });

  it("describes each permission in a sentence", () => {
    expect(PERMISSIONS).toEqual({
      "company:read": "Read the company: its id, name, organisation number and tenant id.",
    });
  });

  it("is what the package exports", () => {
    expect(contract.REGISTRY).toBe(REGISTRY);
  });
});
