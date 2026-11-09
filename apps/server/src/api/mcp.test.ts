// SPDX-License-Identifier: AGPL-3.0-only

// /mcp serves every registry entry as an MCP tool. tools/list lists exactly
// the registry, each tool with its input schema (the idempotency key on a
// write) and its output schema, written out here as the literals a client
// sees. A client of either era lists and calls the tools. A tool call
// answers the same JSON as the REST call, as structured content and as text;
// a refusal and an error the server did not expect answer the same problem
// details as /v1, in a result marked isError. An unknown tool is a protocol
// error. The tests here need no database: getHealth reads none, and every
// other case is refused or fails before one would be read.

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  Client,
  PROTOCOL_VERSION_META_KEY,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { CATALOGUE_PERMISSIONS, MAILBOX } from "@nortfox/contract";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CURSOR_KEY,
  TEST_INSTALL_KEY,
  MCP_ERAS,
  TEST_VERSION,
  bearer,
  buildTestApp,
  callTool,
  mcpClient,
  personOf,
  principalOf,
  problemIn,
  testResolver,
  untouchedDatabase,
  voucherBody,
} from "../../test/api.ts";
import { SHAPES_REGISTRY, SHAPE_OPERATIONS, fakeDatabase, shapeLog, shapesHandlers } from "../../test/shapes.ts";
import { createApp } from "../app.ts";
import type { Database } from "../db/database.ts";
import { startServer } from "../start.ts";
import type { Principal } from "./context.ts";
import { callerPrincipal } from "./mcp.ts";

const COMPANY = randomUUID();
const TOKENS = {
  reader: await principalOf(COMPANY, { permissions: ["company:read"] }),
  writer: await principalOf(COMPANY),
};

const UUID = {
  type: "string",
  format: "uuid",
  pattern:
    "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
};

const MONEY = {
  type: "object",
  description: "An amount: a decimal string and its ISO 4217 currency code. Never a JSON number.",
  properties: {
    amount: {
      type: "string",
      pattern: "^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$",
      description: 'The amount as a decimal string, such as "1234.50" or "-0.05", with no more decimals than its currency has.',
      examples: ["1234.50"],
    },
    currency: { type: "string", enum: ["SEK"], description: "The currency's ISO 4217 code. This install knows SEK." },
  },
  required: ["amount", "currency"],
  additionalProperties: false,
};

const NO_INPUT = { type: "object", properties: {}, additionalProperties: false };

const NO_OUTPUT = { type: "object", properties: {}, additionalProperties: false, description: "Nothing: REST answers with no body, MCP with an empty object." };

const USER = {
  type: "object",
  properties: {
    id: { ...UUID, description: "The person's id. The person stays the actor of every entry they made." },
    name: { type: "string", description: "The person's name." },
    email: { type: "string", description: "The person's personal e-mail address. A password sign-in takes it as the identifier, in any letter case." },
    language: { type: "string", enum: ["sv", "en"], description: "Språk: sv (Svenska) or en (English). It applies in every company." },
  },
  required: ["id", "name", "email", "language"],
  additionalProperties: false,
  description: "A person: their NortFox ID, the one login identity they use for every company.",
};

const CHALLENGE_PATTERN = "^nfc_[A-Za-z0-9_-]{43}$";

const IDEMPOTENCY_KEY = {
  type: "string",
  minLength: 1,
  maxLength: 255,
  pattern: "^[\\x21\\x23-\\x5b\\x5d-\\x7e]+$",
  description:
    'A key you choose for this write, 1 to 255 characters of visible ASCII without " and \\. Send the same key with the same input again, and you get the first answer back instead of a second write.',
};

/** A company's detail as the company gives it, and as updateCompany takes it. */
const DETAIL = (description: string) => ({ type: "string", description: `${description} Absent when it is not set.` });
const COUNTRY_DETAIL = (description: string) => ({ ...DETAIL(description), pattern: "^[A-Z]{2}$" });
const DETAIL_INPUT = (description: string, maxLength: number) => ({ description: `${description} null takes it away.`, anyOf: [{ type: "string", minLength: 1, maxLength }, { type: "null" }] });
const COUNTRY_INPUT = (description: string) => ({ description: `${description} null takes it away.`, anyOf: [{ type: "string", pattern: "^[A-Z]{2}$" }, { type: "null" }] });

/** What an e-mail address must look like, as z.email() with the pattern of one mailbox writes it (packages/contract/src/address.ts). */
const EMAIL = { type: "string", maxLength: 254, format: "email", pattern: MAILBOX.source };

const COMPANY_SCHEMA = {
  type: "object",
  description: "A company: its id, name, organisation number and tenant id, and its postal and visiting addresses and contact details when they are set.",
  properties: {
    id: { ...UUID, description: "The company's id." },
    name: { type: "string", description: "The company's name." },
    organizationNumber: {
      type: "string",
      pattern: "^[0-9]{6}-[0-9]{4}$",
      description: "The organisation number: ten digits with a hyphen after the sixth. For a sole trader it is the owner's personal identity number.",
    },
    databaseNumber: { type: "integer", minimum: 1, maximum: 2147483647, description: "The company's number for programs, its tenant id. It never changes." },
    address: DETAIL("Adress: the postal address's street or box line."),
    zipCode: DETAIL("Postnummer: the postal address's postal code."),
    city: DETAIL("Ort: the postal address's town."),
    countryCode: COUNTRY_DETAIL("Land: the postal address's country, as its code in ISO 3166-1 alpha-2, two capital letters such as SE."),
    visitAddress: DETAIL("Besöksadress: the visiting address's street."),
    visitZipCode: DETAIL("The visiting address's postal code."),
    visitCity: DETAIL("The visiting address's town."),
    visitCountryCode: COUNTRY_DETAIL("The visiting address's country, as its code in ISO 3166-1 alpha-2, two capital letters such as SE."),
    phone: DETAIL("Telefon: the company's phone number."),
    email: DETAIL("E-post: the company's e-mail address."),
  },
  required: ["id", "name", "organizationNumber", "databaseNumber"],
  additionalProperties: false,
};

const SYS_ADMIN = {
  type: "string",
  enum: ["owner", "admin"],
  description:
    "Systemadministratör: owner, the person who made the company, or admin, a member made system administrator later. Both hold the same rights, and neither gives work rights by itself.",
};

const IDLE_TIMEOUT = {
  type: "integer",
  enum: [15, 30, 60, 120, 480],
  description: "Utloggning efter inaktivitet, in whole minutes: 15, 30, 60, 120 (2 hours, the default) or 480 (8 hours).",
};

