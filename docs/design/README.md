# NortFox design

These files are the design rules every NortFox screen follows. Agents and people building screens read them before writing UI.

| File | What it covers |
|---|---|
| [rules.md](rules.md) | Rules for every screen: tables, forms, locked state, empty/loading/error, status, buttons, dialogs vs side panels, keyboard and focus, numbers and dates, copy |
| [app-shell.md](app-shell.md) | The app shell: module navigation, company switcher, financial year switcher, search, user menu |
| [theming.md](theming.md) | Tokens, the appearance settings model, the per-user switcher and the company style builder |
| [screens/vouchers.md](screens/vouchers.md) | Vouchers: the list, the voucher form (new, copy, Ändringsverifikation, booked, Ändra), Radera, Kopiera, the period lock, Registrera kvitto and Registrera dagskassa |

The text in these files is the whole reference. The mockups it was drawn from are not in this repository.

## The five rules that override everything else

1. **API first.** Every action on a screen is an operation in the public API and in MCP. A screen is one client. Never design an action that only a screen can perform. Every screen spec lists the API operations it calls.
2. **Semantic tokens only.** No colour, radius, shadow or font value is written into a screen. Every screen must hold up in every style, theme and mode.
3. **Locked shows its reason.** Anything that can't be changed stays visible, read-only, with what, why, who and when, plus what the user can do instead.
4. **Swedish first.** English is the second language. No en dash or em dash in UI text.
5. **WCAG AA.** Text 4.5:1, input borders, focus ring and chart marks 3:1. Focus is always visible.
