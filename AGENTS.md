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
- **The marker file.** A folder that holds a `.protected-name-ok` marker may name the established system, but only a folder on the owner's marker allowlist counts. It may hold no other protected name. There will be at most two such folders: the compatible API adapter's (slice 2e) and the import adapter's (slice 4f) ([decision 11](docs/decisions/0011-names-policy.md)). Until a folder is on the allowlist and holds its marker, nothing in it may name the established system. Nothing else may name it either. Add, move or delete a marker, or a line on the allowlist, only in the PRs that slices 2e and 4f describe.

## How you work

- Work in your own git worktree, on your own branch, made from the latest `origin/main`. Never work in the main checkout, and never push to `main`.
- One slice, one PR. The slices are in section 5 of the plan. If a slice grows, push what is finished and open the next PR for the rest.
- Each slice starts from its issue, which starts with the slice's terms. Write the tests first: turn each done-when line into a test, see it fail for the right reason, then build until it passes ([plan, section 6](docs/plan.md#6-how-a-slice-is-built)).
- Behaviour copies the established system, unless the law clearly forbids it, and the screens use its words. The look and the controls are NortFox's own. Add nothing of your own to a familiar flow ([plan, section 2](docs/plan.md#how-behaviour-is-decided)).
- Everything for a slice is in its PR: the migration, the engine logic, the contract operations, the server module, the compatible endpoint where there is one, the screens, the docs that change, the tests, and a changeset for what users will notice.
- A new feature starts as an operation in `packages/contract`. REST, `openapi.json`, the client and the MCP tool follow from it. A compatible endpoint calls the same operation ([decision 12](docs/decisions/0012-compatible-api.md)).
- No quiet loosening: never lower a coverage floor, switch off a lint rule, add `--passWithNoTests`, or skip a guard.
- Shell scripts start with `set -euo pipefail`.
- Before you push, run locally what CI runs. The root `package.json` holds the scripts once the frame (step 1) is in place.

## Commits and pull requests

- Commit as the identity in the repository's git config. Check `git config user.email` in your worktree before your first commit.
- An AI agent ends every commit message with a `Co-Authored-By:` line that names the agent and its model, for example `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- An AI agent ends every PR body with the line its tool adds, for example `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Merges are squash only, so the PR title and body become the commit on `main`. Write them with the same care as code, and keep them free of everything in the first section. A PR from Dependabot is the one exception: the agent that merges it writes the commit message ([below](#pull-requests-from-dependabot)).

## The required checks

`main` merges a PR only when all five pass on its head commit ([plan, section 6](docs/plan.md#the-required-checks)):

- **CI OK:** every CI job passed.
- **Names:** the names check found nothing.
- **Owner OK:** Names passed, and a PR that changes an owner path (`.github/owner-paths.txt`) carries the owner-ok label on its head commit. The list is empty, so no PR needs the label. Owner OK then asks for nothing beyond Names, as long as GitHub can list all the files the PR changes (at most 3000).
- **Outside approval:** the PR comes from the owner's account, or the owner's account approved its head commit. A PR comes from the owner's account only when the owner opened it from a branch in this repository or in the owner's own fork.
- **Review OK:** the owner's review agent passed the PR's head commit.

When a check fails on your PR, read its log and fix the cause in your branch.

Never post any of these checks yourself: not by the API, and not through a job or a commit status that carries one of their names. Only the owner's review agent posts Review OK.

## What only the owner does

You work as the owner's GitHub account, so GitHub cannot tell what you do from what the owner does. These rules, and the owner's local setup, keep the two apart.

Of all PRs, only those from outside contributors need the owner. An outside contributor is any account other than the owner's and Dependabot's. A PR that the owner opened from a branch in another account's fork counts as that account's, and so does a PR that Dependabot opened from anywhere but a branch in this repository.

- Only the owner sets the owner-ok label. Never add it or remove it; the approval workflow removes it when a new commit is pushed. The owner path list is empty, so no PR needs the label now.
- Only the owner reviews a PR from an outside contributor, and only the owner starts its approval checks. Never approve such a PR, ask for changes on it or dismiss a review of it. Never do anything to it that starts an approval run. Each of these starts one: a push to its branch, an edit of its title, body or base, marking it ready for review, adding or removing a label of any kind, reopening it, and re-running its checks. Outside approval and Names trust a review and a run from the owner's account, and in such a run Names reads the PR with the list ([plan, section 6](docs/plan.md#the-names-check)).
- Only the owner takes over work from another account, after reading it. The owner makes the changes again as new commits on the owner's machine, where the git hooks check them with the list, runs `pnpm names`, and pushes those commits to a branch of this repository. Never push another account's commits or branch to this repository: on a PR from the owner's account, Names shows where it finds a name, also in text that the other account wrote. Never open a PR from a branch in another account's fork. That account can push to the branch, so the checks treat the PR as one from that account.
- A PR from an outside contributor is merged only by the owner, by hand, after reading its whole diff. Never merge such a PR. A check can be faked by a job that the PR adds, so a green PR from someone else is not safe to merge ([plan, section 6](docs/plan.md#where-the-checks-come-from)).
- Never merge with `--admin`, and never bypass branch protection.
- Never change the repository's settings, branch protection, rulesets, environments, secrets or GitHub Apps.

## Pull requests from Dependabot

You review and merge a PR that Dependabot opened from a branch in this repository ([plan, section 6](docs/plan.md#where-the-checks-come-from)):

1. The owner's review agent reads its whole diff, workflows included. When it does not pass the PR, nobody approves or merges it.
2. When it passes the PR, the review agent approves the PR's head commit and posts Review OK.
3. An agent adds a label to the PR, any but owner-ok, and removes it again. That starts a new approval run from the owner's account, and in it Names reads the PR with the list. A re-run does not work on such a PR: it keeps Dependabot's rights, and GitHub gives it no secrets.
4. When all five checks pass on that head commit, the agent squash-merges the PR. It names that commit in the merge, and writes the commit message itself: Dependabot's title and the PR number as the subject, and an empty body. For example: `gh pr merge <number> --squash --match-head-commit <sha> --subject "<title> (#<number>)" --body ""`. Dependabot's body holds release notes from other projects, with their issue numbers and their authors' accounts, and none of that may reach `main`. The `names-main` job in `ci.yml` checks the message after the merge.

Branch protection merges a PR only when it is up to date with `main`, so GitHub refuses the merge of a PR that is behind, even with all five checks green. Dependabot brings its PR up to date by itself only when it has a conflict. So when the PR is behind `main`, comment `@dependabot rebase` on it. Do that before step 1 when you can, so the review is not done twice. A comment starts no approval run and no CI run. Dependabot then pushes a new commit.

Do nothing else to such a PR but that comment. Never push to its branch, never use Update branch, which is a push too, and never edit its title, body or base: each of these starts a run, and the merge message is set in the merge, not in the PR. When Dependabot pushes a new commit, the review starts again at step 1. When a check still fails after step 3, leave the PR as it is: Dependabot or the owner handles it.
