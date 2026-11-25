# Design tokens (wireframe stage)

> Superseded for visual style: see `../DESIGN.md` and `mockups/theme.css`. Layout, spacing and component rules below still apply.

Source: `wireframes/wire.css`.

## Color (grayscale placeholders)

| Token | Value | Use |
|---|---|---|
| `--ink` | #161616 | text, primary action, route, home |
| `--ink-2` | #484848 | secondary text |
| `--line` | #8a8a8a | borders |
| `--line-soft` | #cfcfcf | dividers |
| `--fill` | #e6e6e6 | current item, normal time segment |
| `--fill-soft` | #f2f2f2 | map ground |
| `--paper` | #ffffff | background |

## Type

System UI stack, tabular figures.

| Token | Size | Use |
|---|---|---|
| `--t-hero` | 96px (72px / 60px on mobile) | drill and compare numbers |
| `--t-2xl` | 44px | landing and result headline |
| `--t-xl` | 30px | page title |
| `--t-l` | 22px | section title, verdict |
| `--t-m` | 17px | lead text |
| `--t-s` | 15px | body |
| `--t-xs` | 13px | notes (smallest text size, except provenance tags at 11px) |

## Spacing and shape

4, 8, 12, 16, 24, 32, 48px (`--s1` to `--s7`). Radius 6px; pills for chips. Touch targets at least 40px.

## Layout

- Map stage plus one side panel (420px; 520px while the drill runs).
- Reading screens: one column, 880px maximum.
- One breakpoint at 900px.

## Components

| Component | Notes |
|---|---|
| Header with steps | Address, Household, Home map, Drill, Fix, Plan |
| SAMPLE DATA badge | dashed border; wireframes only |
| Drill band | solid, full width, on screens 4 to 7 |
| Disclaimer footer | warning icon and text, every screen |
| Provenance tag | CALCULATED: solid square. YOUR ESTIMATE: dashed pill. AI-WRITTEN: double border |
| Hero number | value plus unit, with a plain-language heading above |
| Verdict line | icon plus words: "3 min short", "5 min to spare" |
| Time bar | segments on one shared axis; slow task hatched; fixed task outlined; drive solid |
| Closure marker | thick dashed line with label |
| Map | fire hatched and labeled; main route solid; backup dashed; closed dotted with a no-entry mark; destinations as numbered squares |
| List row | icon, title and note, value |

## Rules that survive restyling

- Meaning never depends on color alone.
- Text contrast at least 4.5:1; large text and meaningful graphics at least 3:1.
