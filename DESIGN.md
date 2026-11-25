---
name: Safe Passage
description: A night-time drill table for rehearsing one household's wildfire leaving plan.
colors:
  night-ground: "#0a0f16"
  ink: "#eef3f9"
  ink-secondary: "#a9b8cb"
  line: "#34465e"
  line-soft: "#223044"
  line-strong: "#64799a"
  fill: "#1b2737"
  fill-soft: "#0f1722"
  fill-hover: "#26364c"
  field: "#0c141f"
  panel-glass: "rgba(20, 29, 42, .78)"
  route-cyan: "#3ddcf5"
  route-cyan-hover: "#7ce9fa"
  route-ink: "#03232b"
  short-coral: "#ff8585"
  spare-green: "#55e6a5"
  drill-amber: "#ffc24d"
  drill-ink: "#211500"
  fire-orange: "#ff7a2f"
  fire-text: "#ffab70"
  fire-hot: "#ffc061"
  fire-ember: "#b8451f"
  fire-burned: "#3a1b14"
  map-ground: "#0b161d"
  road: "#587190"
  highway: "#7a93b4"
  bar-prep: "#2a3a50"
typography:
  display:
    fontFamily: "Barlow Semi Condensed, Barlow, system-ui, sans-serif"
    fontSize: "112px"
    fontWeight: 700
    lineHeight: 0.9
    letterSpacing: "-0.01em"
    fontFeature: "tnum"
  metric:
    fontFamily: "Barlow Semi Condensed, Barlow, system-ui, sans-serif"
    fontSize: "52px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.01em"
  landing-headline:
    fontFamily: "Barlow Semi Condensed, Barlow, system-ui, sans-serif"
    fontSize: "58px"
    fontWeight: 700
    lineHeight: 1
  headline:
    fontFamily: "Barlow, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.15
  title:
    fontFamily: "Barlow, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.15
  subtitle:
    fontFamily: "Barlow, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.15
  body:
    fontFamily: "Barlow, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.45
    fontFeature: "tnum"
  small:
    fontFamily: "Barlow, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.45
  tag:
    fontFamily: "Barlow, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 800
    lineHeight: 1.5
    letterSpacing: "0.04em"
rounded:
  tag: "2px"
  check: "5px"
  bar: "8px"
  control: "10px"
  panel: "16px"
  pill: "99px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "24px"
  s6: "32px"
  s7: "48px"
components:
  button:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "12px 24px"
    height: "44px"
  button-hover:
    backgroundColor: "{colors.fill-hover}"
  button-primary:
    backgroundColor: "{colors.route-cyan}"
    textColor: "{colors.route-ink}"
    rounded: "{rounded.control}"
    padding: "12px 24px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.route-cyan-hover}"
  input:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "12px"
    height: "44px"
  box:
    backgroundColor: "{colors.panel-glass}"
    rounded: "{rounded.panel}"
    padding: "24px"
  chip:
    backgroundColor: "{colors.fill-soft}"
    typography: "{typography.small}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
  tag:
    textColor: "#d6e0ee"
    typography: "{typography.tag}"
    padding: "1px 6px"
  drill-band:
    backgroundColor: "{colors.drill-amber}"
    textColor: "{colors.drill-ink}"
    padding: "7px 16px"
---

# Design System: Safe Passage

## Overview

**Creative North Star: "The Night Drill Table"**

A household sits over a dark table and rehearses leaving. The ground is deep blue-black, panels are translucent with thin cool borders, and the map is the stage. One comparison, time available against time needed, outshines everything else on the screen. The system refuses the look of a multi-panel live-alert dashboard: this is practice, and every screen says so.

Light is rationed by meaning. Cyan is the way out and the next action. Warm colors belong to the drill and the simulated fire. Coral and green deliver the verdict. Everything else stays in cool blue-grays so those signals read at a glance. Voice on screen is short, plain and calm.

The system is recorded from the design mockups in `design/mockups/`; no app code exists yet, all on-screen values are sample data, and the maps are schematic.

**Key Characteristics:**
- Dark only on screen; the personal plan alone prints dark on white.
- Very large condensed numbers carry the comparison.
- Fire is drawn as the model's own grid cells with a glowing front.
- Every number carries a provenance tag whose shape, not color, tells its source.
- Drill screens wear an amber band; every screen carries the practice-only disclaimer.

## Colors

