# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

A React UI shipped as an Electron desktop app (Linux AppImage, x86_64) and also run in the browser during development. Desktop is the product; the browser build is a dev mode.

## Users

The author first: a developer chatting with LLMs about their own local code projects on their own Linux machine (CachyOS / Arch, KDE Wayland). It is meant to be released to other developers later, so it should not depend on knowledge only the author has.

## Product Purpose

OpenVern is a desktop AI app: chat with an LLM about a local code project, with the model able to look at the project through tool calls (list, read and search files) and to propose edits that the user reviews before anything is written. Success is a tool the author prefers to use daily for thinking through their own code, and that another developer could install and trust.

## Positioning

- **You see every step.** Tool calls, files read and proposed edits are shown in the conversation, and every change can be opened as a diff. The user chooses how writes are approved: review each change before it touches disk, or let edits land as the model responds and stop only for high-risk ones.
- **Any model.** Provider-agnostic: V0 talks to OpenRouter through a thin in-house adapter, not one vendor's SDK.
- **Local and private.** Chats, projects and settings live in local JSON files; the API key sits in the OS keyring (Electron `safeStorage`); no telemetry.

## Operating Context

- A project is a folder on disk the user adds; chats belong to a project (or to none).
- The user picks a model per chat, attaches text files and images, can stop a streaming reply and retry a failed one.
- Desktop window, minimum 1080×720. A right panel (Files, Terminal later, Diff) opens beside the conversation.

## Capabilities and Constraints

- **V0 (shipped):** read-only project access. Tools are sandboxed to the project root, skip ignored and secret-looking files (`.env`, keys) and cap file and result sizes.
- **v0.2 (this release):** review mode. The agent proposes file creations, edits and deletions; the user reviews them as unified or split diffs, accepts or rejects each change, and only accepted changes are written. The model is told what happened at its next turn. A read-only Files panel; the model states which model it is. Still no commands and no undo after apply (use git).
- **Next, committed:** an auto mode beside that review mode. Edits are written as the model responds and stay viewable as diffs; only high-risk edits (and commands, once commands exist) are held for the user's approval before they run.
- **Next, committed:** a light theme (only dark exists today).
- **Not committed:** running commands, direct providers besides OpenRouter, branching or editing past messages, token/cost display, context compaction, chat search, MCP, Windows/macOS builds, auto-update, i18n.
- Terminology: *project*, *chat*, *tool call*, *proposed edits*, *apply*, *review mode*, *auto mode*.

## Shipped Design

The interface uses the flat Blue hour design: an indigo `#10162e` ground, tonal surfaces, warm lamplight accents, and self-hosted fonts. The composer changes from `#1a2142` at rest to `#1f2752` on focus; proposed edit cards use `#182040` and `#1d2448` while active. There is no backdrop glow and no selectable theme setting. Late Workshop remains a future theme.

## Brand Commitments

- The name is **OpenVern**, held in one constant (`APP_NAME`; `APP_SLUG` is the lower-case form for paths and identifiers). Version 0.1 was called harness; its data is copied over on first start.
- Fonts are self-hosted in the app (no Google Fonts requests at runtime).

## Evidence on Hand

- Design canvas (claude.ai Design artifact `LBiDZrEcuRYShHmNjEtjco`): Conversation, New chat and Review changes artboards; Conversation and New chat are mirrored in `docs/design/`.
- No users, testimonials, benchmarks or public release yet. Do not invent any.

## Product Principles

1. **Visible over magical.** Show what the model did and is about to do; never hide a tool call or a write.
2. **The user decides who holds the write key.** In review mode, anything that changes disk waits for an explicit, reviewable approval. In auto mode, edits are written as soon as the model responds and only high-risk edits and commands stop for approval before they run; every change, applied or pending, can still be opened as a diff.
3. **Local by default.** Data stays on the machine; network traffic is the model provider and nothing else.
4. **Model-neutral.** No UI or flow should assume one vendor's model.
5. **Built for one, ready for many.** Solve the author's real daily use first, without shortcuts that would block other developers later.
