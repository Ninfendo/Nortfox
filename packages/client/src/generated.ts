// SPDX-License-Identifier: MIT

// Generated from openapi.json by scripts/generate.ts. Do not edit it by hand:
// change the API, then run `pnpm openapi`.

import type { CallOptions, Send, WriteOptions } from "./runtime.ts";

/**
 * A company: its id, name, organisation number and tenant id, and its postal and visiting addresses and contact details when they are set.
 */
export interface Company {
  /**
   * The company's id.
   */
  readonly id: string;
  /**
   * The company's name.
   */
  readonly name: string;
  /**
   * The organisation number: ten digits with a hyphen after the sixth. For a sole trader it is the owner's personal identity number.
   */
  readonly organizationNumber: string;
  /**
   * The company's number for programs, its tenant id. It never changes.
   */
  readonly databaseNumber: number;
  /**
   * Adress: the postal address's street or box line. Absent when it is not set.
   */
  readonly address?: string;
  /**
   * Postnummer: the postal address's postal code. Absent when it is not set.
   */
  readonly zipCode?: string;
  /**
   * Ort: the postal address's town. Absent when it is not set.
   */
  readonly city?: string;
  /**
   * Land: the postal address's country, as its code in ISO 3166-1 alpha-2, two capital letters such as SE. Absent when it is not set.
   */
  readonly countryCode?: string;
  /**
   * Besöksadress: the visiting address's street. Absent when it is not set.
   */
  readonly visitAddress?: string;
  /**
   * The visiting address's postal code. Absent when it is not set.
   */
  readonly visitZipCode?: string;
  /**
   * The visiting address's town. Absent when it is not set.
   */
  readonly visitCity?: string;
  /**
   * The visiting address's country, as its code in ISO 3166-1 alpha-2, two capital letters such as SE. Absent when it is not set.
   */
  readonly visitCountryCode?: string;
  /**
   * Telefon: the company's phone number. Absent when it is not set.
   */
  readonly phone?: string;
  /**
   * E-post: the company's e-mail address. Absent when it is not set.
   */
  readonly email?: string;
}

/**
 * A company where the person is an active member, with the person's system administrator's level there when they have one.
 */
export interface CompanyChoice {
  readonly company: CompanySummary;
  readonly adminLevel?: SysAdmin;
}

/**
 * A company as the company lists give it: its id, name, organisation number and tenant id. getCompany gives its addresses and contact details.
 */
export interface CompanySummary {
  /**
   * The company's id.
   */
  readonly id: string;
  /**
   * The company's name.
   */
  readonly name: string;
  /**
   * The organisation number: ten digits with a hyphen after the sixth. For a sole trader it is the owner's personal identity number.
   */
  readonly organizationNumber: string;
  /**
   * The company's number for programs, its tenant id. It never changes.
   */
  readonly databaseNumber: number;
}

/**
 * What is wrong with one field of a request.
 */
