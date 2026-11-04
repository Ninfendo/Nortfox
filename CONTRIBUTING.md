# Contributing to NortFox

Thank you for helping. Two documents come first:

- [docs/plan.md](docs/plan.md): what NortFox is, the build order, and how a slice is built.
- [AGENTS.md](AGENTS.md): the rules for every change, by a person or an AI agent.

## Set up

You need Node 24, 24.7 or later, for its Argon2id (see `.nvmrc`), and pnpm 12.16.1 (the version in `package.json`). The database tests also need PostgreSQL 18. Docker is the easy way to run it.

```sh
pnpm install   # also points git at the hooks in .githooks
pnpm db:test   # starts the test database in Docker
pnpm check     # what CI runs: the names check, the fixture guard, lint, type check, tests with coverage, build
```

Other commands:

| Command | What it does |
| --- | --- |
| `pnpm --filter @nortfox/server dev` | Runs the server on port 4100 (`PORT` changes it): the API under `/v1` and MCP at `/mcp` ([docs/api.md](docs/api.md)). It reads the database from `NORTFOX_DATABASE_URL` and `NORTFOX_DATABASE_PASSWORD_FILE`, as the migrate step does ([db/README.md](db/README.md)), its own origin from `NORTFOX_PUBLIC_ORIGIN`, such as `http://localhost:5173`, and the install secret from the file that `NORTFOX_SECRET_KEY_FILE` names ([deploy/README.md](deploy/README.md)). It connects at start, for the key check. A browser signs in through `/v1/auth`; the setup link makes the first identity. |
| `pnpm --filter @nortfox/server setup-link` | Prints the setup link that makes the first identity of an empty install. It reads the database and `NORTFOX_PUBLIC_ORIGIN` as `dev` does ([deploy/README.md](deploy/README.md)). |
| `pnpm --filter @nortfox/web dev` | Runs the web app. It passes `/v1` to the server on port 4100. |
| `pnpm test` | Runs every test suite once, the database tests too. `pnpm test:coverage` also checks the coverage floors. |
| `pnpm db:test` | Starts the test database: PostgreSQL in Docker, on 127.0.0.1:55433, with its data in memory. `pnpm db:test:stop` stops it. |
| `pnpm backup:test` | Runs the point-in-time restore test: the compose file of an install in Docker, restored from each backup repository ([deploy/README.md](deploy/README.md)). It needs bash and Docker. CI runs it in the job `backup`. |
| `pnpm openapi` | After a change to the registry in `packages/contract`: writes `packages/client/openapi.json` and the generated client. CI fails when they are out of date. |
| `pnpm changeset` | Records what users will notice in your change. |
| `pnpm names` | Runs the names check over every file. |
| `pnpm fixtures` | Runs the fixture guard over every file. |

## The database tests

The ledger law lives in PostgreSQL ([decision 2](docs/decisions/0002-ledger-law-in-postgresql.md)), so its tests run against real PostgreSQL, never a mock. They are the files `apps/server/src/**/*.db.test.ts`. Each runs as the app role, unless it tests another role, in a database of its own. [db/README.md](db/README.md) says how the database works and how to add a migration.

- `pnpm db:test` starts a test cluster that holds nothing else, with trust authentication on 127.0.0.1 only. CI runs the same PostgreSQL, by the same digest, as a service of the build job.
- `NORTFOX_TEST_DATABASE_URL` points the tests at another cluster: a superuser on a cluster of its own, with trust authentication. The tests make roles, which belong to the whole cluster, so they refuse a cluster that holds any database they did not make.
- One run of the database tests holds the cluster at a time. A second run on the same cluster, from another worktree for example, says that it waits, and starts when the first ends.
- Without a test cluster, the tests fail with a line that says how to start one. They never skip.

## The names check

The owner keeps a private list of names that must never appear in the repository ([decision 11](docs/decisions/0011-names-policy.md)). The list is not in the repository in any form. The check runs in the git hooks and in CI.

