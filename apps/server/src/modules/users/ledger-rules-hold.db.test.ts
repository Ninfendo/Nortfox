// SPDX-License-Identifier: AGPL-3.0-only

// R13 (issue 12, "Roles, admin levels, programs and permissions" 13): no
// permission, the system administrator's included, lets anyone change or
// delete what the database rules of slice 2a protect. Two real members of
// one company try: a member who holds every permission, the system
// administrator's and every right of the catalogue, the manual-only ones
// too; and the company's owner, a system administrator, who holds no work
// right. Each tries each change below in two ways:
//
// - Through test-only operations, by REST and by MCP: each change once in an
//   operation that needs the work right that the change would seem to call
//   for, such as Ändra for changing a booked amount, or Radera
//   behandlingshistorik for deleting from the behandlingshistorik, and once
//   in an operation that needs the system administrator's users:admin. The
//   database refuses each one that passes the permission check, with its
//   rule's answer: 422 with the rule's code, or 500 where the app has no
//   privilege at all, which no request through the server meets unless the
//   server is at fault. The system administrator holds no work right, so the
//   first kind is refused before it runs, with 403 permission-missing.
// - As SQL, in a transaction as the person: as the app, which gets the
//   rule's refusal or, where it has no privilege, 42501; and as the owner
//   role, which holds every privilege and still gets the rule's refusal.
//
// Nothing changes in the ledger or its behandlingshistorik. The test-only
// operations live here, outside the server's source, so no build holds them.
// Until MCP's OAuth comes, MCP gets the session's principal through the
// test's resolver (sessionsOnMcp).

import { CATALOGUE_PERMISSIONS, PERMISSIONS, defineOperation, programPermissions, type Me, type Operation } from "@nortfox/contract";
import type { Client as McpClient } from "@modelcontextprotocol/client";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ALL_PERMISSIONS, TEST_REGISTRY, appPool, callTool, mcpClient, problemIn, testHandlers, type AppPool } from "../../../test/api.ts";
import { INSUFFICIENT_PRIVILEGE, expectError, expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { addBooksYear, balanced, bookVoucher, setLock } from "../../../test/ledger.ts";
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
} from "../../../test/sign-in.ts";
import { apiCompany, calls, newMember, sessionIn, type ApiCompany } from "../../../test/users.ts";
import { handleData, ok, type Handler } from "../../api/operation.ts";
import type { RefusalReason } from "../../db/refusals.ts";

/** The voucher of series A with `number`, as a statement's subquery. */
function voucherNumbered(number: number): string {
  return `(SELECT id FROM ledger.vouchers WHERE series_code = 'A' AND number = ${String(number)})`;
}

/** How the API answers a change that the database refuses. */
type ApiAnswer = { readonly status: 422; readonly code: string } | { readonly status: 500; readonly code: "internal-error" };

/** A change that 2a's rules forbid, and how each one refuses it. */
interface Attempt {
  /** What the change does, for the tests' names. */
  readonly does: string;
  /** Its words in kebab-case, for the paths of its operations. */
  readonly key: string;
  /** The work right the change would seem to need. */
  readonly right: string;
  /** The statements it runs, in order, the change last. */
  readonly statements: readonly string[];
  /** What the database answers the app: a rule's refusal, or no privilege. */
  readonly app: RefusalReason | typeof INSUFFICIENT_PRIVILEGE;
  /** What the database answers the owner role, which holds every privilege. */
  readonly owner: RefusalReason;
  readonly api: ApiAnswer;
}

