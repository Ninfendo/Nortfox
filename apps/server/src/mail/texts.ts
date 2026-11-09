// SPDX-License-Identifier: AGPL-3.0-only

// The texts of the mails the server sends, in Swedish, until slice 2d
// brings packages/i18n. They use the issue's words: the invitation names the
// company and its sender, says that its link works for 14 days and once, and
// its link is "Acceptera inbjudan". The page it opens (slice 2d) offers
// "Skapa ett nytt NortFox ID" and "Koppla ihop med befintligt NortFox ID".
// A mail is plain text, so each link stands on a line of its own after its
// words.

import type { MailMessage } from "./mailer.ts";

/** The path of the web app's page of an invitation, which slice 2d serves: the link's token after it. */
export const INVITATION_PAGE = "/invitations/";

/** The link text of an invitation. */
export const ACCEPT_INVITATION = "Acceptera inbjudan";

/** What an invitation's mail says. */
export interface InvitationMail {
  /** Where it goes: the invitation's address. */
  readonly to: string;
  /** The name the invitation was sent to. */
  readonly name: string;
  readonly companyName: string;
  /** The name of the system administrator who sent it. */
  readonly inviterName: string;
  /** The link: the page of the invitation on the install's own origin. */
  readonly link: string;
}

/** The link of an invitation's page, on the install's own origin. */
export function invitationLink(publicOrigin: string, token: string): string {
  return `${publicOrigin}${INVITATION_PAGE}${token}`;
}

/** The mail of an invitation. */
export function invitationMail(mail: InvitationMail): MailMessage {
  return {
    to: mail.to,
    subject: `Inbjudan till ${mail.companyName} i NortFox`,
    text: [
      `Hej ${mail.name}!`,
      "",
      `${mail.inviterName} har bjudit in dig som användare i ${mail.companyName} i NortFox.`,
      "",
      `${ACCEPT_INVITATION}:`,
      mail.link,
      "",
      "Inbjudan gäller i 14 dagar, och länken fungerar en gång. På sidan som öppnas väljer du Skapa ett nytt NortFox ID eller Koppla ihop med befintligt NortFox ID.",
      "",
      "Väntade du dig inte den här inbjudan kan du bortse från den.",
    ].join("\n"),
  };
}
