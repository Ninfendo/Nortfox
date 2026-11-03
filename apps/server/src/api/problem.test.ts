// SPDX-License-Identifier: AGPL-3.0-only

import { PROBLEM_CODES, Problem } from "@nortfox/contract";
import { describe, expect, it } from "vitest";
import { fieldProblemOf, internalError, methodNotAllowed, notFound, problemOf, type ProblemAnswer } from "./problem.ts";

const JSON_PROBLEM = { "Content-Type": "application/problem+json" };

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