export interface FieldProblem {
  /**
   * What is wrong with the field, as a stable kebab-case code.
   */
  readonly code: string;
  /**
   * The same in an English sentence.
   */
  readonly detail: string;
  /**
   * A JSON Pointer to the field in the operation's input: the path parameters, the query parameters, the body's fields and, for a write, idempotencyKey. An empty pointer is the whole input.
   */
  readonly pointer: string;
  /**
   * The facts behind the code, such as expected, minimum, maximum or allowed. Absent when there are none.
   */
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * Whether the server is up.
 */
export interface Health {
  /**
   * Always "ok" when the server answers.
   */
  readonly status: "ok";
  /**
   * The version of the server that answered.
   */
  readonly version: string;
}

/**
 * Inbjudan: an invitation to a company, as its link shows it. The link works once, for 14 days, and a newer invitation of the same member stops it.
 */
export interface Invitation {
  /**
   * The name the invitation was sent to.
   */
  readonly name: string;
  /**
   * The e-mail address the invitation was sent to. A new identity takes it as its e-mail address.
   */
  readonly email: string;
  /**
   * When the link stops working: 14 days after the invitation was sent.
   */
  readonly expiresAt: string;
  /**
   * The name of the company the invitation is to, as it was when the invitation was sent.
   */
  readonly companyName: string;
  /**
   * The name of the system administrator who sent the invitation, as it was then.
   */
  readonly inviterName: string;
}

/**
 * An accepted invitation: the person who now holds the membership, and the membership. For a new identity, also its TOTP secret, which no answer gives again: the person signs in next, with the password and a code. The TOTP enrolment is absent when the signed-in identity accepted.
 */
export interface InvitationAcceptance {
  readonly user: User;
  readonly membership: Membership;
  readonly totpEnrolment?: TotpEnrolment;
}

/**
 * The signed-in person, with their own login data, and the company the request works in with the person's membership and permissions there.
 */
export interface Me {
  readonly user: User;
  /**
   * The person's personnummer, in twelve digits with a hyphen. Absent until one is added.
   */
  readonly personalIdentityNumber?: string;
  /**
   * The person's mobile number. Absent when none is set.
   */
  readonly mobile?: string;
  /**
   * How often a password sign-in asks for a TOTP code: new_device_90_days on each new device and every 90 days on a known one, or every_login.
   */
  readonly twoStep: "new_device_90_days" | "every_login";
  readonly company?: Company;
  readonly membership?: Membership;
  /**
   * The permissions the request holds in that company, in alphabetical order: a member's own, the admin level's, a program administrator's while the member administers a program, and the rights of the member's program grants. A session holds those it took when it chose the company, less a right whose grant has ended since. Empty when the request works in no company.
   */
  readonly permissions: readonly string[];
}

/**
 * Användare: a member of the company, by the membership's id, with the person's name, the status, the system administrator's level, the idle logout, the work contacts, the roles, the program grants and the programs administered. A program administrator sees only the grants and the administration of the programs they administer, and the roles those give.
 */
export interface Member {
  /**
   * The membership's id: the member's id in the company, which the paths of /v1/users take as memberId.
   */
  readonly id: string;
  /**
   * The company's id.
   */
  readonly companyId: string;
  /**
   * The person's id. Absent while the membership is invited.
   */
  readonly userId?: string;
  /**
   * The person's name; for an invited member, the name the latest invitation was sent to. Absent for an invited member with no invitation.
   */
  readonly name?: string;
  /**
   * invited, active, inactive, removed or left.
   */
  readonly status: "invited" | "active" | "inactive" | "removed" | "left";
  readonly adminLevel?: SysAdmin;
  /**
   * Utloggning efter inaktivitet, in whole minutes: 15, 30, 60, 120 (2 hours, the default) or 480 (8 hours).
   */
  readonly idleTimeout: 15 | 30 | 60 | 120 | 480;
  /**
   * The person's work e-mail address in this company, where its notices go. Every active and inactive member has one. An invited member has one only when updateUser gave it, and accepting the invitation sets it to the invitation's address. A removed, a left or a disconnected member has none.
   */
  readonly workEmail?: string;
  /**
   * The person's work phone number in this company. Absent when none is set.
   */
  readonly workPhone?: string;
  /**
   * The roles the member holds now, in the roles' order: owner or admin by the admin level, bookkeeper by a Bokföring grant with Full behörighet, and approver, viewer and auditor by a grant of their program that has not ended.
   */
  readonly roles: readonly Role[];
  /**
   * The member's program grants as they are now, in the catalogue's order, also one that has ended.
   */
  readonly programs: readonly ProgramGrant[];
  /**
   * The programs the member administers, in the catalogue's order.
   */
  readonly programsAdministered: readonly ProgramAdmin[];
}

/**
 * Användare in one company: a person's membership there, with its status, the system administrator's level, the idle logout, the work contacts, the roles, the program grants and the programs administered.
 */
export interface Membership {
  /**
   * The membership's id: the member's id in the company, which the paths of /v1/users take as memberId.
   */
  readonly id: string;
  /**
   * The company's id.
   */
  readonly companyId: string;
  /**
   * The person's id. Absent while the membership is invited.
   */
  readonly userId?: string;
  /**
   * invited, active, inactive, removed or left.
   */
  readonly status: "invited" | "active" | "inactive" | "removed" | "left";
  readonly adminLevel?: SysAdmin;
  /**
   * Utloggning efter inaktivitet, in whole minutes: 15, 30, 60, 120 (2 hours, the default) or 480 (8 hours).
   */
  readonly idleTimeout: 15 | 30 | 60 | 120 | 480;
  /**
   * The person's work e-mail address in this company, where its notices go. Every active and inactive member has one. An invited member has one only when updateUser gave it, and accepting the invitation sets it to the invitation's address. A removed, a left or a disconnected member has none.
   */
  readonly workEmail?: string;
  /**
   * The person's work phone number in this company. Absent when none is set.
   */
  readonly workPhone?: string;
  /**
   * The roles the member holds now, in the roles' order: owner or admin by the admin level, bookkeeper by a Bokföring grant with Full behörighet, and approver, viewer and auditor by a grant of their program that has not ended.
   */
  readonly roles: readonly Role[];
  /**
   * The member's program grants as they are now, in the catalogue's order, also one that has ended.
   */
  readonly programs: readonly ProgramGrant[];
  /**
   * The programs the member administers, in the catalogue's order.
   */
  readonly programsAdministered: readonly ProgramAdmin[];
}

/**
 * What a right password gives: a session, or the TOTP step.
 */
export interface PasswordSignIn {
  /**
   * signed-in: the session cookie is set, on a known device inside its 90 days. totp-required: verifyTotp comes next, with the challenge.
   */
  readonly outcome: "signed-in" | "totp-required";
  /**
   * The login challenge, for verifyTotp, when the outcome is totp-required. It works for 20 minutes and for five codes.
   */
  readonly challenge?: string;
}

/**
 * Behörighet: a permission of the catalogue, with its group, its screen words and its marks.
 */
export interface Permission {
  readonly key: PermissionKey;
  readonly group: PermissionGroupKey;
  /**
   * The permission's words on the screen, such as Bokför.
   */
  readonly label: string;
  /**
   * Whether it is its group's view right, which every other permission of the group needs.
   */
  readonly view: boolean;
  /**
   * Whether it is only switched on by hand: Full behörighet never holds it.
   */
  readonly manualOnly: boolean;
}

/**
 * The permission catalogue: the roles, the programs with their sets, the groups and the permissions, in order.
 */
export interface PermissionCatalogue {
  /**
   * The plan's six roles, in their order.
   */
  readonly roles: readonly RoleDefinition[];
  /**
   * The programs, in the catalogue's order.
   */
  readonly programs: readonly ProgramDefinition[];
  /**
   * The groups, in the catalogue's order.
   */
  readonly groups: readonly PermissionGroup[];
  /**
   * Every permission, in the catalogue's order.
   */
  readonly permissions: readonly Permission[];
}

/**
 * A group of permissions, with its kind and its screen words.
 */
export interface PermissionGroup {
  readonly key: PermissionGroupKey;
  /**
   * program, for a Bokföring group of a program's own rights; reports, for Rapporter; or register, for Register/Övrigt.
   */
  readonly kind: "program" | "reports" | "register";
  /**
   * The group's words on the screen, such as Verifikationer.
   */
  readonly label: string;
}

/**
 * A group of the catalogue, by its key: vouchers (Verifikationer), supplier-invoices (Leverantörsfakturor), reports (Rapporter) or register (Register/Övrigt).
 */
export type PermissionGroupKey = "vouchers" | "supplier-invoices" | "reports" | "register";

/**
 * A permission of the catalogue, by its key, such as vouchers.view (Verifikationer) or vouchers.book (Bokför).
 */
export type PermissionKey = "vouchers.view" | "vouchers.book" | "vouchers.delete" | "vouchers.alter" | "vouchers.accrue" | "vouchers.created-by" | "vouchers.cash-register" | "vouchers.receipts" | "vouchers.accruals" | "vouchers.run-accruals-vouchers" | "vouchers.run-accruals-supplier-invoices" | "vouchers.run-accruals-customer-invoices" | "vouchers.reconcile" | "vouchers.delete-bank-transactions" | "vouchers.search-amount" | "vouchers.settings" | "vouchers.lock-period" | "vouchers.approve-own-series" | "vouchers.see-all-series" | "supplier-invoices.view" | "supplier-invoices.save" | "supplier-invoices.book" | "supplier-invoices.void" | "supplier-invoices.payment-file" | "supplier-invoices.undo-payment-file" | "supplier-invoices.accrue" | "supplier-invoices.delete-attachments" | "supplier-invoices.created-by" | "supplier-invoices.inbox" | "supplier-invoices.send-for-interpretation" | "supplier-invoices.disbursements" | "supplier-invoices.settings" | "reports.balance-sheet" | "reports.deleted-vouchers" | "reports.general-ledger" | "reports.opening-balance" | "reports.account-analysis" | "reports.liquidity" | "reports.vat" | "reports.accruals" | "reports.periodic-summary" | "reports.project-accounting" | "reports.budget" | "reports.income-statement" | "reports.income-statement-12-months" | "reports.income-statement-advanced" | "reports.system-documentation" | "reports.voucher-list" | "reports.show-struck-rows" | "reports.processing-history" | "reports.supplier-invoices" | "reports.supplier-statistics" | "reports.supplier-ledger" | "reports.supplier-due-list" | "register.suppliers" | "register.chart-of-accounts" | "register.cost-centres" | "register.projects" | "register.sie-export" | "register.sie-import" | "register.export-files" | "register.anonymise-fiscal-year" | "register.removed-users" | "register.delete-processing-history";

/**
 * Problem details (RFC 9457) with a stable code.
 */
export interface Problem {
  /**
   * A URI for the kind of problem. NortFox sends about:blank, and the code says what went wrong.
   */
  readonly type: string;
  /**
   * The status in words, such as Bad Request.
   */
  readonly title: string;
  /**
   * The HTTP status.
   */
  readonly status: number;
  /**
   * What went wrong, in an English sentence.
   */
  readonly detail: string;
  /**
   * What went wrong, as a stable kebab-case code. Clients rely on this.
   */
  readonly code: string;
  /**
   * For invalid-request: what is wrong with each field.
   */
  readonly errors?: readonly FieldProblem[];
  /**
   * For permission-missing: the permission the operation needs.
   */
  readonly permission?: string;
  /**
   * For a rule's refusal that concerns one field: that field's JSON Pointer.
   */
  readonly pointer?: string;
  /**
   * For a rule's refusal: the facts behind it.
   */
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * A program: bookkeeping (Bokföring), approval-read (Bokföring - Attest & Läs), read (Läs) or auditor (Revisor).
 */
export type Program = "bookkeeping" | "approval-read" | "read" | "auditor";

/**
 * Programadministratör: the member grants, narrows and removes this program, and its Rapporter and Register/Övrigt rights.
 */
export interface ProgramAdmin {
  readonly program: Program;
}

/**
 * Program: a program of the catalogue, with its screen words, its end, and its set.
 */
export interface ProgramDefinition {
  readonly key: Program;
  /**
   * The program's words on the screen, such as Bokföring.
   */
  readonly label: string;
  /**
   * The days after which a grant of the program ends by itself: 30 for Revisor. Absent for a program whose grant has no end.
   */
  readonly lifetimeDays?: number;
  /**
   * The program's set: every permission a grant of it may hold, in the catalogue's order.
   */
  readonly permissions: readonly ({
    readonly key: PermissionKey;
    /**
     * Whether Full behörighet holds it. A permission that it does not hold is only switched on by hand.
     */
    readonly full: boolean;
  })[];
}

/**
 * Program: a program granted to a member, with the rights the grant holds.
 */
export interface ProgramGrant {
  readonly program: Program;
  /**
   * The rights the grant holds, as the catalogue's permission keys, in the catalogue's order.
   */
  readonly permissions: readonly string[];
  /**
   * Full behörighet: whether the grant holds every right of its program's Full behörighet, which a grant gets by default.
   */
  readonly full: boolean;
  /**
   * When the program was granted.
   */
  readonly grantedAt: string;
  /**
   * When the grant ends by itself, with no action by anyone: a Revisor grant 30 days after it was granted. From then on it gives nothing. Absent for a grant with no end.
   */
  readonly expiresAt?: string;
}

/**
 * The three companies the person chose last, where the person is still an active member.
 */
export interface RecentCompanies {
  /**
   * The companies, the latest chosen first.
   */
  readonly companies: readonly CompanyChoice[];
}

/**
 * A Rapporter or Register/Övrigt right of the catalogue, by its key, such as reports.vat (Momsrapport) or register.sie-export (Sie-export). A right of a program's own group, such as vouchers.view, is not one.
 */
export type RightKey = "reports.balance-sheet" | "reports.deleted-vouchers" | "reports.general-ledger" | "reports.opening-balance" | "reports.account-analysis" | "reports.liquidity" | "reports.vat" | "reports.accruals" | "reports.periodic-summary" | "reports.project-accounting" | "reports.budget" | "reports.income-statement" | "reports.income-statement-12-months" | "reports.income-statement-advanced" | "reports.system-documentation" | "reports.voucher-list" | "reports.show-struck-rows" | "reports.processing-history" | "reports.supplier-invoices" | "reports.supplier-statistics" | "reports.supplier-ledger" | "reports.supplier-due-list" | "register.suppliers" | "register.chart-of-accounts" | "register.cost-centres" | "register.projects" | "register.sie-export" | "register.sie-import" | "register.export-files" | "register.anonymise-fiscal-year" | "register.removed-users" | "register.delete-processing-history";

/**
 * One of the plan's six roles: owner or admin, a system administrator's level; bookkeeper, Bokföring with Full behörighet; approver, Bokföring - Attest & Läs; viewer, Läs; auditor, Revisor.
 */
export type Role = "owner" | "admin" | "bookkeeper" | "approver" | "viewer" | "auditor";

/**
 * One of the plan's six roles, as a set in this model: owner and admin by the admin level that adminLevel names; the other four by a grant of the program that program names, with Full behörighet when full is true.
 */
export interface RoleDefinition {
  readonly key: Role;
  readonly adminLevel?: SysAdmin;
  readonly program?: Program;
  /**
   * For a program's role: whether only a grant with Full behörighet makes it, as for bookkeeper.
   */
  readonly full?: boolean;
}

/**
 * The browser's session: the person it signed in, and the company it works in once one is chosen.
 */
export interface Session {
  readonly user: User;
  readonly company?: Company;
}

/**
 * The first identity of the install, with its TOTP enrolment. The person signs in next, with the password and a code.
 */
export interface SetupResult {
  readonly user: User;
  readonly totpEnrolment: TotpEnrolment;
}

/**
 * Systemadministratör: owner, the person who made the company, or admin, a member made system administrator later. Both hold the same rights, and neither gives work rights by itself.
 */
export type SysAdmin = "owner" | "admin";

/**
 * A new TOTP secret, which the person adds to an authenticator app.
 */
export interface TotpEnrolment {
  /**
   * The TOTP secret as an otpauth URI, for an authenticator app: show it as a QR code. The first right code of it confirms it.
   */
  readonly otpauthUri: string;
}

/**
 * A person: their NortFox ID, the one login identity they use for every company.
 */
export interface User {
  /**
   * The person's id. The person stays the actor of every entry they made.
   */
  readonly id: string;
  /**
   * The person's name.
   */
  readonly name: string;
  /**
   * The person's personal e-mail address. A password sign-in takes it as the identifier, in any letter case.
   */
  readonly email: string;
  /**
   * Språk: sv (Svenska) or en (English). It applies in every company.
   */
  readonly language: "sv" | "en";
}

/**
 * A member's Rapporter and Register/Övrigt rights, and the program grants that hold them.
 */
export interface UserRights {
  /**
   * The member's Rapporter and Register/Övrigt rights, as the grants hold them now, in the catalogue's order.
   */
  readonly permissions: readonly string[];
  /**
   * The member's grants as they are now, in the catalogue's order.
   */
  readonly programs: readonly ProgramGrant[];
}

export interface Operations {
  /**
   * Sign out
   *
   * Ends the browser's session, so its cookie is refused from the next request, and clears the cookie.
   *
   * `POST /v1/auth/logout`
   *
   * Needs a signed-in person, and works in no company.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   *
   * Serves the browser's session: its MCP tool refuses every call.
   */
  logout(options: WriteOptions): Promise<void>;

