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

  it("holds getHealth and getCompany, then the browser's sign-in and the person's own operations", () => {
    const signIn = (tool: string, writes: boolean) => ({ permission: "none", tool, assistant: false, writes, list: false, session: "flow", company: "none" });
    const signedIn = (tool: string, writes: boolean, session: "flow" | null) => ({
      permission: "signed-in",
      tool,
      assistant: false,
      writes,
      list: false,
      session,
      company: "none",
    });
    expect(REGISTRY.slice(2).map((entry) => [entry.operationId, entry.method, entry.path, entry["x-nortfox"]])).toEqual([
      ["completeSetup", "post", "/v1/setup/{token}", signIn("Makes the first identity of an empty install. It serves the browser's sign-in, so this tool refuses every call.", true)],
      [
        "loginWithPassword",
        "post",
        "/v1/auth/password",
        signIn("Signs a browser in with a password. It serves the browser's sign-in, so this tool refuses every call: an MCP client signs in through OAuth.", true),
      ],
      [
        "verifyTotp",
        "post",
        "/v1/auth/totp",
        signIn("Gives the TOTP code of a browser's sign-in. It serves the browser's sign-in, so this tool refuses every call: an MCP client signs in through OAuth.", true),
      ],
      ["logout", "post", "/v1/auth/logout", signedIn("Signs a browser out. It serves the browser's session, so this tool refuses every call.", true, "flow")],
      [
        "getSession",
        "get",
        "/v1/session",
        signedIn("Reads the browser's session. It serves the browser's sign-in, so this tool refuses every call: an MCP client signs in through OAuth.", false, "flow"),
      ],
      [
        "getMe",
        "get",
        "/v1/me",
        signedIn(
          "Gives the person you act as: their name, e-mail address, language, personnummer and mobile number when set, and how often a sign-in asks for a TOTP code.",
          false,
          null,
        ),
      ],
    ]);
  });

  it("starts with getHealth and getCompany", () => {
    expect(REGISTRY.slice(0, 2).map((entry) => [entry.operationId, entry.method, entry.path, entry["x-nortfox"]])).toEqual([
      [
        "getHealth",
        "get",
        "/v1/health",
        {
          permission: "public",
          tool: "Checks that the NortFox server is up, and gives its version. It reads no data.",
          assistant: false,
          writes: false,
          list: false,
          session: null,
          company: "none",
        },
      ],
      [
        "getCompany",
        "get",
        "/v1/company",
        {
          permission: "company:read",
          tool: "Gives the company you work in: its id, name, organisation number and database number. Every other tool works in this company too.",
          assistant: true,
          writes: false,
          list: false,
          session: null,
          company: "credential",
        },
      ],
    ]);
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
