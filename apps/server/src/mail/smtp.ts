// SPDX-License-Identifier: AGPL-3.0-only

// The install's mail, through its SMTP server, over nodemailer (open point
// 11). Its settings (deploy/README.md), which config.ts reads with the
// server's own:
//
// - NORTFOX_SMTP_URL: the server, as smtp://host:port, or smtps://host:port
//   for TLS from the start, with the user name before the host when the
//   server asks for a sign-in, as smtp://nortfox@mail.example:587. It never
//   holds the password, as the database's URL does not. Port 587 is the
//   default of smtp, and 465 of smtps.
// - NORTFOX_SMTP_PASSWORD_FILE: the file that holds the user's password. It
//   is set when the URL names a user, and only then. With a password, smtp
//   needs STARTTLS: the password never goes over a connection in clear.
// - NORTFOX_MAIL_FROM: the sender, as nortfox@mail.example or as
//   NortFox <nortfox@mail.example>.
//
// With none of the three set, the install has no mailer. A setting that is
// missing or wrong stops the start, with a message that says what to set and
// never holds the password. A mail goes inside its request, before the
// request commits: a send that fails throws, so nothing changes, and the
// server waits at most a few seconds for a mail server that does not answer.

import nodemailer, { type SMTPTransportOptions, type Transporter } from "nodemailer";
import type { Environment } from "../db/connect.ts";
import type { MailMessage, Mailer } from "./mailer.ts";

/** The install's SMTP settings, after their checks. */
export interface SmtpSettings {
  /** smtp: or smtps: */
  readonly protocol: "smtp:" | "smtps:";
  readonly host: string;
  readonly port: number;
  /** The user name, when the server asks for one. */
  readonly user?: string;
  /** The user's password, from its file. */
  readonly password?: string;
  /** The sender of every mail. */
  readonly from: string;
}

/** The sender: an address, or a name and an address in angle brackets. */
const FROM = /^(?:[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+|[^<>@]+\s<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>)$/u;

/** The default port of each protocol. */
const PORTS = { "smtp:": 587, "smtps:": 465 } as const;

/** A setting from the environment, or undefined when it is not set or empty. */
function setting(env: Environment, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** The server's URL, after its checks. Throws on any that fails, with a message that never holds the URL. */
function serverOf(text: string): Pick<SmtpSettings, "protocol" | "host" | "port" | "user"> {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("NORTFOX_SMTP_URL is not a URL. Set it to the mail server, such as smtp://mail.example:587 or smtps://mail.example:465.");
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") {
    throw new Error("NORTFOX_SMTP_URL must start with smtp:// or smtps://.");
  }
  if (url.password !== "") {
    throw new Error("NORTFOX_SMTP_URL holds a password. Put the password in the file that NORTFOX_SMTP_PASSWORD_FILE names, and leave it out of the URL.");
  }
  if (url.hostname === "") {
    throw new Error("NORTFOX_SMTP_URL names no host.");
  }
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    throw new Error("NORTFOX_SMTP_URL must hold only the protocol, the user name, the host and the port.");
  }
  const user = decodeURIComponent(url.username);
  return {
    protocol: url.protocol,
    host: url.hostname,
    port: url.port === "" ? PORTS[url.protocol] : Number(url.port),
    ...(user === "" ? {} : { user }),
  };
}

/** The password in its file: the file's text without the line end after it. */
function passwordIn(path: string, readFile: (path: string) => string): string {
  let text: string;
  try {
    text = readFile(path);
  } catch {
    throw new Error(`The SMTP password's file ${path} cannot be read.`);
  }
  const password = text.replace(/\r?\n$/, "");
  if (password === "" || /[\r\n]/.test(password)) {
    throw new Error(`The SMTP password's file ${path} must hold the password on one line.`);
  }
  return password;
}

/**
 * The install's SMTP settings from the environment, or undefined when none
 * of the three is set: the install then has no mailer. Throws on a setting
 * that is missing or wrong.
 */
export function smtpSettingsOf(env: Environment, readFile: (path: string) => string): SmtpSettings | undefined {
  const url = setting(env, "NORTFOX_SMTP_URL");
  const passwordFile = setting(env, "NORTFOX_SMTP_PASSWORD_FILE");
  const from = setting(env, "NORTFOX_MAIL_FROM");
  if (url === undefined && passwordFile === undefined && from === undefined) {
    return undefined;
  }
  if (url === undefined) {
    throw new Error("NORTFOX_SMTP_URL is not set, but another mail setting is. Set it to the mail server, or set no mail setting at all.");
  }
  if (from === undefined) {
    throw new Error("NORTFOX_MAIL_FROM is not set. Set it to the sender of the install's mail, such as NortFox <nortfox@mail.example>.");
  }
  if (!FROM.test(from)) {
    throw new Error("NORTFOX_MAIL_FROM must be an e-mail address, or a name and an address in angle brackets, such as NortFox <nortfox@mail.example>.");
  }
  const server = serverOf(url);
  if (passwordFile !== undefined && server.user === undefined) {
    throw new Error("NORTFOX_SMTP_PASSWORD_FILE is set, but NORTFOX_SMTP_URL names no user. Put the user name before the host, as smtp://nortfox@mail.example:587.");
  }
  // nodemailer signs in with a user and a password, or not at all: a user alone would fail every mail to a server that asks for a sign-in.
  if (passwordFile === undefined && server.user !== undefined) {
    throw new Error(
      "NORTFOX_SMTP_URL names a user, but NORTFOX_SMTP_PASSWORD_FILE is not set. Set it to the file that holds the user's password, or take the user name out of the URL.",
    );
  }
  return { ...server, ...(passwordFile === undefined ? {} : { password: passwordIn(passwordFile, readFile) }), from };
}

/** How long the server waits for a mail server: to connect, for its greeting, and for each answer. */
const TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 } as const;

/** The options of nodemailer's SMTP transport for the settings. With a password, smtp needs STARTTLS. */
export function smtpTransportOptions(settings: SmtpSettings): SMTPTransportOptions {
  const secure = settings.protocol === "smtps:";
  return {
    host: settings.host,
    port: settings.port,
    secure,
    requireTLS: !secure && settings.password !== undefined,
    ...TIMEOUTS,
    ...(settings.user === undefined || settings.password === undefined ? {} : { auth: { user: settings.user, pass: settings.password } }),
  };
}

/** A mailer over a nodemailer transport, from one sender. */
export class SmtpMailer implements Mailer {
  readonly #transport: Pick<Transporter, "sendMail">;
  readonly #from: string;

  constructor(transport: Pick<Transporter, "sendMail">, from: string) {
    this.#transport = transport;
    this.#from = from;
  }

  async send(message: MailMessage): Promise<void> {
    // An address as an object, which nodemailer never reads as a list of addresses or as a name and an address.
    await this.#transport.sendMail({ from: this.#from, to: { name: "", address: message.to }, subject: message.subject, text: message.text });
  }
}

/** The install's mailer: its SMTP server, from its sender. It connects when the first mail goes. */
export function smtpMailer(settings: SmtpSettings): SmtpMailer {
  return new SmtpMailer(nodemailer.createTransport(smtpTransportOptions(settings)), settings.from);
}
