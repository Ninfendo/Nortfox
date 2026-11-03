// SPDX-License-Identifier: AGPL-3.0-only

// The one place that says how NortFox connects to PostgreSQL.
//
// - A bigint (int8) reads as a JavaScript bigint, never as a number: amounts
//   are whole öre in bigint columns (docs/decisions/0005-money.md). A numeric
//   stays the string the driver gives.
// - The address carries no password: none before the host, and no password
//   parameter in its query. The password comes from a file, such as a compose
//   secret, so it is in no URL that anyone writes and in no environment
//   variable. The driver reads a connection string's fields over every other
//   field of its config, the password among them, so the password reaches the
//   driver inside the connection string, in memory only. The driver takes a
//   password parameter over the password before the host, so an address with
//   one is refused, as one with a password before the host is.

import { readFileSync } from "node:fs";
import { types, type ClientConfig, type CustomTypesConfig } from "pg";

const parseBigint = (text: string): bigint => BigInt(text);

/** The driver's own parsers, but int8, PostgreSQL's bigint, reads as a bigint. */
export const typeParsers: CustomTypesConfig = {
  getTypeParser: (id, format) => {
    if (id === types.builtins.INT8 && format !== "binary") {
      return parseBigint;
    }
    const parser: unknown = types.getTypeParser(id, format);
    return parser;
  },
};

/** A PostgreSQL address. */
const ADDRESS = /^postgres(?:ql)?:\/\//;

/** The connection to the database at `url`, which holds no password, with the password, if one is given. */
export function connectionConfig(url: string, password?: string): ClientConfig {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The database address is not a URL. Write it as postgres://user@host:port/database.");
  }
  if (!ADDRESS.test(url)) {
    throw new Error("The database address must start with postgres:// or postgresql://.");
  }
  if (parsed.password !== "" || parsed.searchParams.has("password")) {
    throw new Error("The database address holds a password. Put the password in the file that NORTFOX_DATABASE_PASSWORD_FILE names.");
  }
  if (password === undefined) {
    return { connectionString: url, types: typeParsers };
  }
  // The driver decodes the password as a URI component, so it is encoded as one.
  parsed.password = encodeURIComponent(password);
  if (parsed.password === "") {
    throw new Error("The database address has no host, so the driver would get no password. Write it as postgres://user@host:port/database.");
  }
  return { connectionString: parsed.toString(), types: typeParsers };
}

/** The environment, as process.env gives it. */
export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The connection from the environment: NORTFOX_DATABASE_URL, the address
 * without a password, and NORTFOX_DATABASE_PASSWORD_FILE, the file that holds
 * the password. Each one missing, and an empty password, fails loudly.
 */
export function configFromEnvironment(
  env: Environment,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): ClientConfig {
  const url = env["NORTFOX_DATABASE_URL"];
  const passwordFile = env["NORTFOX_DATABASE_PASSWORD_FILE"];
  if (url === undefined || url === "") {
    throw new Error("NORTFOX_DATABASE_URL is not set. Set it to the database address, without a password.");
  }
  if (passwordFile === undefined || passwordFile === "") {
    throw new Error("NORTFOX_DATABASE_PASSWORD_FILE is not set. Set it to the file that holds the database password.");
  }
  let password: string;
  try {
    password = readFile(passwordFile).replace(/\r?\n$/, "");
  } catch {
    throw new Error(`The password file ${passwordFile} cannot be read.`);
  }
  if (password === "") {
    throw new Error(`The password file ${passwordFile} is empty.`);
  }
  return connectionConfig(url, password);
}
