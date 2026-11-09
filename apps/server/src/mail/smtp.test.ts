// SPDX-License-Identifier: AGPL-3.0-only

// The install's SMTP mail (open point 11): its three settings, each refused
// when it is wrong, with a message that never holds the password; the
// options of nodemailer's SMTP transport that they give; and the mailer,
// which sends through nodemailer's JSON transport here, so no test reaches a
// mail server.

import nodemailer from "nodemailer";
import { describe, expect, it } from "vitest";
import { SmtpMailer, smtpMailer, smtpSettingsOf, smtpTransportOptions } from "./smtp.ts";

/** A password that a message must never hold. */
const PASSWORD = "hemligt-smtp-lösen";

/** A reader of files that knows one: the password's file. */
function files(content = `${PASSWORD}\n`): (path: string) => string {
  return (path) => {
    if (path !== "/run/secrets/smtp-password") {
      throw new Error(`no such file ${path}`);
    }
    return content;
  };
}

const ALL = {
  NORTFOX_SMTP_URL: "smtp://nortfox@mail.example:2525",
  NORTFOX_SMTP_PASSWORD_FILE: "/run/secrets/smtp-password",
  NORTFOX_MAIL_FROM: "NortFox <nortfox@mail.example>",
};

/** The error of the settings, after checking it never names the password. */
function refusal(env: Readonly<Record<string, string>>, read = files()): string {
  try {
    smtpSettingsOf(env, read);
  } catch (error) {
    const message = (error as Error).message;
    expect(message).not.toContain(PASSWORD);
    return message;
  }
  throw new Error("The settings were taken.");
}

describe("the SMTP settings", () => {
  it("are none when no mail setting is set, or each is empty", () => {
    expect(smtpSettingsOf({}, files())).toBeUndefined();
    expect(smtpSettingsOf({ NORTFOX_SMTP_URL: "", NORTFOX_SMTP_PASSWORD_FILE: "", NORTFOX_MAIL_FROM: "" }, files())).toBeUndefined();
  });

  it("take the server, the user, the password from its file and the sender", () => {
    expect(smtpSettingsOf(ALL, files())).toEqual({
      protocol: "smtp:",
      host: "mail.example",
      port: 2525,
      user: "nortfox",
      password: PASSWORD,
      from: "NortFox <nortfox@mail.example>",
    });
    expect(smtpSettingsOf({ ...ALL, NORTFOX_SMTP_PASSWORD_FILE: "/run/secrets/smtp-password" }, files(`${PASSWORD}\r\n`))?.password).toBe(PASSWORD);
    expect(smtpSettingsOf({ ...ALL, NORTFOX_SMTP_PASSWORD_FILE: "/run/secrets/smtp-password" }, files(PASSWORD))?.password).toBe(PASSWORD);
  });

  it("take the default port of each protocol, a user name with an escape, and no user", () => {
    expect(smtpSettingsOf({ NORTFOX_SMTP_URL: "smtp://mail.example", NORTFOX_MAIL_FROM: "nortfox@mail.example" }, files())).toEqual({
      protocol: "smtp:",
      host: "mail.example",
      port: 587,
      from: "nortfox@mail.example",
    });
    expect(
      smtpSettingsOf({ NORTFOX_SMTP_URL: "smtps://n%40x@mail.example/", NORTFOX_SMTP_PASSWORD_FILE: "/run/secrets/smtp-password", NORTFOX_MAIL_FROM: "nortfox@mail.example" }, files()),
    ).toEqual({
      protocol: "smtps:",
      host: "mail.example",
      port: 465,
      user: "n@x",
      password: PASSWORD,
      from: "nortfox@mail.example",
    });
  });

  it.each([
    ["no URL beside another setting", { NORTFOX_MAIL_FROM: "nortfox@mail.example" }, "NORTFOX_SMTP_URL is not set, but another mail setting is."],
    ["no URL beside the password's file", { NORTFOX_SMTP_PASSWORD_FILE: "/run/secrets/smtp-password" }, "NORTFOX_SMTP_URL is not set, but another mail setting is."],
    ["no sender", { NORTFOX_SMTP_URL: "smtp://mail.example" }, "NORTFOX_MAIL_FROM is not set."],
    ["a sender that is no address", { ...ALL, NORTFOX_MAIL_FROM: "NortFox" }, "NORTFOX_MAIL_FROM must be an e-mail address"],
    ["a sender with a name and no brackets", { ...ALL, NORTFOX_MAIL_FROM: "NortFox nortfox@mail.example" }, "NORTFOX_MAIL_FROM must be an e-mail address"],
    ["a URL that is no URL", { ...ALL, NORTFOX_SMTP_URL: "mail.example:587" }, "NORTFOX_SMTP_URL must start with smtp:// or smtps://."],
    ["a URL of no form at all", { ...ALL, NORTFOX_SMTP_URL: "smtp://[" }, "NORTFOX_SMTP_URL is not a URL."],
    ["another protocol", { ...ALL, NORTFOX_SMTP_URL: "https://mail.example" }, "NORTFOX_SMTP_URL must start with smtp:// or smtps://."],
    ["a password in the URL", { ...ALL, NORTFOX_SMTP_URL: `smtp://nortfox:${PASSWORD}@mail.example` }, "NORTFOX_SMTP_URL holds a password."],
    ["no host", { ...ALL, NORTFOX_SMTP_URL: "smtp://" }, "NORTFOX_SMTP_URL names no host."],
    ["a path", { ...ALL, NORTFOX_SMTP_URL: "smtp://nortfox@mail.example/inbox" }, "NORTFOX_SMTP_URL must hold only the protocol"],
    ["a query", { ...ALL, NORTFOX_SMTP_URL: "smtp://nortfox@mail.example?tls=no" }, "NORTFOX_SMTP_URL must hold only the protocol"],
    ["a fragment", { ...ALL, NORTFOX_SMTP_URL: "smtp://nortfox@mail.example#x" }, "NORTFOX_SMTP_URL must hold only the protocol"],
    ["a password's file with no user", { ...ALL, NORTFOX_SMTP_URL: "smtp://mail.example" }, "NORTFOX_SMTP_PASSWORD_FILE is set, but NORTFOX_SMTP_URL names no user."],
    [
      "a user with no password's file",
      { NORTFOX_SMTP_URL: "smtp://nortfox@mail.example:587", NORTFOX_MAIL_FROM: "nortfox@mail.example" },
      "NORTFOX_SMTP_URL names a user, but NORTFOX_SMTP_PASSWORD_FILE is not set.",
    ],
  ])("refuse %s", (_case, env, message) => {
    expect(refusal(env)).toContain(message);
  });

  it("refuse a password's file that cannot be read, is empty, or holds more than one line", () => {
    expect(refusal({ ...ALL, NORTFOX_SMTP_PASSWORD_FILE: "/run/secrets/other" })).toBe("The SMTP password's file /run/secrets/other cannot be read.");
    expect(refusal(ALL, files("\n"))).toBe("The SMTP password's file /run/secrets/smtp-password must hold the password on one line.");
    expect(refusal(ALL, files(`${PASSWORD}\n${PASSWORD}\n`))).toBe("The SMTP password's file /run/secrets/smtp-password must hold the password on one line.");
  });
});

