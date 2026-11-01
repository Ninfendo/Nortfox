# NortFox theming

Implementation reference: `nortfox-theme.js` (settings to CSS custom properties), `ThemeControls.dc.html` (the controls), `NortFox App Shell.dc.html` (switcher panel, Mitt utseende page, Företagets stil builder).

## Tokens

The standard shadcn token names, unchanged, so any theme from ui.shadcn.com works:

`background foreground card card-foreground popover popover-foreground primary primary-foreground secondary secondary-foreground muted muted-foreground accent accent-foreground destructive border input ring chart-1 … chart-5 sidebar sidebar-foreground sidebar-primary sidebar-primary-foreground sidebar-accent sidebar-accent-foreground sidebar-border sidebar-ring radius`

Added by NortFox, two status pairs:

| Token | Light | Dark |
|---|---|---|
| `--ok-tint` | `oklch(0.962 0.044 156.743)` | `oklch(0.266 0.065 152.934)` |
| `--ok-ink` | `oklch(0.448 0.119 151.328)` | `oklch(0.871 0.15 154.449)` |
| `--warning-tint` | `oklch(0.987 0.022 95.277)` | `oklch(0.279 0.077 45.635)` |
| `--warning-ink` | `oklch(0.473 0.137 46.201)` | `oklch(0.879 0.169 91.605)` |

Derived values (computed from the tokens above, never set by a theme):

| Derived | From |
|---|---|
| `--destructive-tint`, `--destructive-ink` | AA-safe tint and text of `destructive` |
| `--destructive-solid` | `destructive`; darkened in dark mode so white text holds 4.5:1 |
| `--link` | `primary`, adjusted to 4.5:1 on `background` |
| `--nav-active-bg`, `--nav-active-fg` | `sidebar-accent` pair (menu accent subtle) or `sidebar-primary` pair (bold) |
| `--font-sans`, `--font-heading`, `--font-num` | Body font, heading font, number font (Inter when the body font has no tabular digits) |
| `--radius-sm/md/lg/xl`, `--radius-control` | From `radius`; `--radius-control` is fully round in pill styles |
| `--control-h`, `--row-h`, `--pad`, `--gap`, `--shadow-xs`, `--shadow-card`, `--shadow-pop` | From the style and the density setting |

Screens use only these names. No hex, no rgb, no raw oklch in a screen.

## AA adjustments

Applied in place to every theme, imported ones included. The value keeps its hue and chroma and moves in lightness until the requirement is met.

| Pair | Minimum |
|---|---|
| `muted-foreground` on `muted` | 4.5:1 |
| `input` on `background` | 3:1 |
| `ring` on `background` | 3:1 |
| `--link` on `background` | 4.5:1 |
| `destructive-ink` on `destructive-tint` (and ok, warning) | 4.5:1 |
| `chart-1` … `chart-5` on `card` | 3:1 |
| `primary` against `primary-foreground` (theme colours) | 4.5:1 |

Explicit admin choices in the style builder (a forced text colour on the theme colour, a custom theme colour) are **not** adjusted. They are tested, and the style can't be saved until they pass.

## Settings model

Appearance is a set of values. Never CSS.

```jsonc
{
  "style": "nova",          // vega | nova | maia | lyra | mira | luma | sera | rhea
  "base": "neutral",        // neutral | stone | zinc | mauve | olive | mist | taupe (gray is not selectable)
  "accent": "neutral",      // the base colour's own grey or one of the 17 hues; "custom" in the builder only
  "chart": "standard",      // standard | one of the 17 hues
  "mode": "light",          // light | dark | system
  "radius": "default",      // default (0.625rem, same as medium) | none | small | medium | large
  "menu": "default",        // default | inverted
  "menuAccent": "subtle",   // subtle | bold
  "body": "inter",          // font id, one of the 26 fonts
  "heading": "inherit",     // "inherit" (same as body) or a font id
  "density": "compact",     // compact (32 px rows) | standard (40 px)
  "rowTint": "action",      // off | action (warning and destructive rows) | all
  "primaryFg": "auto",      // builder only: auto | light | dark
  "custom": { "h": 250, "l": 0.55 }  // builder only, with accent "custom"
}
```

Resolution order: user setting, then company style, then the NortFox default (Nova, Neutral, Inter with headings inherited, light, compact).

API:
- `GET/PUT /me/appearance`: the user's values. Saved on every change, no save button.
- `GET/PUT /companies/{id}/appearance`: the company style. Admin role. The server validates the values and the contrast; a failing style returns 422 with the failing pairs.
- `GET /appearance/catalogue`: styles, colours, fonts and their locks, so every client shows the same options.

All changes apply live, without a reload, by rewriting the custom properties on `:root`.

## Styles

