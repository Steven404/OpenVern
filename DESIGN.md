---
name: harness
description: Lamplight on canal water: a cool indigo desktop workspace for chatting with LLMs about local code.
colors:
  accent: "#f6bd60"
  accent-2: "#e5865f"
  success: "#9fd4b3"
  danger: "#ff8f87"
  bg: "#0f1428"
  sidebar: "#0b0f20"
  surface: "#1a2142"
  surface-raised: "#222a52"
  surface-raised-hover: "#2c3666"
  surface-raised-active: "#263058"
  bubble: "#232c55"
  tool: "#151b35"
  code: "#0a0d1c"
  border: "#20284a"
  border-header: "#1c2343"
  border-tool: "#29325c"
  border-bubble: "#2f3a68"
  border-control: "#343f72"
  border-hover: "#46528c"
  border-focus: "#5a68a8"
  text: "#ecf0fa"
  text-body: "#d8deef"
  text-code: "#e2e7f5"
  text-secondary: "#c3cbe3"
  text-chat: "#a9b2cf"
  text-muted: "#9ba5c6"
  text-faint: "#8792b6"
  overlay-row: "rgb(200 215 255 / 0.05)"
  overlay-ghost: "rgb(200 215 255 / 0.07)"
  overlay-current: "rgb(200 215 255 / 0.08)"
typography:
  display:
    fontFamily: "Bricolage Grotesque Variable, Bricolage Grotesque, sans-serif"
    fontSize: "44px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.03em"
  wordmark:
    fontFamily: "Bricolage Grotesque Variable, Bricolage Grotesque, sans-serif"
    fontSize: "21px"
    fontWeight: 700
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Figtree Variable, Figtree, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "Figtree Variable, Figtree, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  message:
    fontFamily: "Figtree Variable, Figtree, system-ui, sans-serif"
    fontSize: "15.5px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: "0.12em"
  code:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.7
rounded:
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "18px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  3xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.bg}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  button-outline:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  button-outline-hover:
    backgroundColor: "{colors.surface-raised-hover}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  button-ghost-hover:
    backgroundColor: "{colors.overlay-ghost}"
    textColor: "{colors.text}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.bg}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.md}"
    size: "36px"
  text-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "0 14px"
    height: "44px"
  composer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.xl}"
    padding: "14px 14px 10px 18px"
  user-bubble:
    backgroundColor: "{colors.bubble}"
    textColor: "{colors.text}"
    rounded: "{rounded.xl}"
    padding: "12px 16px"
  tool-row:
    backgroundColor: "{colors.tool}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.lg}"
    padding: "10px 14px"
  code-block:
    backgroundColor: "{colors.code}"
    textColor: "{colors.text-code}"
    rounded: "{rounded.lg}"
    padding: "16px 18px"
  sidebar-chat-current:
    backgroundColor: "{colors.overlay-current}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "7px 10px"
---

# Design System: harness

## Overview

**Creative North Star: "The Blue Hour"**

The few minutes after sunset when the sky turns deep indigo and the windows along a canal light up. The ground is a cool night blue that stays calm for hours of reading; surfaces step up in small dusk-blue increments; and one warm lamplight accent glows where the next action is, the way a lit window draws the eye across dark water. Gable brick, the colour of the canal houses, is the quiet second voice.

The window carries a faint dusk glow at the top (the `--backdrop`), the only gradient in the system. Everything else is flat colour, 1px lines and type. Density is calm, not sparse: a 272px sidebar, a centred 760px conversation column and 32px between turns. The interface shows its work (tool calls, files read, proposed edits) as small legible rows, because the product's stance is visible over magical.

Blue hour is the default theme. The original warm theme, **Late Workshop**, is kept intact as an alternate (see Colors) for a future theme setting.

**Key Characteristics:**
- Cool indigo ground with tonal surface steps, not shadows; one faint dusk glow at the top of the window.
- One warm lamplight accent for the primary action and focus; gable brick for project folders and code keywords.
- Display voice in Bricolage Grotesque, reading voice in Figtree, machine voice in JetBrains Mono.
- Soft corners (8–18px), 1px cool borders, ghost controls by default.
- Self-hosted fonts; no runtime requests to font CDNs.

## Colors

A cool night-blue ramp lit by warm lamplight, taken from canal streets at blue hour.

