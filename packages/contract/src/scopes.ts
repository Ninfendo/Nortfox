// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The scopes of an API token and of an MCP client's consent (issue 12,
 * "Scopes"; open point 14). Each operation that a token may call names one
 * in the registry, beside its permission, and a token whose scopes lack it
 * is refused with 403 scope-missing. What a token may do is its scopes
 * intersected with its person's current permissions in its company. A
 * browser session is not limited by scopes. Each scope reads and writes.
 *
 * The list holds the established API's names that the plan's modules use,
 * also those that no operation names yet, since slice 2e takes them in its
 * login flow, and NortFox's own scope of each module that the established
 * API has none for: companies, users and tokens. A name is case-sensitive,
 * and is small letters a to z alone, the form that access.api_tokens takes.
 */
export const SCOPES = [
  "companyinformation",
  "profile",
  "companies",
  "users",
  "tokens",
  "bookkeeping",
  "settings",
  "costcenter",
  "project",
  "currency",
  "supplier",
  "supplierinvoice",
  "payment",
  "connectfile",
  "inbox",
  "archive",
  "deletevoucher",
] as const;

export type Scope = (typeof SCOPES)[number];
