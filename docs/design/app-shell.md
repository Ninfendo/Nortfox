# NortFox app shell

```
┌──────────────┬──────────────────────────────────────────────────────────┐
│ Company      │ [≡] Bokföring > Verifikationer   [Räkenskapsår 2026 v] [Sök  Ctrl K] │
│ switcher     ├──────────────────────────────────────────────────────────┤
│──────────────│                                                          │
│ Modules      │  Page content                                            │
│  and their   │                                                          │
│  sections    │                                                          │
│──────────────│                                                          │
│ User menu    │                                                          │
└──────────────┴──────────────────────────────────────────────────────────┘
```

## Regions

| Region | Size | Tokens |
|---|---|---|
| Sidebar | 256 px, 56 px collapsed | `--sidebar`, `--sidebar-foreground`, `--sidebar-border`, `--sidebar-accent` (hover), `--nav-active-bg` / `--nav-active-fg` (current item) |
| Top bar | 52 px | `--background`, bottom border `--border` |
| Content | fills, scrolls on its own | `--background`; page padding 20 px top, 24 px sides |

Sidebar secondary text (org. number, e-mail) is `--sidebar-foreground` mixed 68% over `--sidebar`, which holds 4.5:1 in both menu colours.

## Module navigation (sidebar)

Modules are collapsible groups; each opens to its sections, drawn indented with a hairline on the left. Several groups can be open at once. Open/closed state is remembered per user.

Order for the first release:

1. **Inkorg** (count badge): receipts and documents waiting to be booked
2. **Bokföring**: Verifikationer, Kontoplan, Periodiseringar, Dagskassa, Avstämning, Budget
3. **Bank**: Bankhändelser, Bokföringsregler, Betalningar
4. **Leverantörer** (count of invoices to approve): Leverantörsfakturor, Leverantörsregister
5. **Moms och rapporter**: Momsrapport, Periodisk sammanställning, Rapporter, Behandlingshistorik
6. **Register**: Kostnadsställen, Projekt, Valutor
7. separator
8. **Import och export** (SIE, files)
9. **Inställningar**: Företagsuppgifter, Räkenskapsår och perioder, Användare och roller, Företagets stil, Mitt utseende

Rules:
- Items the user's role can't use are hidden from navigation (unlike locked records, a module you have no role for is not content). Opening such a URL directly shows the *you may not* state with the required role.
- The current section has `aria-current="page"` and the active colours. The menu accent setting chooses subtle (`--sidebar-accent`) or bold (`--sidebar-primary`).
- Count badges show work waiting for the user, nothing else.
- The toggle in the top bar collapses the sidebar to icons; labels remain as tooltips and `aria-label`s. Under 1024 px the sidebar becomes an overlay panel (mobile layouts come in round 2).

## Company switcher

Top of the sidebar: company initials on `--sidebar-primary`, company name, org. number, `chevrons-up-down`.

Opens a popover (360 px) sized for users with hundreds of companies:
- A search field with focus on open: `Sök namn eller organisationsnummer`. Matches name and org. number with or without the hyphen.
- **Senaste**: the last three companies used.
- **Alla företag**: the list, each row with initials, name, org. number and the user's role in that company. The current company has a check.
- A footer line `Visar 12 av 312 företag. Sök för att hitta fler.`
- Footer actions: `Alla företag` (full list page) and `Lägg till företag`.
- Up/Down moves, Enter switches, Esc closes.

Switching company reloads data, not the app: route and filters are kept where they exist in the new company, otherwise the user lands on the module's first section.

API: `GET /companies?query=&cursor=`, `GET /me/companies/recent`, `POST /session/company`.

## Financial year switcher

In the top bar, right side, left of search: `calendar` icon (or `lock` when the year is locked), `Räkenskapsår 2026`, chevron.

Popover (340 px), one row per year, newest first:
- Year, range (`2026-01-01 till 2026-12-31`), one line of state (`Perioder till och med 2026-09 är låsta.`), and a badge: `Öppet` (ok) or `Låst` (neutral).
- Locked years are selectable. Everything in them is read-only, and the page shows the year's lock reason. Actions that create entries show `Låst år, kan inte bokföras` next to them.
- Footer: `Räkenskapsår och perioder` (settings) and `Nytt räkenskapsår`.

The selected year is part of the URL so links and the API agree. API: `GET /financial-years`, each with `locked`.

## Search and commands

The top-bar button `Sök` with `Ctrl K` (`Cmd K` on Mac) opens a centred modal (620 px wide, 12% from the top):
- Input: `Sök verifikationer, konton, leverantörer eller kommandon`.
- Results grouped: **Kommandon**, **Verifikationer**, **Konton**, **Leverantörer**, later more modules. Each row: icon, label, right-aligned meta (amount, org. number or shortcut).
- The first result is selected. Up/Down, Enter, Esc. Footer shows these keys.
- Commands are the same operations as the visible controls (`Skapa verifikation`, `Byt företag`, `Byt räkenskapsår`, `Utseende`). Search never offers an action that isn't elsewhere in the UI and in the API.
- No results: `Inga träffar för ”…”.`

API: `GET /search?q=&types=`.

## User menu

Bottom of the sidebar: avatar initials, name, e-mail. Opens upward:
- Header: name and role in the current company (`Administratör i Bergström Konsult AB`).
- `Min profil`
- `Utseende` (opens the appearance side panel; see [theming.md](theming.md))
- `Språk` with the current language on the right (`Svenska`, `English`)
- `Kortkommandon` with `?`
- separator
- `Logga ut`

## Reserved

- **Assistant:** a button in the top bar right of search, opening a non-modal side panel. Designed in a later round.
- **Offline bar:** directly under the top bar, full content width (rules.md, section 5).