A cool blue-black field with a small set of signal colors, each tied to one meaning. Frontmatter holds the values.

### Primary
- **Route Cyan** (route-cyan): the household's route, the primary button, focus rings, checked controls, the current step, text selection, and the drive segment of time bars. Text on it is Route Ink.

### Secondary
- **Spare Green** (spare-green): time to spare, the "After" panel, fixed bar segments, candidate destinations.
- **Short Coral** (short-coral): time short, the "Before" panel, road closures and the closure line.
- **Drill Amber** (drill-amber): the drill band, the disclaimer icon, and (darkened into a diagonal hatch) the slow task segment.

### Tertiary
- **Fire Orange** (fire-orange, fire-hot, fire-ember, fire-burned): the simulated fire's cells, glow and ignition points. **Fire Text** (fire-text) colors the countdown to a road closure.

### Neutral
- **Night Ground** (night-ground): page background, under a faint cyan wash at top right and a faint orange wash at bottom left.
- **Ink** and **Ink Secondary** (ink, ink-secondary): primary text; muted text, icons, table heads.
- **Lines** (line-soft, line, line-strong): soft for panel edges and list dividers; line for chips and unselected segments; strong for control borders and table head rules.
- **Fills** (fill, fill-soft, field, panel-glass): button face and current-row highlight; chips and bar tracks; inputs; translucent header, side panel and boxes.
- **Map set** (map-ground, road, highway): the map's own ground and road strokes.

### Named Rules
**The Never Color Alone Rule.** Danger and verdicts always carry an icon or pattern and words; closures are also dashed or struck through.

**The One Meaning Rule.** Cyan means way out or next action, coral means short or closed, green means spare or fixed. Do not borrow them for decoration.

## Typography

**Display Font:** Barlow Semi Condensed (with Barlow, system-ui)
**Body Font:** Barlow (with system-ui)

**Character:** A highway-signage family, self-hosted (Barlow 400 to 800, Semi Condensed 700). Body runs at medium weight so it holds on dark ground; numbers are condensed and huge.

### Hierarchy
- **Display** (700, 112px, 0.9): hero minutes, with a 34px secondary-ink unit. In the drill's wide side panel 108px, in before/after panels 100px; at 900px and below, 80px and 66px.
- **Metric** (700, 52px, 1): large condensed figures and the results verdict sentence.
- **Landing headline** (700, 58px, 1; 44px narrow): the landing page only.
- **Headline** (700, 30px, 1.15): screen titles.
- **Title** (700, 22px): section heads and verdict lines (verdicts at 800; 17px in narrow compare panels).
- **Subtitle** (700, 17px): list-group heads; also the larger lead paragraph size.
- **Body** (500, 16px, 1.45): paragraphs capped at 70ch; tabular numerals everywhere.
- **Small** (500, 13px): notes, legends, chips, disclaimer.
- **Tag** (800, 11px, 0.04em, uppercase): provenance tags only.

Map labels are Barlow 600 with a dark outline stroke, enlarged on short and narrow maps so they stay legible after scaling.

### Named Rules
**The Big Number Rule.** The condensed face is for minutes and the landing headline. Everything read as prose or UI is Barlow.

## Layout

A full-height column: header, optional drill band, main, disclaimer footer. Working screens split into a fluid map stage and one side panel (420px; 520px on drill-running) that holds the hero numbers and ends with the primary action. Reading screens use a centered 880px column. The fix screen is full width: Before and After side by side, then paired time bars on a shared scale with one closure line, then changes beside the map. The landing page pairs a copy column (560px max) with a map preview (680px max).

Spacing follows the 4, 8, 12, 16, 24, 32, 48px scale. Screen padding is 16 to 24px; side-panel groups sit 24px apart.

At 900px and below, grids collapse to one column, the step nav shows only the current step, the side panel moves under the stage (above it on drill-running, so numbers come first), Before and After stay side by side, and time-bar segment words drop to numbers with the key written underneath. The map is capped by viewport height on desktop so numbers and map share one screen.

## Elevation & Depth

Flat, layered by tone and translucency. Depth comes from the ground washes, 78% opaque panels with 14px backdrop blur (header and side panel), and thin cool borders. The side panel carries a faint diagonal sheen from cool to warm. Glow belongs to the fire (a 28px-blurred orange field behind the cells) and a halo under the route.

