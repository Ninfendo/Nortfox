# Contributing to NortFox

Thank you for helping. Two documents come first:

- [docs/plan.md](docs/plan.md): what NortFox is, the build order, and how a slice is built.
- [AGENTS.md](AGENTS.md): the rules for every change, by a person or an AI agent.

## Set up

You need Node 24 (see `.nvmrc`) and pnpm 12.16.1 (the version in `package.json`). Nothing else.

```sh
pnpm install   # also points git at the hooks in .githooks
pnpm check     # what CI runs: the names check, the fixture guard, lint, type check, tests with coverage, build
```

Other commands:

| Command | What it does |
| --- | --- |
| `pnpm --filter @nortfox/server dev` | Runs the server on port 4100 (`PORT` changes it). |
| `pnpm --filter @nortfox/web dev` | Runs the web app. It passes `/v1` to the server on port 4100. |
| `pnpm test` | Runs every test suite once. `pnpm test:coverage` also checks the coverage floors. |
| `pnpm openapi` | After a change to the API: writes `packages/client/openapi.json` and the generated client. CI fails when they are out of date. |
| `pnpm changeset` | Records what users will notice in your change. |
| `pnpm names` | Runs the names check over every file. |
| `pnpm fixtures` | Runs the fixture guard over every file. |

## The names check

The owner keeps a private list of names that must never appear in the repository ([decision 11](docs/decisions/0011-names-policy.md)). The list is not in the repository in any form. The check runs in the git hooks and in CI.

- Without the list on your machine, the hooks print a one-line note and pass. CI checks every pull request.
- It checks the files and their paths, the PR title and body, the commit message that the squash merge will write, the name and e-mail address it will give the PR's author, the branch name, and each commit's message and the name and e-mail address of its author and committer. The squash merge names the GitHub account that opened the PR, by its profile name and its noreply or public e-mail address.
- When the check fails on a PR from the owner's account, it shows only the place: the file and line, or a field such as the PR title. Reword the text at that place.
- A PR from any other account is checked in a run that the owner starts, after the owner has approved its head commit. A failure then says only how many places there are, never where, and the owner tells you what to change. Until the owner starts that run, and again after each push or edit of yours, Names fails and waits for the owner.
- Never try to work out the list, and never work around the check.

## The fixture guard

Test data is made up ([plan, section 6](docs/plan.md#6-how-a-slice-is-built)). The fixture guard (`scripts/fixtures`) refuses a value in a file, or in a file's path, that looks like real personal data:

- a personal identity number (personnummer) or a coordination number (samordningsnummer), in 10 or 12 digits, with or without the `-` or `+`, when its date and its check digit are valid;
- an organisation number, as `NNNNNN-NNNN` or with `16` in front, when its group digit, its third digit and its check digit are valid;
- an e-mail address, unless it is at `example.com`, `example.net` or `example.org`, under `.example`, `.test`, `.invalid` or `.localhost`, or a GitHub noreply address.

A number with a wrong date or check digit passes, so hashes, versions and timestamps do not trip the guard. A made-up reference with a Luhn check digit, such as an OCR number, can still look like an identity number: give it a length other than 10 or 12 digits, or first digits that are not a date. A value on [the list of test values](scripts/fixtures/test-values.txt) passes too: Skatteverket's published test numbers and one no-reply address, each with its source. Use those in tests and fixtures. Add a number only from a published test series, and give its source.

The guard runs in `pnpm check`, in CI, and in the pre-commit hook over the staged files. It names the file and line and the kind of value, never the value. It refuses a binary file, because it cannot read one yet. In `pnpm-lock.yaml` it skips pnpm's integrity digests, which are random data.

## Pull requests

- One slice or one fix per PR, with its tests and, when users will notice it, a changeset.
- Every new rule has tests, and every new guard has a test that shows it fails on a bad input.
- No PR lowers a coverage floor, switches off a lint rule or skips a check.
- Test data is made up: fictional companies and people, and the values on the fixture guard's list. Never personal data or real company data.
- Commit messages, the PR title and the PR body are written with the same care as code. A merge is a squash, so the title and body become the commit on `main`.

A PR can merge when five checks pass on its head commit:

- **CI OK**: every CI job passed.
- **Names**: the names check found nothing in the PR's files, paths, commits, title, body, author and branch name.
- **Owner OK**: the names check passed, and a PR that changes an owner path carries the owner-ok label, set by the owner on its head commit. A push after the label removes it, and Owner OK fails until the owner sets it again. The owner paths (`.github/owner-paths.txt`) are the database migrations, the licence files and the exceptions to the names rule, and the list itself. Nothing else needs the label.
- **Outside approval**: the owner opened the PR from a branch in this repository or in the owner's own fork, or the owner approved its head commit. A PR that the owner opens from a branch in another account's fork counts as from another account, because that account can push to the branch. A review starts no check run. After approving a PR from another account, the owner re-runs the failed jobs of its latest Approvals run. After asking for changes or dismissing a review, the owner re-runs all of that run's jobs. A PR that Dependabot opened is from another account too, but there a re-run keeps Dependabot's rights, and GitHub gives such a run no secrets, so Names fails without the list. On such a PR the owner starts a new run from the owner's account instead: the owner adds a label, any but owner-ok, and removes it again.
- **Review OK**: the owner's review agent passed it. It is a commit status that the review agent posts.

The owner merges a pull request from another account by hand, after reading the whole diff; agents never merge such a pull request. Just before that merge, the owner runs its approval checks again: all the jobs of its latest Approvals run, or on a PR that Dependabot opened, a new run started by adding a label and removing it again. Its author can change the name on their GitHub account at any time, and that starts no run. Pull requests from the owner's own account are approved by the review agent. GitHub holds the CI of a first-time contributor until the owner approves the run, so a first PR may wait a little before its checks start.

## Licence of contributions

NortFox is under the GNU Affero General Public License v3.0 only, and so are contributions to it. Each source file starts with one `SPDX-License-Identifier` line: exactly `AGPL-3.0-only`, or exactly `MIT` in `packages/client`.

The API client in `packages/client` and the API description `packages/client/openapi.json` are under the MIT licence, so that any program can use them ([decision 4](docs/decisions/0004-licences.md)). They are generated from the server's routes. A contribution to the routes is therefore also offered under the MIT licence for those generated files.

## Security

A security problem goes to a private report, never to a public issue. See [SECURITY.md](SECURITY.md).

## Conduct

Everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
