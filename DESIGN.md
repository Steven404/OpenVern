---
name: OpenVern
description: "Lamplight on canal water: a cool indigo desktop workspace for chatting with LLMs about local code."
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
    backgroundColor: "{colors.overlay-tonal}"
    textColor: "{colors.text}"
    borderColor: "transparent"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  button-outline-hover:
    backgroundColor: "{colors.overlay-tonal-hover}"
  button-outline-active:
    backgroundColor: "{colors.overlay-tonal-active}"
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
  # Reply variant; the new-chat variant adds the floating shadow and 16/14/10/20px padding.
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
    backgroundColor: "{colors.card}"
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

Blue hour is the shipped design. **Late Workshop** remains unshipped and unselectable: the dormant `[data-theme="late-workshop"]` block in `src/renderer/styles/tokens.css` is only partial (it omits card, focus-surface, overlay-tonal, selection and diff tokens), nothing sets `data-theme`, and there is no theme switch or persistence.

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
- **Dusk / Raised Dusk / Hover / Active** (surface, surface-raised and states): composer, fields, selected rows and chip hover.
- **Bubble** (bubble): the user's own messages.
- **Tow Path** (tool): recessed fills for table headers, the Files filter field and launcher key caps. Tool-call rows use the card surface instead.
- **Line family** (border → border-focus): seven cool values from hairline dividers to focused edges.
- **Moonlit text family** (text → text-faint): seven cool off-whites, from Moonlit to Mist. Contrast varies by surface; no single ratio applies across every use.
- **Overlays** (overlay-tonal, overlay-tonal-hover, overlay-tonal-active): translucent cool fills for tonal controls and their states. Separate overlay-row / ghost / current values serve rows, ghost buttons and current items.

### Backdrop
There is no backdrop glow or gradient. The app shell uses the flat Blue hour ground (`#10162e`).

### Diff colours
The diff line tints are tokenised: `diff-add-*`, `diff-del-*`, `diff-text`, `diff-range` and `segment-on` (the selected half of the Unified/Split control). Added lines sit on seafoam at 9% opacity with a `#9fd4b3` sign; removed lines sit on accent-2 at 11% with a `#f09a7c` sign; line-number gutters use related stronger hues. Rejected hunks fade to 42% opacity. Not every diff colour is a token yet: hunk headers, gap rows, status pills and some hover text still use isolated hex values. The diagonal hatch (`repeating-linear-gradient(135deg, transparent 0 6px, rgb(200 215 255 / 0.025) 6px 12px)`) fills only empty cells in Split view as an alignment placeholder; it is not applied to rejected hunks.

### Future theme: Late Workshop
Late Workshop is not shipped as a selectable theme. The dormant `[data-theme="late-workshop"]` block in `src/renderer/styles/tokens.css` is partial (no card, focus-surface, overlay-tonal, selection or diff tokens), nothing sets `data-theme`, and there is no switch or persistence.

### Named Rules
**The One Glow Rule.** Lamplight marks at most one primary action per view, plus focus. If two things are amber, one of them is wrong.

**The Night Not Gray Rule.** Every neutral carries the indigo tint. A pure gray (`#888`, `#1e1e1e`) never enters the palette.

## Typography

**Display Font:** Bricolage Grotesque (with sans-serif)
**Body Font:** Figtree (with system-ui, sans-serif)
**Label/Mono Font:** JetBrains Mono (with ui-monospace, monospace)

**Character:** A slightly quirky grotesque for the few moments the app speaks up, a friendly humanist sans for reading, and a crisp mono for anything the machine produced.

### Hierarchy
- **Display** (700, 44px, 1.1, −0.03em): the New chat prompt only.
- **Wordmark** (700, 21px, −0.02em): the app name in the sidebar.
- **Title** (600, 15px): chat titles in the header. Conversation card titles use 14px semibold.
- **Body** (400, 15px, 1.5): UI copy and controls.
- **Message** (400, 15.5px, 1.65): conversation prose; the 760px column sets the measure.
- **Section label** (600, 13px, Figtree): section headings such as Projects. Mono is reserved for machine data; keyboard hints and counts use mono at 11–12px.
- **Code** (400, 13px, 1.7 mono): code blocks; diffs use 12.5px on a 20px line.

### Named Rules
**The Mono Means Machine Rule.** JetBrains Mono is for code, paths, tool names, timings, counts and key hints. Never for ordinary prose or headings.

## Layout

A non-wrapping flex row: sidebar (272px, fixed basis) then the main column (`flex: 1 1 0; min-width: 420px`). The conversation and composer centre in a 760px column (New chat: 720px). The header is 64px with a 1px divider. Turns are 32px apart; inside a turn, 14px. Side padding is 24px. There is no overlay mode: the minimum window is 1080×720 (`LAYOUT` in `src/shared/constants.ts`), and the row scrolls rather than wrapping below it; 1080px holds the sidebar, a 420px conversation and a 380px panel.

The **right panel** docks to the right of the conversation (1px left border, sidebar colour, 220ms width transition, 12px slide-in). Its width depends on what it shows: 380px for Files, 560px for an open file, 600px for Diff (800px in split view). The conversation shrinks to a 420px floor; the panel to 380px. Split is disabled when the window can't hold the wider panel next to the sidebar and the conversation. Picking Split widens the panel to up to 800px when the window has room; the panel never resizes on its own otherwise.

## Elevation & Depth

Tonal and nearly flat. Depth comes from stepped dusk-blue surfaces and 1px borders: sidebar darker than the ground, raised controls lighter, code darkest. Shadows appear on floating menus, popovers and dialogs, and on the New chat composer; the reply composer is in-flow.

