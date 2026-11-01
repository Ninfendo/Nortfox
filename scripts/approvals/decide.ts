// SPDX-License-Identifier: AGPL-3.0-only

// The decisions behind "Outside approval" and "Owner OK" (docs/plan.md,
// section 6). They take plain data, so the tests can feed them every case.

import { ownerPathsIn } from "./owner-paths.ts";

export const OWNER_OK_LABEL = "owner-ok";

export interface Verdict {
  readonly pass: boolean;
  readonly why: string;
}

export interface Review {
  readonly login: string;
  readonly state: string;
  readonly commitId: string;
}

/** Review states that change whether a PR is approved. A comment does not. */
const DECIDING_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

/**
 * Outside approval: a PR from the owner's account passes. Any other PR passes
 * only when the owner's latest deciding review approves its head commit.
 * `reviews` are in the order GitHub lists them, oldest first.
 */
export function decideOutsideApproval(input: {
  readonly owner: string;
  readonly author: string;
  readonly headSha: string;
  readonly reviews: readonly Review[];
}): Verdict {
  if (input.author === input.owner) {
    return { pass: true, why: "The PR comes from the owner's account." };
  }
  const latest = input.reviews
    .filter((review) => review.login === input.owner && DECIDING_STATES.has(review.state))
    .at(-1);
  if (latest === undefined) {
    return { pass: false, why: "The owner has not approved this PR yet." };
  }
  if (latest.state !== "APPROVED") {
    return { pass: false, why: "The owner's latest review does not approve this PR." };
  }
  if (latest.commitId !== input.headSha) {
    return { pass: false, why: "The owner approved an earlier commit. The new commits need the owner's approval too." };
  }
  return { pass: true, why: "The owner approved this PR's head commit." };
}

/**
 * Owner OK: fails when the names check did not pass. Otherwise it passes when
 * no changed file is an owner path, or when the PR carries the owner-ok label.
 * `paths` are the changed files, with the old name of a renamed file too.
 */
export function decideOwnerOk(input: {
  readonly namesResult: string;
  readonly paths: readonly string[];
  readonly globs: readonly string[];
  readonly labels: readonly string[];
}): Verdict & { readonly ownerPaths: readonly string[] } {
  if (input.namesResult !== "success") {
    return {
      pass: false,
      why: `The names check did not pass (${input.namesResult}). Owner OK waits for it.`,
      ownerPaths: [],
    };
  }
  const ownerPaths = ownerPathsIn(input.paths, input.globs);
  if (ownerPaths.length === 0) {
    return { pass: true, why: "The PR changes no owner path.", ownerPaths };
  }
  if (input.labels.includes(OWNER_OK_LABEL)) {
    return { pass: true, why: "The PR changes owner paths, and the owner set the owner-ok label.", ownerPaths };
  }
  return {
    pass: false,
    why: "The PR changes owner paths. Owner OK passes when the owner sets the owner-ok label.",
    ownerPaths,
  };
}

/**
 * After a push: the owner-ok label goes when the new commits touch an owner
 * path, or when the push cannot be read as plain new commits on top of the old
 * head (a force push, or more files than the API lists).
 */
export function labelMustGo(input: {
  readonly compareStatus: string | undefined;
  readonly pushedPaths: readonly string[];
  readonly complete: boolean;
  readonly globs: readonly string[];
}): boolean {
  if (input.compareStatus !== "ahead" || !input.complete) {
    return true;
  }
  return ownerPathsIn(input.pushedPaths, input.globs).length > 0;
}

/** CI OK: every job it needs succeeded. Failed, cancelled and skipped all fail. */
export function decideCiOk(needs: unknown): Verdict & { readonly lines: readonly string[] } {
  if (typeof needs !== "object" || needs === null || Array.isArray(needs)) {
    return { pass: false, why: "CI OK got no list of jobs.", lines: [] };
  }
  const entries = Object.entries(needs as Record<string, unknown>);
  if (entries.length === 0) {
    return { pass: false, why: "CI OK needs at least one job.", lines: [] };
  }
  const lines = entries.map(([job, value]) => {
    const result =
      typeof value === "object" && value !== null && "result" in value && typeof value.result === "string"
        ? value.result
        : "unknown";
    return `${job}: ${result}`;
  });
  const failed = lines.filter((line) => !line.endsWith(": success"));
  return failed.length === 0
    ? { pass: true, why: "Every CI job passed.", lines }
    : { pass: false, why: `${String(failed.length)} CI job(s) did not succeed.`, lines };
}
