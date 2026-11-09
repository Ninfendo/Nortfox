// SPDX-License-Identifier: AGPL-3.0-only

// The signed-in person's own identity (access.identities), read in the
// person's transaction: the person policy shows the app that one row. The
// resolver gives a principal only for an active identity, so a person
// without their row is a fault of the server.

import type { Me, User } from "@nortfox/contract";
import type { Queryable } from "../../db/database.ts";

interface IdentityRow {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly language: User["language"];
  readonly personal_identity_number: string | null;
  readonly mobile: string | null;
  readonly two_step: Me["twoStep"];
}

/** The person's own part of getMe: the identity, all of it that the person may read. */
export type MyIdentity = Pick<Me, "user" | "personalIdentityNumber" | "mobile" | "twoStep">;

/** The signed-in person's identity, all of it that the person may read. */
export async function readMe(tx: Queryable, personId: string): Promise<MyIdentity> {
  const found = await tx.query<IdentityRow>(
    "SELECT id, name, email, language, personal_identity_number, mobile, two_step FROM access.identities WHERE id = $1",
    [personId],
  );
  const [row] = found.rows;
  if (row === undefined) {
    throw new Error("The signed-in person's identity is not in access.identities.");
  }
  return {
    user: { id: row.id, name: row.name, email: row.email, language: row.language },
    ...(row.personal_identity_number === null ? {} : { personalIdentityNumber: row.personal_identity_number }),
    ...(row.mobile === null ? {} : { mobile: row.mobile }),
    twoStep: row.two_step,
  };
}
