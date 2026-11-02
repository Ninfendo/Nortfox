# Screen spec: vouchers (Verifikationer)

Applies [../rules.md](../rules.md) and [../app-shell.md](../app-shell.md).

Screens: the voucher list, the voucher form in its five modes (new, copy, reversing voucher, booked, Ändra), and the registration screens for receipts and daily takings. Out of scope here: amount search, extended search, accruals, the inbox screen, the report of deleted vouchers, and the period-lock settings screen.

## How vouchers behave

- **No Save.** The voucher form has two actions, `Avbryt` and `Bokför`. An unbooked voucher has no number and is not stored on the server.
- **An unfinished form is kept in this browser only.** Leaving the form does not ask. Opening `Skapa verifikation` again brings the form back with the notice `Du har en påbörjad registrering, klicka här för att rensa den ifyllda informationen.` Clicking `klicka här` empties it. `Avbryt` empties it and goes to the list without asking. One unbooked form is kept per browser.
- **The number is a preview until booking.** The title shows the next number with an asterisk: `Verifikation A143*`. `Bokför` gives the number, shows `Verifikation A143 har skapats.` and opens an empty form for the next number in the same series.
- **A booked voucher can still be changed** with `Ändra`, reversed with `Ändringsverifikation`, and deleted with `Radera` when it is the last in its series.
- **The period lock makes vouchers final.** In a locked period nothing can be booked, changed or deleted. The closing series (I, Bokslut) is not locked.

## API operations

Every control maps to one of these. MCP tools call the same operations. A voucher is identified by financial year, series and number.

| Operation | Used by |
|---|---|
| `GET /vouchers?financialyear=&series=&q=&filter=&sort=&cursor=` | List, quick filters |
| `GET /vouchers/{series}/{number}?financialyear=` | Booked voucher, navigation |
| `POST /vouchers` (with `Idempotency-Key`) | `Bokför` in the new, copy and reversing modes, and on the registration screens. Body: `description`, `series`, `date`, `rows`, optional `comment`, `reversalOf {series, number}`, `registrationTemplateId`, `inboxDocumentIds` |
| `PATCH /vouchers/{series}/{number}` (with `If-Match`) | `Bokför` in Ändra. Body: `description`, `date`, `comment`, per existing row (by position) `transactionInformation` and `removed: true`, and `addRows`. Account and amounts of existing rows are not accepted. Striking a row is part of this call, so the voucher balances after every change |
| `GET /vouchers/{series}/{number}/reversal` | `Ändringsverifikation`: returns the prefilled body (active rows with debit and credit swapped). Nothing is stored |
| `GET /vouchers/{series}/{number}/copy` | `Kopiera`: returns the prefilled body (active rows). Nothing is stored |
| `DELETE /vouchers/{series}/{number}` | `Radera`. Only the last voucher in its series. The number is given out again. The voucher goes to the deleted-vouchers report |
| `GET /vouchers/deleted?financialyear=` | Report of deleted vouchers |
| `POST /inbox/documents`, `POST /vouchers/{series}/{number}/attachments {inboxDocumentId}` | Underlag. Files picked before booking are uploaded to the inbox and linked when the voucher is booked |
| `GET /inbox/documents?linked=false` | Underlag panel, inbox list |
| `PUT /vouchers/{series}/{number}/comment` | `Kommentar`, `Spara` on a booked voucher |
| `GET /vouchers/{series}/{number}/pdf` | `Skriv ut` |
| `GET /accounts?query=` | Account picker |
| `POST /posting-templates/{id}/apply {amount}` | Konteringsmall |
| `POST /registration-templates/{id}/preview {values}` | Registration screens, "Så bokförs det" |
| `GET /settings/locked-period` | Lock notes and lock reasons |

Refusals come back as 422 with the message the screen shows (the texts below) and a pointer to the field or row. A locked period answers with the lock message.

## 1. Voucher list

Page header: title `Verifikationer`, one line `Räkenskapsår 2026, alla serier.`, primary `Skapa verifikation` with `Alt N` (also `N` when focus is not in a field).

Under it, when a period is locked, a note: `Låst period.` and the lock text, for example `Karin Ek har låst perioden t.o.m. 2026-09-30.`

Toolbar: filter field (`/`), series select, count. Table card with quick filters at the top: `Alla`, `Ändrade`, `Rättelseposter`, `I låst period`, each with a count.

