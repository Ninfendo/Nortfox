// SPDX-License-Identifier: AGPL-3.0-only

// F6 and R1 (issue 12, "Done when"), generated from the registry: every
// operation that needs a permission is called by every member below, by
// REST and by MCP. Each member who lacks the operation's permission is
// refused with 403 permission-missing, which names that permission, and the
// call changes nothing. Each member who holds it passes the check: a read
// answers, and a write, sent with one field too many, gets past the
// permission to the check of its input, which refuses it, so nothing
// changes.
//
// The operations: every operation of the registry whose permission is one
// of the contract's, and one test-only read for each permission of the
// catalogue (test/rights.ts), since no operation of slice 2c needs a
// catalogue permission yet. Each later part's operations come in by
// themselves; the first test pins the list, so a change shows.
//
// The members, each a real member of one company, made through the
// operations, never built by hand:
//
// - the six roles of "Roles, admin levels, programs and permissions": the
//   owner, who made the company with createCompany; the admin, an invited
//   member made system administrator with updateUser; and the bookkeeper,
//   the approver, the viewer and the auditor, invited members given their
//   program with assignProgram and Full behörighet;
// - R1's smallest sets: for each permission of the catalogue, an invited
//   member who holds it alone, or with its group's view permission where the
//   view rule asks for it, granted with assignProgram in the first program
//   whose set holds it; a plain member, who holds a member's own; and a
//   program administrator, appointed with updateUser, who holds a program
//   administrator's. The system administrator's are the owner's and the
//   admin's, above.
//
// What each member holds is written here from the issue's words, and getMe
// must give exactly that before the calls. Each member's session chooses the
// company after its grants, so it holds them.
//
// Until MCP's OAuth comes (a later part of slice 2c), the MCP calls carry
// the member's session token as a bearer token, and the test's resolver
// gives the session's principal on /mcp (sessionsOnMcp). That later part
// changes these calls to real MCP tokens.

import {
  CATALOGUE_PERMISSIONS,
  PERMISSIONS,
  PROGRAMS,
  REGISTRY,
  fullPermissions,
  programPermissions,
  viewPermissionOf,
  type CataloguePermissionKey,
  type Me,
  type Operation,
  type Program,
} from "@nortfox/contract";
import type { Client as McpClient } from "@modelcontextprotocol/client";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, callTool, mcpClient, problemIn, type AppPool } from "../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../test/database.ts";
import { OPERATION_ARGUMENTS, restRequestOf, type ArgumentsFixture } from "../../test/operation-arguments.ts";
import { rightCheck, withRightChecks } from "../../test/rights.ts";
import {
  TEST_ORIGIN,
  cookieHeader,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  getAs,
  jsonOf,
  signInApp,
  testClock,
  type SignInApp,
  type TestIdentity,
} from "../../test/sign-in.ts";
import { apiCompany, calls, invite, newMember, sessionIn, type ApiCompany, type TestMember } from "../../test/users.ts";

/** Every permission of the catalogue, in its order. */
const CATALOGUE: readonly CataloguePermissionKey[] = CATALOGUE_PERMISSIONS.map((permission) => permission.key);

/** The test-only read of each permission of the catalogue. */
const RIGHT_CHECKS: readonly Operation[] = CATALOGUE.map((permission) => rightCheck(permission).operation);

/** Every operation of the registry that needs a permission in a company, then the test-only reads. */
const OPERATIONS: readonly Operation[] = [
  ...REGISTRY.filter((operation) => Object.hasOwn(PERMISSIONS, operation["x-nortfox"].permission)),
  ...RIGHT_CHECKS,
];

/** What every active member holds (issue 12, "Roles, admin levels, programs and permissions" 2): they read the company. */
const MEMBER = ["company:read"];

/** What a system administrator holds, the owner and the admin alike: a member's own, the company's details, its users and their programs. */
const SYSTEM_ADMINISTRATOR = [...MEMBER, "company:update", "users:read", "users:admin", "programs:grant"];

/** What a program administrator holds: a member's own, and the users and the grants of their programs. */
const PROGRAM_ADMINISTRATOR = [...MEMBER, "users:read", "programs:grant"];

/** How a member comes to hold their permissions, through the operations. */
type Making =
  | { readonly kind: "owner" }
  | { readonly kind: "admin" }
  | { readonly kind: "member" }
  | { readonly kind: "program-administrator"; readonly program: Program }
  | { readonly kind: "full"; readonly program: Program }
  | { readonly kind: "rights"; readonly program: Program; readonly permissions: readonly CataloguePermissionKey[] };

