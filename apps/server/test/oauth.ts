// SPDX-License-Identifier: AGPL-3.0-only

// The MCP clients, their consents, and the codes and tokens of their login,
// as the database tests make them (db/README.md, the schema access). Each
// helper calls the database's own functions as the app does, in the
// transaction that the server's step would run in: a registration, a
// request and a redemption in an anonymous one, with only the channel; a
// consent and its code in a transaction of the company, as the person who
// approves. Every client, name and address is made up, and every token is
// random: the database keeps only its hash.

import { createHash, randomBytes } from "node:crypto";
import type { Client } from "pg";
import { inTransaction } from "./database.ts";
import { anonymously, later, tokenHash } from "./identities.ts";
import type { Actor } from "./ledger.ts";

/** A loopback redirect URI, where a native MCP client listens (RFC 8252). */
export const REDIRECT_URI = "http://127.0.0.1:33418/callback";

/** The lifetimes of the login (issue 12, open point 9), in minutes. */
export const LIFETIMES = { request: 10, code: 10, accessToken: 60, refreshToken: 45 * 24 * 60 } as const;

/** A made-up client id: nfk_ and 22 characters of base64url, from 16 random bytes. */
export function someClientId(): string {
  return `nfk_${randomBytes(16).toString("base64url")}`;
}

/** A made-up code verifier: 43 characters of base64url, from 32 random bytes (RFC 7636). */
export function someVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** The S256 code challenge of a verifier: BASE64URL(SHA256(verifier)), 43 characters (RFC 7636). */
export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** What a test may give a new client. Each value left out takes a made-up one. */
export interface NewClient {
  readonly clientId?: string;
  readonly name?: string;
  readonly redirectUris?: readonly string[];
  readonly grantTypes?: readonly string[];
  readonly at?: Date;
}

/** A registered client: its row's id, and its client id. */
export interface RegisteredClient {
  readonly id: string;
  readonly clientId: string;
}

/** Registers a client with access.register_oauth_client, as the registration endpoint does, and gives it. */
export async function registerClient(app: Client, client: NewClient = {}): Promise<RegisteredClient> {
  const clientId = client.clientId ?? someClientId();
  const [row] = await anonymously<{ id: string | null }>(app, "SELECT access.register_oauth_client($1, $2, $3, $4, $5) AS id", [
    clientId,
    client.name ?? "Testklienten",
    client.redirectUris ?? [REDIRECT_URI],
    client.grantTypes ?? ["authorization_code", "refresh_token"],
    client.at ?? new Date("2090-03-15T10:00:00.000Z"),
  ]);
  if (row?.id === undefined || row.id === null) {
    throw new Error("The client was not registered.");
  }
  return { id: row.id, clientId };
}

/** What a test may give a new authorization request. Each value left out takes a made-up one. */
export interface NewRequest {
  readonly hash?: Buffer;
  readonly binding?: Buffer;
  readonly redirectUri?: string;
  readonly scopes?: readonly string[];
  readonly challenge?: string;
  readonly state?: string | null;
  readonly resource?: string | null;
  readonly at?: Date;
  readonly expiresAt?: Date;
}

/** An authorization request as a test opened it: its id, its hash, its binding's hash, and the verifier of its challenge. */
export interface OpenedRequest {
  readonly id: string | null;
  readonly hash: Buffer;
  readonly binding: Buffer;
  readonly verifier: string;
  readonly challenge: string;
}

/** Opens a request of `client` (its row's id) with access.open_oauth_request, as the authorization endpoint does. Its id is null when the database made none. */
export async function openRequest(app: Client, client: string, request: NewRequest = {}): Promise<OpenedRequest> {
  const verifier = someVerifier();
  const challenge = request.challenge ?? challengeOf(verifier);
  const hash = request.hash ?? tokenHash();
  const binding = request.binding ?? tokenHash();
  const at = request.at ?? new Date("2090-03-15T10:00:00.000Z");
  const [row] = await anonymously<{ id: string | null }>(app, "SELECT access.open_oauth_request($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS id", [
    hash,
    client,
    request.redirectUri ?? REDIRECT_URI,
    request.scopes ?? ["companyinformation", "profile"],
    challenge,
    request.state === undefined ? "made-up-state" : request.state,
    request.resource === undefined ? "https://nortfox.example/mcp" : request.resource,
    binding,
    at,
    request.expiresAt ?? later(at, LIFETIMES.request),
  ]);
  return { id: row?.id ?? null, hash, binding, verifier, challenge };
}