  /**
   * Sign in with a password
   *
   * Signs in with an identifier, the e-mail address in any letter case or the personnummer, and the password. A right password gives the TOTP step, or a session on a known device inside its 90 days when the person's two-step choice allows it. Every failure gets the same answer. After 5 failures in an hour each attempt waits longer, and after 100 the sign-in waits until the hour has passed.
   *
   * `POST /v1/auth/password`
   *
   * Needs no actor: anyone may call it, before signing in.
   *
   * Serves the browser's session: its MCP tool refuses every call.
   */
  loginWithPassword(
    input: {
      /**
       * The e-mail address, or the personnummer in 10 or 12 digits.
       */
      readonly identifier: string;
      /**
       * The password.
       */
      readonly password: string;
    },
    options?: CallOptions,
  ): Promise<PasswordSignIn>;

  /**
   * Give the TOTP code
   *
   * Ends a password sign-in with the six digits of the person's authenticator app. A right code sets the session cookie, and makes the browser a known device. A code works once. A challenge takes five codes, and ten wrong codes in 15 minutes stop the TOTP step for 15 minutes.
   *
   * `POST /v1/auth/totp`
   *
   * Needs no actor: anyone may call it, before signing in.
   *
   * Serves the browser's session: its MCP tool refuses every call.
   */
  verifyTotp(
    input: {
      /**
       * The login challenge that loginWithPassword gave.
       */
      readonly challenge: string;
      /**
       * The six digits of the authenticator app.
       */
      readonly code: string;
    },
    options?: CallOptions,
  ): Promise<void>;

