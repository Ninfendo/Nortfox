# NortFox design rules

Applies to every screen. Token names refer to [theming.md](theming.md). UI strings are given in Swedish and are the source text for translation keys.

## 1. Numbers and dates

Format with `Intl.NumberFormat('sv-SE')`. The API always sends and receives amounts as decimals and dates as ISO 8601. Formatting is a display concern only.

| Type | Display | Rule |
|---|---|---|
| Amount | `1 234,50` | Two decimals, space between thousands (no-break), decimal comma |
| Negative amount | `−1 234,50` | Minus sign before (sv-SE output, U+2212). Never brackets. Never colour alone |
| Foreign currency | `420,00 EUR` | Currency code after the amount. SEK is not written where everything is SEK |
| Exchange rate | `11,4586` | Four decimals |
| Percent | `25 %` | Space before % |
| Account | `1930` | No grouping |
| Org. number | `556812-4471` | Hyphen after six digits |
| Date | `2026-11-01` | ISO 8601, always |
| Period | `2026-11` | Year and month |
| Range | `2026-01-01 till 2026-12-31` | The word *till*, never a dash |
| Time | `14:05` | 24 hours. Relative time only as an addition to the exact time |
| Voucher number | `A142` | Series and number, no space. Before booking the number is a preview with an asterisk: `A143*` |

**Tabular digits.** Amount, date and number cells use `font-variant-numeric: tabular-nums` and the `--font-num` family. DM Sans, Instrument Serif, Playfair Display, Raleway and Roboto Slab have no tabular digits; when the body font is one of them, `--font-num` resolves to Inter automatically. Screens never pick the number font themselves.

**Input parsing** happens when the field loses focus:
- Dates: `20261101`, `2026-11-01`, `261101`, and `1101` (month and day in the current financial year) all become `2026-11-01`.
- Amounts: `1234,5`, `1234.5`, `1 234,50` all become `1 234,50`.
- Invalid input stays in the field as typed and gets an inline error.

## 2. Tables and lists

- **Density** is a per-user setting: *Kompakt* (32 px rows, the default) or *Standard* (40 px). Use `--row-h`; never hard-code a row height.
- **Column order:** identifier (number), date, text, dimensions (cost centre, project), amounts, status, row actions.
- **Amount columns:** header and cells right-aligned, tabular digits, Swedish format, no currency symbol when all values are SEK. Debit and credit are separate columns. An empty value is an empty cell, never `0,00` and never a dash.
- **Sorting:** click the header; one column at a time; the arrow shows direction; `aria-sort` on the `th`. Every list declares a default sort (vouchers: voucher number ascending, per series, so B9 comes before B10). Sorting never moves the totals row.
- **Totals row:** in `tfoot`, `--muted` background, weight 600. The label says what is summed and the count: `Summa, 15 verifikationer`. With an active filter: `Summa för urvalet, 4 verifikationer`. Only sum columns where the sum means something.
- **Text** truncates with an ellipsis and shows in full on hover (`title`). Amounts and dates never truncate. On narrow screens the table scrolls horizontally inside its card.
- **Rows** open on click and on Enter (`tabindex="0"`). Selection checkboxes appear only when the list has bulk actions. Secondary row actions go in a row menu at the far right.
- **Loading:** lists page through the API cursor and scroll on. The count is always shown.
- **Status column** shows exceptions, not the normal state. A booked voucher with nothing to report has an empty status cell.

### Quick filters and row colour

- **Quick filters** sit at the top of the table card, inside it, whenever the list has statuses. One row of buttons, single choice (`role="radiogroup"`). Each button: the status's tone dot (8 px, the tone's ink), the name, and the count in tabular digits.
- **The first button is the default view:** `Att hantera` when the list has work for the user (supplier invoices: under approval, not booked, overdue), otherwise `Alla`.
- **Counts** respect search and the other filters. The choice is part of the URL and is a named query in the API (`?status=`); counts come from the API.
- **Several statuses may share a tone.** No new colours are added for statuses; the four tones in section 6 are the full set. The name is always written in the row.
- **Row colour** is a per-user setting, `Radfärg` under Utseende, Tabeller:
  - `Av`: no row colour; status only in the status column.
  - `Åtgärd` (default): rows whose status is warning or destructive take the tone's tint over the whole row.
  - `Alla`: every row with a status takes its tone's tint, done rows included.
- **A tinted row keeps its text colours** (`--foreground`, inks on the badge), so contrast stays as in section 6, and keeps its status badge (colour is never the only signal).
- **Hover and selection** overlay the row with 5% `--foreground` (inset shadow) instead of replacing the tint.

