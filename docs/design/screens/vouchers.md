# Screen spec: vouchers (Verifikationer)

Applies [../rules.md](../rules.md) and [../app-shell.md](../app-shell.md). Where this spec differs from rules.md or app-shell.md, this spec wins.

This spec copies the behaviour of an established voucher workflow, called "the reference" below: its steps, fields, field order, keys and messages. The look is NortFox's own.

Screens: the voucher list, the voucher form in its five modes (new, copy, reversing voucher, booked, Ändra), and the registration screens for receipts and daily takings. Out of scope here: amount search, extended search, accruals, the inbox screen, the report of deleted vouchers, and the period-lock settings screen.

## How vouchers behave

- **No Save.** The voucher form has two actions, `Avbryt` and `Bokför`. An unbooked voucher has no number and is not stored on the server.
- **An unfinished form is kept in this browser only.** Leaving the form does not ask. Opening `Skapa verifikation` again brings the form back with the notice `Du har en påbörjad registrering, klicka här för att rensa den ifyllda informationen.` Clicking `klicka här` empties it. `Avbryt` empties it and goes to the list without asking. One unbooked form is kept per browser. What `Skapa verifikation` and `Alt N` do on a form that already holds an unfinished entry is open (see Open points).
- **The number is a preview until booking.** The title shows the next number with an asterisk: `Verifikation A143*`. `Bokför` gives the number, shows `Verifikation A143 har skapats.` with a print icon, and opens an empty form for the next number in the same series.
- **A booked voucher can still be changed** with `Ändra`, reversed with `Ändringsverifikation`, and deleted with `Radera` when it is the last in its series.
- **The period lock makes vouchers final.** In a locked period nothing can be booked, changed or deleted. The series the company names as its closing series (`Bokslutsserie (Ej låsbar serie)`) is not locked. In the examples it is I.

## API operations

Every control maps to one of these. MCP tools call the same operations. A voucher is identified by financial year, series and number; every series starts again at 1 each year, so every per-voucher path takes `financialyear`.

| Operation | Used by |
|---|---|
| `GET /vouchers?financialyear=&series=&q=&searchField=&sort=&page=&pageSize=` | List: quick search, series filter, sort, paging |
| `GET /vouchers/{series}/{number}?financialyear=` | Booked voucher, navigation |
| `POST /vouchers` (with `Idempotency-Key`) | `Bokför` in the new, copy and reversing modes, and on the registration screens. Body: `description`, `series`, `date`, `rows`, optional `comment`, `reversalOf {financialyear, series, number}`, `registrationTemplateId`, `inboxDocumentIds` |
| `PATCH /vouchers/{series}/{number}?financialyear=` (with `If-Match`) | `Bokför` in Ändra. Body: `description`, `date`, `comment`, per existing row (by position) `transactionInformation` and `removed: true`, and `addRows`. Account and amounts of existing rows are not accepted. Striking a row is part of this call, so the voucher balances after every change |
| `GET /vouchers/{series}/{number}/reversal?financialyear=` | `Ändringsverifikation`: returns the prefilled body (active rows with debit and credit swapped). Nothing is stored |
| `GET /vouchers/{series}/{number}/copy?financialyear=` | `Kopiera`: returns the prefilled body (active rows). Nothing is stored |
| `DELETE /vouchers/{series}/{number}?financialyear=` | `Radera`. Only the last voucher in its series. The number is given out again. The voucher goes to the deleted-vouchers report |
| `GET /vouchers/deleted?financialyear=` | Report of deleted vouchers |
| `PUT /vouchers/{series}/{number}/comment?financialyear=` | `Kommentar`, `Spara` on a booked voucher |
| `GET /vouchers/{series}/{number}/pdf?financialyear=` | `Skriv ut`, the print icon in the `har skapats` toast, `Bokför och skriv ut` |
| `POST /inbox/documents`, `POST /vouchers/{series}/{number}/attachments?financialyear= {inboxDocumentId}` | Underlag. Files picked before booking are uploaded to the inbox and linked when the voucher is booked |
| `DELETE /vouchers/{series}/{number}/attachments/{id}?financialyear=` | `Koppla bort` in the Underlag panel. The file goes back to the inbox and the processing history logs the unlinking |
| `GET /inbox/documents/{id}/file` | `Ladda ner`, rotate and zoom in the Underlag panel |
| `GET /inbox/documents?linked=false` | Underlag panel: the inbox list, its refresh icon, `Hantera i Inkorgen` |
| `GET /settings/inbox-addresses` | The company's mail-in address for vouchers: the list's tool row (section 1) and `E-posta bild` in the Underlag panel |
| `GET /voucher-series?financialyear=` | `Verifikationsserie` on the form and the list filter; which series is the closing series and which allow manual entry |
| `GET /accounts?financialyear=&numberPrefix=` | Account picker |
| `GET /accounts/{number}/ledger?financialyear=` | `Visa kontoanalys.` |
| `GET /posting-templates` | The `Konteringsmall` list |
| `POST /posting-templates/{id}/apply {amount}` | `Konteringsmall` and `Belopp`: the rows to add |
| `GET /quick-texts` | The quick texts behind the Beskrivning chevron |
| `GET /registration-templates?type=receipt\|daily-takings` | The `Mall` list on the registration screens |
| `GET /registration-templates/{id}` | One template's body: groups, rows, series, the description it prefills |
| `GET /settings/voucher-entry`, `PUT /settings/voucher-entry {transactionInfoEnabled, transactionInfoInTabOrder, showAccountBalanceColumn}` | The Konteringsvy options (section 2), set in Inställningar, Bokföring, Konteringsvy |
| `GET /settings/locked-period` | Lock reasons |