  /**
   * List your companies
   *
   * Lists the companies where the signed-in person is an active member, by name, with the person's system administrator's level in each. query keeps the companies whose name holds it, in any letter case, or whose organisation number holds it, with or without the hyphen.
   *
   * `GET /v1/companies`
   *
   * Needs a signed-in person, and works in no company.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   */
  listCompanies(
    input?: {
      /**
       * A part of the company's name, in any letter case, or of its organisation number, with or without the hyphen.
       */
      readonly query?: string;
      /**
       * How many items a page holds: from 1 to 500. Any other whole number gives 100.
       */
      readonly limit?: number;
      /**
       * Where the page starts: the nextCursor of the page before. Leave it out for the first page.
       */
      readonly cursor?: string;
    },
    options?: CallOptions,
  ): Promise<{
  /**
   * The items of this page, in the list's order.
   */
  readonly items: readonly CompanyChoice[];
  /**
   * Where the next page starts. It is absent on the last page.
   */
  readonly nextCursor?: string;
  /**
   * How many items the whole list holds.
   */
  readonly total: number;
}>;

  /**
   * Create a company
   *
   * Makes a company with its name and organisation number, and makes the signed-in person its owner, a system administrator, in the same transaction. The company gets its tenant id, a number that is never given out again. The organisation number never changes.
   *
   * `POST /v1/companies`
   *
   * Needs a signed-in person, and works in the company it makes.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   */
  createCompany(
    input: {
      /**
       * The company's name, on one line.
       */
      readonly name: string;
      /**
       * The organisation number: ten digits with a hyphen after the sixth.
       */
      readonly organizationNumber: string;
    },
    options: WriteOptions,
  ): Promise<Company>;

  /**
   * Read the company
   *
   * Gives the company the request works in: its id, name, organisation number and tenant id, and its postal and visiting addresses and its phone number and e-mail address when they are set. The company comes from the request's credential.
   *
   * `GET /v1/company`
   *
   * Needs the permission `company:read`, in the company that the credential names.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   */
  getCompany(options?: CallOptions): Promise<Company>;