const PROGRAM = {
  type: "string",
  enum: ["bookkeeping", "approval-read", "read", "auditor"],
  description: "A program: bookkeeping (Bokföring), approval-read (Bokföring - Attest & Läs), read (Läs) or auditor (Revisor).",
};

/** A time in ISO 8601 with Z, as z.iso.datetime() writes its schema. */
const DATE_TIME = {
  type: "string",
  format: "date-time",
  pattern:
    "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
};

const ROLE = {
  type: "string",
  enum: ["owner", "admin", "bookkeeper", "approver", "viewer", "auditor"],
  description:
    "One of the plan's six roles: owner or admin, a system administrator's level; bookkeeper, Bokföring with Full behörighet; approver, Bokföring - Attest & Läs; viewer, Läs; auditor, Revisor.",
};

const PROGRAM_GRANT = {
  type: "object",
  properties: {
    program: PROGRAM,
    permissions: { type: "array", items: { type: "string" }, description: "The rights the grant holds, as the catalogue's permission keys, in the catalogue's order." },
    full: { type: "boolean", description: "Full behörighet: whether the grant holds every right of its program's Full behörighet, which a grant gets by default." },
    grantedAt: { ...DATE_TIME, description: "When the program was granted." },
    expiresAt: {
      description: "When the grant ends by itself, with no action by anyone: a Revisor grant 30 days after it was granted. From then on it gives nothing. Absent for a grant with no end.",
      ...DATE_TIME,
    },
  },
  required: ["program", "permissions", "full", "grantedAt"],
  additionalProperties: false,
  description: "Program: a program granted to a member, with the rights the grant holds.",
};

const PROGRAM_ADMIN = {
  type: "object",
  properties: { program: PROGRAM },
  required: ["program"],
  additionalProperties: false,
  description: "Programadministratör: the member grants, narrows and removes this program, and its Rapporter and Register/Övrigt rights.",
};

/** The fields of a membership, in their order, without its id, its company and its person. */
const MEMBERSHIP_FIELDS = {
  status: { type: "string", enum: ["invited", "active", "inactive", "removed", "left"], description: "invited, active, inactive, removed or left." },
  adminLevel: SYS_ADMIN,
  idleTimeout: IDLE_TIMEOUT,
  workEmail: {
    type: "string",
    description:
      "The person's work e-mail address in this company, where its notices go. Every active and inactive member has one. An invited member has one only when updateUser gave it, and accepting the invitation sets it to the invitation's address. A removed, a left or a disconnected member has none.",
  },
  workPhone: { type: "string", description: "The person's work phone number in this company. Absent when none is set." },
  roles: {
    type: "array",
    items: ROLE,
    description:
      "The roles the member holds now, in the roles' order: owner or admin by the admin level, bookkeeper by a Bokföring grant with Full behörighet, and approver, viewer and auditor by a grant of their program that has not ended.",
  },
  programs: { type: "array", items: PROGRAM_GRANT, description: "The member's program grants as they are now, in the catalogue's order, also one that has ended." },
  programsAdministered: { type: "array", items: PROGRAM_ADMIN, description: "The programs the member administers, in the catalogue's order." },
};

const MEMBERSHIP_IDS = {
  id: { ...UUID, description: "The membership's id: the member's id in the company, which the paths of /v1/users take as memberId." },
  companyId: { ...UUID, description: "The company's id." },
  userId: { description: "The person's id. Absent while the membership is invited.", ...UUID },
};

const MEMBERSHIP = {
  type: "object",
  properties: { ...MEMBERSHIP_IDS, ...MEMBERSHIP_FIELDS },
  required: ["id", "companyId", "status", "idleTimeout", "roles", "programs", "programsAdministered"],
  additionalProperties: false,
  description:
    "Användare in one company: a person's membership there, with its status, the system administrator's level, the idle logout, the work contacts, the roles, the program grants and the programs administered.",
};

const MEMBER = {
  type: "object",
  properties: { ...MEMBERSHIP_IDS, name: { type: "string", description: "The person's name; for an invited member, the name the latest invitation was sent to. Absent for an invited member with no invitation." }, ...MEMBERSHIP_FIELDS },
  required: ["id", "companyId", "status", "idleTimeout", "roles", "programs", "programsAdministered"],
  additionalProperties: false,
  description:
    "Användare: a member of the company, by the membership's id, with the person's name, the status, the system administrator's level, the idle logout, the work contacts, the roles, the program grants and the programs administered. " +
    "A program administrator sees only the grants and the administration of the programs they administer, and the roles those give.",
};

const COMPANY_CHOICE = {
  type: "object",
  properties: { company: COMPANY_SCHEMA, adminLevel: SYS_ADMIN },
  required: ["company"],
  additionalProperties: false,
  description: "A company where the person is an active member, with the person's system administrator's level there when they have one.",
};

const SESSION = {
  type: "object",
  properties: { user: USER, company: COMPANY_SCHEMA },
  required: ["user"],
  additionalProperties: false,
  description: "The browser's session: the person it signed in, and the company it works in once one is chosen.",
};

const WORK_EMAIL = { ...EMAIL, description: "The work e-mail address in this company. It is required, so null is refused: it can be changed but not taken away." };

const WORK_PHONE = { anyOf: [{ type: "string", minLength: 1, maxLength: 50 }, { type: "null" }], description: "The work phone number in this company, or null for none." };

