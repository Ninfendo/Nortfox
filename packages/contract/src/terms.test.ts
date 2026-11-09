// SPDX-License-Identifier: AGPL-3.0-only

// The terms of each slice and their names in /v1 and the code
// (docs/glossary.md). Each schema that a term names keeps its name in
// openapi.json's components and its fields in their order, and the
// glossary's row for the term names it. Each list of values that a term
// names keeps its values in their order, and the glossary's row lists them
// in that order. So a rename or a new value changes this file, the glossary
// and the API together. Each part of a slice pins its own terms here as it
// adds them.

import { OpenAPIHono } from "@hono/zod-openapi";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REGISTRY } from "./registry.ts";

/** The glossary, which lists the terms. */
const GLOSSARY = new URL("../../../docs/glossary.md", import.meta.url);

/** The schemas that the terms name, each with its fields in their order. */
const SCHEMAS: Readonly<Record<string, readonly string[]>> = {
  // Slice 2b, and the addresses and contact details of slice 2c, part 3.
  Company: [
    "id",
    "name",
    "organizationNumber",
    "databaseNumber",
    "address",
    "zipCode",
    "city",
    "countryCode",
    "visitAddress",
    "visitZipCode",
    "visitCity",
    "visitCountryCode",
    "phone",
    "email",
  ],
  // Slice 2c, part 1: the login identity.
  User: ["id", "name", "email", "language"],
  Me: ["user", "personalIdentityNumber", "mobile", "twoStep", "company", "membership", "permissions"],
  Session: ["user", "company"],
  // Slice 2c, part 2: the companies and the memberships.
  Membership: ["id", "companyId", "userId", "status", "adminLevel", "idleTimeout", "workEmail", "workPhone", "roles", "programs", "programsAdministered"],
  CompanyChoice: ["company", "adminLevel"],
  // Slice 2c, part 3: the company as the company lists give it.
  CompanySummary: ["id", "name", "organizationNumber", "databaseNumber"],
  RecentCompanies: ["companies"],
  // Slice 2c, part 3: the roles and the programs.
  ProgramGrant: ["program", "permissions", "full", "grantedAt", "expiresAt"],
  ProgramAdmin: ["program"],
  Member: ["id", "companyId", "userId", "name", "status", "adminLevel", "idleTimeout", "workEmail", "workPhone", "roles", "programs", "programsAdministered"],
  UserRights: ["permissions", "programs"],
  Permission: ["key", "group", "label", "view", "manualOnly"],
  PermissionGroup: ["key", "kind", "label"],
  ProgramDefinition: ["key", "label", "lifetimeDays", "permissions"],
  RoleDefinition: ["key", "adminLevel", "program", "full"],
  PermissionCatalogue: ["roles", "programs", "groups", "permissions"],
  Invitation: ["name", "email", "expiresAt", "companyName", "inviterName"],
  InvitationAcceptance: ["user", "membership", "totpEnrolment"],
};

/**
 * The enums that the terms name, each with its values in their order: a
 * schema of its own, or a field as Schema.field.
 */
const VALUES: Readonly<Record<string, readonly (string | number)[]>> = {
  // Slice 2c, part 2.
  SysAdmin: ["owner", "admin"],
  "Membership.status": ["invited", "active", "inactive", "removed", "left"],
  "Membership.idleTimeout": [15, 30, 60, 120, 480],
  // Slice 2c, part 3.
  Program: ["bookkeeping", "approval-read", "read", "auditor"],
  Role: ["owner", "admin", "bookkeeper", "approver", "viewer", "auditor"],
  PermissionGroupKey: ["vouchers", "supplier-invoices", "reports", "register"],
};

/** The fields that hold a schema that a term names, as Schema.field, each with that schema. */
const REFERENCES: Readonly<Record<string, string>> = {
  // Slice 2c, part 2.
  "Session.company": "Company",
  "Membership.adminLevel": "SysAdmin",
  "CompanyChoice.adminLevel": "SysAdmin",
  "CompanyChoice.company": "CompanySummary",
  // Slice 2c, part 3.
  "ProgramGrant.program": "Program",
  "ProgramAdmin.program": "Program",
  "Member.adminLevel": "SysAdmin",
  "Permission.group": "PermissionGroupKey",
  "PermissionGroup.key": "PermissionGroupKey",
  "ProgramDefinition.key": "Program",
  "RoleDefinition.key": "Role",
  "RoleDefinition.adminLevel": "SysAdmin",
  "RoleDefinition.program": "Program",
};

/**
 * Each term, as the glossary's first column writes it, with the names its
 * row gives in the column "Name in /v1 and the code": a schema of SCHEMAS
 * or VALUES, or a field of one as Schema.field. The glossary writes each
 * name in backticks, a field by its own name.
 */
