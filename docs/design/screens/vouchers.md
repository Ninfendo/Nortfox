# Screen spec: vouchers (Verifikationer)

Applies [../rules.md](../rules.md) and [../app-shell.md](../app-shell.md). Reference: `NortFox Verifikationer.dc.html` (clickable).

Screens: voucher list, new voucher, draft, voucher detail, correction voucher, receipt and daily takings entry. Out of scope for this round: amount search, extended search, accruals (periodisering), the business inbox screen.

## What booking means

- A **booked voucher can never be edited or deleted.** Not by anyone, not through the API.
- A mistake is fixed with a **correction voucher** (rättelseverifikation): a new voucher with its own number, booked in an open period, linked to the original both ways. The original stays exactly as it was and shows `Rättad med A 144`; the correction shows `Rättelse av A 142`. Each shows the reason, the user and the time on the voucher itself (Bokföringslagen 5 kap. 5 §).
- A voucher gets its **number when it is booked**, in the series' sequence, with no gaps. Drafts have no number. The entry screen shows the number it will get (`Blir A 143`), dashed, as a preview.
- **Drafts are stored on the server**, visible to everyone with the Bokföring role, and listed in the voucher list.

## API operations

Every control below maps to one of these. Nothing on these screens exists only in the UI.

| Operation | Used by |
|---|---|
| `GET /vouchers?year=&series=&q=&status=&sort=&cursor=` | List, quick filters, detail navigation |
| `GET /vouchers/{id}` | Detail |
| `POST /vouchers` (with `Idempotency-Key`) | Bokför, Bokför rättelse. Body has `rows`, `description`, `series`, `date`; optional `draftId`, `correctionOf` + `reason`, `registrationTemplateId` |
| `POST /voucher-drafts`, `PUT /voucher-drafts/{id}` (with `If-Match: <ETag>`), `DELETE /voucher-drafts/{id}` | Spara utkast, conflict handling, discard |
| `POST /voucher-drafts?copyFrom={voucherId}` | Kopiera till ny |
| `POST /vouchers/{id}/corrections/draft` | Skapa rättelse (returns a draft prefilled with `correctionOf`) |
| `POST /vouchers/{id}/attachments`, `POST /voucher-drafts/{id}/attachments` (file or `inboxDocumentId`), `DELETE /voucher-drafts/{id}/attachments/{aid}` | Underlag panel |
| `GET /inbox/documents?linked=false` | Från inkorgen |
| `POST /vouchers/{id}/comments`, `POST /voucher-drafts/{id}/comments` | Kommentarer |
| `GET /vouchers/{id}/pdf` | Skriv ut |
| `GET /accounts?query=` | Account picker (same matching as below, server side) |
| `GET /posting-templates`, `POST /posting-templates/{id}/apply {amount}` | Konteringsmall (rows computed on the server so every client gets the same result) |
| `GET /registration-templates?type=receipt|daily-takings`, `POST /registration-templates/{id}/preview {values}` | Kvitto, Dagskassa ("Så bokförs det") |

Booking errors come back as 422 with a field pointer per problem (row index and column), shown on the field. A booked voucher returns `locked: { reason_code: "booked", reason, by, at }`; a voucher in a locked period additionally carries the period lock.

## 1. Voucher list

Page header: title `Verifikationer`, one line of context, primary `Ny verifikation` with `N`. Under it, the locked-period note when periods are locked. Toolbar: filter field (`/`), series select, count. Table card with quick filters at the top.

Quick filters: `Alla`, `Utkast`, `Underlag saknas` (warning tone), `Rättelser`, `I låst period`, each with count.

Columns: lock (period locked, icon with reason), Ver.nr, Datum, Beskrivning, Underlag (paperclip and count), Belopp (debit total), Status. Default sort: date descending. Totals row: `Summa, 17 poster` / `Summa för urvalet, …`.

Row states:

