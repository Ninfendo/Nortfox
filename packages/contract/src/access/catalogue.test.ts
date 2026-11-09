// SPDX-License-Identifier: AGPL-3.0-only

// The permission catalogue (issue 12, "Roles, admin levels, programs and
// permissions", lines 4 to 10). The labels below are the issue's words, in
// the issue's order: each group's own items, then the six that only
// Bokföring - Attest & Läs holds, in their groups. The first permission of
// each Bokföring group is its view right; the Rapporter and Register/Övrigt
// switches each stand alone. Five rights are only switched on by hand, and
// this slice builds three of them. Each program has its set: the rights of
// "Full behörighet", and those that are switched on by hand only. "Full
// behörighet" never holds a manual-only right. Migration 0009 seeds the same
// rows (apps/server/src/modules/users/catalogue.db.test.ts).

import { describe, expect, it } from "vitest";
import * as contract from "../index.ts";
import {
  CATALOGUE_GROUPS,
  CATALOGUE_PERMISSIONS,
  CATALOGUE_PROGRAMS,
  GROUP_KINDS,
  PROGRAMS,
  PROGRAM_PERMISSIONS,
  fullPermissions,
  programPermissions,
  viewPermissionOf,
  type CataloguePermissionKey,
  type Program,
} from "./catalogue.ts";

/** The issue's catalogue, item 9: each group's labels in order, the six of Bokföring - Attest & Läs last in theirs. */
const ISSUE_LABELS = {
  vouchers: [
    "Verifikationer",
    "Bokför",
    "Radera",
    "Ändra",
    "Periodisera",
    "Se skapad av/ändrad av",
    "Registrera dagskassa",
    "Registrera kvitton",
    "Periodiseringar",
    "Utföra periodiseringar verifikationer",
    "Utföra periodiseringar leverantörsfakturor",
    "Utföra periodiseringar kundfakturor",
    "Stäm av konto",
    "Ta bort banktransaktioner",
    "Sök belopp",
    "Inställningar",
    "Låsa period",
    "Se /attestera verifikationsserie där användaren är attestant",
    "Se samtliga verifikationsserier",
  ],
  "supplier-invoices": [
    "Leverantörsfakturor",
    "Spara",
    "Bokför",
    "Makulera",
    "Betalfil",
    "Ångra betalfil",
    "Periodisera",
    "Ta bort kopplade bilder",
    "Se skapad av / ändrad av",
    "Inkomna fakturor /dokument",
    "Skicka för tolkning",
    "Utbetalningar",
    "Inställningar",
  ],
  reports: [
    "Balansrapport",
    "Borttagna verifikationer",
    "Huvudbok",
    "Ingående balans",
    "Kontoanalys",
    "Likviditetsrapport",
    "Momsrapport",
    "Periodiseringar",
    "Periodisk sammanställning (kvartalsrapport)",
    "Projektredovisning",
    "Resultatbudget",
    "Resultatrapport",
    "Resultatrapport 12 månader",
    "Resultatrapport avancerad",
    "Systemdokumentation",
    "Verifikationslista",
    "Visa strukna rader",
    "Behandlingshistoriken",
    "Leverantörsfakturor",
    "Leverantörsstatistik",
    "Reskontralista - Leverantörsfakturor",
    "Förfallolista - Leverantörsfakturor",
  ],
  register: [
    "Leverantörer",
    "Kontoplan",
    "Kostnadsställen",
    "Projekt",
    "Sie-export",
    "Sie-import",
    "Exportera filer",
    "Anonymisera räkenskapsår",
    "Hantera borttagna användare",
    "Radera behandlingshistorik",
  ],
} as const;

/** The eighteen Rapporter for Bokföring, the issue's own list, before the four that Bokföring - Attest & Läs adds. */
const BOOKKEEPING_REPORTS = ISSUE_LABELS.reports.slice(0, 18);

