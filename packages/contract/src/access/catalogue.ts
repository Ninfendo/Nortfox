// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The permission catalogue (issue 12, "Roles, admin levels, programs and
 * permissions"): the programs, the groups and the permissions, in the
 * catalogue's order, with the screen words, the view marks, the manual-only
 * marks, and each program's set. It is data, and migration 0009 seeds the
 * same rows into the database (db/README.md, the schema access), whose
 * trigger holds every grant to them.
 *
 * - A group is a Bokföring group of a program's own rights, Rapporter, or
 *   Register/Övrigt. The first permission of each Bokföring group is its view
 *   right, and every other permission of the group needs it (open point 4).
 *   A Rapporter or Register/Övrigt switch stands alone.
 * - A manual-only right is never part of "Full behörighet": it is only
 *   switched on by hand.
 * - A program's set holds the rights it may grant. "Full behörighet" is the
 *   part marked in full; the rest are switched on by hand only. The
 *   Register/Övrigt rights are shared by all programs.
 * - A Revisor grant ends by itself 30 days after it is granted (open point
 *   3).
 *
 * Each later slice attaches its operations to these permissions and may add
 * its own.
 */

/** The programs, in the catalogue's order. */
export const PROGRAMS = ["bookkeeping", "approval-read", "read", "auditor"] as const;

export type Program = (typeof PROGRAMS)[number];

/** A group's kind: a program's own rights (a Bokföring group), Rapporter, or Register/Övrigt. */
export const GROUP_KINDS = ["program", "reports", "register"] as const;

export type GroupKind = (typeof GROUP_KINDS)[number];

/** A program, with its screen words, and the days after which its grant ends by itself, if it does. */
export interface CatalogueProgram {
  readonly key: Program;
  readonly label: string;
  readonly lifetimeDays: number | null;
}

/** A group of permissions, with its kind and its screen words. */
export interface CatalogueGroup {
  readonly key: GroupKey;
  readonly kind: GroupKind;
  readonly label: string;
}

/** A permission, with its group, its screen words, whether it is its group's view right, and whether it is only switched on by hand. */
export interface CataloguePermission {
  readonly key: CataloguePermissionKey;
  readonly group: GroupKey;
  readonly label: string;
  readonly view: boolean;
  readonly manualOnly: boolean;
}

/** A permission in a program's set, and whether "Full behörighet" holds it. */
export interface ProgramPermission {
  readonly program: Program;
  readonly permission: CataloguePermissionKey;
  readonly inFull: boolean;
}

/** Deep-freezes a list of plain objects, so no caller changes the catalogue. */
function frozen<const T extends readonly object[]>(list: T): T {
  for (const entry of list) {
    Object.freeze(entry);
  }
  return Object.freeze(list);
}

export const CATALOGUE_PROGRAMS: readonly CatalogueProgram[] = frozen([
  { key: "bookkeeping", label: "Bokföring", lifetimeDays: null },
  { key: "approval-read", label: "Bokföring - Attest & Läs", lifetimeDays: null },
  { key: "read", label: "Läs", lifetimeDays: null },
  { key: "auditor", label: "Revisor", lifetimeDays: 30 },
]);

const GROUPS = frozen([
  { key: "vouchers", kind: "program", label: "Verifikationer" },
  { key: "supplier-invoices", kind: "program", label: "Leverantörsfakturor" },
  { key: "reports", kind: "reports", label: "Rapporter" },
  { key: "register", kind: "register", label: "Register/Övrigt" },
] as const);

export type GroupKey = (typeof GROUPS)[number]["key"];

export const CATALOGUE_GROUPS: readonly CatalogueGroup[] = GROUPS;

/** A permission of `group`: its key, its screen words, and its marks. */
function right<const K extends string, const G extends GroupKey>(group: G, key: K, label: string, marks: { view?: true; manualOnly?: true } = {}) {
  return { key, group, label, view: marks.view ?? false, manualOnly: marks.manualOnly ?? false };
}

