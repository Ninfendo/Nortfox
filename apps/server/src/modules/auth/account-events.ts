// SPDX-License-Identifier: AGPL-3.0-only

// Kontoaktivitet (access.account_events): the person's own events across
// companies, the 100 latest of which the person can read (a later part). A
// person table: the app adds an event only in a transaction whose actor is
// that person. A failed sign-in's actor is the identity whose identifier was
// tried (choice 7), so its entry is found under that person.
//
// The kinds part 1 writes, each with its details in camelCase:
//
// - sign-in: method (password-email or password-personnummer), secondStep
//   (totp or known-device, when the sign-in got that far), application (web
//   for a sign-in through /v1), ipAddress when the server knows it, and
//   outcome (succeeded or failed). A wrong password and a wrong TOTP code
//   are each a failed sign-in.
// - sign-in-locked: step (password or totp) and until, when the step opens
//   again. The first lock of a window writes it once.
// - logout.
//
// The entries of a failure are written after the answer (after-answer.ts),
// so the time of the answer tells nothing of whether the identifier named an
// identity. A crash between the two loses the entry, which records a failure,
// not a change.

import type { Later, RequestFacts } from "../../api/operation.ts";
import type { SignInMethod } from "../../api/context.ts";
import { commit, type Channel, type Database, type Queryable } from "../../db/database.ts";

export type AccountEventKind = "sign-in" | "sign-in-locked" | "logout";

export type AccountEventDetails = Readonly<Record<string, string>>;

/** One event of a person's Kontoaktivitet. */
export interface AccountEvent {
  readonly kind: AccountEventKind;
  readonly details: AccountEventDetails;
}

/** Adds an event to the Kontoaktivitet of the transaction's person. */
export async function addAccountEvent(tx: Queryable, identityId: string, event: AccountEvent): Promise<void> {
  await tx.query("INSERT INTO access.account_events (identity_id, kind, details) VALUES ($1, $2, $3)", [identityId, event.kind, event.details]);
}

/** The details of a sign-in, or of a failed one, through /v1. */
export function signInDetails(method: SignInMethod, secondStep: "totp" | "known-device" | undefined, request: RequestFacts, outcome: "succeeded" | "failed"): AccountEventDetails {
  return {
    method,
    ...(secondStep === undefined ? {} : { secondStep }),
    application: "web",
    ...(request.ipAddress === undefined ? {} : { ipAddress: request.ipAddress }),
    outcome,
  };
}

/** The transaction of a person's own rows: the person as the actor, a user, in no company. */
export function asPerson(identityId: string, channel: Channel): { readonly actorId: string; readonly actorKind: "user"; readonly channel: Channel } {
  return { actorId: identityId, actorKind: "user", channel };
}

/** Writes events to a person's Kontoaktivitet after the answer, in a transaction of their own as that person. */
export function addAfterAnswer(later: Later, database: Database, channel: Channel, identityId: string, events: readonly AccountEvent[]): void {
  later(() =>
    database.write(asPerson(identityId, channel), async (tx) => {
      for (const event of events) {
        await addAccountEvent(tx, identityId, event);
      }
      return commit(undefined);
    }),
  );
}
