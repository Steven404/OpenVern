# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

A React UI shipped as an Electron desktop app (Linux AppImage, x86_64) and also run in the browser during development. Desktop is the product; the browser build is a dev mode.

## Users

The author first: a developer chatting with LLMs about their own local code projects on their own Linux machine (CachyOS / Arch, KDE Wayland). It is meant to be released to other developers later, so it should not depend on knowledge only the author has.

## Product Purpose

OpenVern is a desktop AI app: chat with an LLM about a local code project, with the model able to look at the project through tool calls (list, read and search files) and to change it: in review mode it proposes edits that the user reviews before anything is written, in auto mode its edits are written as it works and recent turns can be undone. Success is a tool the author prefers to use daily for thinking through their own code, and that another developer could install and trust.

## Positioning

- **You see every step.** Tool calls are summarised in place, one click from the full call; proposed and applied edits stay visible as cards and can be opened as diffs (a diff too large to show is listed by file). The user chooses how writes reach the disk, per chat: review each change before it is written, or let the model's edits be written as it works, inside the same sandbox, with recent turns open as diffs and undoable.
- **Any model.** Provider-agnostic: V0 talks to OpenRouter through a thin in-house adapter, not one vendor's SDK.
- **Local and private.** Chats, projects and settings live in local JSON files; the API key sits in the OS keyring (Electron `safeStorage`); no telemetry.

## Operating Context

- A project is a folder on disk the user adds; chats belong to a project (or to none).
- The user picks a model per chat, attaches text files and images, can stop a streaming reply and retry a failed one.
- Desktop window, minimum 1080×720. A right panel (Files, Diff) opens beside the conversation. A terminal dock opens under the composer, one shell per chat.

## Capabilities and Constraints

- **V0 (shipped):** read-only project access. Tools are sandboxed to the project root, skip ignored and secret-looking files (`.env`, keys) and cap file and result sizes.
- **v0.2 (shipped):** review mode. The agent proposes file creations, edits and deletions; the user reviews them as unified or split diffs, accepts or rejects each change, and only accepted changes are written. The model is told what happened at its next turn. A read-only Files panel; the model states which model it is. Still no commands and no undo after apply (use git).
- **Shipped (terminal):** a terminal dock under the composer, with a shell in the project folder (or the home folder for a chat without one). It can be opened on the New Chat screen too, where a chat without a project starts it in the Documents folder; it moves into the chat on the first send, so the model can read what ran before the chat existed. The user types into it and runs commands. The model can read its text through a `read_terminal` tool, which needs no approval and shows as a tool call. The model cannot type into the terminal or run commands.
- **Shipped (auto mode):** a Review / Auto choice per project chat, beside the model picker; new chats start in Review and a change applies from the next message. In Auto the model's edits, new files and deletes are written as it works, inside the same sandbox, and each turn gets an "Edits applied · Auto" card with Undo, which restores only the files still as the turn left them and names the rest. Undo is kept for the last 20 Auto turns per chat. Retrying an Auto turn undoes its edits first. Turning Auto on for a folder without Git warns once per project. The Diff panel keeps pending proposals on top and a History of every batch below. A turn whose edits went into another project can only be retried there.
- **Next, committed:** a light theme (only dark exists today).
- **Not committed:** the model running commands (the terminal is read-only for it), direct providers besides OpenRouter, branching or editing past messages, token/cost display, context compaction, chat search, MCP, Windows/macOS builds, auto-update, i18n.
- Terminology: *project*, *chat*, *tool call*, *proposed edits*, *apply*, *review mode*, *auto mode*, *terminal*.

## Shipped Design

The interface uses the flat Blue hour design: an indigo `#10162e` ground, tonal surfaces, warm lamplight accents, and self-hosted fonts. The composer changes from `#1a2142` at rest to `#1f2752` on focus; proposed edit cards use `#182040` and `#1d2448` while active. There is no backdrop glow and no selectable theme setting. Late Workshop remains a future theme.

## Brand Commitments

- The name is **OpenVern**, held in one constant (`APP_NAME`; `APP_SLUG` is the lower-case form for paths and identifiers). Version 0.1 was called harness; its data is copied over on first start.
- Fonts are self-hosted in the app (no Google Fonts requests at runtime).

## Evidence on Hand

- Design canvas (claude.ai Design artifact `LBiDZrEcuRYShHmNjEtjco`): Conversation, New chat and Review changes artboards; Conversation and New chat are mirrored in `docs/design/` as historical prototypes; `DESIGN.md` describes the current design.
- No users, testimonials, benchmarks or public release yet. Do not invent any.

## Product Principles

1. **Visible over magical.** Show what the model did and is about to do. Tool calls are summarised in place, one click away; edits stay visible as cards and diffs.
2. **The user decides who holds the write key.** In review mode, anything that changes disk waits for an explicit, reviewable approval. In auto mode, the model's edits are written as it works, inside the same sandbox, and the last 20 turns of a chat can be opened as diffs and undone, file by file where nothing changed since.
3. **Local by default.** Data stays on the machine; network traffic is the model provider and nothing else.
4. **Model-neutral.** No UI or flow should assume one vendor's model.
5. **Built for one, ready for many.** Solve the author's real daily use first, without shortcuts that would block other developers later.
