// SPDX-License-Identifier: AGPL-3.0-only

// The pull request that a check in the approval workflow judges, read through
// the API as data.

import { decideOutsideApproval, type Review, type Verdict } from "../approvals/decide.ts";
import { field, pullRequestContext, stringField, type GitHub } from "./api.ts";

export interface PullRequest {
  readonly github: GitHub;
  readonly repository: string;
  /** "/repos/<owner>/<name>". */
  readonly prefix: string;
  readonly number: string;
  /** The PR as the API gives it. */
  readonly data: unknown;
  readonly headSha: string;
  readonly author: string;
}

export class WrongBaseError extends Error {
  override readonly name = "WrongBaseError";
}

/**
 * Reads the PR named by GITHUB_REPOSITORY and PR_NUMBER. It refuses a PR that
 * is not aimed at the repository's default branch: a check that passed for a
 * PR into another branch would count for any PR with the same head commit.
 */
export async function loadPullRequest(env: Readonly<Record<string, string | undefined>>): Promise<PullRequest> {
  const { github, repository, number } = pullRequestContext(env);
  const prefix = `/repos/${repository}`;
  const data = await github.get(`${prefix}/pulls/${String(number)}`);
  const base = field(data, "base");
  if (stringField(base, "ref") !== stringField(field(base, "repo"), "default_branch")) {
    throw new WrongBaseError(
      "The PR is not aimed at the default branch. The approval checks pass only a PR into the default branch.",
    );
  }
  return {
    github,
    repository,
    prefix,
    number: String(number),
    data,
    headSha: stringField(field(data, "head"), "sha"),
    author: stringField(field(data, "user"), "login"),
  };
}

/** The PR's reviews, oldest first. */
export async function reviewsOf(pr: PullRequest): Promise<Review[]> {
  const listed = await pr.github.list(`${pr.prefix}/pulls/${pr.number}/reviews?per_page=100`);
  return listed.map((review) => ({
    login: stringField(field(review, "user"), "login"),
    state: stringField(review, "state"),
    commitId: stringField(review, "commit_id"),
  }));
}

/** Outside approval: the owner wrote the PR, or approved its head commit. */
export async function outsideApprovalOf(pr: PullRequest, owner: string): Promise<Verdict> {
  return decideOutsideApproval({ owner, author: pr.author, headSha: pr.headSha, reviews: await reviewsOf(pr) });
}

export function requireEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set.`);
  }
  return value;
}