// The books: series A in 2090 holds vouchers 1 (15 March), 2 (15 June) and 3
// (20 June); voucher 4 (25 June) was deleted, so the record of deleted
// vouchers holds it; and every date up to 31 March is locked for all users.
const ATTEMPTS: readonly Attempt[] = [
  {
    does: "change a booked amount",
    key: "change-booked-amount",
    right: "vouchers.alter",
    statements: [
      `SELECT 1 FROM ledger.vouchers WHERE id = ${voucherNumbered(2)} FOR NO KEY UPDATE`,
      `UPDATE ledger.voucher_rows SET debit = debit + 100 WHERE debit > 0 AND voucher_id = ${voucherNumbered(2)}`,
    ],
    app: "immutable_field",
    owner: "immutable_field",
    api: { status: 422, code: "immutable-field" },
  },
  {
    does: "delete a voucher that is not the last of its series",
    key: "delete-voucher",
    right: "vouchers.delete",
    statements: [`DELETE FROM ledger.vouchers WHERE id = ${voucherNumbered(2)}`],
    app: "not_last_in_series",
    owner: "not_last_in_series",
    api: { status: 422, code: "not-last-in-series" },
  },
  {
    does: "book a voucher in a locked period",
    key: "book-in-locked-period",
    right: "vouchers.book",
    statements: [
      `INSERT INTO ledger.vouchers (company_id, fiscal_year_id, series_code, description, transaction_date, reference_type)
       SELECT company_id, id, 'A', 'Kontorsmaterial', DATE '2090-03-20', 'MANUAL' FROM ledger.fiscal_years`,
    ],
    app: "period_locked_manual",
    owner: "period_locked_manual",
    api: { status: 422, code: "period-locked-manual" },
  },
  {
    does: "change a voucher in a locked period",
    key: "change-locked-voucher",
    right: "vouchers.alter",
    statements: [`UPDATE ledger.vouchers SET description = 'Ändrad' WHERE id = ${voucherNumbered(1)}`],
    app: "period_locked_manual",
    owner: "period_locked_manual",
    api: { status: 422, code: "period-locked-manual" },
  },
  {
    does: "change the behandlingshistorik",
    key: "change-history",
    right: "register.delete-processing-history",
    statements: ["UPDATE audit.history SET new_values = '{}'::jsonb WHERE new_values IS NOT NULL"],
    app: INSUFFICIENT_PRIVILEGE,
    owner: "append_only",
    api: { status: 500, code: "internal-error" },
  },
  {
    does: "delete from the behandlingshistorik",
    key: "delete-history",
    right: "register.delete-processing-history",
    statements: ["DELETE FROM audit.history"],
    app: INSUFFICIENT_PRIVILEGE,
    owner: "append_only",
    api: { status: 500, code: "internal-error" },
  },
  {
    does: "delete from the record of deleted vouchers",
    key: "delete-deleted-voucher",
    right: "vouchers.delete",
    statements: ["DELETE FROM ledger.deleted_vouchers"],
    app: INSUFFICIENT_PRIVILEGE,
    owner: "append_only",
    api: { status: 500, code: "internal-error" },
  },
  {
    does: "move a series' counter",
    key: "move-counter",
    right: "vouchers.settings",
    statements: ["UPDATE ledger.voucher_counters SET next_number = next_number + 1"],
    app: INSUFFICIENT_PRIVILEGE,
    owner: "internal_only",
    api: { status: 500, code: "internal-error" },
  },
];

/** What a test-only attempt answers when the database lets its change through, which no test expects. */
const Attempted = z.strictObject({ attempt: z.string().meta({ description: "The change that went through." }) });

/** The words of a kebab-case key in PascalCase. */
function pascal(key: string): string {
  return key
    .split("-")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join("");
}

/** A test-only write that runs the attempt's statements in the request's transaction, and needs `permission`. */
function attemptOperation(attempt: Attempt, permission: string, suffix: "" | "-as-administrator"): { readonly operation: Operation; readonly handler: Handler } {
  const operation = defineOperation({
    id: `testAttempt${pascal(`${attempt.key}${suffix}`)}`,
    method: "post",
    path: `/v1/test-ledger/${attempt.key}${suffix}`,
    tags: ["test"],
    summary: "Try a change that the ledger forbids",
    description: `Tries to ${attempt.does}, and needs the permission ${permission}. Only the tests serve it.`,
    output: Attempted,
    permission,
    scope: "bookkeeping",
    tool: `Tries to ${attempt.does}, and needs the permission ${permission}. Only the tests serve it.`,
    writes: true,
  });
  const handler = handleData(operation, async ({ tx }) => {
    for (const statement of attempt.statements) {
      await tx.query(statement);
    }
    return ok({ attempt: attempt.key });
  });
  return { operation, handler };
}

/** Each attempt with its work right, and with the system administrator's users:admin. */
const ATTEMPT_OPERATIONS = ATTEMPTS.map((attempt) => ({
  attempt,
  withRight: attemptOperation(attempt, attempt.right, ""),
  asAdministrator: attemptOperation(attempt, "users:admin", "-as-administrator"),
}));