Columns: lock icon (with the lock message as its label), Ver.nr, Datum, Beskrivning, Underlag (paperclip and count, speech bubble when the voucher has a comment), Belopp (debit total of active rows), Status, row actions. Default sort: voucher number ascending, per series, so B9 comes before B10. Totals row: `Summa, 16 verifikationer` or `Summa för urvalet, …`.

Status shows only exceptions, neutral tone:

| Voucher | Status |
|---|---|
| Booked, unchanged | empty |
| Changed with Ändra | `Ändrad 2026-10-16` |
| Has a reversing voucher | `Rättelsepost finns: A140` |
| Is a reversing voucher | `Rättelsepost avser: A138` |

Row colour follows the user's `rowTint` setting. None of these states needs action, so `Åtgärd` colours nothing and `Alla` gives these rows the muted tint.

Row actions: a `Kopiera` icon button on every row, tooltip `Kopiera (Alt C)`. It follows the same unavailable rule as `Kopiera` on a booked voucher (section 3): on a voucher made by another module it is disabled, with the reason as its tooltip.

Keyboard: Tab reaches each row, Up and Down move, Enter opens, `Alt C` copies the focused voucher.

## 2. The voucher form

One full page for every mode. Fixed footer, primary `Bokför` rightmost.

### Header

- Left: the title and number, badges, and for a booked voucher a line of history: `Skapad: 2026-10-14 Av: Karin Ek`, `Ändrad: 2026-10-16 Av: Karin Ek`, `Källa: Leverantörsfaktura 1087` for vouchers made by another module, and the links `Rättelsepost avser: A138` and `Rättelsepost finns: A140` (each opens the other voucher).
- Right: `Underlag n`, `Kommentar`, `Skriv ut`, `Kopiera` (not on unbooked forms), first, previous, next and last voucher (`Alt Up` / `Alt Down`, by series and number), and `Skapa verifikation` (not in the new mode).

| Mode | Title | Badges |
|---|---|---|
| New | `Verifikation A143*` | none |
| Copy | `Skapa kopia A143*` | none |
| Reversing voucher | `Skapa ändringsverifikation A143*` | none |
| Booked | `Verifikation A138` | `Bokförd`, and `Låst period` when locked |
| Ändra | `Verifikation A139` | `Ändra` |

### Fields, in this order

