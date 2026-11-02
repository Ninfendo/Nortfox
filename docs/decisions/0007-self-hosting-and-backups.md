# 7. Self-hosting and backups

Status: accepted, 2026-11-01

## Context

A company's books must survive a broken disk or a bad update. Many companies want to run the system themselves. Bokföringslagen asks for the data to be kept for seven years.

## Decision

- One Docker Compose file runs NortFox: the server (API, MCP and jobs in one process), Caddy (HTTPS; it serves the web app, and passes `/v1`, `/mcp`, the compatible API's paths and its login paths ([decision 12](0012-compatible-api.md)) and the OAuth discovery paths under `/.well-known/` from [decision 8](0008-authentication.md) to the server), and PostgreSQL.
- The PostgreSQL image includes pgBackRest. WAL archiving and point-in-time recovery are on from day one, to a local repository and to an off-site one. PostgreSQL archives the WAL in whole segments, so `archive_timeout` is set to 60 seconds to keep the archive close to the last commit.
- Migrations run as the owner role, in a one-shot step before the server starts.
- **A restore skips voucher numbers rather than give one out twice.** Before a restore, the restore tool finds the highest number issued in each series. While the live database is still there, it reads that number from it. When the live database is gone, it replays the archive to its end and adds a margin, 1000 numbers by default, which the operator can raise. After the restore, each series continues above that number. The tool, as the owner role, records the skipped numbers as a void range ([decision 2](0002-ledger-law-in-postgresql.md)), with the reason.
- `nortfox doctor` reports the archive lag. It fails when WAL older than twice `archive_timeout` has not reached both repositories.
- A restore drill runs on a schedule, and its result shows in `nortfox doctor`.

## Consequences

- One small server is enough. Where it runs is the owner's choice.
- Vouchers lost in a restore must be booked again, with new numbers. The void range explains the gap to an auditor.
- Without the live database, the promise holds only if no series gave out more numbers than the margin after the last archived WAL segment. The short `archive_timeout` and the doctor's lag check keep that window to about a minute. An install that books in bulk raises the margin.
- A restore to an earlier point is for disaster recovery only. A mistake is fixed in the books, as [decision 2](0002-ledger-law-in-postgresql.md) allows, never with a restore.
- A backup that has never been restored is not trusted. The drill is part of the system.
