# 4. Licences

Status: accepted, 2026-11-01

## Context

NortFox is free software. When someone runs a changed NortFox as a service, the changes should reach its users. Other programs, closed ones too, should be able to talk to NortFox without worrying about the licence.

## Decision

- NortFox is under the GNU Affero General Public License v3.0 only. Copyright (C) 2026 The NortFox authors. Source files carry `SPDX-License-Identifier: AGPL-3.0-only`.
- Two parts are under the MIT licence, each with its own `LICENSE` file: the published API client package (`packages/client`) and the API description (`openapi/openapi.json`). Their identifier is `MIT`.

## Consequences

- Whoever runs a changed NortFox for others over a network must offer them the source of that version.
- Any program can use the client and the API description, under any licence.
- `openapi.json` and the client are generated from `packages/contract`. So a contribution to the contract is also offered under MIT for those generated files. The contribution guide will say so.
- A check in CI keeps the identifiers and the licence files in place.