  /**
   * Change the company
   *
   * Changes the request's company: its name, its postal and visiting addresses, and its phone number and e-mail address. A field left out stays as it is, and null takes an address field or a contact detail away. The organisation number never changes, so the operation does not take it.
   *
   * `PATCH /v1/company`
   *
   * Needs the permission `company:update`, in the company that the credential names.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   */
  updateCompany(
    input: {
      /**
       * The company's name, on one line.
       */
      readonly name?: string;
      /**
       * Adress: the postal address's street or box line. null takes it away.
       */
      readonly address?: string | null;
      /**
       * Postnummer: the postal address's postal code. null takes it away.
       */
      readonly zipCode?: string | null;
      /**
       * Ort: the postal address's town. null takes it away.
       */
      readonly city?: string | null;
      /**
       * Land: the postal address's country, as its code in ISO 3166-1 alpha-2, two capital letters such as SE. null takes it away.
       */
      readonly countryCode?: string | null;
      /**
       * Besöksadress: the visiting address's street. null takes it away.
       */
      readonly visitAddress?: string | null;
      /**
       * The visiting address's postal code. null takes it away.
       */
      readonly visitZipCode?: string | null;
      /**
       * The visiting address's town. null takes it away.
       */
      readonly visitCity?: string | null;
      /**
       * The visiting address's country, as its code in ISO 3166-1 alpha-2, two capital letters such as SE. null takes it away.
       */
      readonly visitCountryCode?: string | null;
      /**
       * Telefon: the company's phone number. null takes it away.
       */
      readonly phone?: string | null;
      /**
       * E-post: the company's e-mail address. null takes it away.
       */
      readonly email?: string | null;
    },
    options: WriteOptions,
  ): Promise<Company>;

  /**
   * Check that the server is up
   *
   * Answers as soon as the server runs. It reads no data.
   *
   * `GET /v1/health`
   *
   * Needs no permission: it reads no data.
   */
  getHealth(options?: CallOptions): Promise<Health>;

  /**
   * Read an invitation
   *
   * Gives the invitation that a link holds: the name and the e-mail address it was sent to, the company, who sent it, and when the link stops working. A link that is unknown, used, stopped by a newer invitation or past its 14 days gets one answer, 422 invitation-link-invalid.
   *
   * `GET /v1/invitations/{token}`
   *
   * Needs no actor: anyone may call it, before signing in.
   *
   * Serves the browser's session: its MCP tool refuses every call.
   *
   * The answer holds personal data: `/name`, `/email`, `/inviterName`.
   */
  getInvitation(
    input: {
      /**
       * The invitation link's token, from the invitation's mail.
       */
      readonly token: string;
    },
    options?: CallOptions,
  ): Promise<Invitation>;

  /**
   * Accept an invitation
   *
   * Accepts the invitation that a link holds, once. With newIdentity, Skapa ett nytt NortFox ID: a new identity with that name and a password of 12 to 1024 characters, which takes the invitation's e-mail address; the answer gives its TOTP secret, and sets no session, so the person signs in next with the password and a code. Without it, Koppla ihop med befintligt NortFox ID: the identity of the browser's session accepts, and with no session the call gets 422 sign-in-required. The member's work e-mail address becomes the invitation's. A link that is unknown, used, stopped by a newer invitation or past its 14 days gets one answer, 422 invitation-link-invalid. An e-mail address that another identity has gets 422 email-taken, and a person who is a member of the company already gets 422 already-member.
   *
   * `POST /v1/invitations/{token}/accept`
   *
   * Needs no actor: anyone may call it, before signing in.
   *
   * Serves the browser's session: its MCP tool refuses every call.
   *
   * The answer holds personal data: `/user/name`, `/user/email`, `/membership/workEmail`, `/membership/workPhone`.
   */
  acceptInvitation(
    input: {
      /**
       * The invitation link's token, from the invitation's mail.
       */
      readonly token: string;
    } & {
      /**
       * Skapa ett nytt NortFox ID: the new identity's name and password. It takes the invitation's e-mail address. Left out, Koppla ihop med befintligt NortFox ID: the signed-in person accepts.
       */
      readonly newIdentity?: {
        /**
         * The person's name, on one line.
         */
        readonly name: string;
        /**
         * The password: 12 to 1024 characters.
         */
        readonly password: string;
      };
    },
    options?: CallOptions,
  ): Promise<InvitationAcceptance>;

  /**
   * Read yourself
   *
   * Gives the signed-in person: their name, e-mail address and language, their personnummer and mobile number when set, and their two-step choice. When the request works in a company, it gives that company too, with the person's membership there, its roles, program grants and programs administered, and the permissions the request holds there.
   *
   * `GET /v1/me`
   *
   * Needs a signed-in person, and works in the company that the credential names, or in none.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   *
   * The answer holds personal data: `/user/name`, `/user/email`, `/personalIdentityNumber`, `/mobile`, `/membership/workEmail`, `/membership/workPhone`.
   */
  getMe(options?: CallOptions): Promise<Me>;

  /**
   * List your recent companies
   *
   * Gives the three companies the signed-in person chose last, the latest first, of those where the person is still an active member.
   *
   * `GET /v1/me/companies/recent`
   *
   * Needs a signed-in person, and works in no company.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   */
  listRecentCompanies(options?: CallOptions): Promise<RecentCompanies>;

  /**
   * Change your membership
   *
   * Changes the signed-in person's own membership in the company that the path names, where the person must be an active member: the work e-mail address and phone number there, and the idle logout. A field left out stays as it is. The work e-mail address is required, so it can be changed but not taken away; null takes the phone number away.
   *
   * `PATCH /v1/me/companies/{companyId}`
   *
   * Needs a signed-in person, and works in the company that `companyId` names, where the person must be an active member.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   *
   * The answer holds personal data: `/workEmail`, `/workPhone`.
   */
  updateMyMembership(
    input: {
      /**
       * The company's id.
       */
      readonly companyId: string;
    } & {
      /**
       * The work e-mail address in this company. It is required, so null is refused: it can be changed but not taken away.
       */
      readonly workEmail?: string;
      /**
       * The work phone number in this company, or null for none.
       */
      readonly workPhone?: string | null;
      /**
       * Utloggning efter inaktivitet, in whole minutes: 15, 30, 60, 120 (2 hours, the default) or 480 (8 hours).
       */
      readonly idleTimeout?: 15 | 30 | 60 | 120 | 480;
    },
    options: WriteOptions,
  ): Promise<Membership>;