/** A consent as the database holds it, with its times as text. */
export interface ConsentRow {
  readonly id: string;
  readonly consent_company_id: string;
  readonly membership_id: string;
  readonly oauth_client_id: string;
  readonly identity_id: string;
  readonly scopes: string[];
  readonly approved_at: string;
  readonly revoked_at: string | null;
  readonly revoked_by: string | null;
}

/** The columns of a consent, with its times as text. */
export const CONSENT_COLUMNS =
  "id, consent_company_id, membership_id, oauth_client_id, identity_id, scopes, approved_at::text AS approved_at, revoked_at::text AS revoked_at, revoked_by";

/** The statement that gives a consent, as the app runs it. */
export const INSERT_CONSENT = `INSERT INTO access.consents (consent_company_id, membership_id, oauth_client_id, scopes)
  VALUES ($1, $2, $3, $4) RETURNING ${CONSENT_COLUMNS}`;

/** Gives a consent as `client` in a transaction of its own in `company`, for `membership` and the MCP client `oauthClient`, as `who`, through REST. */
export async function addConsent(
  client: Client,
  company: string,
  membership: string,
  who: Actor,
  oauthClient: string,
  scopes: readonly string[] = ["companyinformation"],
): Promise<ConsentRow> {
  const row = await inTransaction(client, { company, ...who, channel: "rest" }, async () => {
    const found = await client.query<ConsentRow>(INSERT_CONSENT, [company, membership, oauthClient, scopes]);
    return found.rows[0];
  });
  if (row === undefined) {
    throw new Error("The consent was not given.");
  }
  return row;
}

/** Where a person approves: the company, the membership there, and the person as an actor. */
export interface Approver {
  readonly company: string;
  readonly membership: string;
  readonly who: Actor;
}

/** An approved request: its consent, and its code's hash and id. */
export interface Approval {
  readonly consent: ConsentRow;
  readonly code: Buffer;
  readonly codeId: string | null;
}

/**
 * Approves `request` as the server's approve step does, in one transaction
 * of the company as the person: uses the request, gives the consent, and
 * issues the code. The code's id is null when the database issued none.
 */
export async function approve(app: Client, approver: Approver, request: OpenedRequest, scopes?: readonly string[], at = new Date("2090-03-15T10:01:00.000Z")): Promise<Approval> {
  const code = tokenHash();
  return inTransaction(app, { company: approver.company, ...approver.who, channel: "rest" }, async () => {
    const used = await app.query<{ oauth_client_id: string; scopes: string[] }>("SELECT oauth_client_id, scopes FROM access.use_oauth_request($1, $2, $3)", [
      request.hash,
      request.binding,
      at,
    ]);
    const [found] = used.rows;
    if (found === undefined) {
      throw new Error("The request was not used.");
    }
    const given = await app.query<ConsentRow>(INSERT_CONSENT, [approver.company, approver.membership, found.oauth_client_id, scopes ?? found.scopes]);
    const consent = given.rows[0];
    if (consent === undefined) {
      throw new Error("The consent was not given.");
    }
    const issued = await app.query<{ id: string | null }>("SELECT access.issue_oauth_code($1, $2, $3, $4, $5) AS id", [
      code,
      request.id,
      consent.id,
      at,
      later(at, LIFETIMES.code),
    ]);
    return { consent, code, codeId: issued.rows[0]?.id ?? null };
  });
}

