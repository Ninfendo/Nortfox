# 11. Names policy

Status: accepted, 2026-11-01

## Context

The repository is public. Its text describes NortFox. The owner keeps a short list of names that must never appear in it. A rule like that holds only when a check enforces it, and the check must not leak the list it protects.

## Decision

- The repository never contains a name on the owner's list of protected names, in any case or spelling. This covers file contents, file and folder names, code, comments, tests, fixtures, docs, commit messages, branch names, PR titles and bodies, and issue texts.
- The list is not in the repository, in any form. The names check reads it from a secret ([plan, section 6](../plan.md#the-names-check)).
- The tools, services and open standards that NortFox is built on or connects to may be named, for example PostgreSQL, Hono or BankID.
- The repository also never contains personal data, real company data, private e-mail addresses, internal hostnames or addresses, or issue numbers of other repositories.
- The only exception is one import adapter ([plan, slice 4f](../plan.md#step-4-the-rest-of-the-platform)). Its folder holds a marker file named `.protected-name-ok` and is on the marker allowlist. Inside that folder, the adapter may name the system it imports from.

## Consequences

- The names check honours a marker only in a folder on the marker allowlist, which it reads from `main`. A marker anywhere else fails the check. Adding, moving or removing a marker, or changing the allowlist, needs Owner OK.
- Outside its folder, an adapter has only a neutral id, and its folder is named by that id. The import operations are generic: they take an adapter id. The server reads the adapter's display name and texts from its folder at runtime and serves them through the API. So no protected name reaches `openapi.json`, the client, `packages/i18n`, `docs/system` or a changeset.
- The PR that adds an adapter uses neutral words in its title, body, branch name, commits and changeset, because a squash merge copies the title and body into `main`.
- An adapter's sample data is hand-written from the other system's public API documentation, with made-up companies, people and numbers. It is never recorded from a real account.
- The check prints only where a match is, never the match.