const PERMISSIONS = frozen([
  // Bokföring, Verifikationer, then the two that only Bokföring - Attest & Läs holds.
  right("vouchers", "vouchers.view", "Verifikationer", { view: true }),
  right("vouchers", "vouchers.book", "Bokför"),
  right("vouchers", "vouchers.delete", "Radera"),
  right("vouchers", "vouchers.alter", "Ändra"),
  right("vouchers", "vouchers.accrue", "Periodisera"),
  right("vouchers", "vouchers.created-by", "Se skapad av/ändrad av"),
  right("vouchers", "vouchers.cash-register", "Registrera dagskassa"),
  right("vouchers", "vouchers.receipts", "Registrera kvitton"),
  right("vouchers", "vouchers.accruals", "Periodiseringar"),
  right("vouchers", "vouchers.run-accruals-vouchers", "Utföra periodiseringar verifikationer"),
  right("vouchers", "vouchers.run-accruals-supplier-invoices", "Utföra periodiseringar leverantörsfakturor"),
  right("vouchers", "vouchers.run-accruals-customer-invoices", "Utföra periodiseringar kundfakturor"),
  right("vouchers", "vouchers.reconcile", "Stäm av konto"),
  right("vouchers", "vouchers.delete-bank-transactions", "Ta bort banktransaktioner"),
  right("vouchers", "vouchers.search-amount", "Sök belopp"),
  right("vouchers", "vouchers.settings", "Inställningar"),
  right("vouchers", "vouchers.lock-period", "Låsa period"),
  right("vouchers", "vouchers.approve-own-series", "Se /attestera verifikationsserie där användaren är attestant"),
  right("vouchers", "vouchers.see-all-series", "Se samtliga verifikationsserier"),
  // Bokföring, Leverantörsfakturor.
  right("supplier-invoices", "supplier-invoices.view", "Leverantörsfakturor", { view: true }),
  right("supplier-invoices", "supplier-invoices.save", "Spara"),
  right("supplier-invoices", "supplier-invoices.book", "Bokför"),
  right("supplier-invoices", "supplier-invoices.void", "Makulera"),
  right("supplier-invoices", "supplier-invoices.payment-file", "Betalfil"),
  right("supplier-invoices", "supplier-invoices.undo-payment-file", "Ångra betalfil"),
  right("supplier-invoices", "supplier-invoices.accrue", "Periodisera"),
  right("supplier-invoices", "supplier-invoices.delete-attachments", "Ta bort kopplade bilder"),
  right("supplier-invoices", "supplier-invoices.created-by", "Se skapad av / ändrad av"),
  right("supplier-invoices", "supplier-invoices.inbox", "Inkomna fakturor /dokument"),
  right("supplier-invoices", "supplier-invoices.send-for-interpretation", "Skicka för tolkning"),
  right("supplier-invoices", "supplier-invoices.disbursements", "Utbetalningar"),
  right("supplier-invoices", "supplier-invoices.settings", "Inställningar"),
  // Rapporter for Bokföring, then the four that only Bokföring - Attest & Läs holds.
  right("reports", "reports.balance-sheet", "Balansrapport"),
  right("reports", "reports.deleted-vouchers", "Borttagna verifikationer"),
  right("reports", "reports.general-ledger", "Huvudbok"),
  right("reports", "reports.opening-balance", "Ingående balans"),
  right("reports", "reports.account-analysis", "Kontoanalys"),
  right("reports", "reports.liquidity", "Likviditetsrapport"),
  right("reports", "reports.vat", "Momsrapport"),
  right("reports", "reports.accruals", "Periodiseringar"),
  right("reports", "reports.periodic-summary", "Periodisk sammanställning (kvartalsrapport)"),
  right("reports", "reports.project-accounting", "Projektredovisning"),
  right("reports", "reports.budget", "Resultatbudget"),
  right("reports", "reports.income-statement", "Resultatrapport"),
  right("reports", "reports.income-statement-12-months", "Resultatrapport 12 månader"),
  right("reports", "reports.income-statement-advanced", "Resultatrapport avancerad"),
  right("reports", "reports.system-documentation", "Systemdokumentation"),
  right("reports", "reports.voucher-list", "Verifikationslista"),
  right("reports", "reports.show-struck-rows", "Visa strukna rader"),
  right("reports", "reports.processing-history", "Behandlingshistoriken"),
  right("reports", "reports.supplier-invoices", "Leverantörsfakturor"),
  right("reports", "reports.supplier-statistics", "Leverantörsstatistik"),
  right("reports", "reports.supplier-ledger", "Reskontralista - Leverantörsfakturor"),
  right("reports", "reports.supplier-due-list", "Förfallolista - Leverantörsfakturor"),
  // Register/Övrigt, shared by all programs; the last three only by hand.
  right("register", "register.suppliers", "Leverantörer"),
  right("register", "register.chart-of-accounts", "Kontoplan"),
  right("register", "register.cost-centres", "Kostnadsställen"),
  right("register", "register.projects", "Projekt"),
  right("register", "register.sie-export", "Sie-export"),
  right("register", "register.sie-import", "Sie-import"),
  right("register", "register.export-files", "Exportera filer"),
  right("register", "register.anonymise-fiscal-year", "Anonymisera räkenskapsår", { manualOnly: true }),
  right("register", "register.removed-users", "Hantera borttagna användare", { manualOnly: true }),
  right("register", "register.delete-processing-history", "Radera behandlingshistorik", { manualOnly: true }),
] as const);

/** A permission of the catalogue, by its key. */
export type CataloguePermissionKey = (typeof PERMISSIONS)[number]["key"];

