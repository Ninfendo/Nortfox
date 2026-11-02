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
- Programs written for the established API log in to the compatible API with the established API's login flow, an OAuth 2 flow. Its endpoints live at the same paths as the established API's, on NortFox's own host. It comes in [slice 2e](../plan.md#step-2-the-foundation). It has what the established flow has:
  - the authorization code flow. A code works once, for 10 minutes. The request's `state` is required and comes back unchanged.
  - the redirect URI rule. A redirect URI must equal the one registered for the client. When the request has none, the registered one is used. At the token step, it must match the one sent in the request for the code.
  - PKCE: a `code_challenge` with the `S256` method only. It is optional, or required when the client's setting says so. When a challenge was sent, the token step needs the right `code_verifier`.
  - refresh tokens. Each works once, and each refresh gives a new one.
  - service accounts. A member of the company with the owner or the admin role activates one through the authorization code flow, with `account_type=service`. Every other role is refused. After that, the program gets its tokens with client credentials and the company's tenant id, with no refresh token. A program has at most one service account per company. Each company has a tenant id, a number, as in the established API. An activation for a client that does not allow service accounts is refused, with the established API's error.
  - the revoke endpoint, which revokes a refresh token. A consent lasts until it is revoked in the company, as described below.
  - the established API's scopes. A client may ask only for the scopes registered for it, and a request for any other scope is refused, with the established API's error. A consent keeps the scopes it was given, and a token never holds more. A call outside a token's scopes gets the established API's error.
  - the established API's lifetimes, as they are today: an access token lasts 1 hour, and use does not extend it. A refresh token lasts 45 days.
- Each such program is registered in NortFox as a client, with an id, a secret, its redirect URI, the scopes it may ask for, whether it requires PKCE and whether it allows service accounts, as in the established system. The secret is shown once and stored only as a hash.
- A member of a company with the owner or the admin role ([slice 2c](../plan.md#step-2-the-foundation)) registers such a client, in that company, as a program is registered inside a company in the established system. That member can also change it, give it a new secret and delete it. Each of these is an operation in the registry, with its MCP tool ([decision 3](0003-contract-first-rest-and-mcp.md)). Any company on the install can then activate the client. This comes in [slice 2e](../plan.md#step-2-the-foundation) too.
- Every other role is refused, both for these acts and for the activation of a service account. In the established system, the company's system administrator adds integrations and authorizes a service account. In NortFox, the owner and the admin roles hold that right.
- A member of a company with the owner or the admin role lists the company's consents, service accounts included, and revokes any of them. Any member can also list and revoke the consents that the member gave. This is as in the established system, where the system administrator sees and manages every integration of the company, and a user turns off their own. Each of these is an operation in the registry, with its MCP tool. Every other listing or revocation of a consent is refused. A revoked consent stops its tokens as described below.
- The access token of that flow has the established token's shape: a JWT that carries the company's tenant id as a claim. The established API's docs tell integrators to read the tenant id from the token, so an opaque token would break those integrations. 2e's issue takes the claim names from a token of the established system. NortFox never trusts what the token says: the token holds a random value, is stored only as a hash and is looked up on every request. This shape is a working default that the owner may change.
- The code and the refresh token of that flow are opaque and random, and are stored only as hashes. Every token of that flow is bound to one company. It works only on the compatible API's paths, as the MCP tokens work only for `/mcp`.
- In the established flow, a live access token cannot be revoked: it works until it expires. In NortFox, revoking a consent, or the client, stops every token it gave on the next request, access tokens included, because every token is looked up. This is NortFox's own working default, which the owner may change.
- Every request acts in one company, as one user. A service account has no user: its request acts as its client, with the rights its scopes give. The permission a request needs comes from the operation's entry in the registry.

## Consequences

- A revoked session or token stops working on the next request, because every token is looked up.
- That lookup is one indexed database read per request.
- A real BankID login needs an agreement with the provider the install chooses. Tests use a fake provider.
- A token of the compatible login works only on the compatible API, and an MCP token only on `/mcp`.
- Logins, failed logins, and created and revoked tokens are in the behandlingshistorik.
