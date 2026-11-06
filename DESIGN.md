---
name: OpenVern
description: Lamplight on canal water: a cool indigo desktop workspace for chatting with LLMs about local code.
colors:
  accent: "#f6bd60"
  accent-2: "#e5865f"
  success: "#9fd4b3"
  danger: "#ff8f87"
  bg: "#10162e"
  sidebar: "#0b0f20"
  surface: "#1a2142"
  surface-focus: "#1f2752"
  card: "#182040"
  card-active: "#1d2448"
  code-inline: "#1d2446"
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
  scroll-thumb: "#343f72"
  scroll-thumb-hover: "#46528c"
  scroll-thumb-active: "#5a68a8"
  text: "#ecf0fa"
  text-body: "#d8deef"
  text-code: "#e2e7f5"
  text-secondary: "#c3cbe3"
  text-chat: "#a9b2cf"
  text-muted: "#9ba5c6"
  text-faint: "#8792b6"
  overlay-tonal: "rgb(200 215 255 / 0.06)"
  overlay-tonal-hover: "rgb(200 215 255 / 0.10)"
  overlay-tonal-active: "rgb(200 215 255 / 0.12)"
  selection: "rgb(246 189 96 / 0.28)"
  selection-text: "#fff4e0"
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
    fontFamily: "Figtree Variable, Figtree, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
  code:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.7
rounded:
  xs: "5px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
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
    focusBackgroundColor: "{colors.surface-focus}"
    rounded: "{rounded.xl}"
    padding: "14px 14px 10px 18px"
  user-bubble:
    backgroundColor: "{colors.bubble}"
    textColor: "{colors.text}"
    rounded: "14px 14px 5px 14px"
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

# Design System: OpenVern

## Overview

**Creative North Star: "The Blue Hour"**

The few minutes after sunset when the sky turns deep indigo and the windows along a canal light up. The flat `#10162e` ground stays calm for hours of reading; surfaces step up in small dusk-blue increments; and one warm lamplight accent marks the next action, the way a lit window draws the eye across dark water. Gable brick, the colour of the canal houses, is the quiet second voice.

The window uses a flat `#10162e` ground with no backdrop glow. Everything else is flat colour, 1px lines and type. Density is calm, not sparse: a 272px sidebar, a centred 760px conversation column and 32px between turns. The interface shows its work (tool calls, files read, proposed edits) as small legible rows, because the product's stance is visible over magical.

Blue hour is the shipped design. **Late Workshop** remains a future theme; there is no theme switch or theme persistence yet.

**Key Characteristics:**
- Flat cool indigo ground with tonal surface steps, not shadows or a backdrop glow.
- One warm lamplight accent for the primary action and focus; gable brick for project folders and code keywords.
- Display voice in Bricolage Grotesque, reading voice in Figtree, machine voice in JetBrains Mono.
- Soft corners (5–14px), 1px cool borders where needed, tonal controls by default.
- Self-hosted fonts; no runtime requests to font CDNs.

## Colors

A cool night-blue ramp lit by warm lamplight, taken from canal streets at blue hour.

### Primary
- **Lamplight** (accent): the one primary action per view (Send, Apply), the focus ring, the wordmark's full stop, and the current-chat marker. Text on it is the ground colour.

### Secondary
- **Gable Brick** (accent-2): project folder icons and code keywords. Never a second primary button.

### Tertiary
- **Seafoam** (success): completed tool calls, added lines, accepted changes, code strings.
- **Signal Coral** (danger): errors, destructive confirms, invalid fields.

### Neutral
- **Blue Hour** (bg, `#10162e`): the flat conversation ground.
- **Deep Water** (sidebar): one step darker than the ground so the conversation reads as the lit area.
- **Night Canal** (code): code blocks and diff bodies, the darkest surface.
- **Dusk / Raised Dusk / Hover / Active** (surface, surface-raised and states): composer, fields, outline buttons, selected rows.
- **Bubble** (bubble): the user's own messages.
- **Tow Path** (tool): tool-call rows and inline cards inside assistant replies.
- **Line family** (border → border-focus): six cool steps from hairline dividers to the focused composer edge.
- **Moonlit text family** (text → text-faint): seven cool off-whites, from Moonlit for headings to Mist for meta. Every step passes 4.5:1 on the ground (Mist is 5.9:1).
- **Overlays** (overlay-row / ghost / current): translucent moonlight for row hover, ghost-button hover and the current item.