  /**
   * Leave a company
   *
   * The signed-in person leaves the company that the path names, where the person must be an active member. The membership stays, with the status left, and its sessions end; the work contacts there are erased. Only a new invitation lets the person back. The company always keeps an active system administrator, so its last one cannot leave.
   *
   * `POST /v1/me/companies/{companyId}/leave`
   *
   * Needs a signed-in person, and works in the company that `companyId` names, where the person must be an active member.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   */
  leaveCompany(
    input: {
      /**
       * The company's id.
       */
      readonly companyId: string;
    },
    options: WriteOptions,
  ): Promise<void>;

  /**
   * List the permissions
   *
   * Gives the permission catalogue as the install holds it: the plan's six roles, the programs with each one's set and what Full behörighet holds, the groups, and every permission, each in the catalogue's order, with its view and manual-only marks.
   *
   * `GET /v1/permissions`
   *
   * Needs a signed-in person, and works in no company.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   */
  listPermissions(options?: CallOptions): Promise<PermissionCatalogue>;

  /**
   * Read the session
   *
   * Gives the browser's session: the person it signed in, and the company it works in once one is chosen.
   *
   * `GET /v1/session`
   *
   * Needs a signed-in person, and works in the company that the credential names, or in none.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   *
   * Serves the browser's session: its MCP tool refuses every call.
   *
   * The answer holds personal data: `/user/name`, `/user/email`.
   */
  getSession(options?: CallOptions): Promise<Session>;

  /**
   * Choose the company
   *
   * Makes the browser's session work in the company that companyId names, where the person must be an active member, without a new sign-in. Any other company, also one that does not exist, gets the same refusal. The session takes the person's permissions there as they are now, and the company's behandlingshistorik gets the sign-in.
   *
   * `POST /v1/session/company`
   *
   * Needs a signed-in person, and works in the company that `companyId` names, where the person must be an active member.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   *
   * Serves the browser's session: its MCP tool refuses every call.
   *
   * The answer holds personal data: `/user/name`, `/user/email`.
   */
  selectCompany(
    input: {
      /**
       * The id of the company to work in.
       */
      readonly companyId: string;
    },
    options: WriteOptions,
  ): Promise<Session>;

  /**
   * Make the first identity
   *
   * Makes the install's first identity from its setup link, with a name, an e-mail address and a password of 12 to 1024 characters. The link works once, for 28 days, on an install with no identity, and a newer link stops it. A link that the setup command made while the install's only identity never confirmed its TOTP secret replaces that identity instead. The answer gives the new TOTP secret, and no answer gives it again. It sets no session: the person signs in next, with the password and a code.
   *
   * `POST /v1/setup/{token}`
   *
   * Needs no actor: anyone may call it, before signing in.
   *
   * Serves the browser's session: its MCP tool refuses every call.
   *
   * The answer holds personal data: `/user/name`, `/user/email`.
   */
  completeSetup(
    input: {
      /**
       * The setup link's token, which the install's setup command printed.
       */
      readonly token: string;
    } & {
      /**
       * The person's name, on one line.
       */
      readonly name: string;
      /**
       * The person's personal e-mail address, one mailbox.
       */
      readonly email: string;
      /**
       * The password: 12 to 1024 characters.
       */
      readonly password: string;
    },
    options?: CallOptions,
  ): Promise<SetupResult>;

  /**
   * List the users
   *
   * Lists the company's invited, active and inactive members, in the order they were added, each with the person's name, the status, the admin level, the idle logout, the work contacts and the programs. A program administrator sees only the programs they administer.
   *
   * `GET /v1/users`
   *
   * Needs the permission `users:read`, in the company that the credential names.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   *
   * The answer holds personal data: `/items/*\/name`, `/items/*\/workEmail`, `/items/*\/workPhone`.
   */
  listUsers(
    input?: {
      /**
       * How many items a page holds: from 1 to 500. Any other whole number gives 100.
       */
      readonly limit?: number;
      /**
       * Where the page starts: the nextCursor of the page before. Leave it out for the first page.
       */
      readonly cursor?: string;
    },
    options?: CallOptions,
  ): Promise<{
  /**
   * The items of this page, in the list's order.
   */
  readonly items: readonly Member[];
  /**
   * Where the next page starts. It is absent on the last page.
   */
  readonly nextCursor?: string;
  /**
   * How many items the whole list holds.
   */
  readonly total: number;
}>;

  /**
   * Invite a user
   *
   * Lägg till användare: makes an invited member of the company, with a name and an e-mail address, and sends the invitation to that address. The mail holds a link that works once, for 14 days, and stops the link of the member's earlier invitation. With no mail set up for the install, the call gets 422 mail-not-configured, and nothing changes. An address that a member of the company has, or that an open invitation of the company goes to, gets 422 already-member.
   *
   * `POST /v1/users`
   *
   * Needs the permission `users:admin`, in the company that the credential names.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   *
   * The answer holds personal data: `/name`, `/workEmail`, `/workPhone`.
   */
  inviteUser(
    input: {
      /**
       * Namn: the invited person's name, on one line.
       */
      readonly name: string;
      /**
       * E-postadress: where the invitation goes, one mailbox. A new identity that accepts takes it as its e-mail address, and the member takes it as the work e-mail address.
       */
      readonly email: string;
    },
    options: WriteOptions,
  ): Promise<Member>;

  /**
   * Read a user
   *
   * Gives one invited, active or inactive member of the company, as listUsers gives it. Any other id, also one of a removed or a left member, gets 422 user-not-found.
   *
   * `GET /v1/users/{memberId}`
   *
   * Needs the permission `users:read`, in the company that the credential names.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   *
   * The answer holds personal data: `/name`, `/workEmail`, `/workPhone`.
   */
  getUser(
    input: {
      /**
       * The member's id: the membership's id, Membership.id.
       */
      readonly memberId: string;
    },
    options?: CallOptions,
  ): Promise<Member>;

  /**
   * Remove a user
   *
   * Ta bort användaren: removes a member of the company, never yourself. The membership stays, with the status removed, and its sessions end. The member's work contacts are erased. The company always keeps an active system administrator.
   *
   * `DELETE /v1/users/{memberId}`
   *
   * Needs the permission `users:admin`, in the company that the credential names.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   */
  removeUser(
    input: {
      /**
       * The member's id: the membership's id, Membership.id.
       */
      readonly memberId: string;
    },
    options: WriteOptions,
  ): Promise<void>;

