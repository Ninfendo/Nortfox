// SPDX-License-Identifier: AGPL-3.0-only

// The companies and the person's own memberships (issue 12, "Companies" and
// "Users in a company"). A signed-in person makes a company and becomes its
// owner in the same transaction. The company list holds only the companies
// where the person is an active member. A membership is Användare in one
// company: its status, the system administrator's level, the idle logout,
// and the person's work contacts there, which are personal data.

import { z } from "zod";
import { ADMIN_LEVELS } from "../access/permissions.ts";
import { personal } from "../fields.ts";
import { defineListOperation, defineOperation } from "../operation.ts";
import { noNul } from "../text.ts";

/** An organisation number: ten digits with a hyphen after the sixth. */
const ORGANIZATION_NUMBER = /^[0-9]{6}-[0-9]{4}$/;

export const Company = z
  .strictObject({
    id: z.uuid().meta({ description: "The company's id." }),
    name: z.string().meta({ description: "The company's name." }),
    organizationNumber: z
      .string()
      .regex(ORGANIZATION_NUMBER)
      .meta({
        description:
          "The organisation number: ten digits with a hyphen after the sixth. For a sole trader it is the owner's personal identity number.",
      }),
    databaseNumber: z
      .int()
      .min(1)
      .max(2147483647)
      .meta({ description: "The company's number for programs, its tenant id. It never changes." }),
  })
  .meta({
    id: "Company",
    description: "The company the request works in. Every data request works in exactly one company.",
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

export const Membership = z
  .strictObject({
    companyId: z.uuid().meta({ description: "The company's id." }),
    userId: z.uuid().optional().meta({ description: "The person's id. Absent while the membership is invited." }),
    status: z.enum(MEMBERSHIP_STATUSES).meta({ description: "invited, active, inactive, removed or left." }),
    adminLevel: SysAdmin.optional(),
    idleTimeout: IdleTimeout,
    workEmail: personal(z.string().meta({ description: "The person's work e-mail address in this company, where its notices go. Absent when none is set." })).optional(),
    workPhone: personal(z.string().meta({ description: "The person's work phone number in this company. Absent when none is set." })).optional(),
  })
  .meta({
    id: "Membership",
    description: "Användare in one company: a person's membership there, with its status, the system administrator's level, the idle logout and the work contacts.",
  });

export type Membership = z.infer<typeof Membership>;

export const CompanyChoice = z
  .strictObject({
    company: Company,
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
    "Gives the company the request works in: its id, name, organisation number and tenant id. The company comes from the request's credential.",
  output: Company,
  permission: "company:read",
  tool: "Gives the company you work in: its id, name, organisation number and database number. Every other tool works in this company too.",
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
    name: z.string().min(1).max(200).check(noNul()).meta({ description: "The company's name." }),
    organizationNumber: z.string().regex(ORGANIZATION_NUMBER).meta({ description: "The organisation number: ten digits with a hyphen after the sixth." }),
  }),
  output: Company,
  status: 201,
  permission: "signed-in",
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
    "query keeps the companies whose name or organisation number holds it, in any letter case.",
  query: z.strictObject({
    query: z.string().min(1).max(200).check(noNul()).optional().meta({ description: "A part of the company's name, in any letter case, or of its organisation number." }),
  }),
  item: CompanyChoice,
  permission: "signed-in",
  tool: "Lists the companies where you are an active member, with your system administrator's level in each.",
});

/** The person's last three companies, for the company choice. */
export const listRecentCompanies = defineOperation({
  id: "listRecentCompanies",
  method: "get",
  path: "/v1/me/companies/recent",
  tags: ["me"],
  summary: "List your recent companies",
  description: "Gives the three companies the signed-in person chose last, the latest first, of those where the person is still an active member.",
  output: RecentCompanies,
  permission: "signed-in",
  tool: "Gives the three companies you chose last, where you are still an active member.",
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
    "the work e-mail address and phone number there, and the idle logout. A field left out stays as it is, and null takes a work contact away.",
  params: z.strictObject({ companyId: z.uuid().meta({ description: "The company's id." }) }),
  body: z.strictObject({
    workEmail: z
      .email({ pattern: z.regexes.unicodeEmail })
      .max(254)
      .check(noNul())
      .nullable()
      .optional()
      .meta({ description: "The work e-mail address in this company, or null for none." }),
    workPhone: z.string().min(1).max(50).check(noNul()).nullable().optional().meta({ description: "The work phone number in this company, or null for none." }),
    idleTimeout: IdleTimeout.optional(),
  }),
  output: Membership,
  permission: "signed-in",
  company: { input: "companyId" },
  tool: "Changes your own work e-mail address, work phone number and idle logout in a company where you are an active member.",
  writes: true,
});
