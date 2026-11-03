// SPDX-License-Identifier: AGPL-3.0-only

import { Client, types, type ClientConfig } from "pg";
import { describe, expect, it } from "vitest";
import { configFromEnvironment, connectionConfig, typeParsers } from "./connect.ts";

const { INT8, NUMERIC, TEXT } = types.builtins;

/** What the driver connects with, from a config: the role, the host, the port, the database and the password. */
function driverSees(config: ClientConfig): unknown[] {
  const client = new Client(config);
  return [client.user, client.host, client.port, client.database, client.password];
}

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
  it("passes the address on with the type parsers, and without a password when none is given", () => {
    expect(connectionConfig("postgresql://nortfox_app@db/nortfox")).toEqual({
      connectionString: "postgresql://nortfox_app@db/nortfox",
      types: typeParsers,
    });
    expect(driverSees(connectionConfig("postgresql://nortfox_app@db/nortfox"))).toEqual(["nortfox_app", "db", 5432, "nortfox", null]);
  });

  it("gives the driver the password, which the address's own empty password never takes the place of", () => {
    const config = connectionConfig("postgres://nortfox_app@db:5433/nortfox", "secret");
    expect(config.types).toBe(typeParsers);
    expect(driverSees(config)).toEqual(["nortfox_app", "db", 5433, "nortfox", "secret"]);
  });

  it.each([["s%41cr:t@/é ?#&="], ["%"], [" leading and trailing "], ["back\\slash"]])("gives the driver the password %j exactly", (password) => {
    expect(driverSees(connectionConfig("postgres://nortfox_owner@postgres:5432/nortfox", password))).toEqual([
      "nortfox_owner",
      "postgres",
      5432,
      "nortfox",
      password,
    ]);
  });

  it("refuses a password for an address without a host, which could not carry it", () => {
    expect(() => connectionConfig("postgres:///nortfox", "secret")).toThrow(
      "The database address has no host, so the driver would get no password. Write it as postgres://user@host:port/database.",
    );
  });

  it("refuses an address with a password in it", () => {
    expect(() => connectionConfig("postgres://nortfox_app:secret@db/nortfox")).toThrow(
      "The database address holds a password. Put the password in the file that NORTFOX_DATABASE_PASSWORD_FILE names.",
    );
  });

  it.each([["postgres://nortfox_app@db/nortfox?password=in-the-address"], ["postgres://nortfox_app@db/nortfox?sslmode=disable&pass%77ord=x"]])(
    "refuses %s, whose password the driver would take over the given one",
    (url) => {
      const message = "The database address holds a password. Put the password in the file that NORTFOX_DATABASE_PASSWORD_FILE names.";
      expect(() => connectionConfig(url)).toThrow(message);
      expect(() => connectionConfig(url, "from-the-file")).toThrow(message);
    },
  );

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
    const config = configFromEnvironment({ NORTFOX_DATABASE_URL: url, NORTFOX_DATABASE_PASSWORD_FILE: "/run/secrets/db" }, readFile);
    expect(config.types).toBe(typeParsers);
    expect(driverSees(config)).toEqual(["nortfox_owner", "db", 5432, "nortfox", "secret"]);
    expect(driverSees(configFromEnvironment({ NORTFOX_DATABASE_URL: url, NORTFOX_DATABASE_PASSWORD_FILE: "/run/secrets/crlf" }, readFile))).toEqual([
      "nortfox_owner",
      "db",
      5432,
      "nortfox",
      "secret",
    ]);
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
    [
      { NORTFOX_DATABASE_URL: "postgres://nortfox_owner@db/nortfox?password=in-the-address", NORTFOX_DATABASE_PASSWORD_FILE: "/run/secrets/db" },
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