**Source of truth:** shadcn-ui/ui, `apps/v4/registry/styles/style-<name>.css`, pinned at commit `c0d63c339d`. Each style is one CSS file over one component set; components carry `cn-*` hook classes (`cn-button`, `cn-select-trigger`, ...). The build vendors these files unchanged. Screens never restyle a component per style.

**Radius rules** (from shadcn's pickers): every base colour's default radius is 0.625rem, the same as `medium`. Lyra and Sera lock radius to `none`. Rhea disables `large`.

| Style | Character | Radius | Control height | Lock |
|---|---|---|---|---|
| Vega | Classic, balanced | 0.625rem | 36 px | |
| Nova (default) | Compact, smaller margins | 0.625rem | 32 px | |
| Maia | Soft and round, generous | 0.625rem, round controls | 36 px | |
| Lyra | Boxy, structured | none | 32 px | Radius locked to none |
| Mira | Dense | 0.625rem | 28 px | |
| Luma | Soft and fluid | 0.625rem, round controls | 36 px | |
| Sera | Square and airy | none | 36 px | Radius locked to none |
| Rhea | Compact | 0.625rem | 32 px | `large` disabled |

**Provisional.** Character, control height, round controls, spacing and shadows in this table are working values in the reference mockup. They are replaced by whatever the vendored `style-<name>.css` files define. The radius rules and locks above are final.

A locked setting is shown read-only with its reason, never hidden:
- Lyra, Sera: the corner control is replaced by `Raka hörn` and `Stilen Lyra har alltid raka hörn.`
- Rhea: `Stora` is shown but can't be picked, with `Stilen Rhea tillåter inte stora radier.` under the control.

## Colours and fonts

- **Base colours (7):** `neutral` Neutral, `stone` Sten, `zinc` Zink, `mauve` Malva, `olive` Oliv, `mist` Dimma, `taupe` Gråbrun. They tint the neutral scale. `gray` exists upstream but is not selectable.
- **Theme colours (24 in total):** the 7 base-colour greys plus 17 hues: Röd, Orange, Bärnsten, Gul, Lime, Grön, Smaragd, Blågrön, Cyan, Himmelsblå, Blå, Indigo, Violett, Lila, Fuchsia, Rosa, Ros. **Each base colour offers 18:** the 17 hues plus its own grey. Changing base colour while its grey is the theme colour moves the theme colour to the new base's grey. The text colour on the primary is chosen automatically for contrast.
- **Chart colours:** Standard (five hues) or five shades of one hue.
- **Fonts (26, self-hosted), ids in shadcn's switcher order:** `inter`, `noto-sans`, `nunito-sans`, `figtree`, `roboto`, `raleway`\*, `dm-sans`\*, `public-sans`, `outfit`, `jetbrains-mono`, `geist`, `geist-mono`, `lora`, `merriweather`, `playfair-display`\*, `noto-serif`, `roboto-slab`\*, `oxanium`, `manrope`, `space-grotesk`, `montserrat`, `ibm-plex-sans`, `source-sans-3`, `instrument-sans`, `eb-garamond`, `instrument-serif`\*. The heading font can also be `inherit` (shown as `Samma som brödtext`). \* = no tabular digits; amount columns fall back to Inter and the switcher says so.

## The switcher (per user)

Two entries to the same controls:
- **User menu, then `Utseende`:** a non-modal side panel on the right (420 px). The app stays visible and changes as you choose. Footer: `Följer företagets stil` or `Egna inställningar`, `Öppna som sida`, `Återställ`.
- **Inställningar, then `Mitt utseende`:** the same controls on a page, style tiles four across.

Control order: Läge (Ljust, Mörkt, System), Stil (tiles with a small shape preview), Basfärg, Temafärg, Diagramfärger, Hörn, Tabeller (Täthet, Radfärg), Meny (Färg, Accent), Typsnitt (Brödtext, Rubriker).

Every control is a radio group with `aria-checked`; colour swatches have `aria-label` with the colour name, and the selected name is written next to the heading.

## The style builder (company admins)

`Inställningar > Företagets stil`. Left: the same controls plus two builder-only controls, `Egen` theme colour (hue and lightness) and `Text på temafärg` (Auto, Ljus, Mörk). Right: a live preview in tabs, scoped to the draft so the rest of the app keeps the user's own look:
- **Vyer:** a small shell with menu, a voucher list with statuses and totals, a voucher entry card and a chart.
- **Komponenter:** buttons, fields (normal, error, locked), checkbox, switch, select, badges, the three failure kinds, a dialog.

Under the preview, **Kontrast** lists 15 pairs with sample, ratio and `Klarar` / `Klarar inte`.

Fixed footer: status text, `Visa värden` (the JSON that will be saved), `Återställ`, and the primary `Spara som företagets stil`. If any pair fails, saving is refused and the reason is written next to the button: `Kan inte sparas: 1 färgpar klarar inte kontrastkravet. Se listan Kontrast.`