Refusals come back as 422 with the message the screen shows (the texts in section 2) and a pointer to the field or row. A locked period answers with the lock message.

## 1. Voucher list

- **Header:** title `Verifikationer`; the quick search box, which searches voucher number or description (typing opens suggestions with a choice of Verifikationsnummer or Beskrivning, Enter runs the search, × clears it); the link `Utökad sökning` (out of scope here); and on the right the primary `Skapa verifikation`.
- **Tool row, right:** the company's mail-in address for vouchers (a mailto link; documents sent there land in the inbox) and `Skriv ut lista`, which prints the current list.
- **Filter row:** `Verifikationsserie`: `Alla`, then every series as letter and name.
- **Table toolbar, right:** row height (cycles medium, large, small), page size (10, 25, 50, 75, 100), the total (`av 16`), and the pager: first, previous, page numbers, next, last.
- **Columns:** Verifikationsnummer (series and number), Bokföringsdatum, Beskrivning, Belopp (the debit total, right-aligned), an icon column, and the row action `Kopiera`. The icon column has a picture symbol when the voucher has a linked file (no count), a person icon whose tooltip reads `Skapad: 2026-10-14 Av: Karin Ek`, and a speech bubble when the voucher has a comment.
- **Sort:** Verifikationsnummer ascending by default, per series and then by number, so B9 comes before B10. Verifikationsnummer, Bokföringsdatum and Beskrivning sort; clicking again reverses. Belopp does not sort.
- **Remembered in this browser:** sort column and direction, page size, page, row height.
- **No hits:** the column headers and a total of 0, with no text.
- **Kopiera:** an icon button on every row, tooltip `Kopiera (Alt C)`. It follows the same unavailable rule as `Kopiera` on a booked voucher (section 3): on a voucher made by another module it is disabled, with the reason as its tooltip. It is not a Tab stop: it is reached with `Alt C` or the mouse.
- **Keyboard:** Tab goes quick search, Verifikationsserie, then each row. Up and Down move between rows, Enter opens the voucher, `Alt C` copies it. No shortcuts are shown on the screen.

## 2. The voucher form

One full page for every mode. Fixed footer, primary `Bokför` rightmost.

### Header

- Left: the title and number, badges, and for a booked voucher a line of history: `Skapad: 2026-10-14 Av: Karin Ek`, `Ändrad: 2026-10-16 Av: Karin Ek`, the source reference for vouchers made by another module (for a customer invoice `Fakturanr: 11`, with the number as a link to the invoice), and the links `Rättelsepost avser: A138` and `Rättelsepost finns: A140` (each opens the other voucher).
- Right: `Visa lista` (goes to the voucher list), `Underlag n`, `Kommentar`, `Skriv ut` (disabled on the new, copy and reversing forms until the voucher is booked, reason `Skriv ut går när verifikationen är bokförd.`), `Kopiera` (not on unbooked forms), first, previous, next and last voucher (by series and number), and `Skapa verifikation` (in every mode; on an empty new form it opens a fresh form; on a form that holds an unfinished entry, see Open points).
- The four arrows show on a voucher opened from the list, both booked and in Ändra. They do not show when the voucher's address is opened directly, and never on the new, copy or reversing form.
- No shortcuts are shown on the screen.