## 3. Forms

- **Labels** sit above the field and are always visible. Placeholder text is an example, never a label.
- **Optional fields** are marked `(valfritt)`. Required fields are not marked. In grids (voucher rows), nothing is marked and the row is validated.
- **Help text** sits under the field, one sentence at most, linked with `aria-describedby`.
- **Inline errors** replace the help text under the field: icon plus text in `--destructive-ink`, field border `--destructive-ink`, `aria-invalid="true"`. The text says what to do: `Konto 1930 finns redan i kontoplanen. Välj ett annat nummer.`
- **Validation** runs on blur and on submit. On submit, focus moves to the first error. More than one error adds a summary at the top of the form, with links to the fields.
- **Server validation (422)** maps to fields through the API error's field pointer. Errors without a field go in the summary.
- **Field width follows content:** date 128 px, account 88 px, amount 144 px right-aligned, text fills.
- **Tab order** equals visual order. `Ctrl Enter` (`Cmd Enter`) runs the form's primary action.
- **Field order** follows the workflow of the task, as defined in each screen spec.

## 4. Locked, with its reason

Vouchers in a locked period, locked periods, closed financial years, filed reports, settings controlled by something else, missing permissions. All are shown read-only, never hidden, never greyed out without explanation.

A locked state always has four parts:
1. **What** is locked: `Perioder till och med 2026-09-30 är låsta.`
2. **Why:** `Momsrapporten för juli till september är inlämnad.`
3. **Who and when:** `Låst av Karin Ek 2026-10-12.`
4. **What you can do instead**, when there is something: `Ändringsverifikation`, `Visa perioder`.

The API returns `locked: { reason_code, reason, by, at }` on every lockable resource. The UI shows `reason` verbatim and never writes its own.

Patterns:
- **Page level:** a note under the page header. `--muted` surface, `lock` icon, bold *what*, muted *why, who, when*, a link to the place it is managed.
- **Record level:** a `Låst period` badge with `lock` next to the title, the reason under it, the allowed action as an outline button.
- **Field level:** the value rendered as text on `--muted` with a `lock` icon. Not a disabled input. The reason is the help text.
- **Control level** (a setting forced by another setting): the control is replaced by its value plus the reason: `Stilen Lyra har alltid raka hörn.`
- **Disabled buttons** follow section 7: `aria-disabled` and still focusable, with the reason as a tooltip on hover and on focus and as the button's accessible description.

## 5. Empty, loading and error

**Empty** replaces the content where it would have been. One sentence on what is missing and the next step, if the user is allowed to take it. No illustrations.
- First use: `Inga verifikationer ännu` + primary `Skapa verifikation` + outline `Importera SIE`.
- After a filter: `Inga verifikationer matchar filtret.` + the active filter in words + `Rensa filter`.

**Loading**
- Skeleton rows only after 300 ms.
- On refetch, previous data stays and a thin progress line runs at the top of the area.
- A busy button keeps its label and gains a spinner. The page is never blocked.

**Three failure kinds, three looks.** Users must be able to tell them apart at a glance.

| Kind | Cause | Look | Content | Action |
|---|---|---|---|---|
| You may not | 403, business rule | Neutral surface (`--card`, border), `shield-x` icon | What is blocked, which role is required, who can grant it | Link to roles. No retry |
| The server failed | 5xx, timeout | `--destructive-tint` / `--destructive-ink`, `server-off` icon | What did **not** happen, error id | `Försök igen`, `Kopiera fel-ID` |
| You are offline | No network | `--warning-tint` / `--warning-ink`, `wifi-off` icon, one bar under the top bar, app-wide | What still works, what will sync | None. Disappears by itself |

Validation errors (422) are none of these; they show on the field (section 3). Actions that need a connection show `Kräver anslutning` as their reason while offline.

## 6. Status

Four statuses, each an opaque tint and ink pair. Never a translucent overlay. Colour is never the only signal: a status always has text; the icon is optional.

| Status | Tokens | Used for |
|---|---|---|
| Neutral | `--muted` / `--foreground` | Bokförd, Ändrad, Rättelsepost finns: A140 |
| Ok | `--ok-tint` / `--ok-ink` | Avstämd, Attesterad, Betald, Inlämnad |
| Warning | `--warning-tint` / `--warning-ink` | Väntar på attest, Förfaller om 3 dagar |
| Destructive | `--destructive-tint` / `--destructive-ink` | Förfallen, Avvisad, Differens 120,00 |