/** The tools of the companies and of the person's own memberships, as tools/list gives them. */
const COMPANY_TOOLS = [
  {
    name: "createCompany",
    title: "Create a company",
    description: "Creates a company and makes you its owner. Its organisation number never changes.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200, description: "The company's name, on one line." },
        organizationNumber: { type: "string", pattern: "^[0-9]{6}-[0-9]{4}$", description: "The organisation number: ten digits with a hyphen after the sixth." },
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      required: ["name", "organizationNumber", "idempotencyKey"],
      additionalProperties: false,
    },
    outputSchema: COMPANY_SCHEMA,
    annotations: { readOnlyHint: false },
  },
  {
    name: "listCompanies",
    title: "List your companies",
    description: "Lists the companies where you are an active member, with your system administrator's level in each.",
    inputSchema: {
      type: "object",
      properties: {
        query: { description: "A part of the company's name, in any letter case, or of its organisation number, with or without the hyphen.", type: "string", minLength: 1, maxLength: 200 },
        limit: { type: "integer", default: 100, description: "How many items a page holds: from 1 to 500. Any other whole number gives 100." },
        cursor: { description: "Where the page starts: the nextCursor of the page before. Leave it out for the first page.", type: "string" },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: COMPANY_CHOICE, description: "The items of this page, in the list's order." },
        nextCursor: { description: "Where the next page starts. It is absent on the last page.", type: "string" },
        total: { type: "integer", minimum: 0, maximum: 9007199254740991, description: "How many items the whole list holds." },
      },
      required: ["items", "total"],
      additionalProperties: false,
      description: "A page of the list.",
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "listRecentCompanies",
    title: "List your recent companies",
    description: "Gives the three companies you chose last, where you are still an active member.",
    inputSchema: NO_INPUT,
    outputSchema: {
      type: "object",
      properties: { companies: { maxItems: 3, type: "array", items: COMPANY_CHOICE, description: "The companies, the latest chosen first." } },
      required: ["companies"],
      additionalProperties: false,
      description: "The three companies the person chose last, where the person is still an active member.",
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "selectCompany",
    title: "Choose the company",
    description: "Chooses the browser session's company. It serves the browser's sign-in, so this tool refuses every call: an MCP client signs in through OAuth.",
    inputSchema: {
      type: "object",
      properties: { companyId: { ...UUID, description: "The id of the company to work in." }, idempotencyKey: IDEMPOTENCY_KEY },
      required: ["companyId", "idempotencyKey"],
      additionalProperties: false,
    },
    outputSchema: SESSION,
    annotations: { readOnlyHint: false },
  },
  {
    name: "updateMyMembership",
    title: "Change your membership",
    description: "Changes your own work e-mail address, work phone number and idle logout in a company where you are an active member.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { ...UUID, description: "The company's id." },
        workEmail: WORK_EMAIL,
        workPhone: WORK_PHONE,
        idleTimeout: IDLE_TIMEOUT,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      required: ["companyId", "idempotencyKey"],
      additionalProperties: false,
    },
    outputSchema: MEMBERSHIP,
    annotations: { readOnlyHint: false },
  },
  {
    name: "updateCompany",
    title: "Change the company",
    description: "Changes the company you work in: its name, its addresses, its phone number and its e-mail address. Its organisation number never changes.",
    inputSchema: {
      type: "object",
      properties: {
        name: { description: "The company's name, on one line.", type: "string", minLength: 1, maxLength: 200 },
        address: DETAIL_INPUT("Adress: the postal address's street or box line.", 200),
        zipCode: DETAIL_INPUT("Postnummer: the postal address's postal code.", 20),
        city: DETAIL_INPUT("Ort: the postal address's town.", 100),
        countryCode: COUNTRY_INPUT("Land: the postal address's country, as its code in ISO 3166-1 alpha-2, two capital letters such as SE."),
        visitAddress: DETAIL_INPUT("Besöksadress: the visiting address's street.", 200),
        visitZipCode: DETAIL_INPUT("The visiting address's postal code.", 20),
        visitCity: DETAIL_INPUT("The visiting address's town.", 100),
        visitCountryCode: COUNTRY_INPUT("The visiting address's country, as its code in ISO 3166-1 alpha-2, two capital letters such as SE."),
        phone: DETAIL_INPUT("Telefon: the company's phone number.", 50),
        email: { description: "E-post: the company's e-mail address. null takes it away.", anyOf: [EMAIL, { type: "null" }] },
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      required: ["idempotencyKey"],
      additionalProperties: false,
    },
    outputSchema: COMPANY_SCHEMA,
    annotations: { readOnlyHint: false },
  },
];

const PERMISSION_KEY = {
  type: "string",
  enum: CATALOGUE_PERMISSIONS.map((permission) => permission.key),
  description: "A permission of the catalogue, by its key, such as vouchers.view (Verifikationer) or vouchers.book (Bokför).",
};

const GROUP_KEY = {
  type: "string",
  enum: ["vouchers", "supplier-invoices", "reports", "register"],
  description:
    "A group of the catalogue, by its key: vouchers (Verifikationer), supplier-invoices (Leverantörsfakturor), reports (Rapporter) or register (Register/Övrigt).",
};

/** The member that a path names, and a program as a path names it. */
const MEMBER_ID = { ...UUID, description: "The member's id: the membership's id, Membership.id." };
const PROGRAM_PARAMETER = { type: "string", enum: ["bookkeeping", "approval-read", "read", "auditor"], description: "The program: bookkeeping, approval-read, read or auditor." };

/** A grant's rights as a change gives them. */
const GRANT_PERMISSIONS = (description: string) => ({ maxItems: 64, type: "array", items: PERMISSION_KEY, description });
const GRANT_RIGHTS = "The rights the grant holds: the program's own, its Rapporter and its Register/Övrigt rights, as the catalogue's keys.";

