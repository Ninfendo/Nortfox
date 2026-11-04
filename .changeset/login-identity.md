---
"@nortfox/server": minor
"@nortfox/client": minor
---

Signing in, the first part of login: a person signs in to NortFox in the browser with a password and a TOTP code, and the browser keeps the session in a cookie. `docs/api.md` gives the rules.

- An empty install gets its first identity from a setup link, which the new setup command prints (`pnpm --filter @nortfox/server setup-link`, or `node apps/server/dist/setup-main.js` in the server image). `completeSetup` takes the link with a name, an e-mail address and a password of 12 to 1024 characters, and gives the new TOTP secret as an `otpauth` URI for an authenticator app. The link works once, for 28 days.
- `loginWithPassword` takes the e-mail address, in any letter case, or the personnummer, and the password. `verifyTotp` then takes the app's code and sets the session cookie. The TOTP step comes on each new device, and every 90 days on a known one.
- `logout` ends the session. A session also ends 12 hours after it began, and after 120 minutes without a request. `getSession` and `getMe` read the signed-in person. A session works in no company yet, so `getCompany` answers it 403 `company-required`. Choosing a company comes in the next part.
- Every failed sign-in gets the same answer, 422 `sign-in-failed`, whatever the cause. Repeated failures wait longer and longer, and then lock the step for a while, with 429 `too-many-attempts` and `Retry-After`. When the server checks as many passwords as it can at once, it answers 503 `server-busy`.
- Kontoaktivitet keeps the person's sign-ins, failed sign-ins, locks and logouts.
- Passwords are kept as Argon2id hashes, and TOTP secrets sealed with the install secret. The server now needs two more settings to start: `NORTFOX_PUBLIC_ORIGIN`, its own origin, and `NORTFOX_SECRET_KEY_FILE`, the file of the install secret. It checks the key at start, and refuses one that is not the install's. `deploy/README.md` says how to make it, and to keep a copy apart from the backups. The server needs Node 24.7 or later.
- `/v1` refuses a request from another site with 403 `origin-not-allowed`, and every answer carries `Cache-Control: no-store`.
- The sign-in's operations are MCP tools too, and each refuses every call with 403 `browser-only`: an MCP client signs in through OAuth, which comes in a later part.
- PostgreSQL in the compose file logs a failed statement without the error's detail and without the statement's parameters, which can hold a row or a secret. The server's own log of an error leaves out every token, personnummer and e-mail address.
- `openapi.json` names the session cookie as the credential `sessionCookie` of each operation that needs an actor. The client has `completeSetup()`, `loginWithPassword()`, `verifyTotp()`, `logout()`, `getSession()` and `getMe()`. A method takes its path parameters, its query and its body in one input object, a write that needs one takes its idempotency key in its options, and a method whose answer has no body gives nothing.
