// SPDX-License-Identifier: AGPL-3.0-only

// How the server sends mail (open point 11): through the install's SMTP
// server (smtp.ts), in Swedish texts of its own (texts.ts). An install
// without the mail settings has no mailer, and the operations that send a
// mail then refuse, with 422 mail-not-configured, before they change
// anything: the setting is the install's, so the answer tells nothing about
// anyone. The tests send to a fake sink in memory, and never reach a mail
// server.

import type { RuleRefusal } from "../api/operation.ts";

/** One mail: to one address, with a subject and a plain text. */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/** What sends a mail. A send that fails throws, and the request that sent it changes nothing. */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/**
 * The install's mail: the mailer, and the origin people open NortFox at,
 * which the links in a mail start with.
 */
export interface InstallMail {
  readonly mailer: Mailer;
  readonly publicOrigin: string;
}

/** The refusal of an operation that sends a mail, on an install with no mail set up. */
export const MAIL_NOT_CONFIGURED: RuleRefusal = {
  code: "mail-not-configured",
  detail: "The install has no mail set up, so no invitation can be sent. Its operator sets the mail settings (deploy/README.md).",
};