### Shadow Vocabulary
- **Floating composer** (`box-shadow: 0 16px 40px -24px rgb(0 0 0 / 0.35)`): the New chat composer only; the reply composer is in-flow and has no shadow.
- **Segment lift** (`box-shadow: 0 1px 2px rgba(0,0,0,0.35)`): the selected option in a segmented control.

### Named Rules
**The Tone Not Shadow Rule.** Use surface steps and borders to separate in-flow surfaces; reserve shadows for selected segmented controls and floating elements.

## Shapes

Soft, consistent corners that grow with the element: 5px for key hints, badges and inline code; 6px for small controls, tabs and tree rows; 7px for project rows; 8px for regular controls and chips; 10px for tool rows, code blocks and the New chat button; 12px for cards; 14px for composers and message bubbles. The user bubble tucks its bottom-right corner to 5px to point at its author. Borders, where present, are 1px.

## Components

Soft-cornered and quiet: ghost by default, the accent saved for the one action that moves things forward.

### Buttons
- **Shape:** gently rounded with component-specific sizes. Primary actions commonly use 40px; compact actions use 30–34px.
- **Primary:** Lamplight fill, ground-colour text, weight 500. Hover brightens 6%.
- **Outline:** 6% tonal fill with a transparent 1px border; hover steps the fill to 10%, pressed to 12%.
- **Ghost:** transparent, secondary text; hover adds the ghost overlay and full-strength text.
- **Danger:** Signal Coral fill for destructive confirms only.
- **Icon button:** 28 / 36 / 40px squares, muted icon, always an `aria-label`.
- **Focus:** global `:focus-visible` draws a 2px Lamplight outline with 2px offset. Exceptions: menu and model-list items show a highlight fill instead; the composer also shifts its surface to `surface-focus`; the launcher and dialog containers also set `outline-none`.
- **Motion:** 150ms ease on background, border and colour. The right panel slides in and resizes over 220ms and disables that motion under `prefers-reduced-motion`; a hunk's rejection fade is 200ms and is disabled under reduced motion.

### Chips
- **Style:** 8px corners and borderless by default. The project chip uses the bubble fill and secondary text; composer attachment chips use the 6% tonal overlay; an errored attachment gains a danger border. Hover treatment is component-specific.

### Cards / Containers
- **Tool row:** card surface, no border, 10px corners; seafoam check, mono tool name, muted path, faint timing. Rows hover with `overlay-row`; the expanded panel is separated by a `border-tool` line.
- **Code block:** night canal, no border, 10px corners, 16×18px padding.
- **Proposed edits card:** card surface (`#182040`), active while reviewing (`#1d2448`), 12px corners, no border; file rows show A/M/D badges and +/− counts, with a footer strip holding the status dot and a tonal Review button.

### Inputs / Fields
- **Style:** surface fill, control border, 10px corners, 44px tall, faint placeholder.
- **Focus:** border shifts to border-focus; the global sand outline also shows.
- **Error / Disabled:** danger border and a danger message below; disabled at 50% opacity.

### Navigation
- **Sidebar:** deep water, 13px Figtree section label, project rows 36px with a rotating chevron and terracotta folder icon. Chats indent 30px; the current chat gets the current overlay and a 2px sand inset marker.

### Composer (signature)
Dusk surface (`#1a2142`, focus `#1f2752`), borderless textarea, attach and model controls, and send/stop action. Both variants use 14px corners; the textarea has the global focus ring and the container shifts to `surface-focus`. The new-chat variant adds `0 16px 40px -24px rgb(0 0 0 / 0.35)` and 16/14/10/20px padding; the reply variant is in-flow at 14/14/10/18px.

### Right panel
A tab strip (pinned Files tab, closable tabs for open files and Diff, a "+" that opens the launcher, a close button) over a surface. The launcher lists Files, Terminal and Diff with a hint and a key (F, T, D); unavailable rows are dimmed with the reason ("Not available yet" for Terminal; "Available after the current chat has made edits" for Diff). Files is always enabled: it browses the project, or the home folder for a chat without one. Files: project (or home folder) name, collapse-all, a filter field, the tree in mono, and a footer saying ignored and secret files are hidden. The file viewer has a breadcrumb, line count, an Attach ghost button and numbered lines on the code surface.

### Review pane (signature)
The Diff surface: header with +/− totals and a Unified/Split segmented control, file list with per-file review state (or "Changed on disk" for a skipped file), diff body on night canal with a sticky file header, per-hunk Reject/Accept (then a status pill and Undo), and an apply bar whose primary button counts the accepted changes (Discard when everything is rejected). Applied batches are listed below, read-only. The **Proposed edits** card in the conversation (and **Edits applied** after applying) uses the card surface (`#182040`; `#1d2448` while reviewing), 12px corners and no border, with a footer strip holding the status dot and a tonal "Review changes" button that reads "Reviewing" while the pane is open.

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
- **Do** prefer tokens from `src/renderer/styles/tokens.css`; isolated hard-coded colours remain in diff hunk chrome, gap rows, status pills and the proposed-edits footer.
- **Do** keep Lamplight to one primary action per view, plus focus.
- **Do** show tool calls and proposed edits as visible rows or cards in the conversation.
- **Do** use 1px cool borders and surface steps for separation.
- **Do** maintain readable text contrast; verify contrast against the specific surface in use.
- **Do** route new interface colours through existing Blue hour tokens.

### Don't:
- **Don't** introduce pure grays; neutrals stay indigo-tinted.
- **Don't** put shadows on in-flow surfaces.
- **Don't** use mono for prose or headings.
- **Don't** load fonts from a CDN in the app; use the `@fontsource-variable` packages.
- **Don't** add a second filled accent button beside the primary.
- **Don't** add decorative gradients; the only hatch is the alignment filler in empty Split cells.
