// SPDX-License-Identifier: AGPL-3.0-only

// The subject of a mail reads as it is written, in every mail program. A
// mail program decodes an RFC 2047 encoded-word, =?charset?B?...?=, in a
// subject (RFC 2047, section 5), so a company's name that is written as one
// would show a character that the name's own checks refuse: a line break or
// a control of the text's direction. The mailer encodes such a subject
// itself, so the subject that a mail program shows is the subject that the
// server wrote. Each mail goes through nodemailer's stream transport, which
// reaches no mail server, and its Subject header is read as a mail program
// reads it.

import { NOT_IN_A_NAME } from "@nortfox/contract";
import fc from "fast-check";
import nodemailer from "nodemailer";
import { describe, expect, it } from "vitest";
import { MAIL_ORIGIN } from "../../test/mail.ts";
import { SmtpMailer } from "./smtp.ts";
import { invitationLink, invitationMail } from "./texts.ts";

/** One encoded-word of RFC 2047, in UTF-8, as B or Q. */
const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

/** The text of an encoded-word's payload. */
function decodedWord(encoding: string, payload: string): string {
  if (encoding.toUpperCase() === "B") {
    return Buffer.from(payload, "base64").toString("utf8");
  }
  const bytes = payload.replaceAll("_", " ").replace(/=([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return Buffer.from(bytes, "latin1").toString("utf8");
}

/**
 * A header's text as a mail program shows it: unfolded, with each
 * encoded-word decoded, and the white space between two adjacent ones left
 * out (RFC 2047, section 6.2). The decoded text is not read again.
 */
function shownHeader(value: string): string {
  const unfolded = value.replace(/\r?\n[ \t]/g, " ");
  const parts: string[] = [];
  let last = 0;
  let afterWord = false;
  for (const match of unfolded.matchAll(ENCODED_WORD)) {
    const between = unfolded.slice(last, match.index);
    if (!(afterWord && /^[ \t]*$/.test(between))) {
      parts.push(between);
    }
    parts.push(decodedWord(match[2] ?? "", match[3] ?? ""));
    last = match.index + match[0].length;
    afterWord = true;
  }
  parts.push(unfolded.slice(last));
  return parts.join("");
}

/** The raw Subject header of a message as it goes out: its value, folded as it is. */
function rawSubject(message: string): string {
  const [head = ""] = message.split("\r\n\r\n");
  const found = /^Subject: (.*(?:\r\n[ \t].*)*)/m.exec(head);
  if (found?.[1] === undefined) {
    throw new Error("The message has no Subject.");
  }
  return found[1];
}

/** A mailer over nodemailer's stream transport, and the raw messages it made. */
function streamMailer(): { readonly mailer: SmtpMailer; readonly sent: string[] } {
  const sent: string[] = [];
  const stream = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const mailer = new SmtpMailer(
    {
      sendMail: async (mail) => {
        const info = await stream.sendMail(mail);
        sent.push(Buffer.from(info.message as Buffer).toString("utf8"));
        return info;
      },
    },
    { name: "NortFox", address: "nortfox@mail.example" },
  );
  return { mailer, sent };
}

/** The subject that a mail program shows of a mail with `subject`. */
async function shownSubject(subject: string): Promise<string> {
  const { mailer, sent } = streamMailer();
  await mailer.send({ to: "karin.lund@example.com", subject, text: "t" });
  return shownHeader(rawSubject(sent[0] ?? ""));
}

describe("a mail's subject", () => {
  it("reads as it is written, also when it holds the form of an encoded-word", async () => {
    for (const subject of [
      "Inbjudan till Testbolaget Alfa AB i NortFox",
      "Inbjudan till Bolag =?UTF-8?B?4oCu?= lpmaxe.live AB i NortFox",
      "Inbjudan till =?UTF-8?B?VGVzdGJvbGFnZXQgQULigK4NCkFjY2VwdGVyYSBpbmJqdWRhbjogaHR0cHM6Ly9ldmlsLmV4YW1wbGUv?= i NortFox",
      "Inbjudan till =?utf-8?q?Bolag=E2=80=AE?= AB i NortFox",
      "Inbjudan till =?UTF-8?B?4oCu?==?UTF-8?B?DQo=?= i NortFox",
      "Inbjudan till \u{00C5}sa =?UTF-8?B?4oCu?= AB i NortFox",
      "Inbjudan till Bolag =? AB ?= i NortFox",
    ]) {
      expect(await shownSubject(subject)).toBe(subject);
    }
  });

  it("of an invitation shows the company's name as it is written, and no character that a name never holds", async () => {
    const companyName = "Bolag =?UTF-8?B?DQpBY2NlcHRlcmEgaW5ianVkYW46IGh0dHBzOi8vZXZpbC5leGFtcGxlL3g=?= AB";
    const mail = invitationMail({ to: "karin.lund@example.com", name: "Karin Lund", companyName, inviterName: "Alva Berg", link: invitationLink(MAIL_ORIGIN, `nfi_${"Q".repeat(43)}`) });
    const shown = await shownSubject(mail.subject);
    expect(shown).toBe(`Inbjudan till ${companyName} i NortFox`);
    expect(NOT_IN_A_NAME.test(shown)).toBe(false);
  });

  it("reads as it is written for any text of ASCII and encoded-words", async () => {
    const piece = fc.oneof(
      fc.constantFrom("=?", "?=", "=?UTF-8?B?", "=?utf-8?Q?", "4oCu", "DQo=", "=E2=80=AE", " ", "  ", "AB", "Bolag", "?", "=", "_", "\u{00C5}", "\u{2603}"),
      fc.string({ minLength: 1, maxLength: 4 }).filter((text) => !NOT_IN_A_NAME.test(text)),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(piece, { minLength: 1, maxLength: 12 }), async (pieces) => {
        const subject = `Inbjudan till ${pieces.join("")} i NortFox`;
        expect(await shownSubject(subject)).toBe(subject);
      }),
      { numRuns: 300 },
    );
  });
});
