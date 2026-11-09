---
"@nortfox/server": minor
"@nortfox/client": minor
---

Roles, programs and the user administration, the third part of login. `docs/api.md` gives the rules, under The companies, The users, and The roles and the programs.

- A member's work rights come from their program grants: Bokföring, Bokföring - Attest & Läs, Läs and Revisor, each with the rights of the permission catalogue it holds. A Revisor grant ends by itself 30 days after it was granted, with no action by anyone.
- `getMe` gives, in a company, the membership's `id`, its `roles` (the plan's six: `owner`, `admin`, `bookkeeper`, `approver`, `viewer` and `auditor`), its `programs` and its `programsAdministered`, and the permissions of the member's grants beside the member's own. `updateMyMembership` answers the membership with the same fields.
- A session takes the person's permissions when it chooses the company with `selectCompany`, and keeps them until it chooses a company again: a right taken from the member still works in it, and a right given since does not, until then. A right whose grant ends, such as a Revisor grant's, stops at its end, also in a session that chose the company before.
- A system administrator, the owner or an admin, holds `company:update`, `users:read`, `users:admin` and `programs:grant`; a program administrator `users:read` and `programs:grant`, for the programs they administer.
- `listUsers`, `getUser`, `updateUser` and `removeUser` run the company's users, by the member's id in `/v1/users/{memberId}`: Aktiv användare, the system administrator's level, the programs administered, the idle logout and the work contacts, and Ta bort användaren, never yourself. A company always keeps an active system administrator: removing, deactivating or demoting the last one gets 422 `last-system-administrator`.
- `assignProgram`, `removeProgram`, `moveProgram` and `updateUserRights` grant, take away, move and narrow the members' programs and their Rapporter and Register/Övrigt rights. A program administrator does it only for the programs they administer.
- `listPermissions` gives the permission catalogue: the roles, the programs with their sets, the groups and every permission, in order, with the manual-only marks.
- `updateCompany` changes the company's name, its postal and visiting addresses and its phone and e-mail; `getCompany` gives them. The organisation number never changes.
- The work e-mail address is required: `createCompany` gives the owner the person's own e-mail address as the work e-mail, `updateMyMembership` and `updateUser` refuse `null` for it, and an install's existing members get their identity's e-mail address once.
- The client exports `Program`, `ProgramGrant`, `ProgramAdmin`, `Role`, `Member`, `UserRights`, `Permission`, `PermissionKey`, `PermissionGroup`, `PermissionGroupKey`, `ProgramDefinition`, `RoleDefinition` and `PermissionCatalogue`.
