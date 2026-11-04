// SPDX-License-Identifier: AGPL-3.0-only

import { PROBLEM_CODES, Problem } from "@nortfox/contract";
import { describe, expect, it } from "vitest";
import {
  browserOnly,
  fieldProblemOf,
  internalError,
  malformedJson,
  methodNotAllowed,
  notFound,
  originNotAllowed,
  payloadTooLarge,
  problemOf,
  unsupportedMediaType,
  type ProblemAnswer,
} from "./problem.ts";

/** Every problem answer is application/problem+json, and no cache keeps it. */
const JSON_PROBLEM = { "Content-Type": "application/problem+json", "Cache-Control": "no-store" };

/** Every answer is problem details that the contract's schema takes, with a code it lists at its status. */
function expectProblem(answer: ProblemAnswer): void {
  expect(Problem.safeParse(answer.body).success, JSON.stringify(answer.body)).toBe(true);
  expect(answer.body.status).toBe(answer.status);
  expect(answer.body.type).toBe("about:blank");
  if (Object.hasOwn(PROBLEM_CODES, answer.body.code)) {
    expect(PROBLEM_CODES[answer.body.code as keyof typeof PROBLEM_CODES]).toBe(answer.status);
  }
}

describe("problemOf", () => {
  it("answers no actor with 401, the Bearer challenge and authentication-required", () => {
    const answer = problemOf({ kind: "authentication-required" });
    expectProblem(answer);
    expect(answer).toEqual({
      status: 401,
      headers: { ...JSON_PROBLEM, "WWW-Authenticate": "Bearer" },
      body: {
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        detail: "The request names no actor. Send a credential in the Authorization header.",
        code: "authentication-required",
      },
    });
  });

  it("answers a missing permission with 403, permission-missing and the permission", () => {
    const answer = problemOf({ kind: "permission-missing", permission: "company:read" });
    expectProblem(answer);
    expect(answer).toEqual({
      status: 403,
      headers: JSON_PROBLEM,
      body: {
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail: "The actor lacks the permission company:read, which this operation needs.",
        code: "permission-missing",
        permission: "company:read",
      },
    });
  });

  it("answers a credential that names no company with 403 company-required, for an operation in the credential's company", () => {
    const answer = problemOf({ kind: "company-required" });
    expectProblem(answer);
    expect(answer).toEqual({
      status: 403,
      headers: JSON_PROBLEM,
      body: {
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail: "The operation works in a company, and the request's credential names none. Choose a company first.",
        code: "company-required",
      },
    });
  });

  it("answers an invalid request with 400 and a field problem per issue, without the value received", () => {
    const answer = problemOf({
      kind: "invalid",
      problems: [
        { code: "unknown-parameter", detail: "The field /Limit is not part of this operation.", pointer: "/Limit", data: { value: "5" } },
        { code: "invalid-type", detail: "The field /limit must be a number.", pointer: "/limit", data: { expected: "number", value: "abc" } },
        { code: "missing-field", detail: "The field /name is missing.", pointer: "/name", data: {} },
      ],
    });
    expectProblem(answer);
    expect(answer).toEqual({
      status: 400,
      headers: JSON_PROBLEM,
      body: {
        type: "about:blank",
        title: "Bad Request",
        status: 400,
        detail: "The request does not fit the operation. Each field problem names its field.",
        code: "invalid-request",
        errors: [
          { code: "unknown-parameter", detail: "The field /Limit is not part of this operation.", pointer: "/Limit" },
          { code: "invalid-type", detail: "The field /limit must be a number.", pointer: "/limit", data: { expected: "number" } },
          { code: "missing-field", detail: "The field /name is missing.", pointer: "/name" },
        ],
      },
    });
  });

  it("answers a rule's refusal with 422, its code, its pointer and its facts", () => {
    const answer = problemOf({
      kind: "rule",
      refusal: { code: "amount-not-positive", detail: "The amount must be more than zero.", pointer: "/amount", data: { amount: "0.00" } },
    });
    expectProblem(answer);
    expect(answer).toEqual({
      status: 422,
      headers: JSON_PROBLEM,
      body: {
        type: "about:blank",
        title: "Unprocessable Content",
        status: 422,
        detail: "The amount must be more than zero.",
        code: "amount-not-positive",
        pointer: "/amount",
        data: { amount: "0.00" },
      },
    });
  });

  it("answers a key that a running request holds with 409 idempotency-key-in-use", () => {
    const answer = problemOf({ kind: "idempotency-key-in-use" });
    expectProblem(answer);
    expect(answer).toEqual({
      status: 409,
      headers: JSON_PROBLEM,
      body: {
        type: "about:blank",
        title: "Conflict",
        status: 409,
        detail: "Another request with this idempotency key is still running. Send the request again when it has ended.",
        code: "idempotency-key-in-use",
      },
    });
  });

  it("answers a key that belongs to another request with 422 idempotency-key-reused", () => {
    const answer = problemOf({ kind: "idempotency-key-reused" });
    expectProblem(answer);
    expect(answer).toEqual({
      status: 422,
      headers: JSON_PROBLEM,
      body: {
        type: "about:blank",
        title: "Unprocessable Content",
        status: 422,
        detail: "This idempotency key belongs to another request. A new request takes a new key.",
        code: "idempotency-key-reused",
      },
    });
  });

  it("leaves out a rule's pointer and facts when it has none", () => {
    const answer = problemOf({ kind: "rule", refusal: { code: "description-missing", detail: "The voucher has no description.", data: {} } });
    expectProblem(answer);
    expect(answer.body).toEqual({
      type: "about:blank",
      title: "Unprocessable Content",
      status: 422,
      detail: "The voucher has no description.",
      code: "description-missing",
    });
    expect(problemOf({ kind: "rule", refusal: { code: "no-fiscal-year", detail: "No fiscal year holds the date." } }).body).toEqual({
      type: "about:blank",
      title: "Unprocessable Content",
      status: 422,
      detail: "No fiscal year holds the date.",
      code: "no-fiscal-year",
    });
  });
});

