// SPDX-License-Identifier: AGPL-3.0-only

// The companies and the person's own memberships (issue 12, "Companies" and
// "Users in a company"). A signed-in person makes a company and becomes its
// owner in the same transaction. The company list holds only the companies
// where the person is an active member. A membership is Användare in one
// company: its status, the system administrator's level, the idle logout,
// the person's work contacts there, which are personal data, and the roles,
// the program grants and the programs administered.

import { z } from "zod";
import { PROGRAMS } from "../access/catalogue.ts";
import { ROLE_KEYS } from "../access/effective.ts";
import { ADMIN_LEVELS } from "../access/permissions.ts";
import { personal } from "../fields.ts";
import { NoBody, defineListOperation, defineOperation } from "../operation.ts";
import { emailAddress, invitedAddress } from "../address.ts";
import { noNul, singleLine, wellFormed } from "../text.ts";

/** An organisation number: ten digits with a hyphen after the sixth. */
const ORGANIZATION_NUMBER = /^[0-9]{6}-[0-9]{4}$/;

/** A country's code in ISO 3166-1 alpha-2: two capital letters. */
const COUNTRY_CODE = /^[A-Z]{2}$/;

/**
 * The company's addresses and contact details, as the established company
 * resource names them, each with what it holds and its longest length. The
 * database checks the same lengths.
 */
const COMPANY_DETAILS = {
  address: { max: 200, description: "Adress: the postal address's street or box line." },
  zipCode: { max: 20, description: "Postnummer: the postal address's postal code." },
  city: { max: 100, description: "Ort: the postal address's town." },
  countryCode: { max: 2, description: "Land: the postal address's country, as its code in ISO 3166-1 alpha-2, two capital letters such as SE." },
  visitAddress: { max: 200, description: "Besöksadress: the visiting address's street." },
  visitZipCode: { max: 20, description: "The visiting address's postal code." },
  visitCity: { max: 100, description: "The visiting address's town." },
  visitCountryCode: { max: 2, description: "The visiting address's country, as its code in ISO 3166-1 alpha-2, two capital letters such as SE." },
  phone: { max: 50, description: "Telefon: the company's phone number." },
  email: { max: 254, description: "E-post: the company's e-mail address." },
} as const;

type CompanyDetail = keyof typeof COMPANY_DETAILS;

/** Whether a detail is a country's code. */
function isCountryCode(name: CompanyDetail): boolean {
  return name === "countryCode" || name === "visitCountryCode";
}

/** A detail as the company gives it: absent when it is not set. */
function detailOutput(name: CompanyDetail) {
  const { description } = COMPANY_DETAILS[name];
  const text = isCountryCode(name) ? z.string().regex(COUNTRY_CODE) : z.string();
  return text.meta({ description: `${description} Absent when it is not set.` }).optional();
}

/** A detail as updateCompany takes it: a text of 1 to its length, which the server stores; null takes it away. */
function detailInput(name: CompanyDetail) {
  const { max, description } = COMPANY_DETAILS[name];
  // An address takes its own checks and its length (address.ts).
  const shaped =
    name === "email" ? emailAddress() : (isCountryCode(name) ? z.string().regex(COUNTRY_CODE) : z.string().min(1).max(max)).check(noNul(), wellFormed());
  return shaped
    .nullable()
    .optional()
    .meta({ description: `${description} null takes it away.` });
}

/** What names a company: its id, name, organisation number and tenant id. */
const COMPANY_NAMES = {
  id: z.uuid().meta({ description: "The company's id." }),
  name: z.string().meta({ description: "The company's name." }),
  organizationNumber: z
    .string()
    .regex(ORGANIZATION_NUMBER)
    .meta({
      description: "The organisation number: ten digits with a hyphen after the sixth. For a sole trader it is the owner's personal identity number.",
    }),
  databaseNumber: z
    .int()
    .min(1)
    .max(2147483647)
    .meta({ description: "The company's number for programs, its tenant id. It never changes." }),
};

/**
 * A company as the company lists give it, from the one membership
 * function: what names it, and no detail. getCompany gives the details.
 */
export const CompanySummary = z.strictObject(COMPANY_NAMES).meta({
  id: "CompanySummary",
  description: "A company as the company lists give it: its id, name, organisation number and tenant id. getCompany gives its addresses and contact details.",
});

export type CompanySummary = z.infer<typeof CompanySummary>;