/** The tools of the catalogue and of the company's users, as tools/list gives them. */
const USER_TOOLS = [
  {
    name: "listPermissions",
    title: "List the permissions",
    description: "Gives the permission catalogue: the roles, the programs with their sets, the groups and every permission in order, with the view and manual-only marks.",
    inputSchema: NO_INPUT,
    outputSchema: {
      type: "object",
      properties: {
        roles: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: ROLE,
              adminLevel: SYS_ADMIN,
              program: PROGRAM,
              full: { description: "For a program's role: whether only a grant with Full behörighet makes it, as for bookkeeper.", type: "boolean" },
            },
            required: ["key"],
            additionalProperties: false,
            description:
              "One of the plan's six roles, as a set in this model: owner and admin by the admin level that adminLevel names; the other four by a grant of the program that program names, with Full behörighet when full is true.",
          },
          description: "The plan's six roles, in their order.",
        },
        programs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: PROGRAM,
              label: { type: "string", description: "The program's words on the screen, such as Bokföring." },
              lifetimeDays: {
                description: "The days after which a grant of the program ends by itself: 30 for Revisor. Absent for a program whose grant has no end.",
                type: "integer",
                minimum: 1,
                maximum: 9007199254740991,
              },
              permissions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    key: PERMISSION_KEY,
                    full: { type: "boolean", description: "Whether Full behörighet holds it. A permission that it does not hold is only switched on by hand." },
                  },
                  required: ["key", "full"],
                  additionalProperties: false,
                },
                description: "The program's set: every permission a grant of it may hold, in the catalogue's order.",
              },
            },
            required: ["key", "label", "permissions"],
            additionalProperties: false,
            description: "Program: a program of the catalogue, with its screen words, its end, and its set.",
          },
          description: "The programs, in the catalogue's order.",
        },
        groups: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: GROUP_KEY,
              kind: {
                type: "string",
                enum: ["program", "reports", "register"],
                description: "program, for a Bokföring group of a program's own rights; reports, for Rapporter; or register, for Register/Övrigt.",
              },
              label: { type: "string", description: "The group's words on the screen, such as Verifikationer." },
            },
            required: ["key", "kind", "label"],
            additionalProperties: false,
            description: "A group of permissions, with its kind and its screen words.",
          },
          description: "The groups, in the catalogue's order.",
        },
        permissions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: PERMISSION_KEY,
              group: GROUP_KEY,
              label: { type: "string", description: "The permission's words on the screen, such as Bokför." },
              view: { type: "boolean", description: "Whether it is its group's view right, which every other permission of the group needs." },
              manualOnly: { type: "boolean", description: "Whether it is only switched on by hand: Full behörighet never holds it." },
            },
            required: ["key", "group", "label", "view", "manualOnly"],
            additionalProperties: false,
            description: "Behörighet: a permission of the catalogue, with its group, its screen words and its marks.",
          },
          description: "Every permission, in the catalogue's order.",
        },
      },
      required: ["roles", "programs", "groups", "permissions"],
      additionalProperties: false,
      description: "The permission catalogue: the roles, the programs with their sets, the groups and the permissions, in order.",
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "listUsers",
    title: "List the users",
    description: "Lists the users of the company you work in, with their status, admin level and programs. A program administrator sees only the programs they administer.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", default: 100, description: "How many items a page holds: from 1 to 500. Any other whole number gives 100." },
        cursor: { description: "Where the page starts: the nextCursor of the page before. Leave it out for the first page.", type: "string" },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: MEMBER, description: "The items of this page, in the list's order." },
        nextCursor: { description: "Where the next page starts. It is absent on the last page.", type: "string" },
        total: { type: "integer", minimum: 0, maximum: 9007199254740991, description: "How many items the whole list holds." },
      },
      required: ["items", "total"],
      additionalProperties: false,
      description: "A page of the list.",
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "getUser",
    title: "Read a user",
    description: "Gives one user of the company you work in, by the member's id.",
    inputSchema: { type: "object", properties: { memberId: MEMBER_ID }, required: ["memberId"], additionalProperties: false },
    outputSchema: MEMBER,
    annotations: { readOnlyHint: true },
  },
  {
    name: "updateUser",
    title: "Change a user",
    description:
      "Changes a user of the company you work in: whether they are active, their system administrator's level, the programs they administer, their idle logout and their work contacts.",
    inputSchema: {
      type: "object",
      properties: {
        memberId: MEMBER_ID,
        active: {
          description: "Aktiv användare: true lets the member work in the company, false stops it, and keeps their rights. An invited member has not accepted yet, and takes neither.",
          type: "boolean",
        },
        adminLevel: {
          description: "admin makes the member a system administrator, or keeps the level of one; null makes them no longer one. Only creating a company gives the owner's level.",
          anyOf: [{ type: "string", enum: ["admin"] }, { type: "null" }],
        },
        programsAdministered: {
          description: "Every program the member administers, Programadministratör: the list replaces the one there was.",
          maxItems: 4,
          type: "array",
          items: PROGRAM_ADMIN,
        },
        idleTimeout: IDLE_TIMEOUT,
        workEmail: WORK_EMAIL,
        workPhone: WORK_PHONE,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      required: ["memberId", "idempotencyKey"],
      additionalProperties: false,
    },
    outputSchema: MEMBER,
    annotations: { readOnlyHint: false },
  },
  {
    name: "removeUser",
    title: "Remove a user",
    description: "Removes a user from the company you work in. You cannot remove yourself.",
    inputSchema: { type: "object", properties: { memberId: MEMBER_ID, idempotencyKey: IDEMPOTENCY_KEY }, required: ["memberId", "idempotencyKey"], additionalProperties: false },
    outputSchema: NO_OUTPUT,
    annotations: { readOnlyHint: false },
  },
  {
    name: "assignProgram",
    title: "Grant a program",
    description: "Grants a program to a user of the company you work in, with Full behörighet or with a list of its rights.",
    inputSchema: {
      type: "object",
      properties: {
        memberId: MEMBER_ID,
        program: PROGRAM_PARAMETER,
        full: { description: "Full behörighet: every right of the program's Full behörighet.", type: "boolean", const: true },
        permissions: GRANT_PERMISSIONS(GRANT_RIGHTS),
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      required: ["memberId", "program", "idempotencyKey"],
      additionalProperties: false,
    },
    outputSchema: PROGRAM_GRANT,
    annotations: { readOnlyHint: false },
  },
  {
    name: "removeProgram",
    title: "Remove a program",
    description: "Takes a program from a user of the company you work in.",
    inputSchema: {
      type: "object",
      properties: { memberId: MEMBER_ID, program: PROGRAM_PARAMETER, idempotencyKey: IDEMPOTENCY_KEY },
      required: ["memberId", "program", "idempotencyKey"],
      additionalProperties: false,
    },
    outputSchema: NO_OUTPUT,
    annotations: { readOnlyHint: false },
  },
  {
    name: "moveProgram",
    title: "Move a program",
    description: "Moves a program from one user of the company you work in to another, narrowed first if you give a list of its rights.",
    inputSchema: {
      type: "object",
      properties: {
        memberId: MEMBER_ID,
        program: PROGRAM_PARAMETER,
        targetMemberId: { ...UUID, description: "The member who gets the grant, by the membership's id." },
        permissions: GRANT_PERMISSIONS(GRANT_RIGHTS),
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      required: ["memberId", "program", "targetMemberId", "idempotencyKey"],
      additionalProperties: false,
    },
    outputSchema: PROGRAM_GRANT,
    annotations: { readOnlyHint: false },
  },
  {
    name: "updateUserRights",
    title: "Change a user's rights",
    description: "Sets the Rapporter and Register/Övrigt rights of a user of the company you work in.",
    inputSchema: {
      type: "object",
      properties: {
        memberId: MEMBER_ID,
        permissions: GRANT_PERMISSIONS("Every Rapporter and Register/Övrigt right the member is to hold, as the catalogue's keys."),
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      required: ["memberId", "permissions", "idempotencyKey"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        permissions: { type: "array", items: { type: "string" }, description: "The member's Rapporter and Register/Övrigt rights, as the grants hold them now, in the catalogue's order." },
        programs: { type: "array", items: PROGRAM_GRANT, description: "The member's grants as they are now, in the catalogue's order." },
      },
      required: ["permissions", "programs"],
      additionalProperties: false,
      description: "A member's Rapporter and Register/Övrigt rights, and the program grants that hold them.",
    },
    annotations: { readOnlyHint: false },
  },
];

/** The tools of the browser's sign-in and of the person's own operations, as tools/list gives them. */
/** The tools of the invitations, as tools/list gives them, in the registry's order. */
const INVITATION_TOOLS = [
  {
    name: "inviteUser",
    title: "Invite a user",
    description: "Invites a person to the company you work in, with a name and an e-mail address: the invitation goes to that address by mail.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200, description: "Namn: the invited person's name, on one line." },
        email: {
          ...EMAIL,
          description: "E-postadress: where the invitation goes, one mailbox. A new identity that accepts takes it as its e-mail address, and the member takes it as the work e-mail address.",
        },
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      required: ["name", "email", "idempotencyKey"],
      additionalProperties: false,
    },
    outputSchema: MEMBER,
    annotations: { readOnlyHint: false },
  },
  {
    name: "resendInvitation",
    title: "Send a new invitation",
    description: "Sends a new invitation to a user of the company you work in who has not accepted theirs, and stops the old link.",
    inputSchema: { type: "object", properties: { memberId: MEMBER_ID, idempotencyKey: IDEMPOTENCY_KEY }, required: ["memberId", "idempotencyKey"], additionalProperties: false },
    outputSchema: NO_OUTPUT,
    annotations: { readOnlyHint: false },
  },
  {
    name: "disconnectUserIdentity",
    title: "Disconnect a user's identity",
    description: "Disconnects the identity of a user of the company you work in, and sends the user a new invitation that a new or an existing identity may accept.",
    inputSchema: { type: "object", properties: { memberId: MEMBER_ID, idempotencyKey: IDEMPOTENCY_KEY }, required: ["memberId", "idempotencyKey"], additionalProperties: false },
    outputSchema: MEMBER,
    annotations: { readOnlyHint: false },
  },
  {
    name: "getInvitation",
    title: "Read an invitation",
    description: "Reads an invitation by its link. It serves the browser's sign-in, so this tool refuses every call.",
    inputSchema: {
      type: "object",
      properties: { token: { type: "string", pattern: "^nfi_[A-Za-z0-9_-]{43}$", description: "The invitation link's token, from the invitation's mail." } },
      required: ["token"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name the invitation was sent to." },
        email: { type: "string", description: "The e-mail address the invitation was sent to. A new identity takes it as its e-mail address." },
        expiresAt: { ...DATE_TIME, description: "When the link stops working: 14 days after the invitation was sent." },
        companyName: { type: "string", description: "The name of the company the invitation is to, as it was when the invitation was sent." },
        inviterName: { type: "string", description: "The name of the system administrator who sent the invitation, as it was then." },
      },
      required: ["name", "email", "expiresAt", "companyName", "inviterName"],
      additionalProperties: false,
      description: "Inbjudan: an invitation to a company, as its link shows it. The link works once, for 14 days, and a newer invitation of the same member stops it.",
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "acceptInvitation",
    title: "Accept an invitation",
    description: "Accepts an invitation by its link. It serves the browser's sign-in, so this tool refuses every call.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", pattern: "^nfi_[A-Za-z0-9_-]{43}$", description: "The invitation link's token, from the invitation's mail." },
        newIdentity: {
          description:
            "Skapa ett nytt NortFox ID: the new identity's name and password. It takes the invitation's e-mail address. Left out, Koppla ihop med befintligt NortFox ID: the signed-in person accepts.",
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200, description: "The person's name, on one line." },
            password: { type: "string", description: "The password: 12 to 1024 characters." },
          },
          required: ["name", "password"],
          additionalProperties: false,
        },
      },
      required: ["token"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        user: USER,
        membership: MEMBERSHIP,
        totpEnrolment: {
          type: "object",
          properties: {
            otpauthUri: {
              type: "string",
              description: "The TOTP secret as an otpauth URI, for an authenticator app: show it as a QR code. The first right code of it confirms it.",
            },
          },
          required: ["otpauthUri"],
          additionalProperties: false,
          description: "A new TOTP secret, which the person adds to an authenticator app.",
        },
      },
      required: ["user", "membership"],
      additionalProperties: false,
      description:
        "An accepted invitation: the person who now holds the membership, and the membership. For a new identity, also its TOTP secret, which no answer gives again: " +
        "the person signs in next, with the password and a code. The TOTP enrolment is absent when the signed-in identity accepted.",
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "leaveCompany",
    title: "Leave a company",
    description: "Leaves a company where you are an active member. Only a new invitation lets you back.",
    inputSchema: {
      type: "object",
      properties: { companyId: { ...UUID, description: "The company's id." }, idempotencyKey: IDEMPOTENCY_KEY },
      required: ["companyId", "idempotencyKey"],
      additionalProperties: false,
    },
    outputSchema: NO_OUTPUT,
    annotations: { readOnlyHint: false },
  },
];

