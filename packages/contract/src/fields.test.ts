// SPDX-License-Identifier: AGPL-3.0-only

// personal() marks a person's contact data in an output, and the registry
// derives each operation's list of the marked fields from its output schema
// (plan 2.1 and 2.2), so a marked field is never left off. These tests pin
// the pointers it gives through every shape an output takes: nested objects,
// a schema with a name of its own, optional and nullable fields, and lists.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isPersonal, personal, personalPointers } from "./fields.ts";

const Person = z
  .strictObject({
    id: z.uuid(),
    name: personal(z.string().meta({ description: "The person's name." })),
    email: personal(z.email().max(254)),
  })
  .meta({ id: "FieldsTestPerson" });

describe("personal", () => {
  it("marks the schema it is given, and gives the same schema back", () => {
    const text = z.string();
    expect(personal(text)).toBe(text);
    expect(isPersonal(text)).toBe(true);
    expect(isPersonal(z.string())).toBe(false);
  });
});

describe("personalPointers", () => {
  it("gives nothing for an output with no personal field", () => {
    expect(personalPointers(z.strictObject({ id: z.uuid(), count: z.int() }))).toEqual([]);
  });

  it("gives each marked field of an object, in the order of its fields", () => {
    expect(personalPointers(Person)).toEqual(["/name", "/email"]);
  });

  it("follows a schema with a name of its own, wherever it is used, and a nested object", () => {
    const output = z.strictObject({
      user: Person,
      inviter: Person.optional(),
      contact: z.strictObject({ phone: personal(z.string()), note: z.string() }),
    });
    expect(personalPointers(output)).toEqual(["/user/name", "/user/email", "/inviter/name", "/inviter/email", "/contact/phone"]);
  });

  it("finds a field marked before or after optional() and nullable()", () => {
    const output = z.strictObject({
      before: personal(z.string()).optional(),
      after: personal(z.string().optional()),
      nullable: personal(z.string()).nullable(),
      both: personal(z.email().nullable()),
      plain: z.string().optional(),
    });
    expect(personalPointers(output)).toEqual(["/before", "/after", "/nullable", "/both"]);
  });

  it("names the items of a list with *", () => {
    const output = z.strictObject({ items: z.array(Person), emails: z.array(personal(z.string())) });
    expect(personalPointers(output)).toEqual(["/items/*/name", "/items/*/email", "/emails/*"]);
  });

  it("escapes a field's name as a JSON Pointer does", () => {
    expect(personalPointers(z.strictObject({ "a/b": personal(z.string()), "c~d": personal(z.string()) }))).toEqual(["/a~1b", "/c~0d"]);
  });

  it("gives the whole output's pointer when the output itself is marked", () => {
    expect(personalPointers(personal(z.strictObject({ name: z.string() })))).toEqual([""]);
  });

  it("loses the mark of a schema that a later meta() copies, so a field is marked last", () => {
    expect(personalPointers(z.strictObject({ name: personal(z.string()).meta({ description: "A copy." }) }))).toEqual([]);
  });
});
