# 1. TypeScript 7 on Node 24, with pnpm and Turborepo

Status: accepted, 2026-11-01

## Context

NortFox is one repository with a server, a web app and several packages. Type checks must be strict and fast, so they run on every save and in every CI job. The tool chain should be small and standard.

## Decision

- **TypeScript 7.0** (`typescript@7.0.2`), the native compiler, does all type checking and builds. We move to 7.1 when it is final, not to its beta.
- **Node 24 LTS** is the only runtime.
- **pnpm 12.16.1** is the only package manager. Its version is pinned in `package.json`.
- **Turborepo** runs the tasks and caches their results.
- Some tools still need the old compiler API: typescript-eslint and dependency-cruiser. For those tools, `typescript` is an alias of `npm:@typescript/typescript6`, the side-by-side setup that the TypeScript 7.0 release describes. `tsc` always comes from `typescript@7`.
- `"types": ["node"]` is set explicitly wherever Node types are needed, because the default no longer includes them.
- `strict` is on everywhere.

## Consequences

- Type checks are fast enough for every save and every CI job.
- Two compiler packages are installed for now. When the lint tools work with TypeScript 7 directly, the alias goes.
- A contributor needs Node 24 and pnpm, nothing else.
