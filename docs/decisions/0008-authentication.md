# 8. Authentication

Status: accepted, 2026-11-01

## Context

People log in from the web app. Programs and MCP clients need access too. Swedish users expect BankID. A self-hosted install may already have its own identity provider. Login secrets in the browser must be out of reach of scripts.

## Decision

- People log in with BankID, with generic OpenID Connect, or with a password plus TOTP (RFC 6238). Passwords are hashed with Argon2id.
- BankID sits behind a provider interface, so each install chooses how it reaches BankID. NortFox is not tied to one provider.
- Sessions use opaque random tokens, sent in HttpOnly, Secure, SameSite cookies, and stored only as hashes.
- Programs use API tokens: opaque, bound to one company, with scopes, stored only as hashes, shown once, and revocable.
- MCP clients log in through NortFox's own OAuth 2.1 server: authorization code with PKCE, discovery through protected resource metadata, and opaque tokens that work only for `/mcp`.
- Discovery uses the well-known paths at the root of the host. `/.well-known/oauth-protected-resource/mcp` (RFC 9728) names the authorization server, whose metadata is at `/.well-known/oauth-authorization-server` (RFC 8414). Some clients also ask for `/.well-known/openid-configuration`. The OAuth endpoints themselves live under `/v1/oauth`. Caddy passes all three well-known paths to the server, so a client never gets the web app's page instead of the server's answer.
- Every request acts as one user in one company. The permission it needs comes from the operation's entry in the registry.

## Consequences

- A revoked session or token stops working on the next request, because every token is looked up.
- That lookup is one indexed database read per request.
- A real BankID login needs an agreement with the provider the install chooses. Tests use a fake provider.
- Logins, failed logins, and created and revoked tokens are in the behandlingshistorik.
