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
- **Read access through tool calls.** In a project chat the model can list, read and search files. Consecutive tool
  calls fold into one summary row ("Read 3 files, searched 2 times"), one click from each call.
- **A terminal you type into.** A shell dock under the composer, one per chat, in the project folder (or your home
  folder for a chat without a project). Open it from the right panel's Terminal row or with Ctrl+` (on macOS too),
  in a chat or already on the new-chat screen, where it starts in the chosen project's folder or, with no project, in
  your Documents folder. A terminal opened there moves into the chat when you send the first message, so the model can
  read it, including what it printed before the chat existed. Not available in the web build. The model can read the
  terminal through a `read_terminal` tool, but it cannot type into it or run commands.
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

You can run commands in the terminal, but the model cannot. Applied edits can't be undone from the app (use git).

## Limits

- **Redaction matches patterns.** Before the model reads terminal output, and before a selection goes into the
  composer, API keys, tokens and private-key blocks are replaced with `«redacted:…»`. Only recognisable patterns are
  caught. A secret with no known prefix, a key shown without its prefix, a key file scrolled past both its BEGIN and
  END lines in a pager, or text written to disguise a key can get through. Terminal output reaches the model as
  untrusted data, not instructions.
- **Shells outlive the dock.** Hiding the dock, switching chats and reloading the window all keep the shell running.
  A reload brings back up to the last 2 MiB of its output. Ending the terminal, closing the window or quitting the app
  hangs up the shell and force-stops it after one second. A job started with `nohup`, or one that ignores hang-up,
  keeps running, as in Terminal.app.
- **Size limits.** At most 8 terminals at once, each with 5,000 lines of scrollback. One app run can start at most 100
  shells (a file-descriptor leak in `node-pty` on macOS makes this cap necessary); after that, restart the app. If the
  shell is not reading, input beyond 1 MiB is dropped and the terminal says so, so a very large paste can be cut short.
  The model reads at most 1,000 lines per call, and its output is capped at 50 KB.

## Installation

There are no prebuilt downloads yet. You build the app from source and install it for your user. Both platforms need
Node.js 22 or newer and npm 10 or newer.

The terminal uses the native module `node-pty`, which `npm ci` builds. Install scripts must be allowed to run:
`npm ci --ignore-scripts` breaks it.

After installing, open OpenVern, go to Settings and paste your OpenRouter API key.

### Linux (x86_64)

Requirements: `fuse2` to run the AppImage, unprivileged user namespaces for Chromium's sandbox (enabled by default on
Arch and CachyOS kernels), and a C++ build toolchain for `node-pty`: Python 3, `make` and a C++ compiler. The Linux
build of the terminal has not been verified yet.

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
- Permission to access Documents, Desktop or Downloads when a project is in one of those folders, or when a command you
  run in the terminal reads them. Terminal commands act with OpenVern's permissions, so the prompt can come from a
  command you start there. If you deny it, turn it on again in System Settings › Privacy & Security › Files & Folders.
