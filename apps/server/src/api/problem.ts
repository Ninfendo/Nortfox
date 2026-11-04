// SPDX-License-Identifier: AGPL-3.0-only

// Every /v1 error is problem details (RFC 9457): application/problem+json
// with type, title, status, detail and a stable code. The type is
// about:blank, so the title is the status's phrase (RFC 9110), and the code
// says what went wrong. The texts are English until packages/i18n comes in
// slice 2d. A field problem leaves out the value received, so an answer
// never echoes its input; the runner's refusal keeps it for a surface that
// names it in its own message. Every problem answer carries
// Cache-Control: no-store, as every /v1 answer does. A refusal that may be
// sent again later, 429 and 503, carries Retry-After in whole seconds.

import type { FieldIssue, FieldProblem, Problem, ProblemCode } from "@nortfox/contract";
import type { Refusal } from "./operation.ts";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** A refusal as an HTTP answer: its status, its problem details and its headers. */
export interface ProblemAnswer {
  readonly status: number;
  readonly body: Problem;
  readonly headers: Readonly<Record<string, string>>;
}

/** The statuses of the problems the surfaces answer with. */
type Status = 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 422 | 429 | 500 | 503;

/** The phrase of each status, from RFC 9110, and RFC 6585 for 429. */
const TITLES: Readonly<Record<Status, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

/** Every /v1 answer may hold the request's own data, so no cache keeps it. */
export const NO_STORE = { "Cache-Control": "no-store" } as const;

const PROBLEM_HEADERS = { "Content-Type": PROBLEM_CONTENT_TYPE, ...NO_STORE };

function answer(status: Status, code: string, detail: string, extra: Partial<Problem> = {}, headers: Readonly<Record<string, string>> = {}): ProblemAnswer {
  return {
    status,
    body: { type: "about:blank", title: TITLES[status], status, detail, code, ...extra },
    headers: { ...PROBLEM_HEADERS, ...headers },
  };
}

/** The facts as the wire holds them: absent when there are none. */
function facts(data: Readonly<Record<string, unknown>> | undefined): { data?: Record<string, unknown> } {
  return data === undefined || Object.keys(data).length === 0 ? {} : { data: { ...data } };
}

/** A field issue as the wire holds it: without the value received, and without empty facts. */
export function fieldProblemOf(issue: FieldIssue): FieldProblem {
  const data = Object.fromEntries(Object.entries(issue.data).filter(([name]) => name !== "value"));
  return { code: issue.code, detail: issue.detail, pointer: issue.pointer, ...facts(data) };
}

const CODES = {
  invalid: "invalid-request",
  malformed: "malformed-json",
  authentication: "authentication-required",
  permission: "permission-missing",
  company: "company-required",
  browserOnly: "browser-only",
  notFound: "not-found",
  method: "method-not-allowed",
  keyInUse: "idempotency-key-in-use",
  tooLarge: "payload-too-large",
  mediaType: "unsupported-media-type",
  keyReused: "idempotency-key-reused",
  internal: "internal-error",
  origin: "origin-not-allowed",
  attempts: "too-many-attempts",
  busy: "server-busy",
} as const satisfies Record<string, ProblemCode>;

/** The header of a refusal that the caller may send again later: its whole seconds. */
function retryAfter(seconds: number): Readonly<Record<string, string>> {
  return { "Retry-After": String(seconds) };
}

/** A refusal of the runner as problem details. */
export function problemOf(refusal: Refusal): ProblemAnswer {
  switch (refusal.kind) {
    case "authentication-required":
      return answer(
        401,
        CODES.authentication,
        "The request names no actor. Sign in first: a browser sends its session cookie, and a program its token in the Authorization header.",
        {},
        { "WWW-Authenticate": "Bearer" },
      );
    case "company-required":
      return answer(403, CODES.company, "The operation works in a company, and the request's credential names none. Choose a company first.");
    case "permission-missing":
      return answer(403, CODES.permission, `The actor lacks the permission ${refusal.permission}, which this operation needs.`, {
        permission: refusal.permission,
      });
    case "invalid":
      return answer(400, CODES.invalid, "The request does not fit the operation. Each field problem names its field.", {
        errors: refusal.problems.map(fieldProblemOf),
      });
    case "rule": {
      const { code, detail, pointer, data } = refusal.refusal;
      return answer(422, code, detail, { ...(pointer === undefined ? {} : { pointer }), ...facts(data) });
    }
    case "idempotency-key-in-use":
      return answer(409, CODES.keyInUse, "Another request with this idempotency key is still running. Send the request again when it has ended.");
    case "idempotency-key-reused":
      return answer(422, CODES.keyReused, "This idempotency key belongs to another request. A new request takes a new key.");
    case "too-many-attempts":
      return answer(
        429,
        CODES.attempts,
        "Too many failed attempts. Wait the seconds that Retry-After gives before the next one.",
        {},
        retryAfter(refusal.retryAfterSeconds),
      );
    case "server-busy":
      return answer(
        503,
        CODES.busy,
        "The server checks as many passwords as it can at once. Send the request again after the seconds that Retry-After gives.",
        {},
        retryAfter(refusal.retryAfterSeconds),
      );
  }
}

/** The answer to a body that is not JSON, or not in UTF-8. */
export function malformedJson(): ProblemAnswer {
  return answer(400, CODES.malformed, "The body is not valid JSON in UTF-8.");
}

/** The answer to a body over the limit of 1 MiB. */
export function payloadTooLarge(): ProblemAnswer {
  return answer(413, CODES.tooLarge, "The body is larger than 1 MiB.");
}

/** The answer to a body that is not application/json. */
export function unsupportedMediaType(): ProblemAnswer {
  return answer(415, CODES.mediaType, "The body must be application/json.");
}

/** The answer to a path that no operation has. */
export function notFound(): ProblemAnswer {
  return answer(404, CODES.notFound, "No operation has this path. Paths are case-sensitive and have no trailing slash.");
}

/** The answer to a known path with a method it does not take. */
export function methodNotAllowed(allow: readonly string[]): ProblemAnswer {
  const methods = allow.join(", ");
  return answer(405, CODES.method, `The path takes only ${methods}.`, {}, { Allow: methods });
}

/** The answer to a request to /mcp from a browser origin that may not call it. */
export function originNotAllowed(): ProblemAnswer {
  return answer(403, CODES.origin, "The Origin header names a site that may not call /mcp. A program that is not a browser sends no Origin.");
}

/** The answer of /v1 to a request that another site may have started (auth/origin.ts). */
export function crossSiteRequest(): ProblemAnswer {
  return answer(
    403,
    CODES.origin,
    "The request's Origin is not the install's own site. A browser's write with the session cookie, and a sign-in, come only from there.",
  );
}

/** The answer to an MCP call of an operation that serves the browser's session. */
export function browserOnly(): ProblemAnswer {
  return answer(403, CODES.browserOnly, "This operation serves the browser's sign-in. An MCP client signs in through OAuth.");
}

/** The answer to an error the server did not expect: nothing of the error reaches it. */
export function internalError(): ProblemAnswer {
  return answer(500, CODES.internal, "The server failed. The answer holds no detail of the error, and the server has logged it.");
}