| State | Ver.nr | Status badge | Row colour (Åtgärd) |
|---|---|---|---|
| Draft | empty (no number yet) | `Utkast, Anders Holm` neutral, pencil | none |
| Booked | `A 142` | none | none |
| Booked, missing attachment | `B 310` | `Underlag saknas` warning | warning tint |
| Correction | `A 140` | `Rättelse av A 138` neutral | none |
| Corrected | `A 138` | `Rättad med A 140` neutral | none |
| In a locked period | `A 137` | as above, plus the lock icon in the first column | none |

Keyboard: Tab reaches each row; Up/Down move between rows; Enter opens. A draft opens in entry; a booked voucher opens its detail.

## 2. New voucher (Ny verifikation)

Full page with a fixed footer. Primary `Bokför` in the footer, rightmost.

### Layout, top to bottom

1. Title `Ny verifikation`, the number preview `Blir A 143`, one line of context. Tools on the right: `Underlag n`, `Kommentarer n` (both open the side panel), settings (gear).
2. Head fields, in this order:
   - **Beskrivning**: text, max 200, required. `Alt Down` or the chevron opens quick texts.
   - **Serie**: select, only series flagged for manual entry. Default the company's manual series.
   - **Bokföringsdatum**: date, default today, 128 px. Accepts `1101`, `261101`, `20261101`.
   - **Konteringsmall** (valfritt): select of posting templates as `CODE, name`. Choosing one replaces Beskrivning with the template's text and enables Belopp.
   - **Belopp**: amount, disabled until a template is chosen. Enter, Tab or leaving the field appends the template's rows below the rows already entered and clears the field; the hint says what was added.
