# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

A React UI shipped as an Electron desktop app (Linux AppImage, x86_64) and also run in the browser during development. Desktop is the product; the browser build is a dev mode.

## Users

The author first: a developer chatting with LLMs about their own local code projects on their own Linux machine (CachyOS / Arch, KDE Wayland). It is meant to be released to other developers later, so it should not depend on knowledge only the author has.

## Product Purpose

A desktop AI harness: chat with an LLM about a local code project, with the model able to look at the project through tool calls (list, read and search files). Success is a tool the author prefers to use daily for thinking through their own code, and that another developer could install and trust.

## Positioning

- **You see every step.** Tool calls, files read and (later) proposed edits are shown in the conversation. Nothing touches disk without the user's explicit approval.
- **Any model.** Provider-agnostic: V0 talks to OpenRouter through a thin in-house adapter, not one vendor's SDK.
- **Local and private.** Chats, projects and settings live in local JSON files; the API key sits in the OS keyring (Electron `safeStorage`); no telemetry.

## Operating Context

- A project is a folder on disk the user adds; chats belong to a project (or to none).
- The user picks a model per chat, attaches text files and images, can stop a streaming reply and retry a failed one.
- Desktop window, minimum 800×600; below 760 px wide the sidebar becomes an overlay.

## Capabilities and Constraints

- **V0 (shipped):** read-only project access. Tools are sandboxed to the project root, skip ignored and secret-looking files (`.env`, keys) and cap file and result sizes. No file edits, no commands.
- **Next, committed:** file edits that the agent proposes and the user reviews as diffs, accepting or rejecting each change before anything is written. A design for this exists on the canvas ("Review changes" artboard).
- **Next, committed:** a light theme (only dark exists today).
- **Not committed:** running commands, direct providers besides OpenRouter, branching or editing past messages, token/cost display, context compaction, chat search, MCP, Windows/macOS builds, auto-update, i18n.
- Terminology: *project*, *chat*, *tool call*, *proposed edits*, *apply*.

## Brand Commitments

- Working name `harness`, held in one constant (`APP_NAME`) so it can change; design files use the placeholder `[APPNAME]`. The final name is undecided.
- Fonts are self-hosted in the app (no Google Fonts requests at runtime).

## Evidence on Hand

- Design canvas (claude.ai Design artifact `LBiDZrEcuRYShHmNjEtjco`): Conversation, New chat and Review changes artboards; Conversation and New chat are mirrored in `docs/design/`.
- No users, testimonials, benchmarks or public release yet. Do not invent any.

## Product Principles

1. **Visible over magical.** Show what the model did and is about to do; never hide a tool call or a write.
2. **The user holds the write key.** Anything that changes disk waits for an explicit, reviewable approval.
3. **Local by default.** Data stays on the machine; network traffic is the model provider and nothing else.
4. **Model-neutral.** No UI or flow should assume one vendor's model.
5. **Built for one, ready for many.** Solve the author's real daily use first, without shortcuts that would block other developers later.