### Shadow Vocabulary
- **Panel edge light** (`box-shadow: inset 1px 0 0 rgba(200, 225, 255, .10)`): left edge of the side panel.
- **Selected segment** (`box-shadow: inset 0 0 0 1px var(--route)`): thickens the selected choice.
- **Preview lift** (`box-shadow: 0 24px 60px rgba(0, 0, 0, .5)`): the landing map preview only.

### Motion
One authored motion: while a drill is running, the fire front and its glow breathe (1.8s, 2.6s and 3.2s, ease-in-out, alternating), only when reduced motion is not requested. Controls change background and border over 150ms and drop 1px when pressed.

## Shapes

Softly rounded, nested by size: 16px for panels, maps and compare cards; 10px for buttons, inputs, segments and callouts; 8px for time-bar tracks; 5px for checkboxes; full pills for chips and the step nav; 2px for fire cells and squared tags. Borders are 1px by default; 2px marks checkbox outlines and fixed segments; 3px marks the winning "After" panel. Dashed lines mean provisional or blocked: sample-data badge, estimate tag, closure line and closure ring, backup or unused route.

## Components

### Buttons
Solid, quiet, one bright one.
- **Shape:** 10px radius, 44px minimum height, weight 700, 12px by 24px padding.
- **Default:** fill with a strong-line border; hover lightens the fill and border.
- **Primary:** solid route cyan with route ink; lighter cyan on hover. One per screen region, at the foot of the side panel.
- **Focus:** 3px cyan outline, 2px offset. **Pressed:** 1px down. Secondary navigation is an underlined text link.

### Provenance Tags
Uppercase 11px labels: **Calculated** (solid 1px border, 2px corners), **Your estimate** (dashed pill), **AI-written** (3px double border). Same color and tint for all three.

### Chips
Pill, soft fill, 1px line border, 13px; used for run conditions. The sample-data badge is a dashed, bold variant in the header.

### Cards / Containers
Boxes are glass panels with a soft border, 16px radius and 24px padding (12px by 16px on the landing page). **Before** has a coral border and coral-tinted corner; **After** has a 3px green border and green tint. A **callout** is a bordered, coral-tinted line for the shortfall verdict.

### Inputs / Fields
Field fill, strong-line border, 10px radius, 44px minimum height. Checkboxes and radios are custom 20px controls that fill with cyan. Segmented choices are labeled radios in bordered tiles; the selected tile gets a cyan border and tint. Range sliders use a cyan accent.

### Navigation
A translucent header: route-arrow mark and wordmark (800, 19px), a pill step list (current step has a cyan border and tint), the sample-data badge, and the "How this plan was made" link.

### Lists and Tables
Rows divided by soft rules with 12px vertical padding: 22px stroke icon, label, right-aligned bold value. The task in progress gets a fill background. Tables use the same soft rules with a strong rule under secondary-ink heads.

### Drill Band and Disclaimer
The amber band reads that this is a drill with a simulated fire and not a live alert; it sits under the header on drill and fix screens. The footer disclaimer, with an amber warning triangle, is on every product screen.

### Time Bars
A 40px track on a fixed minute scale with absolutely placed segments: slate prep tasks, amber-hatched slow task, green-outlined fixed task, cyan drive. A dashed coral line marks the road closure and crosses both bars when comparing. A written key repeats the order.

### Drill Map
Dark ground with faint contour rings and cool road strokes; cyan route with halo (dashed when backup, gray dashed when unused); white home dot in a cyan ring; green squared destination markers; wind arrow with text. Fire is 12-unit grid cells: hatched burned area, ember, orange and hot front, translucent spot cells, over a blurred glow, labeled "SIMULATED FIRE".

## Do's and Don'ts

### Do:
- **Do** make time available against time needed the largest thing on any drill or compare screen.
- **Do** put a provenance tag on numbers and generated wording.
- **Do** keep the drill band on drill and fix screens and the disclaimer on every product screen.
- **Do** pair every danger color with an icon or pattern and words.
- **Do** compare before and after on one scale with the same fire, and say the conditions.
- **Do** keep text at WCAG AA contrast or better.

### Don't:
- **Don't** build a multi-panel live-alert dashboard or let a drill be mistaken for a live event.
- **Don't** draw the fire as a smooth shape or photographic flames; it is the model's cells.
- **Don't** distinguish provenance tags by color.
- **Don't** use route cyan, short coral or spare green as decoration.
- **Don't** add motion beyond the breathing fire front and short control feedback.