/** The six that only Bokföring - Attest & Läs holds (item 9's last line), as group and label. */
const APPROVAL_ONLY = [
  ["vouchers", "Se /attestera verifikationsserie där användaren är attestant"],
  ["vouchers", "Se samtliga verifikationsserier"],
  ["reports", "Leverantörsfakturor"],
  ["reports", "Leverantörsstatistik"],
  ["reports", "Reskontralista - Leverantörsfakturor"],
  ["reports", "Förfallolista - Leverantörsfakturor"],
] as const;

/** The manual-only rights this slice builds (line 5): the two outside this plan are not built. */
const MANUAL_ONLY = ["Anonymisera räkenskapsår", "Hantera borttagna användare", "Radera behandlingshistorik"] as const;

/** A permission's key by its group and label, which are unique together. */
function keyOf(group: string, label: string): CataloguePermissionKey {
  const found = CATALOGUE_PERMISSIONS.filter((permission) => permission.group === group && permission.label === label);
  if (found.length !== 1 || found[0] === undefined) {
    throw new Error(`The catalogue has ${String(found.length)} permissions labelled "${label}" in ${group}.`);
  }
  return found[0].key;
}

/** The keys of a group's labels, in the order given. */
function keysOf(group: keyof typeof ISSUE_LABELS, labels: readonly string[]): CataloguePermissionKey[] {
  return labels.map((label) => keyOf(group, label));
}