### Primary
- **Lamplight** (accent): the one primary action per view (Send, Apply), the focus ring, the wordmark's full stop, the current-chat marker and the assistant avatar. Text on it is the ground colour.

### Secondary
- **Gable Brick** (accent-2): project folder icons and code keywords. Never a second primary button.

### Tertiary
- **Seafoam** (success): completed tool calls, added lines, accepted changes, code strings.
- **Signal Coral** (danger): errors, destructive confirms, invalid fields.

### Neutral
- **Blue Hour** (bg): the conversation ground, under the dusk glow.
- **Deep Water** (sidebar): one step darker than the ground so the conversation reads as the lit area.
- **Night Canal** (code): code blocks and diff bodies, the darkest surface.
- **Dusk / Raised Dusk / Hover / Active** (surface, surface-raised and states): composer, fields, outline buttons, selected rows.
- **Bubble** (bubble): the user's own messages.
- **Tow Path** (tool): tool-call rows and inline cards inside assistant replies.
- **Line family** (border → border-focus): six cool steps from hairline dividers to the focused composer edge.
- **Moonlit text family** (text → text-faint): seven cool off-whites, from Moonlit for headings to Mist for meta. Every step passes 4.5:1 on the ground (Mist is 5.9:1).
- **Overlays** (overlay-row / ghost / current): translucent moonlight for row hover, ghost-button hover and the current item.

### Backdrop
`--backdrop` (not a colour token): a radial glow of `rgb(98 126 214 / 0.22)` from above the window's top edge over a vertical ramp `#121a38 → bg → #0d1224`. Painted once, on the app shell.

### Proposed: diff colours (Review changes artboard, not yet tokens)
Added lines sit on seafoam at 10% opacity with a seafoam sign; removed lines on gable brick at 12% with a `#f09a7c` sign; line-number gutters take the same hue a step stronger. Promote these to `diff-*` tokens when the review feature is built.

### Alternate theme: Late Workshop
The original warm theme, kept for a future theme setting. Same token names, warm plum-black values: ground `#161316`, sidebar `#120f12`, surface `#221c21`, text `#f0e6e6`, accent Late Sand `#f2cc8f`, accent-2 Terracotta `#e07a5f`, success Sage `#b8d4a0`, no backdrop glow. The full set lives in `src/renderer/styles/tokens.css` under `[data-theme="late-workshop"]`; setting that attribute on `<html>` switches the whole app.

### Named Rules
**The One Glow Rule.** Lamplight marks at most one primary action per view, plus focus. If two things are amber, one of them is wrong.

**The Night Not Gray Rule.** Every neutral carries the indigo tint. A pure gray (`#888`, `#1e1e1e`) never enters the palette.

**The Same Names Rule.** Themes change values, never token names. A new screen that works in Blue hour works in Late Workshop without edits.

## Typography

**Display Font:** Bricolage Grotesque (with sans-serif)
**Body Font:** Figtree (with system-ui, sans-serif)
**Label/Mono Font:** JetBrains Mono (with ui-monospace, monospace)

**Character:** A slightly quirky grotesque for the few moments the app speaks up, a friendly humanist sans for reading, and a crisp mono for anything the machine produced.

### Hierarchy
- **Display** (700, 44px, 1.1, −0.03em): the New chat prompt only.
- **Wordmark** (700, 21px, −0.02em): the app name in the sidebar.
- **Title** (600, 15px): chat titles in the header, card titles.
- **Body** (400, 15px, 1.5): UI copy and controls.
- **Message** (400, 15.5px, 1.65): conversation prose; the column caps it near 75ch.
- **Label** (500, 11px, 0.12em, uppercase mono): section labels such as Projects; also keyboard hints and counts at 11–12px.
- **Code** (400, 13px, 1.7 mono): code blocks; diffs use 12.5px on a 20px line.

### Named Rules
**The Mono Means Machine Rule.** JetBrains Mono is for code, paths, tool names, timings, counts and key hints. Never for ordinary prose or headings.

## Layout

A flex row that wraps: sidebar (272px, fixed basis) then content (`flex: 999 1 560px; min-width: 0`). The conversation and composer centre in a 760px column (New chat: 720px). The header is 64px with a 1px divider. Turns are 32px apart; inside a turn, 14px. Side padding is 24px. Below 760px the sidebar becomes an overlay. Minimum window is 800×600.