const SIGN_IN_TOOLS = [
  {
    name: "completeSetup",
    title: "Make the first identity",
    description: "Makes the first identity of an empty install. It serves the browser's sign-in, so this tool refuses every call.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", pattern: "^nfu_[A-Za-z0-9_-]{43}$", description: "The setup link's token, which the install's setup command printed." },
        name: { type: "string", minLength: 1, maxLength: 200, description: "The person's name, on one line." },
        email: { ...EMAIL, description: "The person's personal e-mail address, one mailbox." },
        password: { type: "string", description: "The password: 12 to 1024 characters." },
      },
      required: ["token", "name", "email", "password"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        user: USER,
        totpEnrolment: {
          type: "object",
          properties: {
            otpauthUri: {
              type: "string",
              description: "The TOTP secret as an otpauth URI, for an authenticator app: show it as a QR code. The first right code of it confirms it.",
            },
          },
          required: ["otpauthUri"],
          additionalProperties: false,
          description: "A new TOTP secret, which the person adds to an authenticator app.",
        },
      },
      required: ["user", "totpEnrolment"],
      additionalProperties: false,
      description: "The first identity of the install, with its TOTP enrolment. The person signs in next, with the password and a code.",
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "loginWithPassword",
    title: "Sign in with a password",
    description: "Signs a browser in with a password. It serves the browser's sign-in, so this tool refuses every call: an MCP client signs in through OAuth.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", minLength: 1, maxLength: 254, description: "The e-mail address, or the personnummer in 10 or 12 digits." },
        password: { type: "string", minLength: 1, description: "The password." },
      },
      required: ["identifier", "password"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: ["signed-in", "totp-required"],
          description: "signed-in: the session cookie is set, on a known device inside its 90 days. totp-required: verifyTotp comes next, with the challenge.",
        },
        challenge: {
          type: "string",
          pattern: CHALLENGE_PATTERN,
          description: "The login challenge, for verifyTotp, when the outcome is totp-required. It works for 20 minutes and for five codes.",
        },
      },
      required: ["outcome"],
      additionalProperties: false,
      description: "What a right password gives: a session, or the TOTP step.",
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "verifyTotp",
    title: "Give the TOTP code",
    description: "Gives the TOTP code of a browser's sign-in. It serves the browser's sign-in, so this tool refuses every call: an MCP client signs in through OAuth.",
    inputSchema: {
      type: "object",
      properties: {
        challenge: { type: "string", pattern: CHALLENGE_PATTERN, description: "The login challenge that loginWithPassword gave." },
        code: { type: "string", pattern: "^[0-9]{6}$", description: "The six digits of the authenticator app." },
      },
      required: ["challenge", "code"],
      additionalProperties: false,
    },
    outputSchema: NO_OUTPUT,
    annotations: { readOnlyHint: false },
  },
  {
    name: "logout",
    title: "Sign out",
    description: "Signs a browser out. It serves the browser's session, so this tool refuses every call.",
    inputSchema: {
      type: "object",
      properties: {
        idempotencyKey: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          pattern: "^[\\x21\\x23-\\x5b\\x5d-\\x7e]+$",
          description:
            'A key you choose for this write, 1 to 255 characters of visible ASCII without " and \\. Send the same key with the same input again, and you get the first answer back instead of a second write.',
        },
      },
      required: ["idempotencyKey"],
      additionalProperties: false,
    },
    outputSchema: NO_OUTPUT,
    annotations: { readOnlyHint: false },
  },
  {
    name: "getSession",
    title: "Read the session",
    description: "Reads the browser's session. It serves the browser's sign-in, so this tool refuses every call: an MCP client signs in through OAuth.",
    inputSchema: NO_INPUT,
    outputSchema: SESSION,
    annotations: { readOnlyHint: true },
  },
  {
    name: "getMe",
    title: "Read yourself",
    description:
      "Gives the person you act as: their name, e-mail address, language, personnummer and mobile number when set, and how often a sign-in asks for a TOTP code; " +
      "and the company you work in, with your membership and permissions there.",
    inputSchema: NO_INPUT,
    outputSchema: {
      type: "object",
      properties: {
        user: USER,
        personalIdentityNumber: {
          description: "The person's personnummer, in twelve digits with a hyphen. Absent until one is added.",
          type: "string",
          pattern: "^[0-9]{8}-[0-9]{4}$",
        },
        mobile: { description: "The person's mobile number. Absent when none is set.", type: "string" },
        twoStep: {
          type: "string",
          enum: ["new_device_90_days", "every_login"],
          description: "How often a password sign-in asks for a TOTP code: new_device_90_days on each new device and every 90 days on a known one, or every_login.",
        },
        company: COMPANY_SCHEMA,
        membership: MEMBERSHIP,
        permissions: {
          type: "array",
          items: { type: "string" },
          description:
            "The permissions the request holds in that company, in alphabetical order: a member's own, the admin level's, a program administrator's while the member administers a program, and the rights of the member's program grants. " +
            "A session holds those it took when it chose the company, less a right whose grant has ended since. Empty when the request works in no company.",
        },
      },
      required: ["user", "twoStep", "permissions"],
      additionalProperties: false,
      description: "The signed-in person, with their own login data, and the company the request works in with the person's membership and permissions there.",
    },
    annotations: { readOnlyHint: true },
  },
];

