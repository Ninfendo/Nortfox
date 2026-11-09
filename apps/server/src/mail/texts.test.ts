// SPDX-License-Identifier: AGPL-3.0-only

// The texts of the mails, in Swedish with the issue's words (plan 2.15):
// the invitation's subject names the company, its text names the person,
// the company and the sender, says that the link works for 14 days and
// once, and names the two choices of the page it opens; its link text is
// "Acceptera inbjudan", with the link on its own line after it. Each is
// read back from the fake mail sink, as the tests of the operations read
// it. The reset mail and the e-mail code's mail come with their operations
// in part 6.

import { describe, expect, it } from "vitest";
import { FakeMailSink, MAIL_ORIGIN, invitationTokenIn } from "../../test/mail.ts";
import { ACCEPT_INVITATION, INVITATION_PAGE, invitationLink, invitationMail } from "./texts.ts";

const TOKEN = `nfi_${"Q".repeat(43)}`;

describe("the invitation's mail", () => {
  it("has its subject, its words and its link text, as the fake sink holds it", async () => {
    const sink = new FakeMailSink();
    await sink.send(
      invitationMail({
        to: "karin.lund@example.com",
        name: "Karin Lund",
        companyName: "Testbolaget Alfa AB",
        inviterName: "Alva Berg",
        link: invitationLink(MAIL_ORIGIN, TOKEN),
      }),
    );
    const mail = sink.lastTo("karin.lund@example.com");
    expect(mail.subject).toBe("Inbjudan till Testbolaget Alfa AB i NortFox");
    expect(mail.text.split("\n")).toEqual([
      "Hej Karin Lund!",
      "",
      "Alva Berg har bjudit in dig som användare i Testbolaget Alfa AB i NortFox.",
      "",
      "Acceptera inbjudan:",
      `https://nortfox.example/invitations/${TOKEN}`,
      "",
      "Inbjudan gäller i 14 dagar, och länken fungerar en gång. På sidan som öppnas väljer du Skapa ett nytt NortFox ID eller Koppla ihop med befintligt NortFox ID.",
      "",
      "Väntade du dig inte den här inbjudan kan du bortse från den.",
    ]);
    expect(ACCEPT_INVITATION).toBe("Acceptera inbjudan");
    expect(invitationTokenIn(mail)).toBe(TOKEN);
  });

  it("puts each name on one line, so no name adds a line to the mail or turns its text around", () => {
    // The API refuses such a name (packages/contract/src/text.ts); the text holds even so.
    const mail = invitationMail({
      to: "karin.lund@example.com",
      name: "Karin\r\n\r\nAcceptera inbjudan:\nhttps://evil.example/x",
      companyName: "Testbolaget\u2028Alfa\u0085AB",
      inviterName: "Alva\u202E Berg\t",
      link: invitationLink(MAIL_ORIGIN, TOKEN),
    });
    expect(mail.subject).toBe("Inbjudan till Testbolaget Alfa AB i NortFox");
    const lines = mail.text.split("\n");
    expect(lines).toHaveLength(10);
    expect(lines.slice(0, 6)).toEqual([
      "Hej Karin    Acceptera inbjudan: https://evil.example/x!",
      "",
      "Alva  Berg  har bjudit in dig som användare i Testbolaget Alfa AB i NortFox.",
      "",
      "Acceptera inbjudan:",
      `https://nortfox.example/invitations/${TOKEN}`,
    ]);
    expect(mail.text).not.toMatch(/[\r\u2028\u2029\u0085\u202E\t]/u);
  });

  it("links the web app's page of the invitation, on the install's own origin", () => {
    expect(INVITATION_PAGE).toBe("/invitations/");
    expect(invitationLink("https://bokforing.example", TOKEN)).toBe(`https://bokforing.example/invitations/${TOKEN}`);
  });
});

describe("the fake mail sink", () => {
  it("keeps each mail, gives the last one to an address, and fails its next send when asked", async () => {
    const sink = new FakeMailSink();
    expect(() => sink.lastTo("karin.lund@example.com")).toThrow("No mail went to karin.lund@example.com.");
    sink.failNext();
    await expect(sink.send({ to: "karin.lund@example.com", subject: "s", text: "t" })).rejects.toThrow("The test's mail server refused the mail.");
    await sink.send({ to: "karin.lund@example.com", subject: "s", text: "no link" });
    expect(sink.messages).toHaveLength(1);
    expect(() => sink.invitationTokenTo("karin.lund@example.com")).toThrow("The mail holds 0 invitation links, not one.");
  });
});
