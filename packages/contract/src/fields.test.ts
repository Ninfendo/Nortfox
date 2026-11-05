// SPDX-License-Identifier: AGPL-3.0-only

// personal() marks a person's contact data in an output, and the registry
// derives each operation's list of the marked fields from its output schema
// (plan 2.1 and 2.2), so a marked field is never left off. These tests pin
// the pointers it gives through every shape an output takes: nested objects,
// a schema with a name of its own, optional and nullable fields, lists,
// unions, intersections, tuples and records. A mark that no pointer names
// throws.

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

  it("follows each branch of a discriminated union (oneOf) and of an intersection (allOf), as the same field", () => {
    const invitee = z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("person"), email: personal(z.string()) }),
      z.strictObject({ kind: z.literal("address"), phone: personal(z.string()) }),
    ]);
    expect(personalPointers(z.strictObject({ invitee }))).toEqual(["/invitee/email", "/invitee/phone"]);
    const both = z.intersection(z.object({ name: personal(z.string()) }), z.object({ id: z.uuid() }));
    expect(personalPointers(z.strictObject({ both }))).toEqual(["/both/name"]);
  });

  it("names the items of a tuple and the values of a record with *", () => {
    expect(personalPointers(z.strictObject({ pair: z.tuple([z.uuid(), personal(z.string())]) }))).toEqual(["/pair/*"]);
    expect(personalPointers(z.strictObject({ byId: z.record(z.string(), Person) }))).toEqual(["/byId/*/name", "/byId/*/email"]);
    expect(personalPointers(z.object({ id: z.uuid() }).catchall(personal(z.string())))).toEqual(["/*"]);
  });

  it("throws for a mark that no pointer names, so a marked field is never left off its list", () => {
    // The keys of a record are its JSON Schema's propertyNames, which hold no field: the record itself is marked instead.
    expect(() => personalPointers(z.strictObject({ byEmail: z.record(personal(z.email()), z.int()) }))).toThrow(
      "The output holds personal() marks that no JSON Pointer reaches (1), under a key that personalPointers does not follow. Mark the field that holds each one.",
    );
    expect(() => personalPointers(z.strictObject({ byEmail: z.record(personal(z.email()), z.int()), byPhone: z.record(personal(z.string()), z.int()) }))).toThrow(
      "(2)",
    );
    expect(personalPointers(z.strictObject({ byEmail: personal(z.record(z.email(), z.int())) }))).toEqual(["/byEmail"]);
  });

  it("reads a field that has the mark's own name like any other field", () => {
    const output = z.strictObject({ "x-nortfox-personal": z.strictObject({ email: personal(z.string()), note: z.string() }), plain: z.strictObject({ "x-nortfox-personal": personal(z.string()) }) });
    expect(personalPointers(output)).toEqual(["/x-nortfox-personal/email", "/plain/x-nortfox-personal"]);
    // A mark that no pointer reaches still throws inside such a field.
    expect(() => personalPointers(z.strictObject({ "x-nortfox-personal": z.record(personal(z.email()), z.int()) }))).toThrow("(1)");
  });
});
