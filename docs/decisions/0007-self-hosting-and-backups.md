# 7. Self-hosting and backups

Status: accepted, 2026-11-01

## Context

A company's books must survive a broken disk or a bad update. Many companies want to run the system themselves. Bokföringslagen asks for the data to be kept for seven years.

## Decision

- One Docker Compose file runs NortFox: the server (API, MCP and jobs in one process), Caddy (HTTPS; serves the web app and passes `/v1` and `/mcp` to the server), and PostgreSQL.
- The PostgreSQL image includes pgBackRest. WAL archiving and point-in-time recovery are on from day one, to a local repository and to an off-site one.
- Migrations run as the owner role, in a one-shot step before the server starts.
- **A restore never gives out a voucher number twice.** Before a restore, the restore tool reads the highest number issued in each series, from the live database or by replaying the archive to its end. After the restore, each series continues above that number, and the skipped numbers are recorded as a void range in the behandlingshistorik, with the reason.
- A restore drill runs on a schedule, and its result shows in `nortfox doctor`.

## Consequences

- One small server is enough. Where it runs is the owner's choice.
- Vouchers lost in a restore must be booked again, with new numbers. The void range explains the gap to an auditor.
- A restore to an earlier point is for disaster recovery only. A mistake is fixed with a correction voucher, never with a restore.
- A backup that has never been restored is not trusted. The drill is part of the system.