/** A member of the test: what it is called, how it is made, and every permission it holds. */
interface Holder {
  readonly name: string;
  readonly making: Making;
  readonly holds: readonly string[];
}

/** The plan's six roles (issue 12, "Roles, admin levels, programs and permissions" 1). */
const SIX_ROLES: readonly Holder[] = [
  { name: "the owner", making: { kind: "owner" }, holds: SYSTEM_ADMINISTRATOR },
  { name: "the admin", making: { kind: "admin" }, holds: SYSTEM_ADMINISTRATOR },
  { name: "the bookkeeper", making: { kind: "full", program: "bookkeeping" }, holds: [...MEMBER, ...fullPermissions("bookkeeping")] },
  { name: "the approver", making: { kind: "full", program: "approval-read" }, holds: [...MEMBER, ...fullPermissions("approval-read")] },
  { name: "the viewer", making: { kind: "full", program: "read" }, holds: [...MEMBER, ...fullPermissions("read")] },
  { name: "the auditor", making: { kind: "full", program: "auditor" }, holds: [...MEMBER, ...fullPermissions("auditor")] },
];

/** The first program whose set holds `permission`. */
function firstProgramOf(permission: CataloguePermissionKey): Program {
  const program = PROGRAMS.find((candidate) => programPermissions(candidate).includes(permission));
  if (program === undefined) {
    throw new Error(`No program holds ${permission}.`);
  }
  return program;
}

/** The smallest set a real member can hold with `permission`: it alone, or with its group's view permission where the view rule asks for it. */
function smallestSet(permission: CataloguePermissionKey): readonly CataloguePermissionKey[] {
  const view = viewPermissionOf(permission);
  return view === null || view === permission ? [permission] : [view, permission];
}

/** R1's members: one for each smallest set of the catalogue, a plain member and a program administrator. */
const SMALLEST_SETS: readonly Holder[] = [
  ...CATALOGUE.map((permission): Holder => {
    const set = smallestSet(permission);
    return {
      name: set.length === 1 ? `a member who holds ${permission} alone` : `a member who holds ${permission} with ${set[0] ?? ""}`,
      making: { kind: "rights", program: firstProgramOf(permission), permissions: set },
      holds: [...MEMBER, ...set],
    };
  }),
  { name: "a plain member", making: { kind: "member" }, holds: MEMBER },
  { name: "a program administrator", making: { kind: "program-administrator", program: "bookkeeping" }, holds: PROGRAM_ADMINISTRATOR },
];

/** The answer of an operation to an actor who lacks its permission. */
function permissionMissing(permission: string): Record<string, unknown> {
  return {
    type: "about:blank",
    title: "Forbidden",
    status: 403,
    detail: `The actor lacks the permission ${permission}, which this operation needs.`,
    code: "permission-missing",
    permission,
  };
}

/**
 * The answer of an operation to a holder whose input has one field too many,
 * /probe: by REST a query parameter the operation does not declare, and by
 * MCP an argument it does not take.
 */
function probeRefused(code: "unknown-parameter" | "unknown-field"): Record<string, unknown> {
  return {
    status: 400,
    code: "invalid-request",
    errors: expect.arrayContaining([expect.objectContaining({ code, pointer: "/probe" })]) as unknown,
  };
}

