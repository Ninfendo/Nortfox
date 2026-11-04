---
"@nortfox/server": minor
"@nortfox/client": minor
---

Companies and memberships, the second part of login: a signed-in person makes companies, lists them, and chooses the one the session works in. `docs/api.md` gives the rules, under The companies.

- `createCompany` makes a company with its name and organisation number, and makes the person its owner, a system administrator, in the same transaction. The company gets its tenant id, `databaseNumber`, a whole number from 1 to 2147483647 that is never given out again. The organisation number never changes, and a company always has an active system administrator: the database refuses anything else.
- `listCompanies` lists the companies where the person is an active member, with the person's system administrator's level in each, and takes `query` to find one by its name or organisation number. `listRecentCompanies` gives the three the person chose last.
- `selectCompany` ("Byt företag") makes the session work in a company without a new sign-in. Any other company, also one that does not exist, gets 422 `company-not-available`. `getSession` and `getMe` then give the company, and `getMe` the membership and the permissions; `getCompany` works for every member. Before a company is chosen, `getCompany` answers 403 `company-required`, as before.
- The server asks on every request whether the session's membership is still active. When it is deactivated, removed or left, the request gets 401 and the session ends. A session that works in a company ends after the membership's idle logout, "Utloggning efter inaktivitet": 15, 30, 60, 120 or 480 minutes, 120 by default.
- `updateMyMembership` changes the person's own work e-mail address, work phone number and idle logout in a company (Användaruppgifter). `null` takes a work contact away.
- The behandlingshistorik of a company gets each sign-in to it, when `selectCompany` chooses it: Program "Användare", Rubrik "Inloggning", with the method, the second step, the personnummer for a sign-in with it, the application and the IP address. A failed sign-in of a member is written in each of the member's companies, at most once a minute per company, with the count of the last hour. Kontoaktivitet also keeps each company the person made.
- `createCompany`, and each write whose answer holds a person's contact data, such as `selectCompany` and `updateMyMembership`, keep their idempotency keys outside the company tables, for 24 hours. So a person's contact data never reaches the behandlingshistorik through a stored answer.
- Migration 0007 ends every session that is open when it runs, so each person signs in again.
- `openapi.json` gives each operation's company source (`current`, `new`, or a field of its input) and the fields of its answer that hold a person's contact data, `x-nortfox.personalOutput`. The client has `createCompany()`, `listCompanies()`, `listRecentCompanies()`, `selectCompany()` and `updateMyMembership()`, exports `Membership`, `CompanyChoice`, `RecentCompanies` and `SysAdmin`, takes `null` where an input field may be null, and names an answer's personal data in each method's doc comment.
- The restore test takes its compose project's name from `NORTFOX_BACKUP_PROJECT`, and checks the owner of the schema `access` too.
