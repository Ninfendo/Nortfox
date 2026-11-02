# 8. Authentication

Status: accepted, 2026-11-01. Amended 2026-11-02: the login of the compatible API.

## Context

People log in from the web app. Programs and MCP clients need access too. Programs written for the established API log in the way that API asks ([decision 12](0012-compatible-api.md)). Swedish users expect BankID. A self-hosted install may already have its own identity provider. Login secrets in the browser must be out of reach of scripts.

## Decision

- People log in with BankID, with generic OpenID Connect, or with a password plus TOTP (RFC 6238). Passwords are hashed with Argon2id.
- BankID sits behind a provider interface, so each install chooses how it reaches BankID. NortFox is not tied to one provider.
- Sessions use opaque random tokens, sent in HttpOnly, Secure, SameSite cookies, and stored only as hashes.
- Programs use API tokens: opaque, bound to one company, with scopes, stored only as hashes, shown once, and revocable.
- MCP clients log in through NortFox's own OAuth 2.1 server: authorization code with PKCE, discovery through protected resource metadata, and opaque tokens that work only for `/mcp`.
- Discovery uses the well-known paths at the root of the host. `/.well-known/oauth-protected-resource/mcp` (RFC 9728) names the authorization server, whose metadata is at `/.well-known/oauth-authorization-server` (RFC 8414). Some clients also ask for `/.well-known/openid-configuration`. The OAuth endpoints themselves live under `/v1/oauth`. Caddy passes all three well-known paths to the server, so a client never gets the web app's page instead of the server's answer.
- Programs written for the established API log in to the compatible API with the established API's login flow, an OAuth 2 flow: the authorization code flow, refresh tokens that each work once, and client credentials for a service account. Each such program is registered in NortFox as a client, with an id and a secret, and the secret is stored only as a hash. The flow's endpoints live at the same paths as the established API's, on NortFox's own host. It comes in [slice 2e](../plan.md#step-2-the-foundation).
- The tokens of that flow follow the rules for API tokens: opaque and random, stored only as hashes, revocable, and bound to one company. They work only on the compatible API's paths, as the MCP tokens work only for `/mcp`.
- Every request acts as one user in one company. The permission it needs comes from the operation's entry in the registry.

## Consequences

- A revoked session or token stops working on the next request, because every token is looked up.
- That lookup is one indexed database read per request.
- A real BankID login needs an agreement with the provider the install chooses. Tests use a fake provider.
- A token of the compatible login works only on the compatible API, and an MCP token only on `/mcp`.
- Logins, failed logins, and created and revoked tokens are in the behandlingshistorik.
