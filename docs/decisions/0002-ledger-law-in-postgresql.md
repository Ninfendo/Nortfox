# 2. The ledger law lives in PostgreSQL

Status: accepted, 2026-11-01. Amended 2026-11-02: vouchers and the period lock follow the established system's behaviour.

## Context

The rules of Bokföringslagen are the core of an accounting system. If only the server checks them, a bug, a script or a direct database login can break them.

NortFox copies the voucher behaviour of the established Swedish accounting system, so that its users feel at home ([plan, section 2](../plan.md#how-behaviour-is-decided)). There, a voucher is booked at once and gets its number. Until its period is locked, it can still be changed or deleted. It can be corrected at any time. The lock makes it final.

In the law's sense, an entry becomes final, bokförd, when its period is locked; until then it is preliminary and may be changed or deleted (BFNAR 2013:2 kapitel 2). So the company must lock each period in time, within the booking deadlines of BFL 5 kap. 2 § and BFNAR 2013:2 kapitel 3. A lock that leaves out some users or integrations leaves the period open for them.

In this record, a booked voucher is one that has its number, as the screen's Bokför means. A final voucher is one whose date is locked for every actor.

## Decision

PostgreSQL enforces the ledger law itself, with constraints and triggers:

- A voucher is booked when it is created. Its number comes in the same transaction.
- The period lock is the established system's:
  - A lock is a locked-through date. Every date up to and including it is locked.
  - The manual lock has one such date for each user, one for the internal system user, one for integrations, and one for all users. The internal system user makes the bookings that other modules make.
  - The automatic lock comes on top and applies to everyone. It is on or off, with one of the established system's intervals: 50 days after the end of the month, 50 days after the end of the quarter, or 60 days after the end of the fiscal year. The established system names one more case, for sole traders, at the date of the income tax return. NortFox adds it once its rule is confirmed.
  - The database works out the automatic lock's date, in Swedish time, from the day's date and the interval. No job has to run for it.
  - A date is locked for an actor when it is on or before the latest date that applies to that actor: the actor's own row (the user's, the internal system user's or the integrations' row), the all-users row, or the automatic lock.
  - A lock date can be changed or cleared, and the automatic lock turned off, as in the established system.
- One series per fiscal year can be marked as the closing series. The period lock does not apply to it: its vouchers may be dated inside a locked period, under the manual and the automatic lock, on any date.
- While its date is not locked for an actor, a voucher can be, by that actor:
  - **changed:** its description, its date and its row texts can change, and rows can be added. A row's account and amount never change: the row is struck, and a new row takes its place. A struck row stays on the voucher, marked struck, with who struck it and when. It counts in no balance.
  - **corrected** with a reversing voucher, as it can after the lock too;
  - **deleted,** when it is the last voucher of its series in its fiscal year. Its number is given out again. The deleted voucher moves to the record of deleted vouchers, with who deleted it and when.
- A reversing voucher is a new voucher with its own number, dated in an open period. It reverses the old voucher and is linked to it both ways.
- A voucher whose date is locked for an actor is never changed or deleted by that actor, only corrected with a reversing voucher. That actor cannot date a voucher there either. The closing series is the only exception.
- A change or a deletion keeps the earlier data:
  - The record of deleted vouchers shows what the established system's report of deleted vouchers shows: the number, the date and the description, each row's account and amount with struck rows marked, and who deleted the voucher and when.
  - The behandlingshistorik keeps each earlier value, with who changed it and when. This is NortFox's own working default, which the owner may change. The established system overwrites a changed row text in place and keeps a stamp of who changed the voucher and when. Whether it also keeps the old text was not checked.
  - The app role cannot change or delete the behandlingshistorik or the record of deleted vouchers.
- Voucher numbers are gap-free per series and fiscal year. The number comes from a counter row, in the same transaction that books the voucher. It never comes from a sequence, because a sequence leaves a gap when a transaction rolls back. Only the last voucher of a series can be deleted, so a deletion leaves no gap.
- A series can skip numbers only through a void range. A void range is a row in its own table: the series, the fiscal year, the first and the last number skipped, and the reason. Only the owner role can insert one, and no role changes or deletes one. The counter can jump forward only over a void range recorded in the same transaction. The behandlingshistorik trigger logs a void range like any other row.
- For every voucher, the rows that are not struck balance: debit equals credit. This is checked at commit.
- A voucher date must be in an open fiscal year.
- Triggers write the behandlingshistorik for every act: booking, changing, striking a row, correcting, deleting, and every change to a lock date, to the automatic lock and to the closing series. The app cannot change or delete it.

`packages/engine` checks the same rules first, to give clear error messages. The database is the authority.

A change to a ledger rule needs the owner's approval. The law lives in the SQL migrations, and `db/migrations/**` is an owner path, so a PR that changes a migration passes Owner OK only with the owner-ok label on its head commit ([plan, section 6](../plan.md#owner-paths)).

## Consequences

- No client, script or bug can break the rules through the role the server uses.
- The rules live in SQL migrations and are tested in real PostgreSQL, as the app role.
- Some rules exist twice, in the engine and in SQL. One set of test cases runs against both.
- Only a restore records a void range, through the restore tool, as the owner role (see [decision 7](0007-self-hosting-and-backups.md)). The app role cannot record one, so no bug in the server can make a gap that the database accepts.
- A number can stand for two vouchers over time: a deleted one, in the record of deleted vouchers, and the one that got the number after it. Both stay readable.
- A voucher locked for one actor can still be changed by an actor that the lock leaves out, as in the established system.
- The closing series lets a company lock its periods before the year's closing entries are booked (BFL 5 kap. 3 §).
- The books stay preliminary until their periods are locked for every actor. Locking in time is the company's duty, as it is in the established system.