describe("every operation and every role", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  /** Reads every row past row level security, for the check that nothing changed. */
  let superuser: Client;
  let pool: AppPool;
  let server: SignInApp;
  let company: ApiCompany;
  /** The members that the operations' arguments name: one with no program, one with Läs, and one invited. */
  let target: TestMember;
  let reader: TestMember;
  let invited: string;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    superuser = await db.admin();
    pool = appPool(db, 4);
    // The database stamps an invitation's time with its own clock, so the server's starts at the same time.
    server = signInApp(pool.database, { clock: testClock(new Date()), mcpSessions: "on", options: withRightChecks(CATALOGUE) });
    company = await apiCompany(server, { app, owner });
    target = await newMember(server, { app, owner }, company);
    reader = await newMember(server, { app, owner }, company);
    await jsonOf(await calls.assignProgram(server, company.session, reader.id, "read", { full: true }));
    invited = (await invite(server, company.session, "tove.ny@example.com", "Tove Ny")).id;
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** The arguments' fixture: the members above, in the one company. */
  const fixture: ArgumentsFixture = {
    setupToken: () => Promise.reject(new Error("No operation with a permission takes a setup link.")),
    person: () => Promise.reject(new Error("No operation with a permission takes a new person.")),
    challenge: () => Promise.reject(new Error("No operation with a permission takes a login challenge.")),
    companyOf: () => Promise.resolve(company.id),
    memberOf: (_person, program) => Promise.resolve(program === undefined ? target.id : reader.id),
    invitedOf: () => Promise.resolve(invited),
    invitationToken: () => Promise.reject(new Error("No operation with a permission takes an invitation's link.")),
    joinedCompanyOf: () => Promise.reject(new Error("No operation with a permission takes another company.")),
  };

  /** Arguments of `operation` that succeed for a holder: the test-only reads take none. */
  async function argumentsOf(operation: Operation, person: TestIdentity): Promise<Readonly<Record<string, unknown>>> {
    const of = OPERATION_ARGUMENTS[operation.operationId];
    return of === undefined ? {} : of(fixture, person);
  }

  /** What the company holds that an operation of the registry writes: a refused call leaves it as it was. */
  async function companyRows(): Promise<string> {
    const found = await superuser.query<{ rows: string }>(
      `SELECT pg_catalog.jsonb_build_array(
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.company_id) FROM ledger.companies AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.memberships AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.contact_company_id, t.membership_id) FROM access.membership_contacts AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.program_grants AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.program_admins AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.invitations AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.invitation_links AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.events AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.idempotency_keys AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM ledger.idempotency_keys AS t),
         (SELECT pg_catalog.count(*) FROM audit.history)
       )::text AS rows`,
    );
    return found.rows[0]?.rows ?? "";
  }

  /** Makes the member of `making` through the operations, with the owner's session, and gives the person. */
  async function make(making: Making): Promise<TestIdentity> {
    if (making.kind === "owner") {
      return company.creator;
    }
    const member = await newMember(server, { app, owner }, company);
    switch (making.kind) {
      case "admin":
        await jsonOf(await calls.updateUser(server, company.session, member.id, { adminLevel: "admin" }));
        break;
      case "program-administrator":
        await jsonOf(await calls.updateUser(server, company.session, member.id, { programsAdministered: [{ program: making.program }] }));
        break;
      case "full":
        await jsonOf(await calls.assignProgram(server, company.session, member.id, making.program, { full: true }));
        break;
      case "rights":
        await jsonOf(await calls.assignProgram(server, company.session, member.id, making.program, { permissions: making.permissions }));
        break;
      case "member":
        break;
    }
    return member.person;
  }

  /** Calls `operation` by REST with the session's cookie, as the web app does, and with ?probe=1 when `probe` says so. */
  function callByRest(operation: Operation, args: Readonly<Record<string, unknown>>, session: string, probe: boolean): Promise<Response> {
    const { path, init } = restRequestOf(operation, args);
    const sent = probe ? `${path}${path.includes("?") ? "&" : "?"}probe=1` : path;
    return server.send(sent, { ...init, headers: { ...(init.headers as Record<string, string>), origin: TEST_ORIGIN, ...cookieHeader({ session }) } });
  }

  /**
   * Makes the holder, checks that getMe gives exactly what it holds, and calls
   * every operation by REST and by MCP: refused where it lacks the
   * permission, past the check where it holds it, and nothing changes.
   */
  async function runFor(holder: Holder): Promise<void> {
    const person = await make(holder.making);
    const session = await sessionIn(server, person, company.id);
    const me = await jsonOf<Me>(await getAs(server, session, "/v1/me"));
    expect(me.permissions, `getMe of ${holder.name}`).toEqual([...new Set(holder.holds)].sort());
    const before = await companyRows();
    const client: McpClient = await mcpClient(server.app, { token: session });
    try {
      for (const operation of OPERATIONS) {
        const id = operation.operationId;
        const { permission, writes } = operation["x-nortfox"];
        const args = await argumentsOf(operation, person);
        if (!holder.holds.includes(permission)) {
          const rest = await callByRest(operation, args, session, false);
          expect(rest.status, `${id} by REST for ${holder.name}`).toBe(403);
          expect(await problemIn(rest), `${id} by REST for ${holder.name}`).toEqual(permissionMissing(permission));
          expect(await callTool(client, id, args), `${id} by MCP for ${holder.name}`).toEqual({ isError: true, structured: permissionMissing(permission) });
        } else if (writes) {
          const rest = await callByRest(operation, args, session, true);
          expect(await problemIn(rest), `${id} by REST for ${holder.name}`).toMatchObject(probeRefused("unknown-parameter"));
          const tool = await callTool(client, id, { ...args, probe: 1 });
          expect(tool.isError, `${id} by MCP for ${holder.name}`).toBe(true);
          expect(tool.structured, `${id} by MCP for ${holder.name}`).toMatchObject(probeRefused("unknown-field"));
        } else {
          const rest = await callByRest(operation, args, session, false);
          expect(rest.status, `${id} by REST for ${holder.name}: ${await rest.clone().text()}`).toBe(200);
          const tool = await callTool(client, id, args);
          expect(tool.isError, `${id} by MCP for ${holder.name}: ${JSON.stringify(tool.structured)}`).toBe(false);
          if (RIGHT_CHECKS.includes(operation)) {
            expect(await rest.json()).toEqual({ permission });
            expect(tool.structured).toEqual({ permission });
          }
        }
      }
    } finally {
      await client.close();
    }
    expect(await companyRows(), `the company after the calls of ${holder.name}`).toBe(before);
  }

  it("covers every operation with a permission, and each permission but a member's own is held by some member and lacked by another", () => {
    expect(OPERATIONS.slice(0, OPERATIONS.length - RIGHT_CHECKS.length).map((operation) => operation.operationId)).toEqual([
      "getCompany",
      "updateCompany",
      "listUsers",
      "getUser",
      "updateUser",
      "removeUser",
      "assignProgram",
      "removeProgram",
      "moveProgram",
      "updateUserRights",
      "inviteUser",
      "resendInvitation",
      "disconnectUserIdentity",
    ]);
    expect(RIGHT_CHECKS).toHaveLength(64);
    const holders = [...SIX_ROLES, ...SMALLEST_SETS];
    expect(holders).toHaveLength(6 + 64 + 2);
    for (const operation of OPERATIONS) {
      const { permission } = operation["x-nortfox"];
      expect(
        holders.some((holder) => holder.holds.includes(permission)),
        `${permission} is held by a member`,
      ).toBe(true);
      // Every active member reads the company, so no member lacks company:read.
      expect(
        holders.some((holder) => !holder.holds.includes(permission)),
        `${permission} is lacked by a member`,
      ).toBe(!MEMBER.includes(permission));
    }
    expect(holders.every((holder) => MEMBER.every((permission) => holder.holds.includes(permission)))).toBe(true);
    // Every permission of the contract is some operation's.
    expect(Object.keys(PERMISSIONS).filter((permission) => !OPERATIONS.some((operation) => operation["x-nortfox"].permission === permission))).toEqual([]);
  });

  it("reads R1's smallest sets from the view rule: alone where it can be, with its group's view permission where it must be", () => {
    expect(smallestSet("vouchers.view")).toEqual(["vouchers.view"]);
    expect(smallestSet("vouchers.book")).toEqual(["vouchers.view", "vouchers.book"]);
    expect(smallestSet("vouchers.approve-own-series")).toEqual(["vouchers.view", "vouchers.approve-own-series"]);
    expect(smallestSet("supplier-invoices.void")).toEqual(["supplier-invoices.view", "supplier-invoices.void"]);
    expect(smallestSet("reports.vat")).toEqual(["reports.vat"]);
    expect(smallestSet("register.anonymise-fiscal-year")).toEqual(["register.anonymise-fiscal-year"]);
    expect(SMALLEST_SETS.filter((holder) => holder.making.kind === "rights").map((holder) => holder.making)).toContainEqual({
      kind: "rights",
      program: "approval-read",
      permissions: ["reports.supplier-ledger"],
    });
  });

  describe("runs for the six roles", () => {
    it.each(SIX_ROLES.map((holder) => [holder.name, holder] as const))(
      "every operation refuses %s where it lacks the permission, by REST and by MCP, naming the permission",
      async (_name, holder) => {
        await runFor(holder);
      },
    );
  });

  describe("runs for each smallest set of one permission: alone where it can be, with its group's view permission where it must be", () => {
    it.each(SMALLEST_SETS.map((holder) => [holder.name, holder] as const))(
      "every operation refuses %s where the member lacks the permission, by REST and by MCP, naming the permission",
      async (_name, holder) => {
        await runFor(holder);
      },
    );
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
