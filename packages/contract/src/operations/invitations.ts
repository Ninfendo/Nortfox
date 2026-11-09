// SPDX-License-Identifier: AGPL-3.0-only

// The invited person's side of an invitation (issue 12, "Users in a company"
// 2 and 3). The invitation's mail holds a link with a token, which works
// once, for 14 days, and a newer invitation of the same member stops it.
// "Acceptera inbjudan" opens the web app's page, which reads the invitation
// and offers "Skapa ett nytt NortFox ID" or "Koppla ihop med befintligt
// NortFox ID". Both operations serve the browser's sign-in, so their MCP
// tools refuse every call. A new identity takes the invitation's e-mail
// address and gets no session: the person signs in next, with the password
// and the first code of the TOTP secret that the answer gives, as after
// completeSetup.

import { z } from "zod";
import { personal } from "../fields.ts";
import { defineOperation } from "../operation.ts";
import { newPassword } from "../password.ts";
import { noNul, singleLine, wellFormed } from "../text.ts";
import { TotpEnrolment, token } from "./auth.ts";
import { Membership } from "./companies.ts";
import { User } from "./me.ts";

export const Invitation = z
  .strictObject({
    name: personal(z.string().meta({ description: "The name the invitation was sent to." })),
    email: personal(z.string().meta({ description: "The e-mail address the invitation was sent to. A new identity takes it as its e-mail address." })),
    expiresAt: z.iso.datetime().meta({ description: "When the link stops working: 14 days after the invitation was sent." }),
    companyName: z.string().meta({ description: "The name of the company the invitation is to, as it was when the invitation was sent." }),
    inviterName: personal(z.string().meta({ description: "The name of the system administrator who sent the invitation, as it was then." })),
  })
  .meta({
    id: "Invitation",
    description: "Inbjudan: an invitation to a company, as its link shows it. The link works once, for 14 days, and a newer invitation of the same member stops it.",
  });

export type Invitation = z.infer<typeof Invitation>;

export const InvitationAcceptance = z
  .strictObject({
    user: User,
    membership: Membership,
    // A new identity's TOTP secret, which no answer gives again: absent when the signed-in identity accepted.
    totpEnrolment: TotpEnrolment.optional(),
  })
  .meta({
    id: "InvitationAcceptance",
    description:
      "An accepted invitation: the person who now holds the membership, and the membership. For a new identity, also its TOTP secret, which no answer gives again: " +
      "the person signs in next, with the password and a code. The TOTP enrolment is absent when the signed-in identity accepted.",
  });

export type InvitationAcceptance = z.infer<typeof InvitationAcceptance>;

/** The link's token, as a path names it. */
const InvitationPath = z.strictObject({ token: token("i", "The invitation link's token, from the invitation's mail.") });

/** An invitation, by its link, before the person accepts it. */
export const getInvitation = defineOperation({
  id: "getInvitation",
  method: "get",
  path: "/v1/invitations/{token}",
  tags: ["invitations"],
  summary: "Read an invitation",
  description:
    "Gives the invitation that a link holds: the name and the e-mail address it was sent to, the company, who sent it, and when the link stops working. " +
    "A link that is unknown, used, stopped by a newer invitation or past its 14 days gets one answer, 422 invitation-link-invalid.",
  params: InvitationPath,
  output: Invitation,
  permission: "none",
  session: "flow",
  tool: "Reads an invitation by its link. It serves the browser's sign-in, so this tool refuses every call.",
  writes: false,
});

/** Acceptera inbjudan: a new identity, or the signed-in one, takes the invited membership. */
export const acceptInvitation = defineOperation({
  id: "acceptInvitation",
  method: "post",
  path: "/v1/invitations/{token}/accept",
  tags: ["invitations"],
  summary: "Accept an invitation",
  description:
    "Accepts the invitation that a link holds, once. With newIdentity, Skapa ett nytt NortFox ID: a new identity with that name and a password of 12 to 1024 characters, " +
    "which takes the invitation's e-mail address; the answer gives its TOTP secret, and sets no session, so the person signs in next with the password and a code. " +
    "Without it, Koppla ihop med befintligt NortFox ID: the identity of the browser's session accepts, and with no session the call gets 422 sign-in-required. " +
    "The member's work e-mail address becomes the invitation's. A link that is unknown, used, stopped by a newer invitation or past its 14 days gets one answer, 422 invitation-link-invalid. " +
    "An e-mail address that another identity has gets 422 email-taken, and a person who is a member of the company already gets 422 already-member.",
  params: InvitationPath,
  body: z.strictObject({
    newIdentity: z
      .strictObject({
        name: z.string().min(1).max(200).check(noNul(), wellFormed(), singleLine()).meta({ description: "The person's name, on one line." }),
        password: z.string().check(newPassword()).meta({ description: "The password: 12 to 1024 characters." }),
      })
      .optional()
      .meta({
        description:
          "Skapa ett nytt NortFox ID: the new identity's name and password. It takes the invitation's e-mail address. Left out, Koppla ihop med befintligt NortFox ID: the signed-in person accepts.",
      }),
  }),
  output: InvitationAcceptance,
  permission: "none",
  session: "flow",
  tool: "Accepts an invitation by its link. It serves the browser's sign-in, so this tool refuses every call.",
  writes: true,
});
