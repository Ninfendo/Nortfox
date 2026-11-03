// SPDX-License-Identifier: AGPL-3.0-only

// Every /v1 error is problem details (RFC 9457): application/problem+json
// with type, title, status, detail and a stable code. The type is
// about:blank, so the title is the status's phrase (RFC 9110), and the code
// says what went wrong. The texts are English until packages/i18n comes in
// slice 2d. A field problem leaves out the value received, so an answer
// never echoes its input; the runner's refusal keeps it for a surface that
// names it in its own message.

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
type Status = 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 422 | 500;

/** The phrase of each status, from RFC 9110. */
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
  500: "Internal Server Error",
};

const CONTENT_TYPE = { "Content-Type": PROBLEM_CONTENT_TYPE };

function answer(status: Status, code: string, detail: string, extra: Partial<Problem> = {}, headers: Readonly<Record<string, string>> = {}): ProblemAnswer {
  return {
    status,
    body: { type: "about:blank", title: TITLES[status], status, detail, code, ...extra },
    headers: { ...CONTENT_TYPE, ...headers },
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
  notFound: "not-found",
  method: "method-not-allowed",
  keyInUse: "idempotency-key-in-use",
  tooLarge: "payload-too-large",
  mediaType: "unsupported-media-type",
  keyReused: "idempotency-key-reused",
  internal: "internal-error",
} as const satisfies Record<string, ProblemCode>;

/** A refusal of the runner as problem details. */
export function problemOf(refusal: Refusal): ProblemAnswer {
  switch (refusal.kind) {
    case "authentication-required":
      return answer(
        401,
        CODES.authentication,
        "The request names no actor. Send a credential in the Authorization header.",
        {},
        { "WWW-Authenticate": "Bearer" },
      );
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

/** The answer to an error the server did not expect: nothing of the error reaches it. */
export function internalError(): ProblemAnswer {
  return answer(500, CODES.internal, "The server failed. The answer holds no detail of the error, and the server has logged it.");
}