Badge: 20 px high, 12 px text weight 500, `--radius-control`, 8 px side padding, 12 px icon. One status per row in lists. The status describes a state, never an action.

## 7. Buttons

Variants: primary (`--primary`), secondary (`--secondary`), outline (`--border` on `--background`), ghost, destructive (`--destructive-solid`, white text), link (`--link`). Height `--control-h`, radius `--radius-control`.

- **One primary per view.** A dialog or a side panel is its own view and gets its own primary.
- **Placement:**
  - List view: in the page header, right. It creates something new: `Skapa verifikation`.
  - Form and full page: a fixed footer bar at the bottom, right-aligned; order secondary actions, then primary, so the primary is rightmost: `Avbryt`, `Bokför`. An action that removes the record (`Radera`) sits alone at the far left of the same bar.
  - Dialog: footer, right-aligned, `Avbryt` left of the primary.
- **Labels** start with a verb and say what happens: `Bokför`, `Attestera`, `Lås perioden`. Never `Ja`. Where NortFox follows an established accounting workflow, that workflow's own labels and messages are kept as they are, including `OK` in the delete confirmation.
- **Destructive colour** only on the button that confirms a destructive action, inside the dialog. On the page the same action is an outline button.
- **Unavailable:** prefer an enabled button that explains on click. If disabled (`aria-disabled`, still focusable), the reason shows as a tooltip on hover and on focus and is the button's accessible description.
- **Icon-only** buttons have `aria-label` and a tooltip. Shortcuts show in the tooltip. Whether a view also shows them on screen follows its screen spec; the voucher screens show none.

## 8. Dialog, side panel, page or popover

| Surface | When | Behaviour | Examples |
|---|---|---|---|
| Dialog | A short decision, or 1 to 5 fields, that must be done before going on | Modal, 420 to 640 px, focus trapped, Esc closes | Lås period, Borttagning av verifikation, Nytt räkenskapsår |
| Side panel | View or edit one row without leaving the list; tools that sit beside the work | Right edge, 420 to 560 px, non-modal; the list stays usable and Up/Down changes row | Invoice to approve, Underlag, Utseende, the assistant |
| Full page | Long flows and keyboard-heavy work | Own URL, fixed footer with the primary | Skapa verifikation, Momsrapport, Bankavstämning |
| Popover | A choice that belongs to a button | Under the button, Esc or click outside closes | Byt företag, Räkenskapsår, filters |

Dialogs never stack. A dialog may open from a side panel. Closing a dialog or side panel with unsaved changes asks first. A full-page form follows its screen spec: the voucher form keeps an unbooked entry in the browser and does not ask. Focus returns to the control that opened the surface.

## 9. Keyboard and focus

- **Focus ring:** 2 px `outline` in `--ring`, 2 px offset, at least 3:1 against the background. Global `:focus-visible` rule. Never removed.
- Every page starts with a `Hoppa till innehållet` skip link.
- Tab order equals visual order.
- Single-letter shortcuts only fire when focus is not in a field.

| Key | Action |
|---|---|
| `Ctrl K` / `Cmd K` | Search and commands |
| `/` | Filter the current list |
| `N` | New item in a list view |
| `Up`, `Down` | Move between rows |
| `Enter` | Open the row |
| `Ctrl Enter` / `Cmd Enter` | The view's primary action (Bokför, Spara) |
| `Esc` | Close dialog, panel or popover |
| `?` | Show all shortcuts |

Every shortcut is also an API operation behind a visible control; shortcuts are never the only way. The voucher entry keyboard flow is specified in [screens/vouchers.md](screens/vouchers.md#account-picker-and-keyboard-flow).

## 10. Copy

- Swedish first, English second. All strings go through translation keys.
- No en dash or em dash in UI text. Use a full stop, a comma, a colon, or *till* for ranges.
- Standard accounting words stay as they are: Verifikation, Bokför, Kontoplan, Räkenskapsår, Attest, Periodisering, Ändringsverifikation, Rättelsepost.
- Sentence case: capital letter only at the start of a heading or button.
- Errors say what happened and what the user can do.

| Write | Avoid |
|---|---|
| Bokför | OK (except in the delete confirmation, which keeps `OK`; see section 7) |
| Ange ett datum i räkenskapsåret 2026. | Ogiltigt värde. |
| Perioden är låst. Momsrapporten är inlämnad. | Åtgärden är inte tillåten. |
| 2026-01-01 till 2026-12-31 | 2026-01-01 (dash) 2026-12-31 |
| Servern svarade inte. Inget har sparats. | Något gick fel. |
