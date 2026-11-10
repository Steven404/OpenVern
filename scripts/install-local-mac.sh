#!/usr/bin/env bash
# Installs the newest packaged macOS build for the current user (AS-11). Idempotent. Bash 3.2 compatible.
#   scripts/install-local-mac.sh              install / update
#   scripts/install-local-mac.sh --uninstall  remove the installed app (never data or Keychain items)
#
# Installs:
#   ${OPENVERN_INSTALL_DIR:-$HOME/Applications}/OpenVern.app   (copy of the newest release/mac-arm64*/*.app)
# Test overrides: OPENVERN_INSTALL_DIR (install dir), OPENVERN_RELEASE_DIR (the release/ folder to read from).
# Never runs sudo, xattr, spctl or codesign, and never touches ~/Library/Application Support or the Keychain.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_dir="${OPENVERN_INSTALL_DIR:-$HOME/Applications}"
release_dir="${OPENVERN_RELEASE_DIR:-$repo/release}"
target="$install_dir/OpenVern.app"
# Data and Keychain are never removed here; these are printed for manual removal. The data dir is Electron's userData
# for the packaged app: `app.getPath('appData')` + APP_SLUG (src/main/startup.ts, src/shared/constants.ts).
data_dir="$HOME/Library/Application Support/openvern"
keychain_item="OpenVern Safe Storage"

# Temp copy, set while an install is in progress so the EXIT trap can remove it.
INSTALL_TMP=""
cleanup_tmp() {
  if [ -n "$INSTALL_TMP" ]; then rm -rf -- "$INSTALL_TMP"; fi
}

# True when the installed app's executable is running. Path regex-escaped for pgrep -f.
is_running() {
  local pat
  pat="$(printf '%s' "$target/Contents/MacOS/" | sed 's/[][\.*^$+?(){}|]/\\&/g')"
  pgrep -f -- "$pat" >/dev/null 2>&1
}

refuse_if_running() {
  if is_running; then
    echo "OpenVern is running from $target. Quit it, then rerun." >&2
    exit 1
  fi
}

# Newest (by mtime) release/mac-arm64*/*.app. Prints nothing when there is none.
find_source() {
  local app best="" best_m=0 mtime
  [ -d "$release_dir" ] || return 0
  while IFS= read -r -d '' app; do
    case "$(basename "$(dirname "$app")")" in
      mac-arm64*) ;;
      *) continue ;;
    esac
    mtime="$(stat -f %m "$app")"
    if [ -z "$best" ] || [ "$mtime" -gt "$best_m" ]; then
      best="$app"
      best_m="$mtime"
    fi
  done < <(find "$release_dir" -mindepth 2 -maxdepth 2 -type d -name '*.app' -print0 2>/dev/null)
  printf '%s' "$best"
}

uninstall_app() {
  refuse_if_running
  if [ -e "$target" ]; then
    rm -rf -- "$target"
    echo "Removed: $target"
  else
    echo "Not installed: $target (nothing to remove)"
  fi
  echo "Kept (remove manually if you want them gone):"
  echo "  data dir: $data_dir"
  echo "  Keychain item: '$keychain_item' (Keychain Access, or: security delete-generic-password -s '$keychain_item')"
}

install_app() {
  local src tmp old
  src="$(find_source)"
  if [ -z "$src" ]; then
    echo "No *.app under $release_dir/mac-arm64*. Run npm run dist:mac first." >&2
    exit 1
  fi
  refuse_if_running

  mkdir -p "$install_dir"
  # Copy to a temp name in the install dir, then swap: the old bundle is renamed aside, the new one moved into place.
  tmp="$install_dir/.OpenVern.app.tmp.$$"
  INSTALL_TMP="$tmp"
  trap cleanup_tmp EXIT
  rm -rf -- "$tmp"
  ditto "$src" "$tmp"

  old="$install_dir/.OpenVern.app.old.$$"
  rm -rf -- "$old"
  if [ -e "$target" ]; then mv -- "$target" "$old"; fi
  if ! mv -- "$tmp" "$target"; then
    if [ -e "$old" ]; then mv -- "$old" "$target"; fi
    echo "Install failed; previous app restored if it existed." >&2
    exit 1
  fi
  rm -rf -- "$old"
  INSTALL_TMP=""

  echo "Installed $(basename "$(dirname "$src")")/$(basename "$src") -> $target"
  echo "Data dir (untouched): $data_dir"
  echo "Keychain item (untouched): '$keychain_item'"
}

case "${1:-}" in
  "") install_app ;;
  --uninstall) uninstall_app ;;
  -h | --help)
    sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
  *)
    echo "Unknown argument: $1 (use --uninstall)" >&2
    exit 2
    ;;
esac