/** Every permission there is: the contract's and the catalogue's. */
const EVERY_PERMISSION = [...Object.keys(PERMISSIONS), ...CATALOGUE_PERMISSIONS.map((permission) => permission.key)].sort();

/** What a system administrator holds: a member's own, the company's details, its users and their programs. */
const SYSTEM_ADMINISTRATOR = ["company:read", "company:update", "programs:grant", "tokens:all", "tokens:own", "users:admin", "users:read"];

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

describe("a member with every permission and a system administrator get 2a's refusals", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  /** Reads every row past row level security, for the check that nothing changed. */
  let superuser: Client;
  let pool: AppPool;
  let server: SignInApp;
  let company: ApiCompany;
  /** The member who holds every permission, and the company's owner, a system administrator, with their sessions in the company. */
  let everything: { readonly person: TestIdentity; readonly session: string };
  let administrator: { readonly person: TestIdentity; readonly session: string };

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    superuser = await db.admin();
    pool = appPool(db, 4);
    const operations = ATTEMPT_OPERATIONS.flatMap((made) => [made.withRight, made.asAdministrator]);
    // The database stamps an invitation's time with its own clock, so the server's starts at the same time.
    server = signInApp(pool.database, {
      clock: testClock(new Date()),
      mcpSessions: "on",
      options: {
        registry: [...TEST_REGISTRY, ...operations.map((made) => made.operation)],
        handlers: [...testHandlers(), ...operations.map((made) => made.handler)],
        permissions: [...new Set([...ALL_PERMISSIONS, ...ATTEMPTS.map((attempt) => attempt.right)])],
      },
    });
    company = await apiCompany(server, { app, owner });

    // The books, kept by the owner: three vouchers, a fourth deleted, and a lock through 31 March.
    const year = await addBooksYear(app, company.id, "2090-01-01", "2090-12-31", company.asOwner);
    for (const date of ["2090-03-15", "2090-06-15", "2090-06-20"]) {
      await bookVoucher(app, company.id, { year: year.id, series: "A", date, rows: balanced(2000n) }, company.asOwner);
    }
    const fourth = await bookVoucher(app, company.id, { year: year.id, series: "A", date: "2090-06-25", rows: balanced(500n) }, company.asOwner);
    await inTransaction(app, { company: company.id, ...company.asOwner, channel: "rest" }, () => app.query("DELETE FROM ledger.vouchers WHERE id = $1", [fourth.id]));
    await setLock(app, company.id, "all", "2090-03-31", { who: company.asOwner });

    // A member made system administrator, who administers every program and holds every program with every right, by hand too.
    const member = await newMember(server, { app, owner }, company);
    await jsonOf(
      await calls.updateUser(server, company.session, member.id, {
        adminLevel: "admin",
        programsAdministered: [{ program: "bookkeeping" }, { program: "approval-read" }, { program: "read" }, { program: "auditor" }],
      }),
    );
    await jsonOf(await calls.assignProgram(server, company.session, member.id, "bookkeeping", { permissions: programPermissions("bookkeeping") }));
    await jsonOf(await calls.assignProgram(server, company.session, member.id, "approval-read", { full: true }));
    await jsonOf(await calls.assignProgram(server, company.session, member.id, "read", { full: true }));
    await jsonOf(await calls.assignProgram(server, company.session, member.id, "auditor", { permissions: programPermissions("auditor") }));
    everything = { person: member.person, session: await sessionIn(server, member.person, company.id) };
    administrator = { person: company.creator, session: await sessionIn(server, company.creator, company.id) };
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** What the company's ledger and its behandlingshistorik hold: a refused change leaves them as they were. */
  async function ledgerRows(): Promise<string> {
    const found = await superuser.query<{ rows: string }>(
      `SELECT pg_catalog.jsonb_build_array(
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM ledger.fiscal_years AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM ledger.voucher_series AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM ledger.voucher_counters AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM ledger.vouchers AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM ledger.voucher_rows AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM ledger.deleted_vouchers AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM ledger.deleted_voucher_rows AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM ledger.period_locks AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM ledger.automatic_locks AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM audit.history AS t)
       )::text AS rows`,
    );
    return found.rows[0]?.rows ?? "";
  }

  /** Calls a test-only attempt by REST with the session's cookie, as the web app sends a write. */
  function attemptByRest(operation: Operation, session: string): Promise<Response> {
    return server.send(operation.path, {
      method: "POST",
      headers: { origin: TEST_ORIGIN, "idempotency-key": `try-${operation.operationId}`, ...cookieHeader({ session }) },
    });
  }

  /** Calls `operation` as the session by REST and by MCP, and expects the same problem from both. */
  async function expectAnswer(client: McpClient, operation: Operation, session: string, expected: Record<string, unknown>, exact: boolean): Promise<void> {
    const rest = await problemIn(await attemptByRest(operation, session));
    const tool = await callTool(client, operation.operationId, { idempotencyKey: `try-${operation.operationId}` });
    expect(tool.isError, `${operation.operationId} by MCP`).toBe(true);
    if (exact) {
      expect(rest, `${operation.operationId} by REST`).toEqual(expected);
      expect(tool.structured, `${operation.operationId} by MCP`).toEqual(expected);
    } else {
      expect(rest, `${operation.operationId} by REST`).toMatchObject(expected);
      expect(tool.structured, `${operation.operationId} by MCP`).toMatchObject(expected);
    }
  }

  it("the member holds every permission, the manual-only ones too, and the owner a system administrator's", async () => {
    const all = await jsonOf<Me>(await getAs(server, everything.session, "/v1/me"));
    expect(all.permissions).toEqual(EVERY_PERMISSION);
    expect(all.permissions).toEqual(expect.arrayContaining(["register.anonymise-fiscal-year", "register.removed-users", "register.delete-processing-history"]));
    expect(all.membership).toMatchObject({ adminLevel: "admin", roles: ["admin", "bookkeeper", "approver", "viewer", "auditor"] });
    const admin = await jsonOf<Me>(await getAs(server, administrator.session, "/v1/me"));
    expect(admin.permissions).toEqual(SYSTEM_ADMINISTRATOR);
    expect(admin.membership).toMatchObject({ adminLevel: "owner", roles: ["owner"], programs: [] });
  });

  it.each(ATTEMPT_OPERATIONS.map((made) => [made.attempt.does, made] as const))(
    "they are refused when they %s through the test-only operations, by REST and by MCP",
    async (_does, { attempt, withRight, asAdministrator }) => {
      const before = await ledgerRows();
      const refusal = { status: attempt.api.status, code: attempt.api.code };
      const forEverything = await mcpClient(server.app, { token: everything.session });
      const forAdministrator = await mcpClient(server.app, { token: administrator.session });
      try {
        // The member holds both permissions, so both reach the database, which refuses them.
        await expectAnswer(forEverything, withRight.operation, everything.session, refusal, false);
        await expectAnswer(forEverything, asAdministrator.operation, everything.session, refusal, false);
        // The system administrator holds no work right, and users:admin reaches the database, which refuses it too.
        await expectAnswer(forAdministrator, withRight.operation, administrator.session, permissionMissing(attempt.right), true);
        await expectAnswer(forAdministrator, asAdministrator.operation, administrator.session, refusal, false);
      } finally {
        await forEverything.close();
        await forAdministrator.close();
      }
      expect(await ledgerRows()).toBe(before);
    },
  );

  it.each(ATTEMPTS.map((attempt) => [attempt.does, attempt] as const))(
    "they are refused when they %s as SQL, as the app and as the owner role",
    async (_does, attempt) => {
      const before = await ledgerRows();
      for (const person of [everything.person, administrator.person]) {
        for (const [client, expected] of [
          [app, attempt.app],
          [owner, attempt.owner],
        ] as const) {
          const tried = inTransaction(client, { company: company.id, actor: person.id, kind: "user", channel: "rest" }, async () => {
            for (const statement of attempt.statements) {
              await client.query(statement);
            }
          });
          if (expected === INSUFFICIENT_PRIVILEGE) {
            await expectError(tried, INSUFFICIENT_PRIVILEGE, /permission denied/);
          } else {
            await expectRefusal(tried, expected);
          }
        }
      }
      expect(await ledgerRows()).toBe(before);
    },
  );

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
