// SPDX-License-Identifier: AGPL-3.0-only

// The invitations of the transaction's company, as the user administration
// makes them (issue 12, "Users in a company" 1 and 2): an invited member,
// "Lägg till användare", and an invitation of a member with its link, also
// "Skicka en ny inbjudan" and the new invitation of a disconnect. Row level
// security keeps every statement to the transaction's company. The database
// stamps who sent an invitation, when, and its end 14 days later, and a new
// invitation of a member stops the member's open one with its link. The link
// is a secret: the database keeps its hash only, and the token goes in the
// mail alone. Only this module names the memberships' table and the people
// of a company (scripts/guards/membership.ts).

import { newToken, tokenHash } from "../../auth/tokens.ts";
import type { Queryable } from "../../db/database.ts";

/** Whom an invitation goes to: the name and the e-mail address. */
export interface InvitationTo {
  readonly name: string;
  readonly email: string;
}

/** Adds an invited member to the company, with no person: the membership's id. */
export async function addInvitedMember(tx: Queryable, companyId: string): Promise<string> {
  const made = await tx.query<{ id: string }>("INSERT INTO access.memberships (company_id, status) VALUES ($1, 'invited') RETURNING id", [companyId]);
  // An insert gives its one row.
  return (made.rows as [{ readonly id: string }])[0].id;
}

/**
 * Whether a member of the company has the e-mail address, in any letter
 * case, as the identities' unique index folds it: an active or inactive
 * member's identity or work e-mail, or an invited member's open invitation.
 */
export async function addressInCompany(tx: Queryable, email: string): Promise<boolean> {
  const live = await tx.query<{ user_id: string }>("SELECT user_id FROM access.memberships WHERE status IN ('active', 'inactive')");
  const found = await tx.query(
    `SELECT 1 FROM access.company_people($1) AS p WHERE access.identifier_form(p.email) = access.identifier_form($2)
     UNION ALL
     SELECT 1 FROM access.membership_contacts AS c JOIN access.memberships AS m ON m.company_id = c.contact_company_id AND m.id = c.membership_id
     WHERE m.status IN ('active', 'inactive') AND access.identifier_form(c.work_email) = access.identifier_form($2)
     UNION ALL
     SELECT 1 FROM access.invitations AS i JOIN access.memberships AS m ON m.company_id = i.company_id AND m.id = i.membership_id
     WHERE m.status = 'invited' AND i.accepted_at IS NULL AND i.superseded_at IS NULL AND access.identifier_form(i.email) = access.identifier_form($2)
     LIMIT 1`,
    [live.rows.map((row) => row.user_id), email],
  );
  return found.rows.length > 0;
}

/** The name and the address of a member's latest invitation, or undefined when the member has none. */
export async function latestInvitation(tx: Queryable, membershipId: string): Promise<InvitationTo | undefined> {
  const found = await tx.query<InvitationTo>("SELECT name, email FROM access.invitations WHERE membership_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [membershipId]);
  return found.rows[0];
}

/** An invitation's link, as its mail gives it: the token, and the company's and the sender's names. */
export interface IssuedLink {
  readonly token: string;
  readonly companyName: string;
  readonly inviterName: string;
}

/**
 * Invites a held invited member of the company: a new invitation to `to`,
 * which stops the member's open one with its link, and the new
 * invitation's link, made at `at`. Gives the link's token, which only the
 * mail holds, and the company's and the sender's names as they are now:
 * the sender is the transaction's person, whose own identity the app reads.
 */
export async function addInvitation(tx: Queryable, companyId: string, membershipId: string, to: InvitationTo, at: Date): Promise<IssuedLink> {
  const made = await tx.query<{ id: string }>("INSERT INTO access.invitations (company_id, membership_id, name, email) VALUES ($1, $2, $3, $4) RETURNING id", [
    companyId,
    membershipId,
    to.name,
    to.email,
  ]);
  // An insert gives its one row; the transaction's company is one row; and the person reads their own identity.
  const [invitation] = made.rows as [{ readonly id: string }];
  const [company] = (await tx.query<{ name: string }>("SELECT name FROM ledger.companies")).rows as [{ readonly name: string }];
  const [inviter] = (await tx.query<{ name: string }>("SELECT name FROM access.identities WHERE id = access.current_person_id()")).rows as [{ readonly name: string }];
  const token = newToken("invitation");
  const issued = await tx.query<{ made: boolean }>("SELECT access.issue_invitation_link($1, $2, $3, $4, $5) AS made", [tokenHash(token), invitation.id, company.name, inviter.name, at]);
  // A SELECT of one function call gives one row, and the invitation was just made open.
  if (!(issued.rows as [{ readonly made: boolean }])[0].made) {
    throw new Error("The database made no link of the invitation that the request just made.");
  }
  return { token, companyName: company.name, inviterName: inviter.name };
}