1. **Beskrivning**: text, 1 to 200 characters. `Alt Down` or the chevron opens quick texts.
2. **Verifikationsserie**: series marked for manual entry. In Ändra it shows read-only with a lock and `Serien kan inte ändras.`
3. **Bokföringsdatum**: ISO date. Accepts `1102`, `261102`, `20261102`. In the new and copy modes the default is the date of the voucher made last in the series: on a test day of 2026-11-02 both forms showed 2026-11-01, the date of the voucher made last in series A (see Open points). For a reversing voucher it is the original's date.
4. **Konteringsmall** and **Belopp**: choosing a template fills Beskrivning; Enter, Tab or leaving Belopp adds the template's rows under the existing rows.
5. **Rows**: `#`, Konto, Benämning, Transaktionsinfo, Debet, Kredit, Kontosaldo (the account's balance including this row, updated as you type), row actions. Footer rows: `Summa`, and `Differens` with the amount under the side that must grow, or `Balanserar`. Struck rows are not counted.

In the booked mode every field is plain text and Kontosaldo is empty. Konteringsmall, Belopp, the keyboard hints and the settings button are not shown.

### Account picker and keyboard flow

- Typing in Konto filters the list: accounts whose number starts with the text, then accounts whose name contains it. **Tab accepts the first match** and moves on. Up and Down move a highlight; Tab or Enter then accepts the highlighted account.
- An unknown account empties the field, marks it with the error border and shows a short bubble at the field: `Ingen träff`. Focus still moves on to Debet.
- Tab and Enter: Beskrivning, Verifikationsserie, Bokföringsdatum, Konteringsmall, Belopp (with a template), Konto, Debet, Kredit, next row's Konto. A filled Debet skips Kredit. Transaktionsinfo joins the order with the user option `Låt transaktionsinfo ingå vid tabb- och enterinmatning` (the settings button beside the keyboard hints).
- An empty Konto and Tab or Enter goes to `Bokför`.
- `+` and Enter in Transaktionsinfo copies the text from the row above.
- `Alt B` or `Ctrl Enter` books, `Alt K` opens Underlag, `Alt N` opens a new form, `Alt C` copies a booked voucher.

### Validation

`Bokför` looks disabled until the voucher can be booked. The footer status says why, first problem first, with these texts:

| Problem | Text |
|---|---|
| No description | `Beskrivning måste finnas för att verifikationen ska kunna sparas.` |
| Date outside every financial year | `Inget bokföringsår existerar för angivet bokföringsdatum.` |
| Date in a manually locked period | `Karin Ek har låst perioden t.o.m. 2026-09-30.` |
| Date in an automatically locked period | `Bokföringsdatumet ligger i en automatlåst period.` |
| Fewer than two rows with an account | `Ange minst två verifikationsrader.` |
| Debit and credit differ | `Verifikationen balanserar inte.` |
| Unknown account (API; on the screen the field is emptied first) | `Konto 1999 saknas i kontoplanen.` |

A row with an account and no amount is allowed. Activating `Bokför` while something is wrong moves focus to the first problem and turns the status destructive.

### Footer by mode

| Mode | Left | Right |
|---|---|---|
| New, copy, reversing voucher | status | `Avbryt`, `Bokför` |
| Ändra | status | `Avbryt`, `Bokför` |
| Booked | `Radera` | `Avbryt`, `Ändringsverifikation`, `Ändra`, `Bokför` (disabled) |

`Avbryt` empties an unbooked form and goes to the list; in Ändra it drops the changes and goes to the list; on a booked voucher it goes to the list.

## 3. A booked voucher

Opened from the list. Everything is read-only. The actions and when they are unavailable (disabled with `aria-disabled`, reason as tooltip on hover and focus):

| Action | Unavailable when | Reason shown |
|---|---|---|
| `Bokför` | always | `Verifikationen är redan bokförd` |
| `Ändra` | the period is locked | the lock message |
| `Ändringsverifikation` | the voucher was made by another module | `Kan inte skapa ändringsverifikationer på automatskapade verifikationer.` |
| | it already has one | `Ändringsverifikation A140 är redan knuten till verifikationen. Ta bort den för att lägga till en ny ändringsverifikation.` |
| `Radera` | the period is locked | the lock message |
| | it is not the last in its series | `Verifikationen är inte sist i serien. Ta bort de efterkommande verifikationerna i samma serie för att ta bort verifikationen.` |
| `Kopiera` | the voucher was made by another module | `Kan inte kopiera automatskapade verifikationer.` |

`Ändra` stays available on a voucher that has a reversing voucher, and on vouchers made by other modules. `Ändringsverifikation` stays available in a locked period, because it books a new voucher; its date must then be moved to an open period.

A voucher in a locked period also shows a note under the header: `Låst period.` and the lock text.

Struck rows show struck through and muted, with a history button whose tooltip reads `Skapad: 2026-10-15 Av: Karin Ek` / `Borttagen: 2026-10-16 Av: Karin Ek`.

## 4. Ändra

Opened with `Ändra`. The title keeps the number and gets the `Ändra` badge.

- Editable: Beskrivning, Bokföringsdatum, Konteringsmall, Transaktionsinfo on every row that is not struck, and new rows.
- Not editable: the series, and the account and amounts of existing rows.
- Existing rows get `Stryk rad` in place of `Ta bort rad`. A struck row is drawn struck through, leaves the totals, and its button becomes `Ångra strykning.` until booking. A row struck earlier stays struck.
- To change an account or an amount: strike the row and add a new one. The Differens shows until the voucher balances again.
- `Bokför` saves the change on the same number, shows `Verifikation A139 har uppdaterats.` and goes to the list. The voucher gains `Ändrad: date Av: user`. Struck rows record who struck them and when.
- Konto, Debet and Kredit of existing rows are plain text, and Kontosaldo shows each account's balance.
- The Tab path skips existing rows: Beskrivning, Bokföringsdatum, Konteringsmall, then Konto on the first new row. Their Transaktionsinfo and `Stryk rad` are reached with the mouse. Transaktionsinfo also joins the Tab path with the user option `Låt transaktionsinfo ingå vid tabb- och enterinmatning`.

## 5. Ändringsverifikation

Opened with `Ändringsverifikation` on a booked voucher. A new, unbooked form:

- Title `Skapa ändringsverifikation A143*`, Beskrivning `Ändringsverifikation A138`, the original's series (when manual) and date.
- The active rows of the original with debit and credit swapped. Struck rows are left out. Everything stays editable.
- If the original's date is in a locked period, the date field shows the lock message at once.
- `Bokför` books it as an ordinary voucher, shows `Verifikation A143 har skapats.` and opens an empty form. The two vouchers link both ways: `Rättelsepost avser: A138` on the new one, `Rättelsepost finns: A143` on the original.
- Deleting the reversing voucher (when it is last in its series) removes the link, and the original offers `Ändringsverifikation` again.

## 6. Kopiera

`Kopiera` (or `Alt C`) opens an unbooked `Skapa kopia A143*` with the active rows and the description of the original. The date is the new form's default, not today: on the test day the copy form showed 2026-11-01, the date of the voucher made last in the series. Nothing links the copy to the original.

## 7. Radera

`Radera` on the last voucher in a series opens a dialog:

- Title `Borttagning av verifikation`, body `Vill du verkligen ta bort verifikation ”A142”?`, buttons `Avbryt` and `OK` (destructive). `OK` has the focus, so Enter deletes.
- `OK` deletes it, shows `Verifikation A142 har tagits bort` and goes to the list. The series' next number goes back, so the next voucher gets A142 again.
- The deleted voucher stays readable in the report of deleted vouchers, with its number and a count of how many times that number has been deleted, its date, text, rows and who deleted it when.
- The voucher before it is now last, and its `Radera` becomes available.

## 8. Kommentar and Underlag

- **Kommentar** opens a dialog with one text area (at most 1000 characters) and the buttons `Avbryt` and `Spara`. On an unbooked form, `Spara` keeps the comment with the form and it is booked with the voucher. On a booked voucher `Kommentar` is enabled and `Spara` saves the comment at once (`PUT /vouchers/{series}/{number}/comment`), without Ändra. The list shows a speech bubble for vouchers with a comment.
- **Underlag** opens a non-modal side panel on the right, 420 px: a drop zone with `Ladda upp`, the linked files, and the inbox with `Koppla`. Files can be linked before and after booking. On an unbooked form a linked file can be removed and goes back to the inbox.

## 9. Registrera kvitto and Registrera dagskassa

Voucher entry with a registration template. They have their own menu entries but book ordinary vouchers (series R and K) that open in the voucher form.

- Title with the preview number: `Registrera kvitto R13*`.
- Left: **Mall**, then **Bokföringsdatum** and **Verifikationsbeskrivning** (prefilled with the template name), then one card per template group with a line per row (label, account, amount, a text button for Transaktionsinfo) and a subtotal. Daily takings adds a collapsible **Avstämning kontantkassa**, closed by default.
- **Kommentar**: a text area under the rows. It is reached with the mouse only, not with Tab.
- Right: `Så bokförs det`, the rows the template produces, with totals and `Balanserar` or `Differens`.
- Footer, Registrera kvitto: `Rensa` (left), status, `Bokför` (`Alt B`).
- Footer, Registrera dagskassa: `Rensa` (left), status, `Bokför och skriv ut`, `Bokför` (`Alt B`).
- There is no Save and no `Avbryt`. `Bokför` shows `Verifikation R13 har skapats.` and empties the form for the next one. `Bokför och skriv ut` books the same way and opens the voucher's print.
- Tab path, Registrera kvitto: Mall, Bokföringsdatum, Verifikationsbeskrivning, Kontant, Kort, each cost row, `Bokför`.
- Tab path, Registrera dagskassa: Mall, Bokföringsdatum, Verifikationsbeskrivning, the sales rows, the VAT rows (when the template does not compute them), Kontant, Kort, `Bokför och skriv ut`, `Bokför`.
- On both, Enter acts like Tab, and after the last field the focus stays on `Bokför`. The Transaktionsinfo buttons and Kommentar are not in the Tab path.
- **Leaving the screen:** once a template is chosen, leaving opens a dialog. It says there are unsaved changes and asks whether to book them. The buttons are `Nej` (left) and `Ja` (right, primary). `Ja` has the focus, so Enter books. `Nej` leaves without booking. The dialog shows even after `Rensa` with all amounts empty.
- Validation uses the same texts as the voucher form.

## Open points

- The default Bokföringsdatum in the new and copy forms. One test day showed the date of the voucher made last in the series; another source gives the latest date booked in the series, which on that day was a different voucher. Registrera kvitto showed the day's date. Open until tested on more days.
- Whether Tab after the account on the last row fills the difference by itself. One source says it does; a test saw no pre-fill. So it stays open.
- The reason text on a disabled `Kopiera` and `Skriv ut`. The prototype uses NortFox's own texts.
- Saving a comment on a voucher in a locked period is not tested.
- The exact wording of the leave dialog on the registration screens.
- Keyboard access to existing rows in Ändra. With them out of the Tab path, `Stryk rad` and their Transaktionsinfo need another keyboard route to meet WCAG 2.1.1. Proposal: with focus in the rows table, Up and Down move between rows without changing the Tab path.
