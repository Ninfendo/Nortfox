// SPDX-License-Identifier: AGPL-3.0-only

// The fake mail sink of the tests: a mailer that keeps every mail in memory,
// so a test reads the subject, the text and the link of each one, and never
// reaches a mail server. A test can make its next send fail, as a mail
// server that refuses does, or wait at a gate, as a slow one does. The
// addresses are made up.

import type { InstallMail, MailMessage, Mailer } from "../src/mail/mailer.ts";
import { INVITATION_PAGE } from "../src/mail/texts.ts";
import { gate, type Gate } from "./api.ts";

/** The origin the links of the test mails start with: the sign-in tests' own. */
export const MAIL_ORIGIN = "https://nortfox.example";

/** A link to an invitation's page in a mail's text, with its token. */
const INVITATION_LINK = new RegExp(`${MAIL_ORIGIN.replaceAll(".", "\\.")}${INVITATION_PAGE}(nfi_[A-Za-z0-9_-]{43})`, "g");

export class FakeMailSink implements Mailer {
  /** Every mail sent, in order. */
  readonly messages: MailMessage[] = [];
  #failNext: string | undefined;
  #holdNext: Gate | undefined;

  async send(message: MailMessage): Promise<void> {
    const failure = this.#failNext;
    if (failure !== undefined) {
      this.#failNext = undefined;
      throw new Error(failure);
    }
    const held = this.#holdNext;
    if (held !== undefined) {
      this.#holdNext = undefined;
      await held.pass();
    }
    this.messages.push(message);
  }

  /** Makes the next send fail, with `message`, as a mail server's refusal says it. */
  failNext(message = "The test's mail server refused the mail."): void {
    this.#failNext = message;
  }

  /** Makes the next send wait at a gate, as a slow mail server does, until the test opens it; then it is sent. */
  holdNext(): Gate {
    const held = gate();
    this.#holdNext = held;
    return held;
  }

  /** The mails sent to `to`, in order. */
  to(to: string): MailMessage[] {
    return this.messages.filter((message) => message.to === to);
  }

  /** The last mail sent to `to`, or a throw when none was. */
  lastTo(to: string): MailMessage {
    const last = this.to(to).at(-1);
    if (last === undefined) {
      throw new Error(`No mail went to ${to}.`);
    }
    return last;
  }

  /** The token of the invitation link in the last mail to `to`. */
  invitationTokenTo(to: string): string {
    return invitationTokenIn(this.lastTo(to));
  }
}

/** The token of the one invitation link in a mail. */
export function invitationTokenIn(message: MailMessage): string {
  const found = [...message.text.matchAll(INVITATION_LINK)];
  const [match, ...more] = found;
  if (match?.[1] === undefined || more.length > 0) {
    throw new Error(`The mail holds ${String(found.length)} invitation links, not one.`);
  }
  return match[1];
}

/** The install's mail of a test app: a fake sink, and the tests' origin. */
export function testMail(sink: FakeMailSink = new FakeMailSink()): InstallMail & { readonly mailer: FakeMailSink } {
  return { mailer: sink, publicOrigin: MAIL_ORIGIN };
}
