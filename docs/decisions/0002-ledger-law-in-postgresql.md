# 2. The ledger law lives in PostgreSQL

Status: accepted, 2026-11-01

## Context

The rules of Bokföringslagen are the core of an accounting system. If only the server checks them, a bug, a script or a direct database login can break them.

## Decision

PostgreSQL enforces the ledger law itself, with constraints and triggers:

- A booked voucher and its rows cannot be changed or deleted. A mistake is corrected with a new voucher.
- Voucher numbers are gap-free per series and fiscal year. The number comes from a counter row, in the same transaction that books the voucher. It never comes from a sequence, because a sequence leaves a gap when a transaction rolls back.
- For every booked voucher, debit equals credit. This is checked at commit.
- A voucher date must be in an open fiscal year and not in a locked period.
- Triggers write the behandlingshistorik for every change. The app cannot change or delete it.

`packages/engine` checks the same rules first, to give clear error messages. The database is the authority.

A change to a ledger rule needs the owner's approval: the owner-ok label.

## Consequences

- No client, script or bug can break the rules through the role the server uses.
- The rules live in SQL migrations and are tested in real PostgreSQL, as the app role.
- Some rules exist twice, in the engine and in SQL. One set of test cases runs against both.
- The only way to skip a voucher number is a recorded void range. A restore uses it (see [decision 7](0007-self-hosting-and-backups.md)).