describe("the SMTP transport", () => {
  it("needs STARTTLS for a password over smtp, takes TLS from the start over smtps, and waits a few seconds at most", () => {
    const timeouts = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 };
    expect(smtpTransportOptions({ protocol: "smtp:", host: "mail.example", port: 587, user: "nortfox", password: PASSWORD, from: "nortfox@mail.example" })).toEqual({
      host: "mail.example",
      port: 587,
      secure: false,
      requireTLS: true,
      ...timeouts,
      auth: { user: "nortfox", pass: PASSWORD },
    });
    expect(smtpTransportOptions({ protocol: "smtps:", host: "mail.example", port: 465, user: "nortfox", password: PASSWORD, from: "nortfox@mail.example" })).toEqual({
      host: "mail.example",
      port: 465,
      secure: true,
      requireTLS: false,
      ...timeouts,
      auth: { user: "nortfox", pass: PASSWORD },
    });
    expect(smtpTransportOptions({ protocol: "smtp:", host: "mail.example", port: 25, from: "nortfox@mail.example" })).toEqual({
      host: "mail.example",
      port: 25,
      secure: false,
      requireTLS: false,
      ...timeouts,
    });
  });

  it("makes a mailer of the settings, which connects only when a mail goes", () => {
    expect(smtpMailer({ protocol: "smtp:", host: "mail.example", port: 587, from: "nortfox@mail.example" })).toBeInstanceOf(SmtpMailer);
  });
});

describe("the SMTP mailer", () => {
  it("sends a mail from the install's sender, with its address, subject and text", async () => {
    const sent: unknown[] = [];
    const json = nodemailer.createTransport({ jsonTransport: true });
    const mailer = new SmtpMailer(
      {
        sendMail: async (mail) => {
          const info = await json.sendMail(mail);
          sent.push(JSON.parse(info.message));
          return info;
        },
      },
      "NortFox <nortfox@mail.example>",
    );
    await mailer.send({ to: "karin.lund@example.com", subject: "Inbjudan till Testbolaget Alfa AB i NortFox", text: "Hej Karin Lund!" });
    expect(sent).toEqual([
      expect.objectContaining({
        from: { address: "nortfox@mail.example", name: "NortFox" },
        to: [{ address: "karin.lund@example.com", name: "" }],
        subject: "Inbjudan till Testbolaget Alfa AB i NortFox",
        text: "Hej Karin Lund!",
      }),
    ]);
  });

  it("gives nodemailer the address as one mailbox, never as a list or with a name that it would read in it", async () => {
    const sent: { to: unknown; envelope: unknown }[] = [];
    const json = nodemailer.createTransport({ jsonTransport: true });
    const mailer = new SmtpMailer(
      {
        sendMail: async (mail) => {
          const info = await json.sendMail(mail);
          sent.push({ to: (JSON.parse(info.message) as { to: unknown }).to, envelope: info.envelope });
          return info;
        },
      },
      "nortfox@mail.example",
    );
    // The API takes no such address (address.ts); the mailer never reads one as two, or as a name and another address.
    await mailer.send({ to: "a,b@evil.example", subject: "s", text: "t" });
    await mailer.send({ to: "victim<x@evil.example>", subject: "s", text: "t" });
    expect(sent).toEqual([
      { to: [{ address: '"a,b"@evil.example', name: "" }], envelope: { from: "nortfox@mail.example", to: ['"a,b"@evil.example'] } },
      { to: [{ address: '"victim x"@evil.example', name: "" }], envelope: { from: "nortfox@mail.example", to: ['"victim x"@evil.example'] } },
    ]);
  });

  it("throws when the mail server refuses", async () => {
    const mailer = new SmtpMailer({ sendMail: () => Promise.reject(new Error("550 refused")) }, "nortfox@mail.example");
    await expect(mailer.send({ to: "karin.lund@example.com", subject: "s", text: "t" })).rejects.toThrow("550 refused");
  });
});
