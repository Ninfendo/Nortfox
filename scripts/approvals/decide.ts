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

/** The repository that holds a PR's branch, and the account that owns it. */
export interface HeadRepository {
  /** "<owner>/<name>". */
  readonly fullName: string;
  readonly owner: string;
}

/** Who wrote a PR, and where its branch is. */
export interface Origin {
  readonly owner: string;
  readonly author: string;
  /** The repository the PR is in: "<owner>/<name>". */
  readonly repository: string;
  /** Undefined when the fork that held the branch is gone. */
  readonly head: HeadRepository | undefined;
}

/**
 * Whether a PR comes from the owner's account: the owner opened it, from a
 * branch in this repository or in a fork that the owner owns. Anyone who can
 * push to the PR's branch can change what the checks read, so a PR that the
 * owner opened from another account's fork counts as from outside.
 */
export function fromOwnersAccount(origin: Origin): boolean {
  return (
    origin.author === origin.owner &&
    origin.head !== undefined &&
    (origin.head.fullName === origin.repository || origin.head.owner === origin.owner)
  );
}

/**
 * Outside approval: a PR from the owner's account passes. Any other PR passes
 * only when the owner's latest deciding review approves its head commit.
 * `reviews` are in the order GitHub lists them, oldest first.
 */
export function decideOutsideApproval(
  input: Origin & {
    readonly headSha: string;
    readonly reviews: readonly Review[];
  },
): Verdict {
  if (fromOwnersAccount(input)) {
    return { pass: true, why: "The PR comes from the owner's account." };
  }
  const latest = input.reviews
    .filter((review) => review.login === input.owner && DECIDING_STATES.has(review.state))
    .at(-1);
  if (latest === undefined) {
    return {
      pass: false,
      why:
        input.author === input.owner
          ? "The owner opened this PR from a branch in another account's fork, and that account can push to it. So it needs the owner's approval of its head commit, which GitHub does not let the owner give to their own PR. Open it again from a branch in this repository."
          : "The owner has not approved this PR yet.",
    };
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

/** When and by whom the owner-ok label was last set. */
export interface LabelEvent {
  readonly actor: string;
  /** An ISO 8601 time, as the API gives it. */
  readonly at: string;
}

/** The last push to the PR's branch: the commit it left the branch at, and when. */
export interface BranchMove {
  readonly after: string;
  readonly at: string;
}

/**
 * Whether the owner-ok label counts: only for the head commit it was set on
 * (docs/plan.md, section 6). GitHub keeps no commit with a label, so this
 * compares times. The owner must have set the label after the last push to
 * the PR's branch, and that push must have left the branch at the PR's head
 * commit. Anything that cannot be read or does not add up fails, so a missed
 * or failed run never leaves a label that passes later.
 */
export function decideLabelHolds(input: {
  readonly owner: string;
  readonly headSha: string;
  readonly label: LabelEvent | undefined;
  readonly lastMove: BranchMove | undefined;
}): Verdict {
  const { label, lastMove } = input;
  if (label === undefined) {
    return { pass: false, why: "GitHub has no record of who set the owner-ok label, or when." };
  }
  if (label.actor !== input.owner) {
    return { pass: false, why: "The owner-ok label was set by an account that is not the owner's." };
  }
  if (lastMove?.after !== input.headSha) {
    return {
      pass: false,
      why: "The history of the PR's branch does not end at the PR's head commit, so the label cannot be tied to it.",
    };
  }
  if (!(Date.parse(label.at) > Date.parse(lastMove.at))) {
    return {
      pass: false,
      why: "The owner-ok label was set before the last push to the PR's branch. It counts only for the head commit it was set on.",
    };
  }
  return { pass: true, why: "The owner set the owner-ok label on the PR's head commit." };
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