export const Company = z
  .strictObject({
    ...COMPANY_NAMES,
    address: detailOutput("address"),
    zipCode: detailOutput("zipCode"),
    city: detailOutput("city"),
    countryCode: detailOutput("countryCode"),
    visitAddress: detailOutput("visitAddress"),
    visitZipCode: detailOutput("visitZipCode"),
    visitCity: detailOutput("visitCity"),
    visitCountryCode: detailOutput("visitCountryCode"),
    phone: detailOutput("phone"),
    email: detailOutput("email"),
  })
  .meta({
    id: "Company",
    description: "A company: its id, name, organisation number and tenant id, and its postal and visiting addresses and contact details when they are set.",
  });

export type Company = z.infer<typeof Company>;

/** Systemadministratör: the level of a member who runs the users and the company's API access. */
export const SysAdmin = z.enum(ADMIN_LEVELS).meta({
  id: "SysAdmin",
  description:
    "Systemadministratör: owner, the person who made the company, or admin, a member made system administrator later. Both hold the same rights, and neither gives work rights by itself.",
});

/** Utloggning efter inaktivitet: the five idle times the established screen offers, in minutes. */
export const IDLE_TIMEOUTS = [15, 30, 60, 120, 480] as const;

// The OpenAPI writer gives a literal of several values only its first, so the
// meta names the whole list, as z.toJSONSchema does by itself.
export const IdleTimeout = z.literal(IDLE_TIMEOUTS).meta({
  type: "integer",
  enum: [...IDLE_TIMEOUTS],
  description: "Utloggning efter inaktivitet, in whole minutes: 15, 30, 60, 120 (2 hours, the default) or 480 (8 hours).",
});

/** The statuses of a membership. */
export const MEMBERSHIP_STATUSES = ["invited", "active", "inactive", "removed", "left"] as const;

/** Program: a module with its permission set. The name ProgramKey keeps the catalogue's type Program free. */
export const ProgramKey = z.enum(PROGRAMS).meta({
  id: "Program",
  description: "A program: bookkeeping (Bokföring), approval-read (Bokföring - Attest & Läs), read (Läs) or auditor (Revisor).",
});

/** One of the plan's six roles. The name RoleKey keeps the type Role free. */
export const RoleKey = z.enum(ROLE_KEYS).meta({
  id: "Role",
  description:
    "One of the plan's six roles: owner or admin, a system administrator's level; bookkeeper, Bokföring with Full behörighet; approver, Bokföring - Attest & Läs; viewer, Läs; auditor, Revisor.",
});

export const ProgramGrant = z
  .strictObject({
    program: ProgramKey,
    permissions: z.array(z.string()).meta({ description: "The rights the grant holds, as the catalogue's permission keys, in the catalogue's order." }),
    full: z.boolean().meta({ description: "Full behörighet: whether the grant holds every right of its program's Full behörighet, which a grant gets by default." }),
    grantedAt: z.iso.datetime().meta({ description: "When the program was granted." }),
    expiresAt: z.iso
      .datetime()
      .optional()
      .meta({ description: "When the grant ends by itself, with no action by anyone: a Revisor grant 30 days after it was granted. From then on it gives nothing. Absent for a grant with no end." }),
  })
  .meta({ id: "ProgramGrant", description: "Program: a program granted to a member, with the rights the grant holds." });

export type ProgramGrant = z.infer<typeof ProgramGrant>;

export const ProgramAdmin = z
  .strictObject({ program: ProgramKey })
  .meta({ id: "ProgramAdmin", description: "Programadministratör: the member grants, narrows and removes this program, and its Rapporter and Register/Övrigt rights." });

export type ProgramAdmin = z.infer<typeof ProgramAdmin>;

/**
 * A work e-mail address as a change takes it: required on the established
 * screen, so a change sets another one and never takes it away (null is
 * refused). A disconnect invites it, so it keeps the rules of an
 * invitation's address (invitedAddress).
 */
export const WorkEmail = invitedAddress().meta({
  description:
    "The work e-mail address in this company. It is required, so null is refused: it can be changed but not taken away. " +
    "A disconnect sends the member's new invitation to it, so its local part, before the @, is in ASCII, and no character of it has a case fold other than its lower case, such as ß, ς or ſ.",
});

/** A work phone number as a change takes it: null takes it away. */
export const WorkPhone = z
  .string()
  .min(1)
  .max(50)
  .check(noNul(), wellFormed())
  .nullable()
  .meta({ description: "The work phone number in this company, or null for none." });

