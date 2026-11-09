---
"@nortfox/server": minor
"@nortfox/client": minor
---

Roles and programs, the third part of login. `docs/api.md` gives the rules, under The roles and the programs.

- A member's work rights come from their program grants: Bokföring, Bokföring - Attest & Läs, Läs and Revisor, each with the rights of the permission catalogue it holds. A Revisor grant ends by itself 30 days after it was granted, with no action by anyone.
- `getMe` gives, in a company, the membership's `roles` (the plan's six: `owner`, `admin`, `bookkeeper`, `approver`, `viewer` and `auditor`), its `programs` and its `programsAdministered`, and the permissions of the member's grants beside the member's own. `updateMyMembership` answers the membership with the same fields.
- A session takes the person's permissions when it chooses the company with `selectCompany`, and keeps them until it chooses a company again: a right taken from the member still works in it, and a right given since does not, until then. A right whose grant ends, such as a Revisor grant's, stops at its end, also in a session that chose the company before.
- The client exports `Program`, `ProgramGrant`, `ProgramAdmin` and `Role`.