/** The keys in the catalogue's order. */
function inCatalogueOrder(keys: readonly CataloguePermissionKey[]): CataloguePermissionKey[] {
  const order = CATALOGUE_PERMISSIONS.map((permission) => permission.key);
  return [...keys].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** A program's set: the rights of "Full behörighet", and those switched on by hand only. */
interface ProgramSet {
  readonly full: readonly CataloguePermissionKey[];
  readonly byHand: readonly CataloguePermissionKey[];
}

/** Each program's set as the issue gives it, read from the catalogue by group and label when a test asks. */
function issueSets(): Readonly<Record<Program, ProgramSet>> {
  return {
    // Line 4: all of the program's permissions, plus the Rapporter and
    // Register/Övrigt rights for what it covers, but none of the six of
    // Bokföring - Attest & Läs (done-when R2), and no manual-only right.
    bookkeeping: {
      full: [
        ...keysOf("vouchers", ISSUE_LABELS.vouchers.slice(0, 17)),
        ...keysOf("supplier-invoices", ISSUE_LABELS["supplier-invoices"]),
        ...keysOf("reports", BOOKKEEPING_REPORTS),
        ...keysOf("register", ISSUE_LABELS.register.slice(0, 7)),
      ],
      byHand: keysOf("register", MANUAL_ONLY),
    },
    // Line 10: its own permissions and its fifteen Bokföring reports, plus the four supplier reports.
    "approval-read": {
      full: [
        ...keysOf("vouchers", [
          "Verifikationer",
          "Se skapad av/ändrad av",
          "Se /attestera verifikationsserie där användaren är attestant",
          "Se samtliga verifikationsserier",
        ]),
        ...keysOf("supplier-invoices", ["Leverantörsfakturor"]),
        ...keysOf("reports", [
          "Balansrapport",
          "Borttagna verifikationer",
          "Huvudbok",
          "Ingående balans",
          "Kontoanalys",
          "Likviditetsrapport",
          "Momsrapport",
          "Periodiseringar",
          "Projektredovisning",
          "Resultatbudget",
          "Resultatrapport",
          "Resultatrapport 12 månader",
          "Resultatrapport avancerad",
          "Systemdokumentation",
          "Verifikationslista",
          "Leverantörsfakturor",
          "Leverantörsstatistik",
          "Reskontralista - Leverantörsfakturor",
          "Förfallolista - Leverantörsfakturor",
        ]),
      ],
      byHand: [],
    },
    // Line 10: the view rights and the reports of the covered programs, and no action right.
    read: {
      full: [...keysOf("vouchers", ["Verifikationer"]), ...keysOf("supplier-invoices", ["Leverantörsfakturor"]), ...keysOf("reports", BOOKKEEPING_REPORTS)],
      byHand: [],
    },
    // Line 10: read access to Bokföring and its reports, Behandlingshistoriken
    // included; Exportera filer and Sie-export can be switched on (done-when
    // R8: off until switched on).
    auditor: {
      full: [
        ...keysOf("vouchers", ["Verifikationer", "Se skapad av/ändrad av"]),
        ...keysOf("supplier-invoices", ["Leverantörsfakturor", "Se skapad av / ändrad av"]),
        ...keysOf("reports", BOOKKEEPING_REPORTS),
      ],
      byHand: keysOf("register", ["Sie-export", "Exportera filer"]),
    },
  };
}

describe("the permission catalogue", () => {
  it("holds the four programs in order, with their screen words, and only the Revisor grant ends by itself, 30 days after it is granted", () => {
    expect(PROGRAMS).toEqual(["bookkeeping", "approval-read", "read", "auditor"]);
    expect(CATALOGUE_PROGRAMS).toEqual([
      { key: "bookkeeping", label: "Bokföring", lifetimeDays: null },
      { key: "approval-read", label: "Bokföring - Attest & Läs", lifetimeDays: null },
      { key: "read", label: "Läs", lifetimeDays: null },
      { key: "auditor", label: "Revisor", lifetimeDays: 30 },
    ]);
  });

  it("holds the groups in order: the two Bokföring groups, then Rapporter and Register/Övrigt", () => {
    expect(GROUP_KINDS).toEqual(["program", "reports", "register"]);
    expect(CATALOGUE_GROUPS).toEqual([
      { key: "vouchers", kind: "program", label: "Verifikationer" },
      { key: "supplier-invoices", kind: "program", label: "Leverantörsfakturor" },
      { key: "reports", kind: "reports", label: "Rapporter" },
      { key: "register", kind: "register", label: "Register/Övrigt" },
    ]);
  });

  it("holds every permission in the issue's order, group by group, with the six of Bokföring - Attest & Läs after each group's own", () => {
    expect(CATALOGUE_PERMISSIONS.map((permission) => [permission.group, permission.label])).toEqual(
      Object.entries(ISSUE_LABELS).flatMap(([group, labels]) => labels.map((label) => [group, label])),
    );
    expect(APPROVAL_ONLY.map(([group, label]) => keyOf(group, label))).toEqual([
      "vouchers.approve-own-series",
      "vouchers.see-all-series",
      "reports.supplier-invoices",
      "reports.supplier-statistics",
      "reports.supplier-ledger",
      "reports.supplier-due-list",
    ]);
  });

  it("gives each permission a key of its own, in its group's name and kebab-case, Bokför in Verifikationer being vouchers.book", () => {
    const keys = CATALOGUE_PERMISSIONS.map((permission) => permission.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const permission of CATALOGUE_PERMISSIONS) {
      expect(permission.key).toMatch(/^[a-z]+(?:-[a-z]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(permission.key.split(".")[0], permission.key).toBe(permission.group);
    }
    expect(keyOf("vouchers", "Bokför")).toBe("vouchers.book");
    expect(keys).toEqual([
      "vouchers.view",
      "vouchers.book",
      "vouchers.delete",
      "vouchers.alter",
      "vouchers.accrue",
      "vouchers.created-by",
      "vouchers.cash-register",
      "vouchers.receipts",
      "vouchers.accruals",
      "vouchers.run-accruals-vouchers",
      "vouchers.run-accruals-supplier-invoices",
      "vouchers.run-accruals-customer-invoices",
      "vouchers.reconcile",
      "vouchers.delete-bank-transactions",
      "vouchers.search-amount",
      "vouchers.settings",
      "vouchers.lock-period",
      "vouchers.approve-own-series",
      "vouchers.see-all-series",
      "supplier-invoices.view",
      "supplier-invoices.save",
      "supplier-invoices.book",
      "supplier-invoices.void",
      "supplier-invoices.payment-file",
      "supplier-invoices.undo-payment-file",
      "supplier-invoices.accrue",
      "supplier-invoices.delete-attachments",
      "supplier-invoices.created-by",
      "supplier-invoices.inbox",
      "supplier-invoices.send-for-interpretation",
      "supplier-invoices.disbursements",
      "supplier-invoices.settings",
      "reports.balance-sheet",
      "reports.deleted-vouchers",
      "reports.general-ledger",
      "reports.opening-balance",
      "reports.account-analysis",
      "reports.liquidity",
      "reports.vat",
      "reports.accruals",
      "reports.periodic-summary",
      "reports.project-accounting",
      "reports.budget",
      "reports.income-statement",
      "reports.income-statement-12-months",
      "reports.income-statement-advanced",
      "reports.system-documentation",
      "reports.voucher-list",
      "reports.show-struck-rows",
      "reports.processing-history",
      "reports.supplier-invoices",
      "reports.supplier-statistics",
      "reports.supplier-ledger",
      "reports.supplier-due-list",
      "register.suppliers",
      "register.chart-of-accounts",
      "register.cost-centres",
      "register.projects",
      "register.sie-export",
      "register.sie-import",
      "register.export-files",
      "register.anonymise-fiscal-year",
      "register.removed-users",
      "register.delete-processing-history",
    ]);
  });

  it("makes the first permission of each Bokföring group its view right, and no Rapporter or Register/Övrigt switch one (line 7)", () => {
    for (const group of CATALOGUE_GROUPS) {
      const own = CATALOGUE_PERMISSIONS.filter((permission) => permission.group === group.key);
      const views = own.filter((permission) => permission.view).map((permission) => permission.key);
      expect(views, group.key).toEqual(group.kind === "program" ? [own[0]?.key] : []);
      for (const permission of own) {
        expect(viewPermissionOf(permission.key), permission.key).toBe(group.kind === "program" ? own[0]?.key : null);
      }
    }
    expect(viewPermissionOf("vouchers.book")).toBe("vouchers.view");
    expect(viewPermissionOf("vouchers.view")).toBe("vouchers.view");
    expect(viewPermissionOf("supplier-invoices.void")).toBe("supplier-invoices.view");
    expect(viewPermissionOf("reports.vat")).toBeNull();
    expect(viewPermissionOf("register.sie-export")).toBeNull();
  });

  it("marks exactly the three manual-only rights this slice builds, all in Register/Övrigt, none of them a view right (line 5)", () => {
    expect(CATALOGUE_PERMISSIONS.filter((permission) => permission.manualOnly).map((permission) => [permission.group, permission.label])).toEqual(
      MANUAL_ONLY.map((label) => ["register", label]),
    );
  });

  it.each(PROGRAMS)("gives %s the set the issue gives it, in the catalogue's order", (program) => {
    const wanted = issueSets()[program];
    expect(fullPermissions(program)).toEqual(inCatalogueOrder(wanted.full));
    expect(programPermissions(program)).toEqual(inCatalogueOrder([...wanted.full, ...wanted.byHand]));
    expect(PROGRAM_PERMISSIONS.filter((row) => row.program === program)).toEqual(
      programPermissions(program).map((permission) => ({ program, permission, inFull: wanted.full.includes(permission) })),
    );
  });

  it("puts every permission of the catalogue in some program's set", () => {
    const granted = new Set(PROGRAMS.flatMap((program) => programPermissions(program)));
    expect(CATALOGUE_PERMISSIONS.filter((permission) => !granted.has(permission.key))).toEqual([]);
  });

  it("lists the program sets program by program, each permission of a program once", () => {
    // Bokföring 58, Bokföring - Attest & Läs 24, Läs 20, Revisor 24.
    expect(PROGRAM_PERMISSIONS).toHaveLength(126);
    expect(PROGRAM_PERMISSIONS.map((row) => row.program)).toEqual(PROGRAMS.flatMap((program) => programPermissions(program).map(() => program)));
    for (const program of PROGRAMS) {
      expect(new Set(programPermissions(program)).size, program).toBe(programPermissions(program).length);
    }
  });

  it.each(PROGRAMS)("never puts a manual-only right in the Full behörighet of %s (line 5)", (program) => {
    const manual = new Set(CATALOGUE_PERMISSIONS.filter((permission) => permission.manualOnly).map((permission) => permission.key));
    expect(manual.size).toBe(3);
    expect(fullPermissions(program).length).toBeGreaterThan(0);
    expect(fullPermissions(program).filter((permission) => manual.has(permission))).toEqual([]);
  });

  it.each(PROGRAMS)("keeps the view rule in the Full behörighet of %s, and in its whole set: each action right with its group's view right", (program) => {
    expect(fullPermissions(program)).toContain("vouchers.view");
    for (const set of [fullPermissions(program), programPermissions(program)]) {
      for (const permission of set) {
        const view = viewPermissionOf(permission);
        expect(view === null || set.includes(view), `${program}: ${permission} needs ${String(view)}`).toBe(true);
      }
    }
  });

  it("gives the bookkeeper, and every program but Bokföring - Attest & Läs, none of the six it alone holds, and Läs only view rights and reports (R2)", () => {
    const approvalOnly = APPROVAL_ONLY.map(([group, label]) => keyOf(group, label));
    expect(programPermissions("bookkeeping").filter((permission) => approvalOnly.includes(permission))).toEqual([]);
    for (const program of PROGRAMS.filter((other) => other !== "approval-read")) {
      expect(
        programPermissions(program).filter((permission) => approvalOnly.includes(permission)),
        program,
      ).toEqual([]);
    }
    const kinds = new Map(CATALOGUE_GROUPS.map((group) => [group.key, group.kind]));
    expect(fullPermissions("read")).toHaveLength(20);
    for (const permission of fullPermissions("read")) {
      const entry = CATALOGUE_PERMISSIONS.find((found) => found.key === permission);
      expect(entry?.view === true || kinds.get(entry?.group ?? "vouchers") === "reports", permission).toBe(true);
    }
  });

  it("gives a new list each call, so no caller changes another's", () => {
    expect(fullPermissions("read")).toEqual(fullPermissions("read"));
    expect(fullPermissions("read")).toContain("reports.vat");
    expect(fullPermissions("read")).not.toBe(fullPermissions("read"));
    expect(programPermissions("read")).not.toBe(programPermissions("read"));
  });

  it("freezes its data, so no caller changes the catalogue", () => {
    for (const list of [CATALOGUE_PROGRAMS, CATALOGUE_GROUPS, CATALOGUE_PERMISSIONS, PROGRAM_PERMISSIONS]) {
      expect(Object.isFrozen(list)).toBe(true);
      for (const entry of list) {
        expect(Object.isFrozen(entry)).toBe(true);
      }
    }
  });

  it("is what the package exports", () => {
    expect(contract.PROGRAMS).toBe(PROGRAMS);
    expect(contract.GROUP_KINDS).toBe(GROUP_KINDS);
    expect(contract.CATALOGUE_PROGRAMS).toBe(CATALOGUE_PROGRAMS);
    expect(contract.CATALOGUE_GROUPS).toBe(CATALOGUE_GROUPS);
    expect(contract.CATALOGUE_PERMISSIONS).toBe(CATALOGUE_PERMISSIONS);
    expect(contract.PROGRAM_PERMISSIONS).toBe(PROGRAM_PERMISSIONS);
    expect(contract.fullPermissions).toBe(fullPermissions);
    expect(contract.programPermissions).toBe(programPermissions);
    expect(contract.viewPermissionOf).toBe(viewPermissionOf);
  });
});
