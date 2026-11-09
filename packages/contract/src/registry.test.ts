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

  it("holds getHealth and getCompany, the browser's sign-in, the person's own operations, the companies, the catalogue, the users and their programs, and the invitations", () => {
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
      ["updateCompany", "PATCH /v1/company", "company:update", { assistant: false, writes: true, list: false, session: null, company: "credential", personalOutput: [] }],
      ["listPermissions", "GET /v1/permissions", "signed-in", { assistant: false, writes: false, list: false, session: null, company: "none", personalOutput: [] }],
      [
        "listUsers",
        "GET /v1/users",
        "users:read",
        { assistant: false, writes: false, list: true, session: null, company: "credential", personalOutput: ["/items/*/name", "/items/*/workEmail", "/items/*/workPhone"] },
      ],
      [
        "getUser",
        "GET /v1/users/{memberId}",
        "users:read",
        { assistant: false, writes: false, list: false, session: null, company: "credential", personalOutput: ["/name", "/workEmail", "/workPhone"] },
      ],
      [
        "updateUser",
        "PATCH /v1/users/{memberId}",
        "users:admin",
        { assistant: false, writes: true, list: false, session: null, company: "credential", personalOutput: ["/name", "/workEmail", "/workPhone"] },
      ],
      ["removeUser", "DELETE /v1/users/{memberId}", "users:admin", { assistant: false, writes: true, list: false, session: null, company: "credential", personalOutput: [] }],
      [
        "assignProgram",
        "PUT /v1/users/{memberId}/programs/{program}",
        "programs:grant",
        { assistant: false, writes: true, list: false, session: null, company: "credential", personalOutput: [] },
      ],
      [
        "removeProgram",
        "DELETE /v1/users/{memberId}/programs/{program}",
        "programs:grant",
        { assistant: false, writes: true, list: false, session: null, company: "credential", personalOutput: [] },
      ],
      [
        "moveProgram",
        "POST /v1/users/{memberId}/programs/{program}/move",
        "programs:grant",
        { assistant: false, writes: true, list: false, session: null, company: "credential", personalOutput: [] },
      ],
      [
        "updateUserRights",
        "PUT /v1/users/{memberId}/rights",
        "programs:grant",
        { assistant: false, writes: true, list: false, session: null, company: "credential", personalOutput: [] },
      ],
      [
        "inviteUser",
        "POST /v1/users",
        "users:admin",
        { assistant: false, writes: true, list: false, session: null, company: "credential", personalOutput: ["/name", "/workEmail", "/workPhone"] },
      ],
      [
        "resendInvitation",
        "POST /v1/users/{memberId}/invitation",
        "users:admin",
        { assistant: false, writes: true, list: false, session: null, company: "credential", personalOutput: [] },
      ],
      [
        "disconnectUserIdentity",
        "POST /v1/users/{memberId}/disconnect",
        "users:admin",
        { assistant: false, writes: true, list: false, session: null, company: "credential", personalOutput: ["/name", "/workEmail", "/workPhone"] },
      ],
      [
        "getInvitation",
        "GET /v1/invitations/{token}",
        "none",
        { assistant: false, writes: false, list: false, session: "flow", company: "none", personalOutput: ["/name", "/email", "/inviterName"] },
      ],
      [
        "acceptInvitation",
        "POST /v1/invitations/{token}/accept",
        "none",
        {
          assistant: false,
          writes: true,
          list: false,
          session: "flow",
          company: "none",
          personalOutput: ["/user/name", "/user/email", "/membership/workEmail", "/membership/workPhone"],
        },
      ],
      [
        "leaveCompany",
        "POST /v1/me/companies/{companyId}/leave",
        "signed-in",
        { assistant: false, writes: true, list: false, session: null, company: { input: "companyId" }, personalOutput: [] },
      ],
    ]);
  });

  it("gives each operation its MCP tool text", () => {
    expect(Object.fromEntries(REGISTRY.map((entry) => [entry.operationId, entry["x-nortfox"].tool]))).toEqual({
      getHealth: "Checks that the NortFox server is up, and gives its version. It reads no data.",
      getCompany: "Gives the company you work in: its id, name, organisation number and database number. Each tool that needs a permission works in this company too, and a tool that takes a companyId works in the company it names.",
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
      updateCompany: "Changes the company you work in: its name, its addresses, its phone number and its e-mail address. Its organisation number never changes.",
      listPermissions:
        "Gives the permission catalogue: the roles, the programs with their sets, the groups and every permission in order, with the view and manual-only marks.",
      listUsers: "Lists the users of the company you work in, with their status, admin level and programs. A program administrator sees only the programs they administer.",
      getUser: "Gives one user of the company you work in, by the member's id.",
      updateUser:
        "Changes a user of the company you work in: whether they are active, their system administrator's level, the programs they administer, their idle logout and their work contacts.",
      removeUser: "Removes a user from the company you work in. You cannot remove yourself.",
      assignProgram: "Grants a program to a user of the company you work in, with Full behörighet or with a list of its rights.",
      removeProgram: "Takes a program from a user of the company you work in.",
      moveProgram: "Moves a program from one user of the company you work in to another, narrowed first if you give a list of its rights.",
      updateUserRights: "Sets the Rapporter and Register/Övrigt rights of a user of the company you work in.",
      inviteUser: "Invites a person to the company you work in, with a name and an e-mail address: the invitation goes to that address by mail.",
      resendInvitation: "Sends a new invitation to a user of the company you work in who has not accepted theirs, and stops the old link.",
      disconnectUserIdentity:
        "Disconnects the identity of a user of the company you work in, and sends the user a new invitation that a new or an existing identity may accept.",
      getInvitation: "Reads an invitation by its link. It serves the browser's sign-in, so this tool refuses every call.",
      acceptInvitation: "Accepts an invitation by its link. It serves the browser's sign-in, so this tool refuses every call.",
      leaveCompany: "Leaves a company where you are an active member. Only a new invitation lets you back.",
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
      "company:read": "Read the company: its id, name, organisation number, tenant id, addresses and contact details.",
      "company:update": "Change the company's name, addresses and contact details. Its organisation number never changes.",
      "users:read":
        "Read the company's users: each member's status, admin level, idle logout, work contacts and programs. A program administrator sees only the programs they administer.",
      "users:admin":
        "Run the company's users: invite a person and send a new invitation, activate and deactivate a member, make a member system administrator or no longer one, appoint program administrators, set a member's idle logout and work contacts, disconnect a member's identity, and remove a member.",
      "programs:grant":
        "Grant, narrow, move and remove the members' programs, and set their Rapporter and Register/Övrigt rights. A program administrator does it only for the programs they administer.",
    });
  });

  it("is what the package exports", () => {
    expect(contract.REGISTRY).toBe(REGISTRY);
  });
});
