#!/usr/bin/env bash
# Installs the newest built AppImage for the current user (plan S8.10). Idempotent.
#   scripts/install-local.sh              install / update
#   scripts/install-local.sh --uninstall  remove everything this script installed
#
# Installs:
#   ~/.local/bin/harness.AppImage
#   ~/.local/share/icons/hicolor/512x512/apps/harness.png
#   ~/.local/share/applications/harness.desktop
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"

bin_dir="$HOME/.local/bin"
appimage="$bin_dir/harness.AppImage"
icon="$data_home/icons/hicolor/512x512/apps/harness.png"
desktop_dir="$data_home/applications"
desktop_file="$desktop_dir/harness.desktop"

refresh_caches() {
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$desktop_dir" >/dev/null 2>&1 || true
  fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1 && [ -f "$data_home/icons/hicolor/index.theme" ]; then
    gtk-update-icon-cache -q -t "$data_home/icons/hicolor" >/dev/null 2>&1 || true
  fi
}

uninstall_app() {
  rm -f -- "$appimage" "$icon" "$desktop_file"
  refresh_caches
  echo "Removed: $appimage, $icon, $desktop_file"
}

install_app() {
  # Newest by version sort (release/harness-<version>-x86_64.AppImage).
  local newest
  newest=""
  if [ -d "$repo/release" ]; then
    newest="$(find "$repo/release" -maxdepth 1 -type f -name 'harness-*-x86_64.AppImage' 2>/dev/null | sort -V | tail -n 1)"
  fi
  if [ -z "$newest" ]; then
    echo "No release/harness-*-x86_64.AppImage found. Run 'npm run dist' first." >&2
    exit 1
  fi
  if [ ! -f "$repo/build/icon.png" ]; then
    echo "Missing $repo/build/icon.png." >&2
    exit 1
  fi

  mkdir -p "$bin_dir" "$(dirname "$icon")" "$desktop_dir"

  # Copy to a temp name and rename so a running AppImage is replaced atomically (no "text file busy").
  install -m 755 -- "$newest" "$appimage.tmp"
  mv -f -- "$appimage.tmp" "$appimage"
  install -m 644 -- "$repo/build/icon.png" "$icon"

  # Desktop Entry spec: quote the program path only when it contains whitespace.
  local exec_path="$appimage"
  case "$exec_path" in *[[:space:]]*) exec_path="\"$exec_path\"" ;; esac

  cat >"$desktop_file" <<EOF
[Desktop Entry]
Type=Application
Name=harness
Comment=Chat with LLMs about your local code projects
Exec=$exec_path %U
Icon=harness
Terminal=false
Categories=Development;
StartupWMClass=harness
EOF
  chmod 644 "$desktop_file"

  refresh_caches
  echo "Installed $(basename "$newest") -> $appimage"
  echo "Desktop entry: $desktop_file"
}

case "${1:-}" in
  "") install_app ;;
  --uninstall) uninstall_app ;;
  -h | --help)
    sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
  *)
    echo "Unknown argument: $1 (use --uninstall)" >&2
    exit 2
    ;;
esac
