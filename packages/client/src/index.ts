// SPDX-License-Identifier: MIT

import { createOperations, type Operations } from "./generated.ts";
import { createSend, type ClientOptions } from "./runtime.ts";

export type {
  Company,
  CompanyChoice,
  FieldProblem,
  Health,
  Me,
  Member,
  Membership,
  PasswordSignIn,
  Permission,
  PermissionCatalogue,
  PermissionGroup,
  Problem,
  ProgramAdmin,
  ProgramDefinition,
  ProgramGrant,
  RecentCompanies,
  RoleDefinition,
  Session,
  SetupResult,
  TotpEnrolment,
  User,
  UserRights,
  Operations
} from "./generated.ts";
export type { PermissionGroupKey, PermissionKey, Program, Role, SysAdmin } from "./generated.ts";
export { ApiError } from "./runtime.ts";
export type { CallOptions, ClientOptions, FetchFunction, WriteOptions } from "./runtime.ts";

/** A client for the NortFox API: one method per operation. */
export function createClient(options: ClientOptions): Operations {
  return createOperations(createSend(options));
}
