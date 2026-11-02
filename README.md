# NortFox

An open-source Swedish accounting system.

> **Status: early development.** NortFox is not ready for real books yet.

## Principles

- **Everything through the API.** Every feature works through the public API and through MCP. A screen is one client of the API, never the only way in.
- **The law lives in the database.** PostgreSQL itself refuses a change to a voucher in a locked period, a gap in a voucher series that is not a recorded void range, and a voucher where debit and credit differ.
- **Self-hosted.** One Docker Compose file runs NortFox on one small server, with backups that restore to the minute.
- **Swedish first.** BAS, SIE, the VAT report and Bokföringslagen are built in. The screens are in Swedish and English.

## Contributing

The plan is in [docs/plan.md](docs/plan.md). The rules for every change, by a person or an AI agent, are in [AGENTS.md](AGENTS.md).

## Licence

Copyright (C) 2026 The NortFox authors.

NortFox is free software under the GNU Affero General Public License v3.0. See [LICENSE](LICENSE).

The API client package and the API description (`openapi.json`) are under the MIT licence, so any program can use them. The MIT licence file sits next to them.
