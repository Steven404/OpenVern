# OpenVern

Desktop app to chat with LLMs about your projects. The model can read a project and propose edits
through tool calls, and you review every change as a diff before anything is written to disk.

OpenVern talks to [OpenRouter](https://openrouter.ai), so you need an
[OpenRouter API key](https://openrouter.ai/keys). Chats, projects and settings are stored in local files, and there is
no telemetry.

## Features

- **Projects and chats.** Add a folder as a project and keep chats inside it, or chat without a project. Chats can be
  archived and deleted.
- **Any OpenRouter model.** Pick a model per chat. For models that support reasoning, choose the reasoning effort.
- **Read access through tool calls.** In a project chat the model can list, read and search files. Each tool call is
  shown in the conversation.
- **Proposed edits with review.** The model can propose creating, editing and deleting files. Nothing touches your
  disk until you apply. Review each file as a unified or split diff, accept or reject each hunk, then apply the
  accepted ones.
- **Sandboxed file access.** Tools are limited to the project folder and skip `.env` files, keys and `.git`. A file
  you changed on disk after a proposal is skipped, never merged.
- **Files panel.** A read-only tree of the project with a filter, a file viewer and an Attach button.
- **Attachments.** Attach text files and images (PNG, JPEG, WebP, GIF) to a message.
- **Context usage.** The chat header shows the tokens used against the model's limit, with total tokens and cost.
- **Stop and retry.** Stop a streaming reply, or retry a failed turn.
- **API key in the OS keyring.** The installed app encrypts the key with the macOS Keychain, or with KWallet/libsecret
  on Linux.

OpenVern cannot run commands, and applied edits can't be undone from the app (use git).

## Installation

There are no prebuilt downloads yet. You build the app from source and install it for your user. Both platforms need
Node.js 22 or newer and npm 10 or newer.

After installing, open OpenVern, go to Settings and paste your OpenRouter API key.

### Linux (x86_64)

Requirements: `fuse2` to run the AppImage, and unprivileged user namespaces for Chromium's sandbox (enabled by default
on Arch and CachyOS kernels).

```bash
git clone https://github.com/Steven404/OpenVern.git && cd OpenVern
npm ci
npm run dist
scripts/install-local.sh
```

- `npm run dist` writes `release/OpenVern-<version>-x86_64.AppImage`.
- `scripts/install-local.sh` copies the AppImage to `~/.local/bin/openvern.AppImage` and adds an icon and a launcher
  entry.
- To remove it, run `scripts/install-local.sh --uninstall`.
- Your data is in `~/.config/openvern`.

### macOS (Apple Silicon)

Requirements: an Apple Silicon Mac (arm64) with macOS 13 or later, and an arm64 build of Node.js (not under Rosetta).
Intel Macs are not supported.

```bash
git clone https://github.com/Steven404/OpenVern.git && cd OpenVern
npm ci
npm run dist:mac
scripts/install-local-mac.sh
```

- `npm run dist:mac` writes `release/OpenVern-<version>-arm64.dmg` and `release/mac-arm64/openvern.app`.
- `scripts/install-local-mac.sh` copies the app to `~/Applications/OpenVern.app`. Set `OPENVERN_INSTALL_DIR=<dir>` to
  install somewhere else.
- To remove it, run `scripts/install-local-mac.sh --uninstall`.
- Your data is in `~/Library/Application Support/openvern`.

The app is ad-hoc signed and not notarized, so it is meant for the Mac that built it. A copy moved to another Mac is
blocked by Gatekeeper until you allow it with Open Anyway in System Settings › Privacy & Security.

On first use macOS may ask two things:

- A Keychain prompt for `OpenVern Safe Storage`, where the API key is encrypted. Choose **Always Allow** to avoid
  repeated prompts.
- Permission to access Documents, Desktop or Downloads when a project is in one of those folders. If you deny it, turn
  it on again in System Settings › Privacy & Security › Files & Folders.
