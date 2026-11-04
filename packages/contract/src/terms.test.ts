// SPDX-License-Identifier: AGPL-3.0-only

// The terms of each slice and their names in /v1 and the code
// (docs/glossary.md). Each schema that a term names keeps its name in
// openapi.json's components and its fields in their order, and the
// glossary's row for the term names it. So a rename changes this file, the
// glossary and the API together. Each part of a slice pins its own terms
// here as it adds them.

import { OpenAPIHono } from "@hono/zod-openapi";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REGISTRY } from "./registry.ts";

/** The glossary, which lists the terms. */
const GLOSSARY = new URL("../../../docs/glossary.md", import.meta.url);

/** The schemas that the terms name, each with its fields in their order. */
const SCHEMAS: Readonly<Record<string, readonly string[]>> = {
  // Slice 2b.
  Company: ["id", "name", "organizationNumber", "databaseNumber"],
  // Slice 2c, part 1: the login identity.
  User: ["id", "name", "email", "language"],
  Me: ["user", "personalIdentityNumber", "mobile", "twoStep"],
  Session: ["user"],
};

/**
 * Each term, as the glossary's first column writes it, with the names its
 * row gives in the column "Name in /v1 and the code": a schema of SCHEMAS,
 * or a field of one as Schema.field. The glossary writes each name in
 * backticks, a field by its own name.
 */
const TERMS: readonly (readonly [string, readonly string[]])[] = [
  ["Företag / company", ["Company"]],
  ["Organisationsnummer / organisation number", ["Company.organizationNumber"]],
  ["(no screen word) / tenant id", ["Company.databaseNumber"]],
  ["Användare / user", ["User", "User.id", "User.name", "User.email", "User.language"]],
  ["NortFox ID / login identity", ["User", "Me"]],
  ["(no screen word) / session", ["Session"]],
  ["Personnummer / personal identity number", ["Me.personalIdentityNumber"]],
];

interface Described {
  readonly components: { readonly schemas: Readonly<Record<string, { readonly properties?: Readonly<Record<string, unknown>> }>> };
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

  it.each(Object.entries(SCHEMAS))("names the schema %s in openapi.json's components, with its fields in their order", (name, fields) => {
    expect(Object.keys(schemas[name]?.properties ?? {})).toEqual(fields);
  });

  it.each(TERMS)("gives the term %j names that /v1 has", (_term, names) => {
    for (const name of names) {
      const [schema = "", field] = name.split(".");
      expect(SCHEMAS[schema], name).toBeDefined();
      if (field !== undefined) {
        expect(SCHEMAS[schema], name).toContain(field);
      }
    }
  });
});

describe("docs/glossary.md", () => {
  const rows = glossaryRows();

  it.each(TERMS)("lists the term %j with its names in /v1 and the code", (term, names) => {
    const wanted = names.map((name) => name.split(".").at(-1));
    const row = rows.find((cells) => cells[0] === term && wanted.every((name) => backticked(cells[2] ?? "").includes(String(name))));
    expect(row, `docs/glossary.md has no row "${term}" whose names in /v1 are ${wanted.map((name) => `\`${String(name)}\``).join(", ")}.`).toBeDefined();
  });

  it("reads each table row as four cells", () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const cells of rows) {
      expect(cells, cells.join(" | ")).toHaveLength(4);
    }
  });
});