| Mode | Title | Badges |
|---|---|---|
| New | `Verifikation A143*` | none |
| Copy | `Skapa kopia A143*` | none |
| Reversing voucher | `Skapa ändringsverifikation A143*` | none |
| Booked | `Verifikation A138` | `Bokförd`, and `Låst period` when locked |
| Ändra | `Verifikation A139` | `Ändra` |

### Fields, in this order

1. **Beskrivning**: text, 1 to 200 characters. The chevron opens quick texts.
2. **Verifikationsserie**: series marked for manual entry. In Ändra it shows read-only, with no message.
3. **Bokföringsdatum**: ISO date, `2026-11-02`. In the new and copy modes, on a test day of 2026-11-02 both forms showed 2026-11-01, the date of the voucher made last in series A (see Open points). The reversing form's default date is open (see Open points).
4. **Konteringsmall** and **Belopp**: choosing a template fills Beskrivning; Tab or leaving Belopp adds the template's rows under the existing rows. On a booked voucher both show read-only.
5. **Rows**: Konto, Benämning, Transaktionsinfo, Debet, Kredit, Kontosaldo (the account's balance including this row, updated as you type), row tools. Footer rows: `Summa`, and `Differens`, always shown: the amount under the side that must grow, or 0,00 when the voucher balances. Struck rows are not counted.

Row tools:
- `Dra för att flytta raden`: a drag handle on the rows of an unbooked form and on the new rows in Ändra. Drag a row to a new position.
- `Visa kontoanalys.`: on every row with an account. Opens the account's ledger for the year in a new browser tab.
- `Ta bort rad`: on new rows.
- `Stryk rad`: on existing rows in Ändra (section 4).
- On a booked voucher and in Ändra, a person icon on every existing row. Its tooltip reads `Skapad: 2026-10-14 Av: Karin Ek`, and on a struck row also `Borttagen: 2026-10-16 Av: Karin Ek`.

Column header tools: on the new, copy and reversing forms an icon that clears all rows; in Ändra an icon that strikes all existing rows.

The options for this form are set in Inställningar, Bokföring, Konteringsvy (out of scope here, like the period-lock screen). That section has its own `Spara`, a link to Snabbtexter and three Ja/Nej options: `Aktivera transaktionsinfo` (Ja in the test company), `Låt transaktionsinfo ingå vid tabb-/enterinmatning` (Nej) and `Visa kontosaldokolumn i konteringsvyn` (Ja; Nej hides the Kontosaldo column). What `Aktivera transaktionsinfo` does when set to Nej was not tested.

In the booked mode every field is plain text and Kontosaldo is empty.

### Account picker and keyboard flow

- Typing in Konto lists the accounts whose number starts with the text. **Tab accepts the first match** and moves on. Only number prefixes match: `bank` matches nothing. The list has a `+` button in its header that creates a new account.
- An unknown account empties the field, marks it with the error border and shows a short bubble at the field: `Inga sökresultat hittades.` Focus still moves on to Debet.
- Focus starts in Beskrivning when the form opens.
- Tab moves through the whole path: Beskrivning, Verifikationsserie, Bokföringsdatum, Konteringsmall, Belopp (with a template), Konto, Debet, Kredit, next row's Konto. In the row fields (Konto, Debet, Kredit) Enter acts like Tab. A filled Debet skips Kredit. Transaktionsinfo joins the order with the option `Låt transaktionsinfo ingå vid tabb-/enterinmatning`.
- An empty Konto and Tab or Enter goes to `Bokför`. Further Tab stays on `Bokför`.
- Shift+Tab walks back the same way, and also skips Transaktionsinfo (unless the option is on).
- `+` and Enter in Transaktionsinfo copies the text from the row above.
- Keys: `Alt B` books, `Alt N` opens a new form (on a form that holds an unfinished entry, see Open points), `Alt K` opens Underlag, `Alt C` copies a booked voucher. No other shortcuts.
- Controls outside this path (`Avbryt`, the header tools, the row tools) are reached with the mouse. See "For the owner to decide".

### Bokför and refused bookings

`Bokför` is an enabled primary button on every unbooked form, even an empty one. There is no status text. Problems show as red borders on the field (an unknown account, a date outside every financial year or in a locked period) and in the live Differens line. A row with an account and no amount is allowed.

When the API refuses a booking, it answers with these texts:

| Problem | Text |
|---|---|
| No description | `Beskrivning måste finnas för att verifikationen ska kunna sparas.` |
| Date outside every financial year | `Inget bokföringsår existerar för angivet bokföringsdatum.` |
| Date in a manually locked period | `Karin Ek har låst perioden t.o.m. 2026-09-30.` |
| Date in an automatically locked period | `Bokföringsdatumet ligger i en automatlåst period.` |
| Fewer than two rows with an account | `Ange minst två verifikationsrader.` |
| Debit and credit differ | `Verifikationen balanserar inte.` |
| Unknown account (on the screen the field is emptied first) | `Konto 1999 saknas i kontoplanen.` |

What the screen does when `Bokför` is pressed on a voucher that cannot be booked is open (see Open points).

### Footer by mode

| Mode | Left | Right |
|---|---|---|
| New, copy, reversing voucher | (empty) | `Avbryt`, `Bokför` |
| Ändra | (empty) | `Avbryt`, `Bokför` |
| Booked | `Radera` | `Avbryt`, `Ändringsverifikation`, `Ändra`, `Bokför` (disabled) |

`Avbryt` empties an unbooked form and goes to the list; in Ändra it drops the changes and goes to the list; on a booked voucher it goes to the list.

## 3. A booked voucher

Opened from the list. Everything is read-only.

Tab path: `Visa lista`, `Skapa verifikation`, `Ändra`; focus then stays on `Ändra`. The path starts at `Visa lista`, the first control in the header. Read-only fields, the tools (Underlag, Kommentar, Skriv ut, Kopiera, the arrows), the other footer buttons and the disabled buttons are skipped; they are reached with the mouse.

The actions and when they are unavailable (disabled with `aria-disabled`, reason as tooltip on hover and focus):

| Action | Unavailable when | Reason shown |
|---|---|---|
| `Bokför` | always | `Verifikationen är redan bokförd` |
| `Ändra` | the period is locked | the lock message |
| `Ändringsverifikation` | the voucher was made by another module | `Kan inte skapa ändringsverifikationer på automatskapade verifikationer.` |
| | it already has one | `Ändringsverifikation A140 är redan knuten till verifikationen. Ta bort den för att lägga till en ny ändringsverifikation.` |
| `Radera` | the period is locked | the lock message |
| | it is not the last in its series | `Verifikationen är inte sist i serien. Ta bort de efterkommande verifikationerna i samma serie för att ta bort verifikationen.` |
| `Kopiera` | the voucher was made by another module | `Kan inte kopiera automatskapade verifikationer.` |

`Ändra` stays available on a voucher that has a reversing voucher, and on vouchers made by other modules. Whether `Ändringsverifikation` is offered in a locked period is open (see Open points). A voucher in a locked period can always be corrected by a new, ordinary voucher dated in an open period.

A voucher in a locked period also shows a note under the header: `Låst period.` and the lock text.

Every row has the person icon (section 2, Row tools). Struck rows show struck through and muted, and their tooltip adds `Borttagen: 2026-10-16 Av: Karin Ek`.

## 4. Ändra

Opened with `Ändra`. The title keeps the number and gets the `Ändra` badge.

- Editable: Beskrivning, Bokföringsdatum, Konteringsmall, Transaktionsinfo on every row that is not struck, and new rows.
- Not editable: the series, and the account and amounts of existing rows.
- Existing rows get `Stryk rad` in place of `Ta bort rad`, and the column header has an icon that strikes all existing rows. A struck row is drawn struck through, leaves the totals, and its button becomes `Ångra strykning.` until booking. A row struck earlier stays struck.
- To change an account or an amount: strike the row and add a new one. The Differens goes back to 0,00 once the voucher balances again.
- `Bokför` saves the change on the same number, shows `Verifikation A139 har uppdaterats.` and goes to the list. The voucher gains `Ändrad: date Av: user`. Struck rows record who struck them and when.
- Konto, Debet and Kredit of existing rows are plain text, and Kontosaldo shows each account's balance.
- The Tab path skips existing rows: Beskrivning, Bokföringsdatum, Konteringsmall, then Konto on the first new row. Their Transaktionsinfo and `Stryk rad` are reached with the mouse. Transaktionsinfo also joins the Tab path with the option `Låt transaktionsinfo ingå vid tabb-/enterinmatning`.

## 5. Ändringsverifikation

Opened with `Ändringsverifikation` on a booked voucher. A new, unbooked form:

- Title `Skapa ändringsverifikation A143*`, Beskrivning `Ändringsverifikation A138`, the original's series (when manual). The default date is open (see Open points).
- The active rows of the original with debit and credit swapped. Struck rows are left out. Everything stays editable.
- The Underlag panel opens by itself.
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
- **Underlag** opens a non-modal side panel on the right, 420 px: a drop zone with `Ladda upp`; `E-posta bild`, which shows the company's mail-in address for vouchers so a picture can be e-mailed into the inbox; `Hantera i Inkorgen`; `Koppla fler`; the linked files, each with `Ladda ner`, rotate, zoom and `Koppla bort`; and the inbox with `Koppla` and a refresh icon. Files can be linked before and after booking. `Koppla bort` unlinks a file and puts it back in the inbox; the processing history logs it. It works on every voucher, booked ones too, also in a locked period (plan slice 3e). Whether the reference checks the lock there is settled in 3e's issue (see Open points).

## 9. Registrera kvitto and Registrera dagskassa

Voucher entry with a registration template. They have their own menu entries under Bokföring, right after Verifikationer: `Registrera dagskassa`, then `Registrera kvitto` (see [../app-shell.md](../app-shell.md)). The booked voucher is an ordinary voucher in the template's series (for example K for receipts and F for daily takings) and opens in the voucher form.

- **Header:** the title and the preview number, for example `Registrera kvitto K13*`. Before a template is chosen the number is only `*`.
- **Head fields:** **Mall**; then **Bokföringsdatum** (today) and **Verifikationsbeskrivning** side by side. With no template chosen, only these three fields show. Registrera kvitto prefills the template's text (`Utlägg`, `Resa`); Registrera dagskassa prefills the template name. Switching template clears the amounts without asking.
- **Body:** one group per template group: a heading, one line per row (label, amount, and a pin button for Transaktionsinformation) and a subtotal. The template's accounts are not shown.
  - Registrera kvitto: Betalsätt (Kontant, Kort), then the template's cost rows, including VAT. No VAT fields and no Differens line.
  - Registrera dagskassa: the sales rows per VAT rate; the VAT rows (`Moms 25 %`, `Moms 12 %`, `Moms 6 %`, typed, not computed) on templates that sell excluding VAT; Betalsätt (Kontant, Kort); then a live **Differens** line, with its own pin: payments minus sales minus VAT. Then **Avstämning kontantkassa**, collapsed by default and remembered in this browser: Ingående kontantkassa, Dagens kontantkassa, Dagens uttag, Avstämning kontantkassa.
- **Pin:** opens the dialog `Transaktionsinformation` with one text field and `Avbryt`, `Spara`.
- **Kommentar:** a text area under the body, reached with the mouse only.
- **Underlag:** the side panel, as on the voucher form.
- **Footer:** Registrera kvitto: `Rensa` (left), `Bokför` (right). Registrera dagskassa: `Rensa` (left), `Bokför och skriv ut` and `Bokför` (right). No Save, no `Avbryt`, no status text, and no shortcuts shown. `Rensa` empties the amounts and keeps the template.
- **Tab path, Registrera kvitto:** Mall, Bokföringsdatum, Verifikationsbeskrivning, Kontant, Kort, each cost row, `Bokför`.
- **Tab path, Registrera dagskassa:** Mall, Bokföringsdatum, Verifikationsbeskrivning, the sales rows, the VAT rows (when the template has them), Kontant, Kort, `Bokför och skriv ut`, `Bokför`.
- On both, focus stays on `Bokför` after Tab from the last field. The pins, Ingående kontantkassa and Kommentar are not in the Tab path.
- **Leaving the screen:** once a template is chosen, leaving opens the dialog `Bokför ändringar` with the body `Du har osparade ändringar i vyn, vill du bokföra?` and the buttons `Nej` (left) and `Ja` (right, primary). `Ja` has the focus, so Enter books. `Nej` leaves without booking. The dialog shows even after `Rensa` with all amounts empty.

## Open points

Not yet settled by tests:

- The default Bokföringsdatum in the new and copy forms. One test day showed the date of the voucher made last in the series; another source gives the latest date booked in the series, which on that day was a different voucher. Registrera kvitto showed the day's date. Open until tested on more days.
- The reversing voucher's default date: the original's date or the new form's default. On the test day both were the same date. Settled in plan slice 3d's issue.
- Whether `Ändringsverifikation` is offered on a voucher in a locked period. Settled in plan slice 3d's issue.
- Whether Tab after the account on the last row fills the difference by itself. One source says it does; a test saw no pre-fill. So it stays open.
- What the voucher form does when `Bokför` is pressed on a voucher that cannot be booked. Proposal for the owner: mark the fields and show the refusal text from section 2.
- Registrera kvitto and Registrera dagskassa: what Enter does; what `Bokför` and `Bokför och skriv ut` leave on the screen (for example whether `Verifikation K13 har skapats.` shows and the form empties); and the texts of a refused booking.
- Saving a comment on a voucher in a locked period.
- Whether the Konteringsvy options apply per user or per company.
- What `Skapa verifikation` and `Alt N` do on a form that holds an unfinished entry: keep the form with the notice `Du har en påbörjad registrering, …`, or open a fresh one. The notice was seen only when coming back from the list.
- Whether the reference checks the period lock when a file is unlinked from a booked voucher. Settled in plan slice 3e's issue.
- The reason texts on a disabled `Kopiera` (section 3) and `Skriv ut` (section 2). This spec uses NortFox's own texts.
- What Enter does in the head fields: Beskrivning (with its quick-text list), Verifikationsserie, Bokföringsdatum, Konteringsmall and Belopp.
- The source reference on vouchers from other modules: supplier invoices, bank and the VAT report. Not seen yet.

For the owner to decide:

- Whether the app-wide keys from [rules.md](../rules.md) section 9 apply on the voucher screens: `Ctrl Enter` (book), `/` (filter the list), `N` (new voucher from the list) and `?` (show all shortcuts). None of them is in the reference.
- Whether closing the Kommentar dialog, the Transaktionsinformation dialog or the Underlag panel with unsaved changes asks first. Nobody has seen the reference ask.
- Whether disabled buttons are Tab stops. [rules.md](../rules.md) section 7 makes them focusable; the measured paths skip them.
- Keyboard access to the controls outside the measured Tab paths: on the new form `Avbryt`, the header tools and the row tools; on a booked voucher the header tools, `Avbryt`, `Ändringsverifikation` and `Radera`. WCAG 2.1.1 needs them reachable.
- Keyboard access to existing rows in Ändra. With them out of the Tab path, `Stryk rad` and their Transaktionsinfo need another keyboard route to meet WCAG 2.1.1. Proposal: with focus in the rows table, Up and Down move between rows without changing the Tab path.
- Keyboard access to `Skapa verifikation`, `Utökad sökning`, `Skriv ut lista` and the table toolbar on the list, which the measured Tab path does not reach. WCAG 2.1.1 needs them reachable. Proposal: keep them in the Tab order after the series filter.

Proposals for the owner (not in the reference, so not part of this spec):

- Voucher list: quick filters `Ändrade`, `Rättelseposter` and `I låst period` with counts; a lock icon column; a separate Underlag column and a count of linked files; a status column (`Ändrad 2026-10-16`, `Rättelsepost finns: A140`, `Rättelsepost avser: A138`); a totals row; a note above the list when a period is locked; a text when a search has no hits.
- Account picker: name search (accounts whose name contains the text, after the number matches), and an arrow highlight in the list with Tab or Enter accepting the highlighted account.
- Voucher form: `Alt Up` and `Alt Down` to step between vouchers; `Alt Down` in Beskrivning to open quick texts; date shorthands such as `1102`, `261102` and `20261102`; a footer status that says why a voucher cannot be booked yet; `Balanserar` in place of 0,00 on the Differens line; a row-number column.
- Underlag panel: sending a document by e-mail to an address.
- Registration screens: `Alt B` to book; a panel `Så bokförs det` with the rows the template produces, their totals and `Balanserar` or `Differens` (API: `POST /registration-templates/{id}/preview {values}`).
