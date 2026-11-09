// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { personal } from "../fields.ts";
import { defineOperation } from "../operation.ts";
import { Company, Membership } from "./companies.ts";

/** Språk: the languages a person can choose, for every company. */
export const LANGUAGES = ["sv", "en"] as const;

/** How often a password sign-in asks for a TOTP code (open point 15: a new identity starts with the first). */
export const TWO_STEP_CHOICES = ["new_device_90_days", "every_login"] as const;

export const User = z
  .strictObject({
    id: z.uuid().meta({ description: "The person's id. The person stays the actor of every entry they made." }),
    name: personal(z.string().meta({ description: "The person's name." })),
    email: personal(z.string().meta({ description: "The person's personal e-mail address. A password sign-in takes it as the identifier, in any letter case." })),
    language: z.enum(LANGUAGES).meta({ description: "Språk: sv (Svenska) or en (English). It applies in every company." }),
  })
  .meta({ id: "User", description: "A person: their NortFox ID, the one login identity they use for every company." });

export type User = z.infer<typeof User>;

export const Me = z
  .strictObject({
    user: User,
    personalIdentityNumber: personal(
      z
        .string()
        .regex(/^[0-9]{8}-[0-9]{4}$/)
        .meta({ description: "The person's personnummer, in twelve digits with a hyphen. Absent until one is added." }),
    ).optional(),
    mobile: personal(z.string().meta({ description: "The person's mobile number. Absent when none is set." })).optional(),
    twoStep: z.enum(TWO_STEP_CHOICES).meta({
      description: "How often a password sign-in asks for a TOTP code: new_device_90_days on each new device and every 90 days on a known one, or every_login.",
    }),
    // The company the request works in, and the person's membership there: absent when it works in none.
    company: Company.optional(),
    membership: Membership.optional(),
    permissions: z.array(z.string()).meta({
      description:
        "The permissions the request holds in that company, in alphabetical order: a member's own, the admin level's, and the rights of the member's program grants. " +
        "A session holds those it took when it chose the company, less a right whose grant has ended since. Empty when the request works in no company.",
    }),
  })
  .meta({ id: "Me", description: "The signed-in person, with their own login data, and the company the request works in with the person's membership and permissions there." });

export type Me = z.infer<typeof Me>;

/** The signed-in person, and their current company when the credential names one. */
export const getMe = defineOperation({
  id: "getMe",
  method: "get",
  path: "/v1/me",
  tags: ["me"],
  summary: "Read yourself",
  description:
    "Gives the signed-in person: their name, e-mail address and language, their personnummer and mobile number when set, and their two-step choice. " +
    "When the request works in a company, it gives that company too, with the person's membership there, its roles, program grants and programs administered, and the permissions the request holds there.",
  output: Me,
  permission: "signed-in",
  company: "current",
  tool:
    "Gives the person you act as: their name, e-mail address, language, personnummer and mobile number when set, and how often a sign-in asks for a TOTP code; " +
    "and the company you work in, with your membership and permissions there.",
  writes: false,
});