A docked side pane (Review changes) joins the row at a 600px basis (800px in split view) and the conversation shrinks to a 360px floor.

## Elevation & Depth

Tonal and nearly flat. Depth comes from stepped dusk-blue surfaces and 1px borders: sidebar darker than the ground, raised controls lighter, code darkest. Shadows appear only on things that float above the page: menus, popovers, dialogs and the New chat composer.

### Shadow Vocabulary
- **Floating composer** (`box-shadow: 0 24px 64px -32px rgba(0,0,0,0.6)`): the New chat composer, the one hero surface.
- **Segment lift** (`box-shadow: 0 1px 2px rgba(0,0,0,0.35)`): the selected option in a segmented control.

### Named Rules
**The Tone Not Shadow Rule.** If a surface sits in the page flow, separate it with a surface step or a border, never a shadow.

## Shapes

Soft, consistent corners that grow with the element: 6px for key hints and badges, 8px for list rows and small buttons, 10px for buttons and icon buttons, 12px for fields, tool rows, code blocks and the New chat button, 18px for the composer and message bubbles, full pill for chips. The user bubble tucks its bottom-right corner to 6px to point at its author. Borders are always 1px.

## Components

Soft-cornered and quiet: ghost by default, the accent saved for the one action that moves things forward.

### Buttons
- **Shape:** gently rounded (10px; 12px at large size). Heights 32 / 40 / 44px.
- **Primary:** Lamplight fill, ground-colour text, weight 500. Hover brightens 10%.
- **Outline:** raised dusk with a control border; hover steps both up.
- **Ghost:** transparent, secondary text; hover adds the ghost overlay and full-strength text.
- **Danger:** Signal Coral fill for destructive confirms only.
- **Icon button:** 28 / 36 / 40px squares, muted icon, always an `aria-label`.
- **Focus:** 2px Lamplight outline, 2px offset, on every interactive element.
- **Motion:** 150ms ease on background, border and colour. Nothing else animates by default.

### Chips
- **Style:** transparent pill, 1px control border, 13px secondary text, optional 14px icon (e.g. the project chip in the composer). Hover fills with bubble.

### Cards / Containers
- **Tool row:** tow path, 1px tool border, 12px corners, seafoam check, mono tool name, muted path, faint timing.
- **Code block:** night canal, 1px border, 12px corners, 16×18px padding.
- **Proposed edits card:** tow path, 14px corners, file rows with A/M badges and +/− counts, a footer strip one step darker holding status and the Review button.

### Inputs / Fields
- **Style:** surface fill, control border, 12px corners, 44px tall, faint placeholder.
- **Focus:** border shifts to border-focus; the global sand outline also shows.
- **Error / Disabled:** danger border and a danger message below; disabled at 50% opacity.

### Navigation
- **Sidebar:** deep water, mono uppercase section label, project rows 36px with a rotating chevron and terracotta folder icon. Chats indent 30px; the current chat gets the current overlay and a 2px sand inset marker.

### Composer (signature)
Dusk surface, 18px corners, borderless textarea, a tools row with attach (ghost icon), model picker (ghost text) and a 38px sand send button. The border brightens to border-focus while focused.

### Review pane (signature, proposed)
Docked right of the conversation: header with +/− totals and a Unified/Split segmented control, file list with per-file review state, diff body on night canal with sticky file header, per-change Accept/Reject, and an apply bar whose primary button counts the accepted changes.

## Do's and Don'ts

### Do:
- **Do** route every colour through a token from `src/renderer/styles/tokens.css`; themes depend on it.
- **Do** keep Lamplight to one primary action per view, plus focus.
- **Do** show tool calls and proposed edits as visible rows or cards in the conversation.
- **Do** use 1px cool borders and surface steps for separation.
- **Do** keep text at 4.5:1 or better; `text-faint` is the floor for meta text on the ground.
- **Do** add any new colour to both themes in `tokens.css`.

### Don't:
- **Don't** introduce pure grays; neutrals stay indigo-tinted.
- **Don't** put shadows on in-flow surfaces.
- **Don't** use mono for prose or headings.
- **Don't** load fonts from a CDN in the app; use the `@fontsource-variable` packages.
- **Don't** add a second filled accent button beside the primary.
- **Don't** add gradients beyond the backdrop glow.
