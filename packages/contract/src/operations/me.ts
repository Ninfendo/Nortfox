// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { defineOperation } from "../operation.ts";

/** Språk: the languages a person can choose, for every company. */
export const LANGUAGES = ["sv", "en"] as const;

/** How often a password sign-in asks for a TOTP code (open point 15: a new identity starts with the first). */
export const TWO_STEP_CHOICES = ["new_device_90_days", "every_login"] as const;

export const User = z
  .strictObject({
    id: z.uuid().meta({ description: "The person's id. The person stays the actor of every entry they made." }),
    name: z.string().meta({ description: "The person's name." }),
    email: z.string().meta({ description: "The person's personal e-mail address. A password sign-in takes it as the identifier, in any letter case." }),
    language: z.enum(LANGUAGES).meta({ description: "Språk: sv (Svenska) or en (English). It applies in every company." }),
  })
  .meta({ id: "User", description: "A person: their NortFox ID, the one login identity they use for every company." });

export type User = z.infer<typeof User>;

export const Me = z
  .strictObject({
    user: User,
    personalIdentityNumber: z
      .string()
      .regex(/^[0-9]{8}-[0-9]{4}$/)
      .optional()
      .meta({ description: "The person's personnummer, in twelve digits with a hyphen. Absent until one is added." }),
    mobile: z.string().optional().meta({ description: "The person's mobile number. Absent when none is set." }),
    twoStep: z.enum(TWO_STEP_CHOICES).meta({
      description: "How often a password sign-in asks for a TOTP code: new_device_90_days on each new device and every 90 days on a known one, or every_login.",
    }),
  })
  .meta({ id: "Me", description: "The signed-in person, with their own login data." });

export type Me = z.infer<typeof Me>;

/** The signed-in person. In slice 2c's first part a person works in no company yet. */
export const getMe = defineOperation({
  id: "getMe",
  method: "get",
  path: "/v1/me",
  tags: ["me"],
  summary: "Read yourself",
  description: "Gives the signed-in person: their name, e-mail address and language, their personnummer and mobile number when set, and their two-step choice.",
  output: Me,
  permission: "signed-in",
  tool: "Gives the person you act as: their name, e-mail address, language, personnummer and mobile number when set, and how often a sign-in asks for a TOTP code.",
  writes: false,
});
