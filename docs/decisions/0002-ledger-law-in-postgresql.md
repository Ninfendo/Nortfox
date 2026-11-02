# 2. The ledger law lives in PostgreSQL

Status: accepted, 2026-11-01. Amended 2026-11-02: vouchers follow the established system's behaviour.

## Context

The rules of Bokföringslagen are the core of an accounting system. If only the server checks them, a bug, a script or a direct database login can break them.

NortFox copies the voucher behaviour of the established Swedish accounting system, so that its users feel at home ([plan, section 2](../plan.md#how-behaviour-is-decided)). There, a voucher is booked at once and gets its number. Until its period is locked, it can still be changed, corrected or deleted. The lock makes it final.

In the law's sense, an entry becomes final, bokförd, when its period is locked; until then it is preliminary and may be changed or deleted (BFNAR 2013:2 kapitel 2). So the company must lock each period in time, within the booking deadlines of BFL 5 kap. 2 § and BFNAR 2013:2 kapitel 3.

In this record, a booked voucher is one that has its number, as the screen's Bokför means. A final voucher is one in a locked period.

## Decision

PostgreSQL enforces the ledger law itself, with constraints and triggers:

- A voucher is booked when it is created. Its number comes in the same transaction.
- Until its period is locked, a voucher can be:
  - **changed:** its description, its date and its row texts can change, and rows can be added. A row's account and amount never change: the row is struck, and a new row takes its place. A struck row stays on the voucher, marked struck, with who struck it and when. It counts in no balance.
  - **corrected** with a reversing voucher, as it can after the lock too;
  - **deleted,** when it is the last voucher of its series in its fiscal year. Its number is given out again. The deleted voucher stays readable in full in the record of deleted vouchers, with who deleted it and when.
- A reversing voucher is a new voucher with its own number, dated in an open period. It reverses the old voucher and is linked to it both ways.
- Locking a period makes its vouchers final. A final voucher is never changed or deleted, only corrected with a reversing voucher, and no voucher can be dated in a locked period. A period is locked by hand, or automatically a set number of days after its month ends. A locked period can be unlocked, as in the established system.
- Nothing is ever erased. A change is new rows: every earlier version of a voucher, its rows and its texts stays readable. A deleted voucher moves, whole, to the record of deleted vouchers. The app role cannot change or delete an earlier version, or anything in that record.
- Voucher numbers are gap-free per series and fiscal year. The number comes from a counter row, in the same transaction that books the voucher. It never comes from a sequence, because a sequence leaves a gap when a transaction rolls back. Only the last voucher of a series can be deleted, so a deletion leaves no gap.
- A series can skip numbers only through a void range. A void range is a row in its own table: the series, the fiscal year, the first and the last number skipped, and the reason. Only the owner role can insert one, and no role changes or deletes one. The counter can jump forward only over a void range recorded in the same transaction. The behandlingshistorik trigger logs a void range like any other row.
- For every voucher, the rows that are not struck balance: debit equals credit. This is checked at commit.
- A voucher date must be in an open fiscal year.
- Triggers write the behandlingshistorik for every act: booking, changing, striking a row, correcting, deleting, locking and unlocking. The app cannot change or delete it.

`packages/engine` checks the same rules first, to give clear error messages. The database is the authority.

A change to a ledger rule needs the owner's approval. The law lives in the SQL migrations, and `db/migrations/**` is an owner path, so a PR that changes a migration passes Owner OK only with the owner-ok label on its head commit ([plan, section 6](../plan.md#owner-paths)).

## Consequences

- No client, script or bug can break the rules through the role the server uses.
- The rules live in SQL migrations and are tested in real PostgreSQL, as the app role.
- Some rules exist twice, in the engine and in SQL. One set of test cases runs against both.
- Only a restore records a void range, through the restore tool, as the owner role (see [decision 7](0007-self-hosting-and-backups.md)). The app role cannot record one, so no bug in the server can make a gap that the database accepts.
- A number can stand for two vouchers over time: a deleted one, in the record of deleted vouchers, and the one that got the number after it. Both stay readable.
- The books stay preliminary until their periods are locked. Locking in time is the company's duty, as it is in the established system.
