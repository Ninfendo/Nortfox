// SPDX-License-Identifier: AGPL-3.0-only

// R9 (issue 12, "Roles, admin levels, programs and permissions" 1, 9 and 10;
// What the law requires: BFNAR 2013:2 punkt 9.12). listPermissions gives
// every role, program, group and permission of the catalogue in the
// catalogue's order, with the view and manual-only marks, and each program's
// set with what Full behörighet holds: as the install holds it, so the
// systemdokumentation can say how an outside examiner gets access. Any
// signed-in person reads it, in a company or in none.

import { CATALOGUE_GROUPS, CATALOGUE_PERMISSIONS, CATALOGUE_PROGRAMS, PROGRAM_PERMISSIONS, ROLES, type PermissionCatalogue } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import {
  addSignInIdentity,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  getAs,
  jsonOf,
  signIn,
  signInApp,
  testClock,
  type SignInApp,
} from "../../../test/sign-in.ts";
import { apiCompany } from "../../../test/users.ts";

describe("listPermissions", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let pool: AppPool;
  let server: SignInApp;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    pool = appPool(db, 4);
    server = signInApp(pool.database, { clock: testClock() });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** The catalogue as the contract holds it, in the shape of listPermissions. */
  function contractCatalogue(): PermissionCatalogue {
    return {
      roles: ROLES.map((role) => ({ ...role })),
      programs: CATALOGUE_PROGRAMS.map((program) => ({
        key: program.key,
        label: program.label,
        ...(program.lifetimeDays === null ? {} : { lifetimeDays: program.lifetimeDays }),
        permissions: PROGRAM_PERMISSIONS.filter((row) => row.program === program.key).map((row) => ({ key: row.permission, full: row.inFull })),
      })),
      groups: CATALOGUE_GROUPS.map((group) => ({ ...group })),
      permissions: CATALOGUE_PERMISSIONS.map((permission) => ({ ...permission })),
    };
  }

  it("gives the catalogue in its order with the manual-only marks", async () => {
    const { session } = await signIn(server, await addSignInIdentity(owner));
    const catalogue = await jsonOf<PermissionCatalogue>(await getAs(server, session, "/v1/permissions"));
    expect(catalogue).toEqual(contractCatalogue());
    expect(catalogue.roles.map((role) => role.key)).toEqual(["owner", "admin", "bookkeeper", "approver", "viewer", "auditor"]);
    expect(catalogue.programs.map((program) => [program.key, program.label, program.lifetimeDays])).toEqual([
      ["bookkeeping", "Bokföring", undefined],
      ["approval-read", "Bokföring - Attest & Läs", undefined],
      ["read", "Läs", undefined],
      ["auditor", "Revisor", 30],
    ]);
    expect(catalogue.groups.map((group) => [group.key, group.kind, group.label])).toEqual([
      ["vouchers", "program", "Verifikationer"],
      ["supplier-invoices", "program", "Leverantörsfakturor"],
      ["reports", "reports", "Rapporter"],
      ["register", "register", "Register/Övrigt"],
    ]);
    expect(catalogue.permissions).toHaveLength(64);
    expect(catalogue.permissions.slice(0, 2)).toEqual([
      { key: "vouchers.view", group: "vouchers", label: "Verifikationer", view: true, manualOnly: false },
      { key: "vouchers.book", group: "vouchers", label: "Bokför", view: false, manualOnly: false },
    ]);
    expect(catalogue.permissions.filter((permission) => permission.manualOnly).map((permission) => permission.label)).toEqual([
      "Anonymisera räkenskapsår",
      "Hantera borttagna användare",
      "Radera behandlingshistorik",
    ]);
    expect(catalogue.permissions.filter((permission) => permission.view).map((permission) => permission.key)).toEqual(["vouchers.view", "supplier-invoices.view"]);
    // Full behörighet never holds a manual-only right.
    const manual = new Set(catalogue.permissions.filter((permission) => permission.manualOnly).map((permission) => permission.key));
    for (const program of catalogue.programs) {
      expect(program.permissions.filter((entry) => entry.full && manual.has(entry.key)), program.key).toEqual([]);
    }
    expect(catalogue.programs.find((program) => program.key === "auditor")?.permissions.filter((entry) => !entry.full)).toEqual([
      { key: "register.sie-export", full: false },
      { key: "register.export-files", full: false },
    ]);
  });

  it("gives what the install holds, not only what the contract holds", async () => {
    // A label that only the database has shows that the operation reads the install's catalogue.
    const superuser = await db.admin();
    await superuser.query("UPDATE access.catalogue_permissions SET label = 'Bokför (provad)' WHERE permission = 'vouchers.book'");
    try {
      const { session } = await signIn(server, await addSignInIdentity(owner));
      const catalogue = await jsonOf<PermissionCatalogue>(await getAs(server, session, "/v1/permissions"));
      expect(catalogue.permissions[1]).toEqual({ key: "vouchers.book", group: "vouchers", label: "Bokför (provad)", view: false, manualOnly: false });
    } finally {
      await superuser.query("UPDATE access.catalogue_permissions SET label = 'Bokför' WHERE permission = 'vouchers.book'");
    }
  });

  it("gives the same to any signed-in person, in a company or in none, and asks for a session", async () => {
    const company = await apiCompany(server, { app, owner });
    const inCompany = await jsonOf<PermissionCatalogue>(await getAs(server, company.session, "/v1/permissions"));
    expect(inCompany).toEqual(contractCatalogue());
    const anonymous = await server.send("/v1/permissions", { method: "GET" });
    expect(anonymous.status).toBe(401);
    expect(((await anonymous.json()) as ProblemBody).code).toBe("authentication-required");
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
