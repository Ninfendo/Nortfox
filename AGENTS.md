# Working on NortFox

These are the rules for every change to this repository, by a person or by an AI agent. Read them before your first commit.

- The plan, with the build order and the rules for a slice: [docs/plan.md](docs/plan.md)
- The choices that are hard to undo: [docs/decisions/](docs/decisions/)

NortFox is an open-source Swedish accounting system. Everything in it works through the API and through MCP; a screen is one client of the API, never the only way in. The ledger law lives in PostgreSQL. Money is never a JavaScript number.

## What never enters the repository

- **Protected names.** The owner keeps a private list of names that must never appear in the repository, in any case or spelling. That covers file contents, file and folder names, code, comments, tests, fixtures, docs, commit messages, branch names, PR titles and bodies, and issue texts. The list is not in the repository in any form, so reading the code will not tell you what is on it. The names check knows it ([plan, section 6](docs/plan.md#the-names-check)).
- When the names check fails on a PR from the owner's account, which is how you work, it shows only the file and line, or the field. Reword that text. On a PR from any other account it shows only how many places there are. Never try to work out the list, for example by probing the check with guesses, and never work around the check.
- The tools, services and open standards that NortFox is built on or connects to may be named, for example PostgreSQL, Hono or BankID.
- **Never:** personal data, real company data, private e-mail addresses, internal hostnames or IP addresses, or issue numbers of other repositories.
- **Test data is made up:** fictional companies and people, and the test identity and organisation numbers on [the fixture guard's list](scripts/fixtures/test-values.txt). Nothing is recorded from a real account. A file made by another program has its program record and its metadata rewritten. A file from a third party carries a note with its source and its terms.
- **The marker file.** A folder that holds a `.protected-name-ok` marker may name one other system, but only the folder on the owner's marker allowlist counts. It is for one import adapter ([decision 11](docs/decisions/0011-names-policy.md)). Never add, move or delete a marker.

## How you work

- Work in your own git worktree, on your own branch, made from the latest `origin/main`. Never work in the main checkout, and never push to `main`.
- One slice, one PR. The slices are in section 5 of the plan. If a slice grows, push what is finished and open the next PR for the rest.
- Everything for a slice is in its PR: the migration, the engine logic, the contract operations, the server module, the screens, the docs that change, the tests, and a changeset for what users will notice.
- A new feature starts as an operation in `packages/contract`. REST, `openapi.json`, the client and the MCP tool follow from it.
- No quiet loosening: never lower a coverage floor, switch off a lint rule, add `--passWithNoTests`, or skip a guard.
- Shell scripts start with `set -euo pipefail`.
- Before you push, run locally what CI runs. The root `package.json` holds the scripts once the frame (step 1) is in place.

## Commits and pull requests

- Commit as the identity in the repository's git config. Check `git config user.email` in your worktree before your first commit.
- An AI agent ends every commit message with a `Co-Authored-By:` line that names the agent and its model, for example `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- An AI agent ends every PR body with the line its tool adds, for example `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Merges are squash only, so the PR title and body become the commit on `main`. Write them with the same care as code, and keep them free of everything in the first section.

## The required checks

`main` merges a PR only when all five pass on its head commit ([plan, section 6](docs/plan.md#the-required-checks)):

- **CI OK:** every CI job passed.
- **Names:** the names check found nothing.
- **Owner OK:** Names passed, and a PR that changes an owner path (`.github/owner-paths.txt`) carries the owner-ok label on its head commit.
- **Outside approval:** the PR comes from the owner's account, or the owner approved its head commit. A PR comes from the owner's account only when the owner opened it from a branch in this repository or in the owner's own fork.
- **Review OK:** the owner's review agent passed the PR's head commit.

Never post any of these checks yourself: not by the API, and not through a job or a commit status that carries one of their names. Only the owner's review agent posts Review OK.

## What only the owner does

You work as the owner's GitHub account, so GitHub cannot tell what you do from what the owner does. These rules, and the owner's local setup, keep the two apart.

- Only the owner sets the owner-ok label. Never add it or remove it; the approval workflow removes it when a new commit is pushed.
- Only the owner reviews a PR from another account, and only the owner starts its approval checks. Never approve such a PR, ask for changes on it or dismiss a review of it. Never do anything to it that starts an approval run. Each of these starts one: a push to its branch, an edit of its title, body or base, marking it ready for review, adding or removing a label of any kind, reopening it, and re-running its checks. Outside approval and Names trust a review and a run from the owner's account, and in such a run Names reads the PR with the list ([plan, section 6](docs/plan.md#the-names-check)).
- Only the owner takes over work from another account, after reading it. The owner makes the changes again as new commits on the owner's machine, where the git hooks check them with the list, runs `pnpm names`, and pushes those commits to a branch of this repository. Never push another account's commits or branch to this repository: on a PR from the owner's account, Names shows where it finds a name, also in text that the other account wrote. Never open a PR from a branch in another account's fork. That account can push to the branch, so the checks treat the PR as one from that account.
- A PR whose author is not the owner's account is merged only by the owner, by hand, after reading its whole diff. Never merge such a PR. A check can be faked by a job that the PR adds, so a green PR from someone else is not safe to merge ([plan, section 6](docs/plan.md#where-the-checks-come-from)).
- Never merge with `--admin`, and never bypass branch protection.
- Never change the repository's settings, branch protection, rulesets, environments, secrets or GitHub Apps.

When a check fails, read its log and fix the cause in your branch.
