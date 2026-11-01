# 10. Quality gates

Status: accepted, 2026-11-01

## Context

An accounting system must be right, and it must stay right as it grows. A rule that is written down but not checked drifts. A check that cannot fail protects nothing.

## Decision

From the first commit:

- TypeScript in strict mode.
- ESLint with typescript-eslint's strict type-checked rules, including `no-floating-promises`, `switch-exhaustiveness-check` and `restrict-plus-operands`, run with `--max-warnings 0`.
- Vitest with v8 coverage and real floors for each package. The pure engine has a floor of 100%. Floors only go up.
- Property-based tests with fast-check for every invariant: debit equals credit, gap-free numbers, exact sums, SIE round trips.
- Database tests against real PostgreSQL, run as the app role. The database is never mocked.
- Every guard is proven to fail: each check has a test that gives it a bad case and expects it to fail.
- Every test suite runs in CI, and no suite runs with `--passWithNoTests`. One aggregator job, "CI OK", passes only when every CI job passed.
- Shell scripts start with `set -euo pipefail`.
- Changesets record the release notes.

## Consequences

- A slice takes a little longer, and stays right.
- There is no warning backlog, because a warning fails the build.
- A new package brings its tests and its coverage floor in the same PR.