- Without the list on your machine, the hooks print a one-line note and pass. CI checks every pull request.
- It checks the files and their paths, the PR title and body, the commit message that the squash merge will write, the name and e-mail address it will give the PR's author, the branch name, and each commit's message and the name and e-mail address of its author and committer. The squash merge names the GitHub account that opened the PR, by its profile name and its noreply or public e-mail address.
- When the check fails on a PR from the owner's account, it shows only the place: the file and line, or a field such as the PR title. Reword the text at that place.
- A PR from any other account is checked in a run that the owner's account starts, after the owner's account has approved its head commit. A failure then says only how many places there are, never where, and the owner tells you what to change. Until that run starts, and again after each push or edit of yours, Names fails and waits for that run.
- Never try to work out the list, and never work around the check.

## The fixture guard

Test data is made up ([plan, section 6](docs/plan.md#6-how-a-slice-is-built)). The fixture guard (`scripts/fixtures`) refuses a value in a file, or in a file's path, that looks like real personal data:

- a personal identity number (personnummer) or a coordination number (samordningsnummer), in 10 or 12 digits, with or without the `-` or `+`, when its date and its check digit are valid;
- an organisation number, as `NNNNNN-NNNN`, as 10 digits without the dash, or with `16` in front, when its group digit, its third digit and its check digit are valid. 10 digits without the dash and with the group digit 1 pass, because a Unix time from 2001 to 2033 has that form;
- a VAT number, `SE` and 10 digits and `01`, when the 10 digits make an organisation number, or an identity number as in a sole trader's VAT number. Here the group digit 1 counts too;
- an e-mail address, unless it is at `example.com`, `example.net` or `example.org`, under `.example`, `.test`, `.invalid` or `.localhost`, or a GitHub noreply address. An address used as a file or folder name counts too, also with an extension, a dash or a digit after it. A file name such as `logo@2x.png` is not an address.

The guard reads a file as UTF-8. A file that is not UTF-8 it also reads as Windows-1252 and as CP437, the encodings of a CSV file from Excel on Windows and of a SIE file. It reads each line, and each path, as it is and as it decodes: from base64, percent-encoding, HTML character references, and the escapes of JSON and JavaScript, such as `\u00f6` and `\xf6`.

A path is read more strictly than a line. In a line, the user part of a URL, a git remote, the start of a UUID and a run of digits without `-` or `+` in a decimal number are not values. An address in a URL's path is a value. In a path, each part between `/` is read on its own, without those exceptions.

A number with a wrong date or check digit passes, so a hash or a version seldom trips the guard. A date with four digits after it, such as a time or a daily serial number (`YYYYMMDD-HHMM` or `YYYYMMDDHHMM`), always has a valid date, so it trips the guard about one time in ten. Write a time with a `T` or a `:`, as in `20261102T0112`, or give such an id another length. A made-up reference with a Luhn check digit, such as an OCR number, can still look like an identity or organisation number. Give it a length other than 10 or 12 digits. Or, in 10 digits, start it with 0 or 4 and make its third and fourth digits 13 or more.

[The list of test values](scripts/fixtures/test-values.txt) holds Skatteverket's published test numbers, each with its source. They pass, and tests and fixtures may use them. A listed identity number in 10 digits with `+` does not pass: `+` says the person is 100 or older, so it is a different number. For the same reason, the list takes no number for a person who is 100 or older this year, or born after this year: in 10 digits with `-`, its digits name another person. For an address, use one at the reserved example domains above. The guard's own tests must show that it finds an address outside them, so they use one at `zarquon.zz`, which can never be real (see `scripts/testing/personal-data.ts`). The list also holds one no-reply address, only so that the Co-Authored-By example in AGENTS.md passes. Never use it in a test or a fixture. Add a number only from a published test series, and give its source.

The guard runs in `pnpm check`, in CI, and in the pre-commit hook over the staged files. It names the file and line and the kind of value, never the value. When a file's path holds anything shaped like a value, it names the file by its place in the list of files instead of by its path. It refuses a binary file, because it cannot read one yet. In `pnpm-lock.yaml` it skips pnpm's integrity digests, which are random data.

## Pull requests

- One slice or one fix per PR, with its tests and, when users will notice it, a changeset.
- A slice's terms go into [docs/glossary.md](docs/glossary.md), each with its name in `/v1` and the code. `packages/contract/src/terms.test.ts` checks that the glossary and `/v1` give the same names.
- Every new rule has tests, and every new guard has a test that shows it fails on a bad input.
- No PR lowers a coverage floor, switches off a lint rule or skips a check.
- Test data is made up: fictional companies and people, the test numbers on the fixture guard's list, and addresses at the reserved example domains. Never personal data or real company data.
- Commit messages, the PR title and the PR body are written with the same care as code. A merge is a squash, so the title and body become the commit on `main`.

A PR can merge when five checks pass on its head commit:

- **CI OK**: every CI job passed.
- **Names**: the names check found nothing in the PR's files, paths, commits, title, body, author and branch name.
- **Owner OK**: the names check passed, and a PR that changes an owner path carries the owner-ok label, set by the owner on its head commit. A push after the label removes it, and Owner OK fails until the owner sets it again. The list of owner paths (`.github/owner-paths.txt`) is empty, so no PR needs the label. Owner OK then asks for nothing beyond the names check, as long as GitHub can list all the files the PR changes (at most 3000). The label stays, so the owner can put paths on the list again.
- **Outside approval**: the owner opened the PR from a branch in this repository or in the owner's own fork, or the owner's account approved its head commit. A PR that the owner opens from a branch in another account's fork counts as from another account, because that account can push to the branch. A review starts no check run. After approving a PR from an outside contributor, the owner re-runs the failed jobs of its latest Approvals run. After asking for changes or dismissing a review, the owner re-runs all of that run's jobs. A PR that Dependabot opened is from another account too, but there a re-run keeps Dependabot's rights, and GitHub gives such a run no secrets, so Names fails without the list. On such a PR, when Dependabot opened it from a branch in this repository, an agent starts a new run from the owner's account instead, after the review agent has approved its head commit: it adds a label, any but owner-ok, and removes it again. On any other PR that Dependabot opened, the owner does this, as for an outside contributor.
- **Review OK**: the owner's review agent passed it. It is a commit status that the review agent posts.

The owner merges a pull request from an outside contributor by hand, after reading the whole diff; agents never merge such a pull request. An outside contributor is any account other than the owner's and Dependabot's. A PR that the owner opened from a branch in another account's fork counts as that account's, and so does a PR that Dependabot opened from anywhere but a branch in this repository. Just before that merge, the owner runs its approval checks again: all the jobs of its latest Approvals run, or, on a PR that Dependabot opened, a new run started by adding a label and removing it again. Its author can change the name on their GitHub account at any time, and that starts no run. A pull request that Dependabot opens from a branch in this repository is reviewed and merged by the owner's agents: the review agent reads the whole diff and approves its head commit, and an agent starts a new approval run and merges the pull request when all five checks pass. When the pull request is behind `main`, the agent comments `@dependabot rebase` on it and does nothing else to it, because a pull request merges only when it is up to date with `main`. Dependabot then pushes a new commit, and the review starts again. The agent writes that commit message itself: Dependabot's title and the PR number, with an empty body, because Dependabot's body holds release notes from other projects. The names check on `main` reads the message after the merge. Pull requests from the owner's own account are approved by the review agent. GitHub holds the CI of a first-time contributor until the owner approves the run, so a first PR may wait a little before its checks start.

## Licence of contributions

NortFox is under the GNU Affero General Public License v3.0 only, and so are contributions to it. Each source file starts with one `SPDX-License-Identifier` line: exactly `AGPL-3.0-only`, or exactly `MIT` in `packages/client`.

The API client in `packages/client` and the API description `packages/client/openapi.json` are under the MIT licence, so that any program can use them ([decision 4](docs/decisions/0004-licences.md)). They are generated from the operation registry in `packages/contract`. A contribution to `packages/contract` is therefore also offered under the MIT licence for those generated files.

## Security

A security problem goes to a private report, never to a public issue. See [SECURITY.md](SECURITY.md).

## Conduct

Everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