const TERMS: readonly (readonly [string, readonly string[]])[] = [
  ["Företag / company", ["Company", "CompanySummary"]],
  ["Organisationsnummer / organisation number", ["Company.organizationNumber"]],
  ["(no screen word) / tenant id", ["Company.databaseNumber"]],
  [
    "Användare / user",
    [
      "User",
      "User.id",
      "User.name",
      "User.email",
      "User.language",
      "Membership",
      "Membership.id",
      "Membership.companyId",
      "Membership.userId",
      "Membership.status",
      "Membership.workEmail",
      "Membership.workPhone",
      "Membership.roles",
      "Membership.programs",
      "Membership.programsAdministered",
      "Member",
      "Member.id",
      "Member.name",
    ],
  ],
  ["NortFox ID / login identity", ["User", "Me"]],
  ["(no screen word) / session", ["Session", "Session.user", "Session.company"]],
  ["Personnummer / personal identity number", ["Me.personalIdentityNumber"]],
  ["Systemadministratör / system administrator", ["SysAdmin", "Membership.adminLevel", "CompanyChoice.adminLevel"]],
  ["Utloggning efter inaktivitet / idle logout", ["Membership.idleTimeout"]],
  ["(no screen word) / role", ["Role", "Membership.roles"]],
  ["Programadministratör / program administrator", ["ProgramAdmin", "ProgramAdmin.program", "Membership.programsAdministered"]],
  [
    "Program / program",
    ["Program", "ProgramGrant", "ProgramGrant.program", "ProgramGrant.permissions", "ProgramGrant.grantedAt", "ProgramGrant.expiresAt", "Membership.programs"],
  ],
  ["Full behörighet / full permission", ["ProgramGrant.full"]],
  [
    "Behörighet / permission",
    ["Permission", "Permission.key", "Permission.group", "Permission.label", "Permission.view", "Permission.manualOnly", "PermissionGroupKey", "PermissionCatalogue"],
  ],
  ["Bokför (permission) / book (permission)", ["Permission.key"]],
  [
    "Inbjudan / invitation",
    ["Invitation", "Invitation.name", "Invitation.email", "Invitation.expiresAt", "Invitation.companyName", "Invitation.inviterName", "InvitationAcceptance"],
  ],
];

interface DescribedSchema {
  readonly properties?: Readonly<Record<string, DescribedSchema>>;
  readonly enum?: readonly unknown[];
  readonly $ref?: string;
}

interface Described {
  readonly components: { readonly schemas: Readonly<Record<string, DescribedSchema>> };
}

/** The API description of the registry, as the server builds it. */
function described(): Described {
  const describer = new OpenAPIHono();
  for (const operation of REGISTRY) {
    describer.openAPIRegistry.registerPath(operation);
  }
  return describer.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "NortFox API", version: "0.0.0" } }) as unknown as Described;
}

/** The rows of the glossary's tables, each as its cells, without the header and separator rows. */
function glossaryRows(): string[][] {
  return readFileSync(GLOSSARY, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|") && !/^\|[-| ]+\|$/.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells[0] !== "Term (sv / en)");
}

/** The names that a cell writes in backticks. */
function backticked(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => String(match[1]));
}

describe("the terms in /v1", () => {
  const { schemas } = described().components;

  /** The schema that a name of VALUES or REFERENCES gives: a component, or a field of one. */
  function schemaOf(name: string): DescribedSchema | undefined {
    const [schema = "", field] = name.split(".");
    return field === undefined ? schemas[schema] : schemas[schema]?.properties?.[field];
  }

  it.each(Object.entries(SCHEMAS))("names the schema %s in openapi.json's components, with its fields in their order", (name, fields) => {
    expect(Object.keys(schemas[name]?.properties ?? {})).toEqual(fields);
  });

  it.each(Object.entries(VALUES))("gives %s its values in their order", (name, values) => {
    expect(schemaOf(name)?.enum, name).toEqual(values);
  });

  it.each(Object.entries(REFERENCES))("gives %s the schema %s", (name, schema) => {
    expect(schemaOf(name)?.$ref, name).toBe(`#/components/schemas/${schema}`);
  });

  it.each(TERMS)("gives the term %j names that /v1 has", (_term, names) => {
    for (const name of names) {
      const [schema = "", field] = name.split(".");
      if (field === undefined) {
        expect(SCHEMAS[schema] ?? VALUES[schema], name).toBeDefined();
      } else {
        expect(SCHEMAS[schema], name).toContain(field);
      }
    }
  });

  it("knows each schema and field that VALUES and REFERENCES name", () => {
    for (const name of [...Object.keys(VALUES), ...Object.keys(REFERENCES), ...Object.values(REFERENCES)]) {
      const [schema = "", field] = name.split(".");
      if (field === undefined) {
        expect(SCHEMAS[schema] ?? VALUES[schema], name).toBeDefined();
      } else {
        expect(SCHEMAS[schema], name).toContain(field);
      }
    }
  });
});

describe("docs/glossary.md", () => {
  const rows = glossaryRows();

  /** The last part of each name, as the glossary's row writes it in backticks. */
  function wantedOf(names: readonly string[]): string[] {
    return names.map((name) => String(name.split(".").at(-1)));
  }

  /** The glossary's row of the term whose names in /v1 are `names`. */
  function rowOf(term: string, names: readonly string[]): string[] | undefined {
    return rows.find((cells) => cells[0] === term && wantedOf(names).every((name) => backticked(cells[2] ?? "").includes(name)));
  }

  it.each(TERMS)("lists the term %j with its names in /v1 and the code", (term, names) => {
    expect(rowOf(term, names), `docs/glossary.md has no row "${term}" whose names in /v1 are ${wantedOf(names).map((name) => `\`${name}\``).join(", ")}.`).toBeDefined();
  });

  it.each(Object.entries(VALUES))("lists the values of %s in their order, in the row of each term that names it", (name, values) => {
    const terms = TERMS.filter(([, names]) => names.includes(name));
    expect(terms, `No term names ${name}.`).not.toEqual([]);
    const listed = values.map((value) => `\`${String(value)}\``);
    const list = listed.length === 1 ? String(listed[0]) : `${listed.slice(0, -1).join(", ")} or ${String(listed.at(-1))}`;
    for (const [term, names] of terms) {
      expect(rowOf(term, names)?.slice(2).join(" | "), `docs/glossary.md's row "${term}" lists ${name} as ${list}.`).toContain(list);
    }
  });

  it("reads each table row as four cells", () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const cells of rows) {
      expect(cells, cells.join(" | ")).toHaveLength(4);
    }
  });
});
