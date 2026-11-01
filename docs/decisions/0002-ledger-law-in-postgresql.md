# 2. The ledger law lives in PostgreSQL

Status: accepted, 2026-11-01

## Context

The rules of Bokföringslagen are the core of an accounting system. If only the server checks them, a bug, a script or a direct database login can break them.

## Decision

PostgreSQL enforces the ledger law itself, with constraints and triggers:

- A booked voucher and its rows cannot be changed or deleted. A mistake is corrected with a new voucher.
- Voucher numbers are gap-free per series and fiscal year. The number comes from a counter row, in the same transaction that books the voucher. It never comes from a sequence, because a sequence leaves a gap when a transaction rolls back.
- A series can skip numbers only through a void range. A void range is a row in its own table: the series, the fiscal year, the first and the last number skipped, and the reason. Only the owner role can insert one, and no role changes or deletes one. The counter can jump forward only over a void range recorded in the same transaction. The behandlingshistorik trigger logs a void range like any other row.
- For every booked voucher, debit equals credit. This is checked at commit.
- A voucher date must be in an open fiscal year and not in a locked period.
- Triggers write the behandlingshistorik for every change. The app cannot change or delete it.

`packages/engine` checks the same rules first, to give clear error messages. The database is the authority.

A change to a ledger rule needs the owner's approval. The migrations and the engine's ledger checks are owner paths, so a PR that changes them passes Owner OK only with the owner-ok label on its head commit ([plan, section 6](../plan.md#owner-paths)).

## Consequences

- No client, script or bug can break the rules through the role the server uses.
- The rules live in SQL migrations and are tested in real PostgreSQL, as the app role.
- Some rules exist twice, in the engine and in SQL. One set of test cases runs against both.
- Only a restore records a void range, through the restore tool, as the owner role (see [decision 7](0007-self-hosting-and-backups.md)). The app role cannot record one, so no bug in the server can make a gap that the database accepts.