  /**
   * Change a user
   *
   * Changes a member of the company: Aktiv användare, the system administrator's level, the programs the member administers, the idle logout and the work contacts. A field left out stays as it is. adminLevel admin makes the member a system administrator, and null makes them no longer one; only creating a company gives the owner's level, which admin keeps. The work e-mail address is required, so null is refused for it. The company always keeps an active system administrator.
   *
   * `PATCH /v1/users/{memberId}`
   *
   * Needs the permission `users:admin`, in the company that the credential names.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   *
   * The answer holds personal data: `/name`, `/workEmail`, `/workPhone`.
   */
  updateUser(
    input: {
      /**
       * The member's id: the membership's id, Membership.id.
       */
      readonly memberId: string;
    } & {
      /**
       * Aktiv användare: true lets the member work in the company, false stops it, and keeps their rights. An invited member has not accepted yet, and takes neither.
       */
      readonly active?: boolean;
      /**
       * admin makes the member a system administrator, or keeps the level of one; null makes them no longer one. Only creating a company gives the owner's level.
       */
      readonly adminLevel?: "admin" | null;
      /**
       * Every program the member administers, Programadministratör: the list replaces the one there was.
       */
      readonly programsAdministered?: readonly ProgramAdmin[];
      /**
       * Utloggning efter inaktivitet, in whole minutes: 15, 30, 60, 120 (2 hours, the default) or 480 (8 hours).
       */
      readonly idleTimeout?: 15 | 30 | 60 | 120 | 480;
      /**
       * The work e-mail address in this company. It is required, so null is refused: it can be changed but not taken away.
       */
      readonly workEmail?: string;
      /**
       * The work phone number in this company, or null for none.
       */
      readonly workPhone?: string | null;
    },
    options: WriteOptions,
  ): Promise<Member>;

  /**
   * Disconnect a user's identity
   *
   * Takes the identity from an active or inactive member, so it no longer reaches the company, and sends the member a new invitation, to the person's name and the member's work e-mail address: a new or an existing identity may accept it. The member keeps the admin level and the programs, and is invited again; their sessions end, and their work contacts are erased. The mail holds a link that works once, for 14 days, and stops the link of the member's earlier invitation. With no mail set up for the install, the call gets 422 mail-not-configured, and nothing changes. An invited member gets 422 user-invited. The company always keeps an active system administrator.
   *
   * `POST /v1/users/{memberId}/disconnect`
   *
   * Needs the permission `users:admin`, in the company that the credential names.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   *
   * The answer holds personal data: `/name`, `/workEmail`, `/workPhone`.
   */
  disconnectUserIdentity(
    input: {
      /**
       * The member's id: the membership's id, Membership.id.
       */
      readonly memberId: string;
    },
    options: WriteOptions,
  ): Promise<Member>;

  /**
   * Send a new invitation
   *
   * Skicka en ny inbjudan: sends an invited member a new invitation, to the name and the e-mail address of their latest one. The mail holds a link that works once, for 14 days, and stops the link of the member's earlier invitation. With no mail set up for the install, the call gets 422 mail-not-configured, and nothing changes. A member who is not invited gets 422 user-not-invited.
   *
   * `POST /v1/users/{memberId}/invitation`
   *
   * Needs the permission `users:admin`, in the company that the credential names.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   */
  resendInvitation(
    input: {
      /**
       * The member's id: the membership's id, Membership.id.
       */
      readonly memberId: string;
    },
    options: WriteOptions,
  ): Promise<void>;

  /**
   * Grant a program
   *
   * Tilldela program: grants the program to a member, with Full behörighet (full: true), or with a list of its rights. For a member who holds the program, the list replaces the grant's, which keeps its time and its end; a grant that has ended is granted again. A program administrator grants only the programs they administer.
   *
   * `PUT /v1/users/{memberId}/programs/{program}`
   *
   * Needs the permission `programs:grant`, in the company that the credential names.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   */
  assignProgram(
    input: {
      /**
       * The member's id: the membership's id, Membership.id.
       */
      readonly memberId: string;
      /**
       * The program: bookkeeping, approval-read, read or auditor.
       */
      readonly program: "bookkeeping" | "approval-read" | "read" | "auditor";
    } & {
      /**
       * Full behörighet: every right of the program's Full behörighet.
       */
      readonly full?: true;
      /**
       * The rights the grant holds: the program's own, its Rapporter and its Register/Övrigt rights, as the catalogue's keys.
       */
      readonly permissions?: readonly PermissionKey[];
    },
    options: WriteOptions,
  ): Promise<ProgramGrant>;

  /**
   * Remove a program
   *
   * Ta bort program: takes the program's grant from a member. A program administrator removes only the programs they administer.
   *
   * `DELETE /v1/users/{memberId}/programs/{program}`
   *
   * Needs the permission `programs:grant`, in the company that the credential names.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   */
  removeProgram(
    input: {
      /**
       * The member's id: the membership's id, Membership.id.
       */
      readonly memberId: string;
      /**
       * The program: bookkeeping, approval-read, read or auditor.
       */
      readonly program: "bookkeeping" | "approval-read" | "read" | "auditor";
    },
    options: WriteOptions,
  ): Promise<void>;

  /**
   * Move a program
   *
   * Flytta program: gives a member's grant of the program to another member, who must not hold the program, and takes it from the first. The grant keeps its time and its end. With permissions, it is narrowed first: the list holds only rights the grant holds. A program administrator moves only the programs they administer.
   *
   * `POST /v1/users/{memberId}/programs/{program}/move`
   *
   * Needs the permission `programs:grant`, in the company that the credential names.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   */
  moveProgram(
    input: {
      /**
       * The member's id: the membership's id, Membership.id.
       */
      readonly memberId: string;
      /**
       * The program: bookkeeping, approval-read, read or auditor.
       */
      readonly program: "bookkeeping" | "approval-read" | "read" | "auditor";
    } & {
      /**
       * The member who gets the grant, by the membership's id.
       */
      readonly targetMemberId: string;
      /**
       * The rights the grant holds: the program's own, its Rapporter and its Register/Övrigt rights, as the catalogue's keys.
       */
      readonly permissions?: readonly PermissionKey[];
    },
    options: WriteOptions,
  ): Promise<ProgramGrant>;