export const CATALOGUE_PERMISSIONS: readonly CataloguePermission[] = PERMISSIONS;

/** The eighteen Rapporter for Bokföring, the Bokföring reports, Behandlingshistoriken among them. */
const BOOKKEEPING_REPORTS: readonly CataloguePermissionKey[] = [
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
];

/** The six that only Bokföring - Attest & Läs holds. */
const APPROVAL_READ_ONLY: readonly CataloguePermissionKey[] = [
  "vouchers.approve-own-series",
  "vouchers.see-all-series",
  "reports.supplier-invoices",
  "reports.supplier-statistics",
  "reports.supplier-ledger",
  "reports.supplier-due-list",
];

/** The keys of a group's permissions, in the catalogue's order. */
function groupKeys(group: GroupKey): CataloguePermissionKey[] {
  return PERMISSIONS.filter((permission) => permission.group === group).map((permission) => permission.key);
}

/** Each program's set: the rights of "Full behörighet", and those that are switched on by hand only. */
const SETS: Readonly<Record<Program, { readonly full: readonly CataloguePermissionKey[]; readonly byHand: readonly CataloguePermissionKey[] }>> = {
  // Every right of the two Bokföring groups, the Bokföring reports and the
  // Register/Övrigt rights, but none of the six of Bokföring - Attest & Läs;
  // the manual-only rights by hand.
  bookkeeping: {
    full: [
      ...groupKeys("vouchers"),
      ...groupKeys("supplier-invoices"),
      ...BOOKKEEPING_REPORTS,
      ...PERMISSIONS.filter((permission) => permission.group === "register" && !permission.manualOnly).map((permission) => permission.key),
    ].filter((permission) => !APPROVAL_READ_ONLY.includes(permission)),
    byHand: PERMISSIONS.filter((permission) => permission.manualOnly).map((permission) => permission.key),
  },
  // See and attest vouchers, see supplier invoices, and fifteen Bokföring
  // reports with the four supplier reports.
  "approval-read": {
    full: [
      "vouchers.view",
      "vouchers.created-by",
      "vouchers.approve-own-series",
      "vouchers.see-all-series",
      "supplier-invoices.view",
      ...BOOKKEEPING_REPORTS.filter((report) => !["reports.periodic-summary", "reports.show-struck-rows", "reports.processing-history"].includes(report)),
      "reports.supplier-invoices",
      "reports.supplier-statistics",
      "reports.supplier-ledger",
      "reports.supplier-due-list",
    ],
    byHand: [],
  },
  // The view rights and the reports of Bokföring, and no action right.
  read: {
    full: ["vouchers.view", "supplier-invoices.view", ...BOOKKEEPING_REPORTS],
    byHand: [],
  },
  // Read access to Bokföring and its reports, Behandlingshistoriken
  // included; Exportera filer and Sie-export by hand.
  auditor: {
    full: ["vouchers.view", "vouchers.created-by", "supplier-invoices.view", "supplier-invoices.created-by", ...BOOKKEEPING_REPORTS],
    byHand: ["register.sie-export", "register.export-files"],
  },
};

/** The keys, once each, in the catalogue's order. */
function ordered(keys: readonly CataloguePermissionKey[]): CataloguePermissionKey[] {
  return PERMISSIONS.map((permission) => permission.key).filter((key) => keys.includes(key));
}

/** Each program's set, program by program, each in the catalogue's order. */
export const PROGRAM_PERMISSIONS: readonly ProgramPermission[] = frozen(
  PROGRAMS.flatMap((program) => {
    const { full, byHand } = SETS[program];
    return ordered([...full, ...byHand]).map((permission) => ({ program, permission, inFull: full.includes(permission) }));
  }),
);

/** The rights of a program's "Full behörighet", in the catalogue's order. Each call gives a new list. */
export function fullPermissions(program: Program): CataloguePermissionKey[] {
  return PROGRAM_PERMISSIONS.filter((row) => row.program === program && row.inFull).map((row) => row.permission);
}

/** Every right a program may grant, "Full behörighet" and those by hand, in the catalogue's order. Each call gives a new list. */
export function programPermissions(program: Program): CataloguePermissionKey[] {
  return PROGRAM_PERMISSIONS.filter((row) => row.program === program).map((row) => row.permission);
}

/** The view right of each permission in a group that has one. */
const VIEWS: ReadonlyMap<CataloguePermissionKey, CataloguePermissionKey> = new Map(
  PERMISSIONS.flatMap((permission) =>
    PERMISSIONS.filter((entry) => entry.group === permission.group && entry.view).map((view) => [permission.key, view.key] as const),
  ),
);

/** The view right of a permission's group, which every other permission of the group needs, or null for a group that has none. */
export function viewPermissionOf(permission: CataloguePermissionKey): CataloguePermissionKey | null {
  return VIEWS.get(permission) ?? null;
}