/** What a redemption gives: its outcome, the person, the scopes, and the new tokens' ids and hashes. */
export interface Redemption {
  readonly outcome: string | null;
  readonly identityId: string | null;
  readonly scopes: string[] | null;
  readonly accessTokenId: string | null;
  readonly refreshTokenId: string | null;
  readonly accessHash: Buffer;
  readonly refreshHash: Buffer;
}

interface RedemptionRow {
  readonly outcome: string;
  readonly identity_id: string;
  readonly scopes: string[];
  readonly access_token_id: string | null;
  readonly refresh_token_id: string | null;
}

function redemptionOf(row: RedemptionRow | undefined, accessHash: Buffer, refreshHash: Buffer): Redemption {
  return {
    outcome: row?.outcome ?? null,
    identityId: row?.identity_id ?? null,
    scopes: row?.scopes ?? null,
    accessTokenId: row?.access_token_id ?? null,
    refreshTokenId: row?.refresh_token_id ?? null,
    accessHash,
    refreshHash,
  };
}

/** What the token endpoint sends with a code: the client's id, the redirect URI and the challenge of the verifier. */
export interface CodeGrant {
  readonly clientId: string;
  readonly redirectUri?: string;
  readonly challenge: string;
  readonly at?: Date;
}

/** Redeems a code with access.redeem_oauth_code, as the token endpoint does, on `client` in one statement, and gives what it gave. */
export async function redeemCode(client: Client, code: Buffer, grant: CodeGrant): Promise<Redemption> {
  const accessHash = tokenHash();
  const refreshHash = tokenHash();
  const at = grant.at ?? new Date("2090-03-15T10:02:00.000Z");
  const found = await client.query<RedemptionRow>("SELECT * FROM access.redeem_oauth_code($1, $2, $3, $4, $5, $6, $7, $8, $9)", [
    code,
    grant.clientId,
    grant.redirectUri ?? REDIRECT_URI,
    grant.challenge,
    accessHash,
    refreshHash,
    at,
    later(at, LIFETIMES.accessToken),
    later(at, LIFETIMES.refreshToken),
  ]);
  return redemptionOf(found.rows[0], accessHash, refreshHash);
}

/** What the token endpoint sends with a refresh token: the client's id, and the scopes it narrows to, if any. */
export interface RefreshGrant {
  readonly clientId: string;
  readonly scopes?: readonly string[] | null;
  readonly at?: Date;
}

/** Redeems a refresh token with access.redeem_oauth_refresh_token, as the token endpoint does, on `client` in one statement. */
export async function redeemRefreshToken(client: Client, token: Buffer, grant: RefreshGrant): Promise<Redemption> {
  const accessHash = tokenHash();
  const refreshHash = tokenHash();
  const at = grant.at ?? new Date("2090-03-15T10:30:00.000Z");
  const found = await client.query<RedemptionRow>("SELECT * FROM access.redeem_oauth_refresh_token($1, $2, $3, $4, $5, $6, $7, $8)", [
    token,
    grant.clientId,
    grant.scopes ?? null,
    accessHash,
    refreshHash,
    at,
    later(at, LIFETIMES.accessToken),
    later(at, LIFETIMES.refreshToken),
  ]);
  return redemptionOf(found.rows[0], accessHash, refreshHash);
}

/** A whole login of a client: the client, its request, the approval, and the redemption of its code. */
export interface Login {
  readonly client: RegisteredClient;
  readonly request: OpenedRequest;
  readonly approval: Approval;
  readonly tokens: Redemption;
}

/** Registers a client (unless one is given), opens a request, approves it as `approver` and redeems its code. */
export async function logIn(app: Client, approver: Approver, options: { readonly client?: RegisteredClient; readonly scopes?: readonly string[] } = {}): Promise<Login> {
  const client = options.client ?? (await registerClient(app));
  const request = await openRequest(app, client.id, options.scopes === undefined ? {} : { scopes: options.scopes });
  const approval = await approve(app, approver, request);
  const tokens = await redeemCode(app, approval.code, { clientId: client.clientId, challenge: request.challenge });
  return { client, request, approval, tokens };
}