/** The tools of the test app, as tools/list gives them: the registry's, then the test-only write and list. */
const TOOLS = [
  {
    name: "getHealth",
    title: "Check that the server is up",
    description: "Checks that the NortFox server is up, and gives its version. It reads no data.",
    inputSchema: NO_INPUT,
    outputSchema: {
      type: "object",
      description: "Whether the server is up.",
      properties: {
        status: { type: "string", const: "ok", description: 'Always "ok" when the server answers.' },
        version: { type: "string", description: "The version of the server that answered.", examples: ["0.0.0"] },
      },
      required: ["status", "version"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "getCompany",
    title: "Read the company",
    description:
      "Gives the company you work in: its id, name, organisation number and database number. Each tool that needs a permission works in this company too, and a tool that takes a companyId works in the company it names.",
    inputSchema: NO_INPUT,
    outputSchema: COMPANY_SCHEMA,
    annotations: { readOnlyHint: true },
  },
  ...SIGN_IN_TOOLS,
  ...COMPANY_TOOLS,
  ...USER_TOOLS,
  ...INVITATION_TOOLS,
  {
    name: "testBookVoucher",
    title: "Book a voucher",
    description: "Books a voucher of one amount in the company you work in. Only the tests serve it.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", minLength: 1, maxLength: 200, description: "The voucher's description." },
        amount: MONEY,
        idempotencyKey: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          pattern: "^[\\x21\\x23-\\x5b\\x5d-\\x7e]+$",
          description:
            'A key you choose for this write, 1 to 255 characters of visible ASCII without " and \\. Send the same key with the same input again, and you get the first answer back instead of a second write.',
        },
      },
      required: ["description", "amount", "idempotencyKey"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { ...UUID, description: "The voucher's id." },
        number: { type: "integer", minimum: -9007199254740991, maximum: 9007199254740991, description: "The voucher's number in series A." },
        amount: MONEY,
      },
      required: ["id", "number", "amount"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "testListAccounts",
    title: "List the accounts",
    description: "Lists the accounts of the company you work in. Only the tests serve it.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", default: 100, description: "How many items a page holds: from 1 to 500. Any other whole number gives 100." },
        cursor: {
          type: "string",
          description: "Where the page starts: the nextCursor of the page before. Leave it out for the first page.",
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      description: "A page of the list.",
      properties: {
        items: {
          type: "array",
          description: "The items of this page, in the list's order.",
          items: {
            type: "object",
            properties: {
              id: { ...UUID, description: "The account's id." },
              number: { type: "integer", minimum: -9007199254740991, maximum: 9007199254740991, description: "The account's number." },
              description: { type: "string", description: "The account's name." },
            },
            required: ["id", "number", "description"],
            additionalProperties: false,
          },
        },
        nextCursor: { type: "string", description: "Where the next page starts. It is absent on the last page." },
        total: { type: "integer", minimum: 0, maximum: 9007199254740991, description: "How many items the whole list holds." },
      },
      required: ["items", "total"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

const HEALTH = { status: "ok", version: TEST_VERSION };

function testApp(database = untouchedDatabase(), report: (error: unknown) => void = () => undefined) {
  return buildTestApp({ database, resolve: testResolver(TOKENS), report });
}

describe("tools/list", () => {
  it.each(MCP_ERAS)("lists exactly the registry's operations, in its order, each with the schemas written here, to a client of the %s era", async (era) => {
    const client = await mcpClient(testApp(), { era });
    const listed = await client.listTools();
    expect(listed.tools).toEqual(TOOLS);
    expect(listed.nextCursor).toBeUndefined();
    await client.close();
  });

  it("lists the same tools with and without an actor", async () => {
    const app = testApp();
    const anonymous = await mcpClient(app);
    const writer = await mcpClient(app, { token: "writer" });
    expect((await anonymous.listTools()).tools).toEqual((await writer.listTools()).tools);
    await anonymous.close();
    await writer.close();
  });

  it("asks a write for its idempotency key, and no read", async () => {
    const client = await mcpClient(testApp());
    const { tools } = await client.listTools();
    const inputOf = (name: string) => tools.find((tool) => tool.name === name)?.inputSchema;
    expect(inputOf("testBookVoucher")?.required).toContain("idempotencyKey");
    expect(inputOf("testBookVoucher")?.properties).toHaveProperty("idempotencyKey");
    for (const read of ["getHealth", "getCompany", "testListAccounts"]) {
      expect(inputOf(read)?.properties).not.toHaveProperty("idempotencyKey");
      expect(inputOf(read)?.required ?? []).not.toContain("idempotencyKey");
    }
    await client.close();
  });
});

describe("tools/call", () => {
  it.each(MCP_ERAS)("answers getHealth with no actor as REST does: the same JSON as structured content and as text (%s)", async (era) => {
    const app = testApp();
    const rest = await app.hono.request("/v1/health");
    expect(await rest.json()).toEqual(HEALTH);
    const client = await mcpClient(app, { era });
    expect(await callTool(client, "getHealth")).toEqual({ isError: false, structured: HEALTH });
    // A call may leave out its arguments when the tool takes none.
    expect(await client.callTool({ name: "getHealth" })).toMatchObject({ structuredContent: HEALTH });
    await client.close();
  });

  it("answers an unknown tool with a protocol error, and runs nothing", async () => {
    const database = untouchedDatabase();
    const client = await mcpClient(testApp(database), { token: "writer" });
    for (const name of ["noSuchTool", "GetCompany", "getcompany", "toString", "__proto__", ""]) {
      const error = await client.callTool({ name, arguments: {} }).then(
        () => undefined,
        (refused: unknown) => refused,
      );
      expect(error).toMatchObject({ code: -32602 });
      expect(String(error)).toContain(`There is no tool named ${JSON.stringify(name)}.`);
    }
    expect(database.asked).toEqual([]);
    await client.close();
  });

  it("answers a call that fails with isError and 500 internal-error, with nothing of the error, and reports the error", async () => {
    const reported: unknown[] = [];
    const database = untouchedDatabase();
    const client = await mcpClient(testApp(database, (error) => reported.push(error)), { token: "reader" });
    expect(await callTool(client, "getCompany")).toEqual({
      isError: true,
      structured: {
        type: "about:blank",
        title: "Internal Server Error",
        status: 500,
        detail: "The server failed. The answer holds no detail of the error, and the server has logged it.",
        code: "internal-error",
      },
    });
    expect(database.asked).toEqual(["read"]);
    expect(reported.map(String)).toEqual(["Error: The database was asked to read, and this test must not touch it."]);
    await client.close();
  });

  it("answers 500 internal-error to a principal whose company access the one membership function did not make, runs nothing, and reports it", async () => {
    const reported: unknown[] = [];
    const database = untouchedDatabase();
    const plain = { ...TOKENS.reader, company: { companyId: COMPANY, permissions: new Set(["company:read"]) } } as unknown as Principal;
    const app = buildTestApp({ database, resolve: testResolver({ plain }), report: (error) => reported.push(error) });
    const client = await mcpClient(app, { token: "plain" });
    expect(await callTool(client, "getCompany")).toMatchObject({ isError: true, structured: { status: 500, code: "internal-error" } });
    expect(database.asked).toEqual([]);
    expect(reported.map(String)).toEqual([
      "Error: The principal's company access was not made from the one membership function's answer (modules/memberships/resolve.ts).",
    ]);
    await client.close();
    // REST answers the same, through the app's own 500.
    const rest = await app.hono.request("/v1/company", { headers: bearer("plain") });
    expect(rest.status).toBe(500);
    expect(await problemIn(rest)).toMatchObject({ code: "internal-error" });
    expect(reported).toHaveLength(2);
  });

  it("takes an argument the operation does not declare as an unknown field at its pointer, with the text /v1 gives", async () => {
    const database = untouchedDatabase();
    const client = await mcpClient(testApp(database), { token: "writer" });
    const unknown = (pointer: string) => ({ code: "unknown-field", detail: `The field ${pointer} is not part of this operation.`, pointer });
    const invalid = (...errors: unknown[]) => ({
      isError: true,
      structured: {
        type: "about:blank",
        title: "Bad Request",
        status: 400,
        detail: "The request does not fit the operation. Each field problem names its field.",
        code: "invalid-request",
        errors,
      },
    });
    expect(await callTool(client, "getCompany", { cursor: "x", idempotencyKey: "k-1" })).toEqual(invalid(unknown("/cursor"), unknown("/idempotencyKey")));
    expect(await callTool(client, "testListAccounts", { limit: 5, Limit: 5, amount: "1.00" })).toEqual(invalid(unknown("/Limit"), unknown("/amount")));
    expect(await callTool(client, "testBookVoucher", { ...voucherBody(), idempotencyKey: "k-1", limit: 5, "a/b~c": 1 })).toEqual(
      invalid(unknown("/limit"), unknown("/a~1b~0c")),
    );
    expect(await callTool(client, "getHealth", { constructor: 2, toString: 3 })).toEqual(invalid(unknown("/constructor"), unknown("/toString")));
    // The SDK's own check of the request drops an argument named __proto__ before any tool sees it.
    const odd = JSON.parse('{"__proto__": {"limit": 1}, "hasOwnProperty": 4}') as Record<string, unknown>;
    expect(await callTool(client, "testListAccounts", odd)).toEqual(invalid(unknown("/hasOwnProperty")));
    expect(database.asked).toEqual([]);
    await client.close();
  });

  it("answers GET and DELETE on /mcp, the 2025 session operations, with 405, and asks no database", async () => {
    const database = untouchedDatabase();
    const app = testApp(database);
    for (const method of ["GET", "DELETE"]) {
      const response = await app.hono.request("/mcp", { method, headers: { ...bearer("writer"), accept: "application/json, text/event-stream" } });
      expect(response.status).toBe(405);
    }
    expect(database.asked).toEqual([]);
  });
});

describe("the shapes of slice 2c by MCP", () => {
  const THING = "1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b";
  const PERSON = personOf();
  const SHAPE_TOKENS = { ...TOKENS, person: PERSON };

  function shapeApp(database: Database = untouchedDatabase()) {
    const log = shapeLog();
    return { log, app: buildTestApp({ database, resolve: testResolver(SHAPE_TOKENS), registry: SHAPES_REGISTRY, handlers: shapesHandlers(log), report: () => undefined }) };
  }

  /** Arguments with which each operation that serves the browser's session would succeed by REST. */
  const FLOW_ARGUMENTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    testSignIn: { email: "anna@example.com" },
    testSendLetter: { email: "anna@example.com" },
    testStartRedirect: { provider: "alfa" },
    testEndSession: { idempotencyKey: "k-1" },
  };

  const FLOW = SHAPE_OPERATIONS.filter((operation) => operation["x-nortfox"].session === "flow");

  it("covers every test-only operation that serves the browser's session", () => {
    expect(FLOW.map((operation) => operation.operationId)).toEqual(Object.keys(FLOW_ARGUMENTS));
  });

  it.each(FLOW.flatMap((operation) => MCP_ERAS.flatMap((era) => [undefined, "person", "writer"].map((token) => [operation.operationId, era, token] as const))))(
    "refuses %s with 403 browser-only, before any argument is read, and runs no handler and asks no database (%s, %s)",
    async (name, era, token) => {
      const database = untouchedDatabase();
      const { app, log } = shapeApp(database);
      const client = await mcpClient(app, { era, ...(token === undefined ? {} : { token }) });
      for (const args of [FLOW_ARGUMENTS[name] ?? {}, { unknown: 1 }]) {
        expect(await callTool(client, name, args)).toEqual({
          isError: true,
          structured: {
            type: "about:blank",
            title: "Forbidden",
            status: 403,
            detail: "This operation serves the browser's sign-in. An MCP client signs in through OAuth.",
            code: "browser-only",
          },
        });
      }
      expect(log.calls).toEqual([]);
      expect(database.asked).toEqual([]);
      await client.close();
    },
  );

  it("lists each operation of the browser's session with its schemas, as any tool", async () => {
    const client = await mcpClient(shapeApp().app);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(SHAPES_REGISTRY.map((operation) => operation.operationId));
    expect(tools.find((tool) => tool.name === "testSignIn")?.inputSchema).toEqual({
      type: "object",
      properties: { email: { type: "string", minLength: 1, description: "The e-mail address." } },
      required: ["email"],
      additionalProperties: false,
    });
    await client.close();
  });

  it("takes a path parameter as an argument, and names a bad one at its pointer", async () => {
    const { app } = shapeApp(fakeDatabase());
    const client = await mcpClient(app, { token: "writer" });
    expect(await callTool(client, "testGetThing", { thingId: THING, view: "long" })).toEqual({
      isError: false,
      structured: { id: THING, view: "long", companyId: COMPANY },
    });
    expect(await callTool(client, "testGetThing", { view: "long" })).toMatchObject({
      isError: true,
      structured: { status: 400, errors: [{ code: "missing-field", pointer: "/thingId" }] },
    });
    await client.close();
  });

  it("answers an operation that answers 204 with an empty object", async () => {
    const { app } = shapeApp(fakeDatabase());
    const client = await mcpClient(app, { token: "writer" });
    expect(await callTool(client, "testRemoveThing", { thingId: THING, idempotencyKey: "k-1" })).toEqual({ isError: false, structured: {} });
    await client.close();
  });

  it("answers a signed-in person's operation that does not serve the browser's session", async () => {
    const database = fakeDatabase();
    const { app } = shapeApp(database);
    const client = await mcpClient(app, { token: "person" });
    expect(await callTool(client, "testGetPerson")).toEqual({ isError: false, structured: { personId: PERSON.personId } });
    expect(database.transactions).toEqual([{ mode: "read", settings: { actorId: PERSON.personId, actorKind: "user", channel: "mcp" }, ended: "commit" }]);
    await client.close();
  });
});

describe("the caller of an MCP request", () => {
  it("is the principal that /mcp passes with each request, and nothing else", () => {
    expect(() => callerPrincipal(undefined)).toThrow("The MCP server got no caller");
    expect(() => callerPrincipal({ token: "", clientId: "", scopes: [] })).toThrow("The MCP server got no caller");
  });
});

describe("/mcp on the real server", () => {
  it.each(MCP_ERAS)("serves a client of the %s era over HTTP, as through app.request", async (era) => {
    const app = createApp({ version: TEST_VERSION, resolve: testResolver(TOKENS), database: untouchedDatabase(), cursorKey: CURSOR_KEY, installKey: TEST_INSTALL_KEY });
    const server = await startServer({ app, port: 0 });
    try {
      const client = new Client(
        { name: "nortfox-tests", version: "0.0.0" },
        era === "2025" ? {} : { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(server.port)}/mcp`)));
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["getHealth", "getCompany", ...[...SIGN_IN_TOOLS, ...COMPANY_TOOLS, ...USER_TOOLS, ...INVITATION_TOOLS].map((tool) => tool.name)]);
      expect(await callTool(client, "getHealth")).toEqual({ isError: false, structured: { status: "ok", version: TEST_VERSION } });
      await client.close();
    } finally {
      await server.close();
    }
  });

  it("answers a 2026-07-28 call with one JSON body, never a stream", async () => {
    const app = testApp();
    const response = await app.hono.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "getHealth",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "getHealth",
          arguments: {},
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_INFO_META_KEY]: { name: "nortfox-tests", version: "0.0.0" },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { structuredContent: HEALTH } });
  });

  it("answers a 2025 call with an event stream that holds its one answer, as the stateless fallback does", async () => {
    const app = testApp();
    const response = await app.hono.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "getHealth", arguments: {} } }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: "));
    expect(events.map((line) => JSON.parse(line.slice("data: ".length)) as unknown)).toEqual([
      { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(HEALTH) }], structuredContent: HEALTH } },
    ]);
  });
});