3. Rows table (always at least two empty rows after the last used row):
   - `#`, **Konto** (input, 112 px), **Benämning** (read-only), **Transaktionsinfo** (input, max 100), **Debet**, **Kredit** (right-aligned amounts), **Saldo efter** (the account's balance including this row and the rows above it on the same account, read-only), row actions: account analysis (opens the ledger for the year in a new tab), delete row. The header of the action column clears all rows.
   - Footer: `Summa` with debit and credit totals; a second line with `Differens`, the amount shown under the side that must grow, or `Balanserar` in ok ink.
4. A line of keyboard hints.
5. Fixed footer: status text (left, `role="status"`), `Avbryt`, `Spara utkast` (secondary), `Bokför` with `Ctrl Enter`.

### Account picker

- Opens under the Konto field as you type. Up to 8 rows, `number` and `name`; footer shows the count and `+ Nytt konto`.
- Order: accounts whose **number starts with** the text, then accounts whose **name contains** the text.
- **Enter or Tab commits only an exact number match or a unique match.** With several matches nothing is committed; a hint under the row says `4 konton matchar ”19”. Skriv fler tecken eller välj med Upp och Ned.` Up/Down moves a highlight; after that, Enter commits the highlighted account.
- No match: the text stays in the field, the field gets the error border, and the row says `Konto 1999 finns inte i kontoplanen. Kontrollera numret eller skapa kontot.` Focus stays in the field.
- Leaving the field without committing: an exact number is committed; anything else shows `Välj ett konto i listan.`
- Esc closes the list and keeps the text.

### Keyboard flow

| From | Key | Goes to |
|---|---|---|
| Open | | Beskrivning |
| Beskrivning | Tab | Serie, then Bokföringsdatum, Konteringsmall, Belopp (only with a template), row 1 Konto |
| Beskrivning | Enter | Bokföringsdatum |
| Bokföringsdatum | Enter | first empty Konto |
| Konto (committed) | Tab or Enter | Debet (or Transaktionsinfo when the user option is on) |
| Konto (empty) | Tab or Enter | **Bokför** (the "done" signal). Enter again books if the voucher is valid |
| Transaktionsinfo | Tab or Enter | Debet |
| Debet filled | Tab or Enter | next row's Konto (a row is added if needed) |
| Debet empty | Tab or Enter | Kredit |
| Kredit | Tab or Enter | next row's Konto |
| Debet or Kredit | `=` | fills the remaining difference, if this side must grow |
| anywhere | Ctrl Enter (Cmd Enter) | Bokför |
| Shift Tab | | walks back, skipping read-only cells and Transaktionsinfo (unless the option is on) |

- **Transaktionsinfo in the Tab order** is a per-user option in the settings popover (gear): `Transaktionsinfo i tabbordningen`. Off by default.
- **The remaining difference** shows as placeholder text in the empty amount field on the side that must grow, when that field has focus. `=` fills it. It is never filled automatically.
- Amounts are formatted when the field is left. Typing an amount on one side clears the other side of that row.

### Validation and Bokför

`Bokför` looks disabled (50% opacity, `aria-disabled="true"`) until the voucher is valid, and the status text says why, first problem first: `Differens 250,00. Debet och kredit måste vara lika.` It stays focusable so the empty-Konto jump works; activating it while invalid moves focus to the first problem and turns the status text destructive.

Valid means: Beskrivning filled; date inside the financial year and not in a locked period; at least two rows with account and amount; every used row has a committed account and a readable amount; debit equals credit.

Date errors under the field: `Datumet ligger utanför räkenskapsåret 2026 (2026-01-01 till 2026-12-31).` / `Perioden 2026-09 är låst. Perioder till och med 2026-09 är låsta sedan momsrapporten lämnades in.`

After booking: the detail view of the new voucher opens, with the toast `A 143 är bokförd.`

### Attachments and comments (side panel)

Non-modal panel on the right (380 px), the entry compresses beside it. Tabs `Underlag n` / `Kommentarer n`.
- Underlag: drop zone with `Välj fil`; `Kopplat` list (removable while unbooked); `Från inkorgen` list with `Koppla`. Attachments can be added before booking; they are booked with the voucher.
- Kommentarer: list, text area, `Lägg till kommentar`. Comments are not part of the voucher and can be added after booking.

## 3. Drafts and conflicts

- `Spara utkast` stores the draft on the server and keeps the user on the page; the title gets an `Utkast` badge and the context line says when and by whom it was saved.
- Opening a draft from the list restores everything, including attachments and comments.
- Every draft has an ETag. Saving sends `If-Match`. If someone else saved in between, the server answers 412 and nothing is saved. The page shows a warning-tint banner, not a dialog:
  - `Anders Holm sparade utkastet 10:41, efter att du öppnade det. Dina ändringar är inte sparade. Välj vilken version du vill fortsätta med.`
  - `Läs in den sparade versionen` (replaces your rows with theirs) and `Spara mina ändringar som nytt utkast`.
  - This is not one of the three failure kinds; it is a conflict and has its own look (warning tint, `users` icon).
- **Leave guard.** Leaving with unsaved changes opens a dialog: `Ändringarna är inte sparade`, body `Spara dem som utkast så kan du fortsätta senare. Inget bokförs.` Buttons: `Släng ändringarna` (left, outline, destructive ink), `Fortsätt redigera` (outline, **has focus**), `Spara utkast` (primary). An untouched form never triggers it. The guard never offers to book.

## 4. Voucher detail (booked)

Read-only page, no primary button.

1. Title `A 138 Representation, kundlunch`; badges: `Bokförd` (lock), plus `Rättelse av …`, `Rättad med …`, `Underlag saknas` as they apply; one line `Bokförd 2026-10-14 09:12 av Karin Ek. Manuell verifikation.` or `Skapad från Leverantörsfaktura 1087.`
2. Right: previous/next (`Alt Up` / `Alt Down`, following the list's current filter and sort) with `3 av 15`; `Kopiera till ny`; `Skriv ut`; `Skapa rättelse` (outline).
3. Locked note (muted): `Bokförd. Kan inte ändras eller tas bort. Fel rättas med en rättelseverifikation, som blir en egen verifikation länkad hit.` If the period is locked too: `Perioden 2026-09 är också låst sedan momsrapporten lämnades in. En rättelse bokförs i en öppen period.`
4. Link note when corrected or a correction: `Rättad med A 140 2026-10-24 11:02 av Karin Ek. Orsak: …` with `Öppna A 140`.
5. Missing attachment (warning tint): `Underlag saknas. Lägg till kvittot eller fakturan. Det loggas med tid och namn.` with `Lägg till underlag`.
6. Facts: Bokföringsdatum, Serie, Belopp, Källa.
7. Rows: Konto, Benämning, Transaktionsinfo, Debet, Kredit, totals.
8. Three cards: **Underlag** (list, `Lägg till`), **Kommentarer** (`Skriv`), **Händelser** (registered and booked, attachments added, copied from, corrected with; each with who and when).

`Skapa rättelse` on an already corrected voucher stays visible, looks disabled, and the reason is written in the locked note: `Skapa rättelse går inte: verifikationen är redan rättad med A 140. Rätta A 140 i stället.`

Attachments added after booking are logged under Händelser and cannot be removed.

## 5. Correction voucher (Rättelse av A 142)

Opened with `Skapa rättelse` on the detail. Same page as new voucher, with:

1. Title `Rättelse av A 142`, number preview, context `A 142 är bokförd och ändras inte. Rättelsen blir en egen verifikation som länkas till A 142 åt båda hållen.`
2. **Original card**, read-only, muted header with lock: `Original: A 142 Hyra november, Fastighets AB Fjällgatan. Bokförd 2026-10-31. Ändras inte.` Its rows each have `Vänd`; the header has `Vänd alla rader`. Vänd adds the row with debit and credit swapped and Transaktionsinfo `Vänd från A 142`, and the button turns into `Tillagd`.
3. **Orsak till rättelsen**: required, first field, focus starts here. Shown on both vouchers.
4. Head fields as new voucher. Beskrivning is prefilled `Rättelse av A 142`. Serie defaults to the original's series if it allows manual entry, otherwise the company's manual series. Date defaults to today and must be in an open period.
5. Rows as new voucher. The correction must balance on its own.
6. **Effekt per konto efter rättelsen**: per account, the original's net, the correction's net and the result, so the user sees the end state before booking.
7. Primary `Bokför rättelse`.

A correction can be saved as a draft like any voucher.

## 6. Receipts and daily takings (Registrera kvitto, Dagskassa)

These are **voucher entry with a registration template**, not separate screen types. They keep their own menu entries because they are separate tasks, but share the voucher engine: number preview, drafts, leave guard, attachments panel, footer, Ctrl Enter, and the booked result is an ordinary voucher (series R and K here) that opens in the detail view.

Layout: two columns that wrap on narrow screens.
- **Left, the form:** Mall, Bokföringsdatum, Beskrivning (prefilled from the template). Then one card per template group with a line per template row: label, the account it posts to (small, muted), amount (144 px), and a text button that opens a Transaktionsinfo field inline under the line. Subtotal per group. Daily takings adds a collapsible **Kassaavstämning** (valfritt): Ingående kontantkassa, Kontant i dag, Utgående kontantkassa.
- **Right, `Så bokförs det`:** the voucher rows the template produces, live (VAT split computed from the template's rates), with totals and `Balanserar` or `Differens`.
- Footer: `Rensa` (left, ghost), status, `Avbryt`, `Spara utkast`, `Bokför`.

Keyboard: Mall, Bokföringsdatum, Beskrivning, then every amount in order; Enter acts like Tab; Enter on the last amount goes to Bokför. Text buttons are not in the Tab order.

Validation: at least one amount, readable amounts, valid date, payments equal costs (receipt) or sales (daily takings): `Betalt 1 250,00, kostnader 1 200,00. Differens 50,00.`

Switching template keeps the amounts whose lines exist in the new template and drops the rest, with a toast saying so. It never clears silently.

Templates in the reference data:
- Kvitto, `Diverse utlägg` (series R): Betalsätt Kontant 1910, Kort 1930; Kostnader inklusive moms: Kontorsmateriel 6110 25 %, Fika 7690 12 %, Frakt 6250 25 %, Förbrukningsinventarier 5410 25 %, Övriga kostnader 6990 25 %.
- Kvitto, `Resa`: Taxi, Flyg, Tåg 5800 6 %, Drivmedel 5611 25 %.
- Dagskassa, `Försäljning inklusive moms` (series K): Varugrupp 25 % 3001/2611, 12 % 3002/2621, 6 % 3003/2631; Betalsätt Kontant 1910, Kort 1580.