### Backdrop
There is no backdrop glow or gradient. The app shell uses the flat Blue hour ground (`#10162e`).

### Diff colours
Tokens `diff-add-*`, `diff-del-*`, `diff-text`, `diff-range` and `segment-on` (the selected half of the Unified/Split control). Added lines sit on seafoam at 9% opacity with a `#9fd4b3` sign; removed lines on gable brick at 11% with a `#f09a7c` sign; line-number gutters (`*-num`, `*-num-bg`) take the same hue a step stronger. Rejected hunks are dimmed to 42% opacity.

### Future theme: Late Workshop
Late Workshop is not shipped as a selectable theme. A future theme setting may bring back the original warm palette; there is no switch, persistence, or expanded alternate token set in the current product.

### Named Rules
**The One Accent Rule.** Lamplight marks at most one primary action per view, plus focus. If two things are amber, one of them is wrong.

**The Night Not Gray Rule.** Every neutral carries the indigo tint. A pure gray (`#888`, `#1e1e1e`) never enters the palette.

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
- **Section label** (600, 13px, Figtree): section headings such as Projects. Mono is reserved for machine data; keyboard hints and counts use mono at 11–12px.
- **Code** (400, 13px, 1.7 mono): code blocks; diffs use 12.5px on a 20px line.

### Named Rules
**The Mono Means Machine Rule.** JetBrains Mono is for code, paths, tool names, timings, counts and key hints. Never for ordinary prose or headings.

## Layout

A flex row that wraps: sidebar (272px, fixed basis) then content (`flex: 999 1 560px; min-width: 0`). The conversation and composer centre in a 760px column (New chat: 720px). The header is 64px with a 1px divider. Turns are 32px apart; inside a turn, 14px. Side padding is 24px. There is no overlay mode: the minimum window is 1080×720 (`LAYOUT` in `src/shared/constants.ts`), which fits the sidebar, a 420px conversation and a 380px panel without wrapping.

The **right panel** docks to the right of the conversation (1px left border, sidebar colour, 220ms width transition, 12px slide-in). Its width depends on what it shows: 380px for Files, 560px for an open file, 600px for Diff (800px in split view). The conversation shrinks to a 420px floor; the panel to 380px. Split is disabled when the window can't hold the wider panel next to the sidebar and the conversation. Picking Split widens the panel to up to 800px when the window has room; the panel never resizes on its own otherwise.

## Elevation & Depth

Tonal and nearly flat. Depth comes from stepped dusk-blue surfaces and 1px borders: sidebar darker than the ground, raised controls lighter, code darkest. Shadows appear only on things that float above the page: menus, popovers, dialogs and the New chat composer.

### Shadow Vocabulary
- **Floating composer** (`box-shadow: 0 24px 64px -32px rgba(0,0,0,0.6)`): the New chat composer.
- **Segment lift** (`box-shadow: 0 1px 2px rgba(0,0,0,0.35)`): the selected option in a segmented control.

### Named Rules
**The Tone Not Shadow Rule.** If a surface sits in the page flow, separate it with a surface step or a border, never a shadow.

## Shapes

Soft, consistent corners that grow with the element: 5px for key hints, badges and inline code; 6px for small controls, tabs and tree rows; 7px for project rows; 8px for regular controls; 10px for tool rows, code blocks and the New chat button; 12px for cards; 14px for composers and message bubbles, full pill for chips. The user bubble tucks its bottom-right corner to 6px to point at its author. Borders are always 1px.

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
- **Tool row:** tow path, 1px tool border, 10px corners, seafoam check, mono tool name, muted path, faint timing.
- **Code block:** night canal, 1px border, 10px corners, 16×18px padding.
- **Proposed edits card:** card surface (`#182040`), active while reviewing (`#1d2448`), 12px corners; file rows show A/M badges and +/− counts, with a footer strip holding status and the Review button.

