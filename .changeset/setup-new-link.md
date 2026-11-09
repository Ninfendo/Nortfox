---
"@nortfox/server": patch
"@nortfox/client": patch
---

A lost answer of `completeSetup` no longer leaves an install stuck. That answer holds the only copy of the first identity's TOTP secret. While the install's only identity, which the setup link made, has never confirmed its secret, the setup command now makes a new link, and says that using it replaces that identity. Its use deletes the old identity, with its password, its TOTP secret and its open login challenges, frees its e-mail address, and makes a new identity with a new secret. Once someone has signed in with the identity, the command makes no new link, as before, and a link made before refuses with 422 `install-not-empty`. `deploy/README.md` says how to use it.

- The server now keeps each used setup link, so it can tell the setup's identity from every other. Migration 0008 keeps an install's used link from before when the install has one identity and one used link, and deletes any other used link, which works for nothing.
- `completeSetup`'s description in `openapi.json` and the client says when a link replaces the identity.
