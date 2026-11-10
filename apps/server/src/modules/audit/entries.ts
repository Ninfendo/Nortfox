// SPDX-License-Identifier: AGPL-3.0-only

// The behandlingshistorik entries of acts that change no company row (issue
// 12, Behandlingshistorik 1 and 2; plan 2.10). Each is one row of
// access.events in the company, and that row's history row is the entry.
// Its program and heading are stable codes, which ENTRY_WORDS gives the
// screen's words; its details are an object of facts in camelCase.
//
// - A sign-in: Program "Användare" (users), Rubrik "Inloggning" (sign-in),
//   written in the company that the web app chooses, at each choice, by the
//   person (selectCompany). Its details: the method, the second step, the
//   time of the identification (when the session began, once the sign-in's
//   last step passed), the personnummer when the method gives one, the
//   application (web, "Webb"), the IP address and the outcome. The method
//   and the time share the line Identifiering, as the established entry
//   shows them: "Identifiering: <method>, <date and time>". So an entry
//   of a switch of company is told from one of a new sign-in.
// - A failed sign-in: the same, with the outcome failed, in each company
//   where the tried identity is an active member, by that identity (choice
//   7), after the answer. At most one entry per identity, company and minute
//   (choice 22), with the count of the identity's failed sign-ins in the
//   last hour, from its Kontoaktivitet, which gets each one. A failure for
//   an identifier that names no identity is written nowhere: its caller
//   knows of no identity.

import type { RequestFacts } from "../../api/operation.ts";
import type { SecondStep, SignInMethod } from "../../api/context.ts";
import { commit, type Channel, type Database, type Queryable } from "../../db/database.ts";
import { activeMemberships, resolveActive } from "../memberships/resolve.ts";

/**
 * The screen's words of the entries' codes. "Inloggning via NortFox ID"
 * heads a sign-in's Händelse, and each fact has the line of its label: the
 * method and the time of the identification share the line Identifiering,
 * the method first.
 */
export const ENTRY_WORDS = {
  programs: { users: "Användare" },
  headings: { "sign-in": "Inloggning", "api-token-created": "API-token skapad", "api-token-revoked": "API-token återkallad" },
  events: { "sign-in": "Inloggning via NortFox ID" },
  details: { method: "Identifiering", identifiedAt: "Identifiering", personalIdentityNumber: "Personnummer", application: "Applikation", ipAddress: "IP-adress" },
  applications: { web: "Webb" },
} as const;

/** The facts of an entry. */
export type EntryDetails = Readonly<Record<string, string | number>>;

/** One entry of the behandlingshistorik in the transaction's company. */
export interface AuditEntry {
  readonly program: keyof (typeof ENTRY_WORDS)["programs"];
  readonly heading: keyof (typeof ENTRY_WORDS)["headings"];
  /** The person the entry is about. */
  readonly subjectId: string;
  readonly details: EntryDetails;
  /** When it happened, by the server's clock. */
  readonly at: Date;
}

/** Adds an entry to the behandlingshistorik of the transaction's company. */
export async function addEntry(tx: Queryable, entry: AuditEntry): Promise<void> {
  await tx.query("INSERT INTO access.events (company_id, program, heading, subject_id, details, at) VALUES (ledger.current_company_id(), $1, $2, $3, $4, $5)", [
    entry.program,
    entry.heading,
    entry.subjectId,
    entry.details,
    entry.at,
  ]);
}

/** What a sign-in's entry tells: how the person signed in, and from where. */
export interface SignIn {
  readonly method: SignInMethod;
  readonly secondStep?: SecondStep | undefined;
  /** When the person identified, for a sign-in that succeeded. */
  readonly identifiedAt?: Date | undefined;
  /** The personnummer, for a method that gives one. */
  readonly personalIdentityNumber?: string | undefined;
  readonly request: RequestFacts;
  readonly outcome: "succeeded" | "failed";
}

/** The details of a sign-in's entry, through /v1, the web app's surface. */
export function signInEntryDetails(signIn: SignIn): EntryDetails {
  return {
    method: signIn.method,
    ...(signIn.secondStep === undefined ? {} : { secondStep: signIn.secondStep }),
    ...(signIn.identifiedAt === undefined ? {} : { identifiedAt: signIn.identifiedAt.toISOString() }),
    ...(signIn.personalIdentityNumber === undefined ? {} : { personalIdentityNumber: signIn.personalIdentityNumber }),
    application: "web",
    ...(signIn.request.ipAddress === undefined ? {} : { ipAddress: signIn.request.ipAddress }),
    outcome: signIn.outcome,
  };
}

/** A failed sign-in's entries come at most once a minute per identity and company. */
export const FAILED_ENTRY_EVERY_MS = 60 * 1000;

/**
 * Writes a failed sign-in of `identityId` in the behandlingshistorik of each
 * company where it is an active member, each in a transaction of its own as
 * that identity, entered from the one membership function. A company that
 * has an entry of the identity's failed sign-in from the last minute gets
 * none. The count of the last hour comes from the identity's Kontoaktivitet,
 * which holds each failed sign-in, this one too.
 */
export async function addFailedSignInEntries(database: Database, channel: Channel, identityId: string, details: EntryDetails, at: Date): Promise<void> {
  const person = { actorId: identityId, actorKind: "user", channel } as const;
  const { companies, failures } = await database.person("read", person, async (tx) => {
    const counted = await tx.query<{ failures: string }>(
      `SELECT count(*) AS failures FROM access.account_events
       WHERE identity_id = $1 AND kind = 'sign-in' AND details ->> 'outcome' = 'failed' AND at > pg_catalog.clock_timestamp() - interval '1 hour'`,
      [identityId],
    );
    // A count gives one row.
    return commit({ companies: (await activeMemberships(tx)).map((membership) => membership.companyId), failures: Number((counted.rows as [{ readonly failures: string }])[0].failures) });
  });
  for (const companyId of companies) {
    await database.person("write", person, async (tx) => {
      const membership = await resolveActive(tx, companyId);
      // The person may have left the company since the list was read.
      if (membership === undefined) {
        return commit(undefined);
      }
      await tx.enter(membership);
      const recent = await tx.query(
        "SELECT 1 FROM access.events WHERE subject_id = $1 AND program = 'users' AND heading = 'sign-in' AND details ->> 'outcome' = 'failed' AND at > $2 LIMIT 1",
        [identityId, new Date(at.getTime() - FAILED_ENTRY_EVERY_MS)],
      );
      if (recent.rows.length === 0) {
        await addEntry(tx, { program: "users", heading: "sign-in", subjectId: identityId, details: { ...details, failuresInLastHour: failures }, at });
      }
      return commit(undefined);
    });
  }
}
