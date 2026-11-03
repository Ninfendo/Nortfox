---
"@nortfox/server": minor
---

The ledger database, and a compose file to run it yourself.

- The ledger's rules live in PostgreSQL: companies, fiscal years and periods, the period lock, accounts, voucher series with gap-free numbers and void ranges, vouchers and their rows, the record of deleted vouchers, and the behandlingshistorik. The server's database role cannot break them.
- A lock date, the automatic lock, and a change of a fiscal year, a series or an account get their turn while vouchers are being booked: each waits only for the bookings that were open when it came, never until the bookings pause.
- `deploy/compose.yaml` runs PostgreSQL 18 with pgBackRest and a one-shot migrate step. Every WAL segment goes to a local and an off-site backup repository, at most a minute after the last write. The first start takes the first full backup to each, so a restore works from day one, and a point-in-time restore from either one is tested. Before the first start, set the secret files and the off-site repository, as `deploy/README.md` says. The stack does not start without them. A first start that fails, or stops during its first backups, is never healthy, so the migrations do not run until it is fixed. An off-site folder must be a mount of its own.
