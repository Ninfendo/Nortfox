# 11. Names policy

Status: accepted, 2026-11-01. Amended 2026-11-02: a second exception, the compatible API adapter.

## Context

The repository is public. Its text describes NortFox. The owner keeps a short list of names that must never appear in it. A rule like that holds only when a check enforces it, and the check must not leak the list it protects.

## Decision

- The repository never contains a name on the owner's list of protected names, in any case or spelling. This covers file contents, file and folder names, code, comments, tests, fixtures, docs, commit messages, branch names, PR titles and bodies, and issue texts.
- The list is not in the repository, in any form. The names check reads it from a secret ([plan, section 6](../plan.md#the-names-check)).
- The tools, services and open standards that NortFox is built on or connects to may be named, for example PostgreSQL, Hono or BankID.
- The repository also never contains personal data, real company data, private e-mail addresses, internal hostnames or addresses, or issue numbers of other repositories.
- There are exactly two exceptions, both for the established Swedish accounting system:
  - the import adapter that reads from its API ([plan, slice 4f](../plan.md#step-4-the-rest-of-the-platform));
  - the compatible API adapter ([decision 12](0012-compatible-api.md)).
- Each lives in one folder that holds a marker file named `.protected-name-ok` and is on the marker allowlist. Inside that folder, the adapter may name the established system. Its docs page, if it has one, lives in that folder too.
- Nothing else in the repository may name the established system.

## Consequences

- The names check honours a marker only in a folder on the marker allowlist, which it reads from `main`. A marker anywhere else fails the check. Adding, moving or removing a marker, or changing the allowlist, needs Owner OK.
- So an adapter's folder comes in two PRs, in this order. First, a PR adds only the folder's line to the allowlist, with no marker and no text that names the established system. After it merges, the PR that adds the folder, its marker and its content follows. Each needs the owner-ok label. In one PR, the check would refuse the new marker, because the folder's line is not on `main` yet.
- Outside its folder, an adapter has only a neutral id, and its folder is named by that id. The import operations are generic: they take an adapter id. The server reads the import adapter's display name and texts from its folder at runtime and serves them through the API. So no protected name reaches `openapi.json`, the client, `packages/i18n`, `docs/system` or a changeset.
- Both PRs that add an adapter use neutral words in their titles, bodies, branch names, commits and changesets, because a squash merge copies the title and body into `main`.
- An adapter's sample data is hand-written from the other system's public API documentation, with made-up companies, people and numbers. It is never recorded from a real account.
- The check never prints a match. On a PR from the owner's account, it prints only where a match is. A PR from any other account it reads with the list only in a run that the owner starts, after the owner has approved its head commit, and then it prints only how many matches it found, never where. Otherwise anyone could open a PR with one guess per line and read from the public log which guesses are on the list.
- The names check reads each text by what it is. An integrity digest that pnpm writes in `pnpm-lock.yaml` is data: the check decodes it and searches what it decodes to, and does not read its base64 letters as words. This is how a digest is read, not an exception to the names rule. A digest written by hand is a hand edit of the lockfile, and the review reads it.
