// SPDX-License-Identifier: AGPL-3.0-only

import { types } from "pg";
import { describe, expect, it } from "vitest";
import { configFromEnvironment, connectionConfig, typeParsers } from "./connect.ts";

const { INT8, NUMERIC, TEXT } = types.builtins;

describe("typeParsers", () => {
  it("reads an int8 as a bigint, also past 2^53", () => {
    const parse = typeParsers.getTypeParser(INT8, "text") as (text: string) => unknown;
    expect(parse("9007199254740993")).toBe(9007199254740993n);
    expect(parse("-1")).toBe(-1n);
    expect((typeParsers.getTypeParser(INT8) as (text: string) => unknown)("0")).toBe(0n);
  });

  it("leaves every other type, and a binary int8, to the driver", () => {
    expect(typeParsers.getTypeParser(NUMERIC, "text")).toBe(types.getTypeParser(NUMERIC, "text"));
    expect(typeParsers.getTypeParser(TEXT, "text")).toBe(types.getTypeParser(TEXT, "text"));
    expect(typeParsers.getTypeParser(INT8, "binary")).toBe(types.getTypeParser(INT8, "binary"));
  });
});

describe("connectionConfig", () => {
  it("passes the address on, with the password and the type parsers", () => {
    expect(connectionConfig("postgres://nortfox_app@db:5432/nortfox", "secret")).toEqual({
      connectionString: "postgres://nortfox_app@db:5432/nortfox",
      password: "secret",
      types: typeParsers,
    });
    expect(connectionConfig("postgresql://nortfox_app@db/nortfox")).toEqual({
      connectionString: "postgresql://nortfox_app@db/nortfox",
      types: typeParsers,
    });
  });

  it("refuses an address with a password in it", () => {
    expect(() => connectionConfig("postgres://nortfox_app:secret@db/nortfox")).toThrow(
      "The database address holds a password. Put the password in the file that NORTFOX_DATABASE_PASSWORD_FILE names.",
    );
  });

  it("refuses what is not a PostgreSQL address", () => {
    expect(() => connectionConfig("db:5432")).toThrow("The database address must start with postgres:// or postgresql://.");
    expect(() => connectionConfig("http://db/nortfox")).toThrow("must start with postgres:// or postgresql://.");
    expect(() => connectionConfig("nortfox")).toThrow("The database address is not a URL.");
  });
});

describe("configFromEnvironment", () => {
  const files: Record<string, string> = { "/run/secrets/db": "secret\n", "/run/secrets/crlf": "secret\r\n", "/run/secrets/empty": "\n" };
  const readFile = (path: string): string => {
    const text = files[path];
    if (text === undefined) {
      throw new Error("ENOENT");
    }
    return text;
  };
  const url = "postgres://nortfox_owner@db/nortfox";

  it("reads the address and the password file, without the line break at its end", () => {
    expect(configFromEnvironment({ NORTFOX_DATABASE_URL: url, NORTFOX_DATABASE_PASSWORD_FILE: "/run/secrets/db" }, readFile)).toEqual({
      connectionString: url,
      password: "secret",
      types: typeParsers,
    });
    expect(
      configFromEnvironment({ NORTFOX_DATABASE_URL: url, NORTFOX_DATABASE_PASSWORD_FILE: "/run/secrets/crlf" }, readFile).password,
    ).toBe("secret");
  });

  it.each([
    [{}, "NORTFOX_DATABASE_URL is not set."],
    [{ NORTFOX_DATABASE_URL: "" }, "NORTFOX_DATABASE_URL is not set."],
    [{ NORTFOX_DATABASE_URL: url }, "NORTFOX_DATABASE_PASSWORD_FILE is not set."],
    [{ NORTFOX_DATABASE_URL: url, NORTFOX_DATABASE_PASSWORD_FILE: "" }, "NORTFOX_DATABASE_PASSWORD_FILE is not set."],
    [{ NORTFOX_DATABASE_URL: url, NORTFOX_DATABASE_PASSWORD_FILE: "/run/secrets/none" }, "The password file /run/secrets/none cannot be read."],
    [{ NORTFOX_DATABASE_URL: url, NORTFOX_DATABASE_PASSWORD_FILE: "/run/secrets/empty" }, "The password file /run/secrets/empty is empty."],
    [
      { NORTFOX_DATABASE_URL: "postgres://nortfox_owner:secret@db/nortfox", NORTFOX_DATABASE_PASSWORD_FILE: "/run/secrets/db" },
      "The database address holds a password.",
    ],
  ])("fails loudly on %j", (env, message) => {
    expect(() => configFromEnvironment(env, readFile)).toThrow(message);
  });

  it("reads the password file from disk by default", () => {
    expect(() => configFromEnvironment({ NORTFOX_DATABASE_URL: url, NORTFOX_DATABASE_PASSWORD_FILE: "/no/such/file" })).toThrow(
      "The password file /no/such/file cannot be read.",
    );
  });
});
