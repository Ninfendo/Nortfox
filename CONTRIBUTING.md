# Contributing to NortFox

Thank you for helping. Two documents come first:

- [docs/plan.md](docs/plan.md): what NortFox is, the build order, and how a slice is built.
- [AGENTS.md](AGENTS.md): the rules for every change, by a person or an AI agent.

## Set up

You need Node 24 (see `.nvmrc`) and pnpm 12.16.1 (the version in `package.json`). Nothing else.

```sh
pnpm install   # also points git at the hooks in .githooks
pnpm check     # what CI runs: the names check, lint, type check, tests with coverage, build
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

## The names check

The owner keeps a private list of names that must never appear in the repository ([decision 11](docs/decisions/0011-names-policy.md)). The list is not in the repository in any form. The check runs in the git hooks and in CI.

- Without the list on your machine, the hooks print a one-line note and pass. CI checks every pull request.
- When the check fails, it shows only the place: the file and line, or a field such as the PR title. Reword the text at that place.
- Never try to work out the list, and never work around the check.

## Pull requests

- One slice or one fix per PR, with its tests and, when users will notice it, a changeset.
- Every new rule has tests, and every new guard has a test that shows it fails on a bad input.
- No PR lowers a coverage floor, switches off a lint rule or skips a check.
- Test data is made up: fictional companies and people. Never personal data or real company data.
- Commit messages, the PR title and the PR body are written with the same care as code. A merge is a squash, so the title and body become the commit on `main`.

A PR can merge when four checks pass on its head commit:

- **CI OK**: every CI job passed.
- **Owner OK**: the names check found nothing, and a PR that changes an owner path (`.github/owner-paths.txt`) carries the owner's approval.
- **Outside approval**: the owner wrote the PR or approved its head commit.
- **Review OK**: the owner's code review passed it.

Maintainers merge pull requests by hand. GitHub holds the CI of a first-time contributor until a maintainer approves the run, so a first PR may wait a little before its checks start.

## Licence of contributions

NortFox is under the GNU Affero General Public License v3.0 only, and so are contributions to it. Each source file starts with its `SPDX-License-Identifier` line.

The API client in `packages/client` and the API description `packages/client/openapi.json` are under the MIT licence, so that any program can use them ([decision 4](docs/decisions/0004-licences.md)). They are generated from the server's routes. A contribution to the routes is therefore also offered under the MIT licence for those generated files.

## Security

A security problem goes to a private report, never to a public issue. See [SECURITY.md](SECURITY.md).

## Conduct

Everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