  /**
   * Change a user's rights
   *
   * Anpassa Rapporter and Anpassa Register/Övrigt: sets a member's Rapporter and Register/Övrigt rights, the whole list. Each of the member's grants holds those its program covers, and keeps its own rights. A right that no grant of the member covers is refused. A program administrator sets them only in the grants of the programs they administer.
   *
   * `PUT /v1/users/{memberId}/rights`
   *
   * Needs the permission `programs:grant`, in the company that the credential names.
   *
   * Credential: the cookie `__Host-nortfox-session`.
   */
  updateUserRights(
    input: {
      /**
       * The member's id: the membership's id, Membership.id.
       */
      readonly memberId: string;
    } & {
      /**
       * Every Rapporter and Register/Övrigt right the member is to hold, as the catalogue's keys. A right of a program's own is refused.
       */
      readonly permissions: readonly RightKey[];
    },
    options: WriteOptions,
  ): Promise<UserRights>;
}

export function createOperations(send: Send): Operations {
  return {
    logout: async (options) => { await send({ method: "POST", path: "/v1/auth/logout", key: true, answer: "none" }, undefined, options); },
    loginWithPassword: async (input, options) => (await send({ method: "POST", path: "/v1/auth/password", body: true }, input, options)) as PasswordSignIn,
    verifyTotp: async (input, options) => { await send({ method: "POST", path: "/v1/auth/totp", body: true, answer: "none" }, input, options); },
    listCompanies: async (input, options) => (await send({ method: "GET", path: "/v1/companies", query: ["query", "limit", "cursor"] }, input, options)) as {
  /**
   * The items of this page, in the list's order.
   */
  readonly items: readonly CompanyChoice[];
  /**
   * Where the next page starts. It is absent on the last page.
   */
  readonly nextCursor?: string;
  /**
   * How many items the whole list holds.
   */
  readonly total: number;
},
    createCompany: async (input, options) => (await send({ method: "POST", path: "/v1/companies", body: true, key: true }, input, options)) as Company,
    getCompany: async (options) => (await send({ method: "GET", path: "/v1/company" }, undefined, options)) as Company,
    updateCompany: async (input, options) => (await send({ method: "PATCH", path: "/v1/company", body: true, key: true }, input, options)) as Company,
    getHealth: async (options) => (await send({ method: "GET", path: "/v1/health" }, undefined, options)) as Health,
    getInvitation: async (input, options) => (await send({ method: "GET", path: "/v1/invitations/{token}", params: ["token"] }, input, options)) as Invitation,
    acceptInvitation: async (input, options) => (await send({ method: "POST", path: "/v1/invitations/{token}/accept", params: ["token"], body: true }, input, options)) as InvitationAcceptance,
    getMe: async (options) => (await send({ method: "GET", path: "/v1/me" }, undefined, options)) as Me,
    listRecentCompanies: async (options) => (await send({ method: "GET", path: "/v1/me/companies/recent" }, undefined, options)) as RecentCompanies,
    updateMyMembership: async (input, options) => (await send({ method: "PATCH", path: "/v1/me/companies/{companyId}", params: ["companyId"], body: true, key: true }, input, options)) as Membership,
    leaveCompany: async (input, options) => { await send({ method: "POST", path: "/v1/me/companies/{companyId}/leave", params: ["companyId"], key: true, answer: "none" }, input, options); },
    listPermissions: async (options) => (await send({ method: "GET", path: "/v1/permissions" }, undefined, options)) as PermissionCatalogue,
    getSession: async (options) => (await send({ method: "GET", path: "/v1/session" }, undefined, options)) as Session,
    selectCompany: async (input, options) => (await send({ method: "POST", path: "/v1/session/company", body: true, key: true }, input, options)) as Session,
    completeSetup: async (input, options) => (await send({ method: "POST", path: "/v1/setup/{token}", params: ["token"], body: true }, input, options)) as SetupResult,
    listUsers: async (input, options) => (await send({ method: "GET", path: "/v1/users", query: ["limit", "cursor"] }, input, options)) as {
  /**
   * The items of this page, in the list's order.
   */
  readonly items: readonly Member[];
  /**
   * Where the next page starts. It is absent on the last page.
   */
  readonly nextCursor?: string;
  /**
   * How many items the whole list holds.
   */
  readonly total: number;
},
    inviteUser: async (input, options) => (await send({ method: "POST", path: "/v1/users", body: true, key: true }, input, options)) as Member,
    getUser: async (input, options) => (await send({ method: "GET", path: "/v1/users/{memberId}", params: ["memberId"] }, input, options)) as Member,
    removeUser: async (input, options) => { await send({ method: "DELETE", path: "/v1/users/{memberId}", params: ["memberId"], key: true, answer: "none" }, input, options); },
    updateUser: async (input, options) => (await send({ method: "PATCH", path: "/v1/users/{memberId}", params: ["memberId"], body: true, key: true }, input, options)) as Member,
    disconnectUserIdentity: async (input, options) => (await send({ method: "POST", path: "/v1/users/{memberId}/disconnect", params: ["memberId"], key: true }, input, options)) as Member,
    resendInvitation: async (input, options) => { await send({ method: "POST", path: "/v1/users/{memberId}/invitation", params: ["memberId"], key: true, answer: "none" }, input, options); },
    assignProgram: async (input, options) => (await send({ method: "PUT", path: "/v1/users/{memberId}/programs/{program}", params: ["memberId", "program"], body: true, key: true }, input, options)) as ProgramGrant,
    removeProgram: async (input, options) => { await send({ method: "DELETE", path: "/v1/users/{memberId}/programs/{program}", params: ["memberId", "program"], key: true, answer: "none" }, input, options); },
    moveProgram: async (input, options) => (await send({ method: "POST", path: "/v1/users/{memberId}/programs/{program}/move", params: ["memberId", "program"], body: true, key: true }, input, options)) as ProgramGrant,
    updateUserRights: async (input, options) => (await send({ method: "PUT", path: "/v1/users/{memberId}/rights", params: ["memberId"], body: true, key: true }, input, options)) as UserRights,
  };
}