export const Membership = z
  .strictObject({
    id: z.uuid().meta({ description: "The membership's id: the member's id in the company, which the paths of /v1/users take as memberId." }),
    companyId: z.uuid().meta({ description: "The company's id." }),
    userId: z.uuid().optional().meta({ description: "The person's id. Absent while the membership is invited." }),
    status: z.enum(MEMBERSHIP_STATUSES).meta({ description: "invited, active, inactive, removed or left." }),
    adminLevel: SysAdmin.optional(),
    idleTimeout: IdleTimeout,
    workEmail: personal(
      z.string().meta({
        description:
          "The person's work e-mail address in this company, where its notices go. Every active and inactive member has one. An invited member has one only when updateUser gave it, and accepting the invitation sets it to the invitation's address. A removed, a left or a disconnected member has none.",
      }),
    ).optional(),
    workPhone: personal(z.string().meta({ description: "The person's work phone number in this company. Absent when none is set." })).optional(),
    roles: z.array(RoleKey).meta({
      description:
        "The roles the member holds now, in the roles' order: owner or admin by the admin level, bookkeeper by a Bokföring grant with Full behörighet, and approver, viewer and auditor by a grant of their program that has not ended.",
    }),
    programs: z.array(ProgramGrant).meta({ description: "The member's program grants as they are now, in the catalogue's order, also one that has ended." }),
    programsAdministered: z.array(ProgramAdmin).meta({ description: "The programs the member administers, in the catalogue's order." }),
  })
  .meta({
    id: "Membership",
    description:
      "Användare in one company: a person's membership there, with its status, the system administrator's level, the idle logout, the work contacts, the roles, the program grants and the programs administered.",
  });

export type Membership = z.infer<typeof Membership>;

export const CompanyChoice = z
  .strictObject({
    company: CompanySummary,
    adminLevel: SysAdmin.optional(),
  })
  .meta({
    id: "CompanyChoice",
    description: "A company where the person is an active member, with the person's system administrator's level there when they have one.",
  });

export type CompanyChoice = z.infer<typeof CompanyChoice>;

export const RecentCompanies = z
  .strictObject({
    companies: z.array(CompanyChoice).max(3).meta({ description: "The companies, the latest chosen first." }),
  })
  .meta({ id: "RecentCompanies", description: "The three companies the person chose last, where the person is still an active member." });

export type RecentCompanies = z.infer<typeof RecentCompanies>;

/**
 * The request's own company. It is open to the assistant: it reads no money,
 * no settings and nothing an outsider wrote, and the assistant needs to know
 * which company it works in.
 */
export const getCompany = defineOperation({
  id: "getCompany",
  method: "get",
  path: "/v1/company",
  tags: ["companies"],
  summary: "Read the company",
  description:
    "Gives the company the request works in: its id, name, organisation number and tenant id, and its postal and visiting addresses and its phone number and e-mail address when they are set. The company comes from the request's credential.",
  output: Company,
  permission: "company:read",
  scope: "companyinformation",
  tool: "Gives the company you work in: its id, name, organisation number and database number, and its postal and visiting addresses and its phone number and e-mail address when they are set. Each tool that needs a permission works in this company too, and a tool that takes a companyId works in the company it names.",
  assistant: true,
  writes: false,
});

/** A new company, with the person who makes it as its owner, in one transaction. */
export const createCompany = defineOperation({
  id: "createCompany",
  method: "post",
  path: "/v1/companies",
  tags: ["companies"],
  summary: "Create a company",
  description:
    "Makes a company with its name and organisation number, and makes the signed-in person its owner, a system administrator, in the same transaction. " +
    "The company gets its tenant id, a number that is never given out again. The organisation number never changes.",
  body: z.strictObject({
    name: z.string().min(1).max(200).check(noNul(), wellFormed(), singleLine()).meta({ description: "The company's name, on one line." }),
    organizationNumber: z.string().regex(ORGANIZATION_NUMBER).meta({ description: "The organisation number: ten digits with a hyphen after the sixth." }),
  }),
  output: Company,
  status: 201,
  permission: "signed-in",
  scope: "companies",
  company: "new",
  tool: "Creates a company and makes you its owner. Its organisation number never changes.",
  writes: true,
});

