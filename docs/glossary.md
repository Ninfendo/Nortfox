# Glossary

The terms that NortFox's slices pin. A word can mean one thing on the screen and another in the law: the screen's Bokför gives a voucher its number, but in the law's sense an entry is bokförd only once its period is locked for everyone ([plan, section 2](plan.md#names)). So each slice's issue starts with its terms, and they gather here.

Each term has its Swedish and English word, what the law means by it, and its name in the API (`/v1`) and the code.

## Bokföring

Pinned by slice 2a, the ledger core in PostgreSQL.

| Term (sv / en) | What the law means | Name in /v1 and the code | Note |
|---|---|---|---|
| Verifikation / voucher | The record of one business event: when it was compiled, the event date, what it concerns, the amount, the counterparty (BFL 5 kap. 6-7 §). | `Voucher` | |
| Verifikationsrad / voucher row | One bokföringspost: kontering and amount (BFNAR 2013:2 punkt 2.3). | `VoucherRow` | |
| Bokför / book (the button) | Not the law's "bokförd". | `book` | Booking gives the voucher its number, in the same transaction. A booked voucher is one that has its number (decision 2). There is no draft in the database. |
| Bokförd / final (the law) | Durable: it can no longer be removed or changed. Until an active lock, entries are "preliminär bokföring" (BFNAR punkt 2.1 with kommentar). | final; locked for an actor | A voucher is final when its date is locked for every actor (decision 2). A lock for one user or one kind of actor stops only that actor. For the others, the voucher is still open. |
| Ändra / alter | A change in place. A computer ledger never corrects a bokförd entry in place (punkt 2.17). A preliminary entry may still change (kommentar till punkt 2.1). | `alter` | Allowed only while the voucher's date is not locked for the actor. |
| Stryk rad / struck row | Striking through, the method of a manual ledger (punkt 2.17 andra stycket). | `Removed` | A struck row stays on the voucher, with who struck it and when. It counts in no balance. |
| Ändringsverifikation / reversing voucher | A rättelsepost: a new posting with its own verifikation (punkt 2.18; BFL 5 kap. 5 §). | reversing voucher; links `reverses`, `reversedBy` | A new voucher with its own number, linked to the old one both ways. |
| Radera / delete | Nothing bokfört may be erased (punkt 2.1). A preliminary entry may still be deleted (kommentar till punkt 2.1). | delete | Only the last voucher of its series, and only while its date is not locked for the actor. Its number is given out again. |
| Borttagna verifikationer / record of deleted vouchers | None. | `DeletedVoucher` | Each deletion is its own entry. Nothing in it is changed or deleted. |
| Verifikationsserie / voucher series | Voucher numbers in an unbroken series (punkt 5.9). | `VoucherSeries`, `NextVoucherNumber` | Per fiscal year. |
| Void range | None. | `VoidRange` | A recorded skip in a series, made only by a restore (decisions 2 and 7). |
| Räkenskapsår / fiscal year | The business's accounting year: normally twelve months, one for all its business (BFL 3 kap. 1 §, 4 §). | `FinancialYear` | It has no open or closed state of its own. A whole year is locked with the period lock. |
| Redovisningsperiod / period | A calendar month or similar (punkt 1.8). | period | The monthly periods of a fiscal year. A lock is a date, not a period: a period is locked when its dates are. |
| Låsning av period / locked period | The law has no such term. A lock is the active step that makes preliminary entries durable (kommentar till punkt 2.1). Once a period's work is finished, no later event or rättelse goes into it (kommentar till punkt 2.3 b). | `LockedPeriod` | A locked-through date for each user, for Intern systemanvändare, for Externt via integration and for Alla användare, plus the automatic lock. |
| Automatlåsning av period / automatic lock | As above. Its intervals follow the booking deadlines of BFNAR 2013:2 punkt 3.6-3.8. | automatic lock | Locks by an interval after the end of a month, a quarter or the fiscal year. It applies to every actor. |
| Bokslutsserie / closing series | The law has no such series. Bokslutstransaktioner are booked when the löpande bokföring is closed (BFL 5 kap. 3 §; punkt 2.19). | closing series | The period lock does not apply to it. |
| Manuell kontering / manual | None. | `Manual` | A series open for vouchers made by hand. |
| Behandlingshistorik / processing history | BFL 5 kap. 11 §; punkt 9.16-9.17. It is räkenskapsinformation. | behandlingshistorik (module `audit`) | Written by triggers, with the actor, its kind and the channel of each change. |
| Skapad / created | The registreringsdatum (punkt 9.16). | `created` at and by | On every voucher and every row. |
| Ändrad / altered | None. | `altered` at and by | Set by every change. |
| Konto / account | The kontoplan's account. | `Account` | Per fiscal year. |
| Företag / company | A bokföringsskyldig business. It keeps one bookkeeping for all its business (BFL 4 kap. 4 §). | `Company`; operation `getCompany` | Every data request works in exactly one company, which its credential names. |

Where the established API has no name for a term, the code name here is proposed: `book`, `alter`, the links `reverses` and `reversedBy`, `DeletedVoucher`, `VoidRange`, the automatic lock, `created` and `altered`. The owner may change them.

## Platform

Pinned by slice 2b, the API and MCP spine. [docs/api.md](api.md) gives the API's rules.

| Term (sv / en) | What the law means | Name in /v1 and the code | Note |
|---|---|---|---|
| Organisationsnummer / organisation number | The company's number in the register. For a sole trader it is the owner's personal identity number, so it is personal data. | `organizationNumber` | Ten digits with a hyphen after the sixth. |
| (no screen word) / tenant id | None. | `databaseNumber` | The company's number for programs ([decision 8](decisions/0008-authentication.md)). It never changes. |
| Användare / user | The law asks when each entry was registered (punkt 9.16), and who made each correction, and when (BFL 5 kap. 5 §). | actor, with its kind: `user`, `system` or `integration` | On the screen, Användare names every kind of actor, not only a person. So the code says actor, and user is one of its kinds. |
| (no screen word) / channel | None. | `channel`: `rest` or `mcp` | The client a change came through. The behandlingshistorik records it. Later slices add others. |
| Belopp / amount | The books are presented in one redovisningsvaluta: SEK, or EUR for some company forms (BFL 4 kap. 6 §). | `Money`: `{"amount": "1234.50", "currency": "SEK"}` | Never a JSON number on `/v1` ([decision 5](decisions/0005-money.md)). |
| Behörighet / permission | Instruktioner om behörighet are räkenskapsinformation (BFN's commentary to BFL 1 kap. 2 § första stycket 9 c). | `permission`, such as `company:read` | Declared once for each operation, in the registry. Slice 2c grants them. |
| (no screen word) / operation | None. | one entry in the registry in `packages/contract` | The REST route, the client method and the MCP tool come from it. |
| (no screen word) / idempotency key | None. | the `Idempotency-Key` header; the `idempotencyKey` argument on MCP | A write takes one. The same key and request give the first answer again. |