### Inputs / Fields
- **Style:** surface fill, control border, 10px corners, 44px tall, faint placeholder.
- **Focus:** border shifts to border-focus; the global sand outline also shows.
- **Error / Disabled:** danger border and a danger message below; disabled at 50% opacity.

### Navigation
- **Sidebar:** deep water, 13px Figtree section label, project rows 36px with a rotating chevron and terracotta folder icon. Chats indent 30px; the current chat gets the current overlay and a 2px sand inset marker.

### Composer (signature)
Dusk surface (`#1a2142`, focus `#1f2752`), 14px corners, borderless textarea, a tools row with attach (ghost icon), model picker (ghost text) and a 38px sand send button. On focus, the fill shifts to `#1f2752` and the border brightens to border-focus.

### Right panel
A tab strip (pinned Files tab, closable tabs for open files and Diff, a "+" that opens the launcher, a close button) over a surface. The launcher lists Files, Terminal and Diff with a hint and a key (F, T, D); unavailable rows are dimmed with the reason ("Not available yet", "Only for chats in a project", "Available after the current chat has made edits"). Files: project name, collapse-all, a filter field, the tree in mono, and a footer saying ignored and secret files are hidden. The file viewer has a breadcrumb, line count, an Attach ghost button and numbered lines on the code surface.

### Review pane (signature)
The Diff surface: header with +/− totals and a Unified/Split segmented control, file list with per-file review state (or "Changed on disk" for a skipped file), diff body on night canal with a sticky file header, per-hunk Reject/Accept (then a status pill and Undo), and an apply bar whose primary button counts the accepted changes (Discard when everything is rejected). Applied batches are listed below, read-only. The **Proposed edits** card in the conversation (and **Edits applied** after applying) uses the tool-row surface with a status dot and a "Review changes" button that reads "Reviewing" while the pane is open.

### Scrollbars
Quiet and always there when something can scroll. The thumb is the only mark.
- **Visibility:** shown whenever the region can scroll. No auto-hide.
- **Shape:** no track and no arrow buttons. The gutter is transparent; the thumb is the only visible mark.
- **Colour:** the thumb uses `--color-scroll-thumb` at rest, `--color-scroll-thumb-hover` on hover and `--color-scroll-thumb-active` while dragging. In Blue hour these alias border-control (`#343f72`), border-hover (`#46528c`) and border-focus (`#5a68a8`). Lamplight never appears on a thumb, including while dragging; the One Glow Rule holds.
- **Size:** one size everywhere. Chat, diff, file tree, file viewer and sidebar share a 10px gutter. Horizontal bars are the same metrics turned sideways.
- **Reserved gutter:** the gutter is reserved even when nothing overflows, so rows and lines do not reflow. Menus, popovers and dialogs do not reserve that gutter.
- **Motion:** none. Rest, hover and drag switch instantly.
- **Anatomy:** 4px end inset, 10px gutter, thumb 6px at rest and 8px on hover and drag, pill ends, 40px minimum length.

## Do's and Don'ts

### Do:
- **Do** route every colour through a token from `src/renderer/styles/tokens.css`; themes depend on it.
- **Do** keep Lamplight to one primary action per view, plus focus.
- **Do** show tool calls and proposed edits as visible rows or cards in the conversation.
- **Do** use 1px cool borders and surface steps for separation.
- **Do** keep text at 4.5:1 or better; `text-faint` is the floor for meta text on the ground.
- **Do** route new interface colours through existing Blue hour tokens.

### Don't:
- **Don't** introduce pure grays; neutrals stay indigo-tinted.
- **Don't** put shadows on in-flow surfaces.
- **Don't** use mono for prose or headings.
- **Don't** load fonts from a CDN in the app; use the `@fontsource-variable` packages.
- **Don't** add a second filled accent button beside the primary.
- **Don't** add gradients.