/** The companies the person may choose. */
export const listCompanies = defineListOperation({
  id: "listCompanies",
  method: "get",
  path: "/v1/companies",
  tags: ["companies"],
  summary: "List your companies",
  description:
    "Lists the companies where the signed-in person is an active member, by name, with the person's system administrator's level in each. " +
    "query keeps the companies whose name holds it, in any letter case, or whose organisation number holds it, with or without the hyphen.",
  query: z.strictObject({
    query: z
      .string()
      .min(1)
      .max(200)
      .check(noNul(), wellFormed())
      .optional()
      .meta({ description: "A part of the company's name, in any letter case, or of its organisation number, with or without the hyphen." }),
  }),
  item: CompanyChoice,
  permission: "signed-in",
  scope: "companies",
  tool: "Lists the companies where you are an active member, with your system administrator's level in each.",
});

/** The person's last three companies, for the company choice. */
export const listRecentCompanies = defineOperation({
  id: "listRecentCompanies",
  method: "get",
  path: "/v1/me/companies/recent",
  tags: ["me"],
  summary: "List your recent companies",
  description:
    "Gives the three companies the signed-in person chose last, the latest first, of those where the person is still an active member. " +
    "It tells of the person's other companies, so it needs a browser session: a token is refused it with 403 session-required.",
  output: RecentCompanies,
  permission: "signed-in",
  session: "only",
  tool: "Gives the three companies you chose last, where you are still an active member. It needs a browser session, so this tool refuses a call that comes with a token.",
  writes: false,
});

/** Användaruppgifter: the person's own work contacts and idle logout in one company. */
export const updateMyMembership = defineOperation({
  id: "updateMyMembership",
  method: "patch",
  path: "/v1/me/companies/{companyId}",
  tags: ["me"],
  summary: "Change your membership",
  description:
    "Changes the signed-in person's own membership in the company that the path names, where the person must be an active member: " +
    "the work e-mail address and phone number there, and the idle logout. A field left out stays as it is. The work e-mail address is required, " +
    "so it can be changed but not taken away; null takes the phone number away.",
  params: z.strictObject({ companyId: z.uuid().meta({ description: "The company's id." }) }),
  body: z.strictObject({
    workEmail: WorkEmail.optional(),
    workPhone: WorkPhone.optional(),
    idleTimeout: IdleTimeout.optional(),
  }),
  output: Membership,
  permission: "signed-in",
  scope: "companies",
  company: { input: "companyId" },
  tool: "Changes your own work e-mail address, work phone number and idle logout in a company where you are an active member.",
  writes: true,
});

/** Koppla bort användaren: the person leaves a company from the company list. */
export const leaveCompany = defineOperation({
  id: "leaveCompany",
  method: "post",
  path: "/v1/me/companies/{companyId}/leave",
  tags: ["me"],
  summary: "Leave a company",
  description:
    "The signed-in person leaves the company that the path names, where the person must be an active member. The membership stays, with the status left, " +
    "and its sessions end; the work contacts there are erased. Only a new invitation lets the person back. The company always keeps an active system administrator, " +
    "so its last one cannot leave.",
  params: z.strictObject({ companyId: z.uuid().meta({ description: "The company's id." }) }),
  output: NoBody,
  status: 204,
  permission: "signed-in",
  scope: "companies",
  company: { input: "companyId" },
  tool: "Leaves a company where you are an active member. Only a new invitation lets you back.",
  writes: true,
});

/**
 * The company's details: its name, its postal and visiting addresses and its
 * contact details (issue 12, Companies 3). The organisation number never
 * changes, so the operation does not take it.
 */
export const updateCompany = defineOperation({
  id: "updateCompany",
  method: "patch",
  path: "/v1/company",
  tags: ["companies"],
  summary: "Change the company",
  description:
    "Changes the request's company: its name, its postal and visiting addresses, and its phone number and e-mail address. " +
    "A field left out stays as it is, and null takes an address field or a contact detail away. The organisation number never changes, so the operation does not take it.",
  body: z.strictObject({
    name: z.string().min(1).max(200).check(noNul(), wellFormed(), singleLine()).optional().meta({ description: "The company's name, on one line." }),
    address: detailInput("address"),
    zipCode: detailInput("zipCode"),
    city: detailInput("city"),
    countryCode: detailInput("countryCode"),
    visitAddress: detailInput("visitAddress"),
    visitZipCode: detailInput("visitZipCode"),
    visitCity: detailInput("visitCity"),
    visitCountryCode: detailInput("visitCountryCode"),
    phone: detailInput("phone"),
    email: detailInput("email"),
  }),
  output: Company,
  permission: "company:update",
  scope: "companies",
  tool: "Changes the company you work in: its name, its addresses, its phone number and its e-mail address. Its organisation number never changes.",
  writes: true,
});
