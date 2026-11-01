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
  /** The head commit the run judges: the one the event that started the run named. */
  readonly headSha: string;
  readonly author: string;
}

export class WrongBaseError extends Error {
  override readonly name = "WrongBaseError";
}

/** The PR moved on from what the run judges: a new head commit, title, body, branch or base. */
export class PullRequestMovedError extends Error {
  override readonly name = "PullRequestMovedError";
}

/**
 * Reads the PR named by GITHUB_REPOSITORY and PR_NUMBER. It refuses a PR that
 * is not aimed at the repository's default branch: a check that passed for a
 * PR into another branch would count for any PR with the same head commit. It
 * also refuses a PR whose head is not HEAD_SHA, the commit named by the event
 * that started the run. GitHub writes the run's verdict on that commit, so a
 * check never judges another one.
 */
export async function loadPullRequest(env: Readonly<Record<string, string | undefined>>): Promise<PullRequest> {
  const { github, repository, number } = pullRequestContext(env);
  const expected = requireEnv(env, "HEAD_SHA");
  const prefix = `/repos/${repository}`;
  const data = await github.get(`${prefix}/pulls/${String(number)}`);
  const base = field(data, "base");
  if (stringField(base, "ref") !== stringField(field(base, "repo"), "default_branch")) {
    throw new WrongBaseError(
      "The PR is not aimed at the default branch. The approval checks pass only a PR into the default branch.",
    );
  }
  const headSha = stringField(field(data, "head"), "sha");
  if (headSha !== expected) {
    throw new PullRequestMovedError(
      "The PR's head commit is not the one this run was started for. The run for its new head commit checks it.",
    );
  }
  return {
    github,
    repository,
    prefix,
    number: String(number),
    data,
    headSha,
    author: stringField(field(data, "user"), "login"),
  };
}

/** What a check reads from the PR itself: its head commit, title, body, branch and base. */
function snapshotOf(data: unknown): string {
  const head = field(data, "head");
  const body = field(data, "body");
  return JSON.stringify([
    stringField(head, "sha"),
    stringField(head, "ref"),
    stringField(data, "title"),
    typeof body === "string" ? body : "",
    stringField(field(data, "base"), "ref"),
  ]);
}

/**
 * Reads the PR again, at the end of a check, and fails when its head commit,
 * title, body, branch or base is not what the check read at the start. Every
 * such change starts a run of its own, which judges the PR as it is then.
 */
export async function requireUnchanged(pr: PullRequest): Promise<void> {
  const now = await pr.github.get(`${pr.prefix}/pulls/${pr.number}`);
  if (snapshotOf(now) !== snapshotOf(pr.data)) {
    throw new PullRequestMovedError(
      "The PR changed while the check read it, so this run gives no result. The run for that change checks it.",
    );
  }
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
