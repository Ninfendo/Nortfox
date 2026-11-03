// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { defineOperation } from "../operation.ts";

export const Company = z
  .strictObject({
    id: z.uuid().meta({ description: "The company's id." }),
    name: z.string().meta({ description: "The company's name." }),
    organizationNumber: z
      .string()
      .regex(/^[0-9]{6}-[0-9]{4}$/)
      .meta({
        description:
          "The organisation number: ten digits with a hyphen after the sixth. For a sole trader it is the owner's personal identity number.",
      }),
    databaseNumber: z
      .int()
      .min(1)
      .max(2147483647)
      .meta({ description: "The company's number for programs, its tenant id. It never changes." }),
  })
  .meta({
    id: "Company",
    description: "The company the request works in. Every data request works in exactly one company.",
  });

export type Company = z.infer<typeof Company>;

/**
 * The request's own company. It is open to the assistant: it reads no money,
 * no settings and nothing an outsider wrote, and the assistant needs to know
 * which company it works in.
 */
export const getCompany = defineOperation({
  id: "getCompany",
  method: "get",
  path: "/v1/company",
  tags: ["companies"],
  summary: "Read the company",
  description:
    "Gives the company the request works in: its id, name, organisation number and tenant id. The company comes from the request's credential.",
  output: Company,
  permission: "company:read",
  tool: "Gives the company you work in: its id, name, organisation number and database number. Every other tool works in this company too.",
  assistant: true,
  writes: false,
});