describe("fieldProblemOf", () => {
  it("keeps the code, the detail, the pointer and the facts, and leaves out the value", () => {
    expect(fieldProblemOf({ code: "too-long", detail: "d", pointer: "/a", data: { maximum: 200, value: "x" } })).toEqual({
      code: "too-long",
      detail: "d",
      pointer: "/a",
      data: { maximum: 200 },
    });
    expect(fieldProblemOf({ code: "unknown-field", detail: "d", pointer: "", data: {} })).toEqual({ code: "unknown-field", detail: "d", pointer: "" });
  });
});

describe("the answers of the surface itself", () => {
  it("answers an unknown path with 404 not-found", () => {
    const answer = notFound();
    expectProblem(answer);
    expect(answer).toEqual({
      status: 404,
      headers: JSON_PROBLEM,
      body: {
        type: "about:blank",
        title: "Not Found",
        status: 404,
        detail: "No operation has this path. Paths are case-sensitive and have no trailing slash.",
        code: "not-found",
      },
    });
  });

  it("answers another method with 405 method-not-allowed and the methods in Allow", () => {
    const answer = methodNotAllowed(["GET", "HEAD"]);
    expectProblem(answer);
    expect(answer).toEqual({
      status: 405,
      headers: { ...JSON_PROBLEM, Allow: "GET, HEAD" },
      body: {
        type: "about:blank",
        title: "Method Not Allowed",
        status: 405,
        detail: "The path takes only GET, HEAD.",
        code: "method-not-allowed",
      },
    });
  });

  it("answers a body that is not JSON with 400 malformed-json", () => {
    const answer = malformedJson();
    expectProblem(answer);
    expect(answer).toEqual({
      status: 400,
      headers: JSON_PROBLEM,
      body: { type: "about:blank", title: "Bad Request", status: 400, detail: "The body is not valid JSON in UTF-8.", code: "malformed-json" },
    });
  });

  it("answers a body over the limit with 413 payload-too-large", () => {
    const answer = payloadTooLarge();
    expectProblem(answer);
    expect(answer).toEqual({
      status: 413,
      headers: JSON_PROBLEM,
      body: { type: "about:blank", title: "Content Too Large", status: 413, detail: "The body is larger than 1 MiB.", code: "payload-too-large" },
    });
  });

  it("answers a body that is not application/json with 415 unsupported-media-type", () => {
    const answer = unsupportedMediaType();
    expectProblem(answer);
    expect(answer).toEqual({
      status: 415,
      headers: JSON_PROBLEM,
      body: {
        type: "about:blank",
        title: "Unsupported Media Type",
        status: 415,
        detail: "The body must be application/json.",
        code: "unsupported-media-type",
      },
    });
  });

  it("answers a request to /mcp from an origin that may not call it with 403 origin-not-allowed", () => {
    const answer = originNotAllowed();
    expectProblem(answer);
    expect(answer).toEqual({
      status: 403,
      headers: JSON_PROBLEM,
      body: {
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail: "The Origin header names a site that may not call /mcp. A program that is not a browser sends no Origin.",
        code: "origin-not-allowed",
      },
    });
  });

  it("answers an MCP call of an operation that serves the browser's session with 403 browser-only", () => {
    const answer = browserOnly();
    expectProblem(answer);
    expect(answer).toEqual({
      status: 403,
      headers: JSON_PROBLEM,
      body: {
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail: "This operation serves the browser's sign-in. An MCP client signs in through OAuth.",
        code: "browser-only",
      },
    });
  });

  it("answers an error of the server with 500 internal-error and a fixed detail", () => {
    const answer = internalError();
    expectProblem(answer);
    expect(answer).toEqual({
      status: 500,
      headers: JSON_PROBLEM,
      body: {
        type: "about:blank",
        title: "Internal Server Error",
        status: 500,
        detail: "The server failed. The answer holds no detail of the error, and the server has logged it.",
        code: "internal-error",
      },
    });
  });
});
