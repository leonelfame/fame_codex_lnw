#!/bin/sh
set -eu

REPOSITORY="${CODEX_CHATGPT_WEB_REPOSITORY:-miuuyy/codex-chatgpt-web}"
VERSION="${CODEX_CHATGPT_WEB_VERSION:-0.1.0}"
INSTALL_DIR="${CODEX_CHATGPT_WEB_BIN_DIR:-$HOME/.local/bin}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "codex-chatgpt-web 0.1 supports macOS only" >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="amd64" ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

ASSET="codex-chatgpt-web-darwin-$ARCH"
BASE_URL="https://github.com/$REPOSITORY/releases/download/v$VERSION"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-chatgpt-web.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM

curl -fsSL "$BASE_URL/$ASSET" -o "$TEMP_DIR/$ASSET"
curl -fsSL "$BASE_URL/checksums.txt" -o "$TEMP_DIR/checksums.txt"

EXPECTED="$(awk -v asset="$ASSET" '$2 == asset { print $1 }' "$TEMP_DIR/checksums.txt")"
if [ -z "$EXPECTED" ]; then
  echo "checksums.txt has no entry for $ASSET" >&2
  exit 1
fi
ACTUAL="$(shasum -a 256 "$TEMP_DIR/$ASSET" | awk '{ print $1 }')"
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "SHA-256 verification failed for $ASSET" >&2
  exit 1
fi

DOC_DIR="${CODEX_CHATGPT_WEB_DOC_DIR:-$HOME/.local/share/doc/codex-chatgpt-web}"
for DOC in LICENSE NOTICE.md OpenCodex-MIT.txt Bun-1.3.11.md THIRD_PARTY_NOTICES.txt; do
  curl -fsSL "$BASE_URL/$DOC" -o "$TEMP_DIR/$DOC"
  DOC_EXPECTED="$(awk -v asset="$DOC" '$2 == asset { print $1 }' "$TEMP_DIR/checksums.txt")"
  DOC_ACTUAL="$(shasum -a 256 "$TEMP_DIR/$DOC" | awk '{ print $1 }')"
  if [ -z "$DOC_EXPECTED" ] || [ "$DOC_ACTUAL" != "$DOC_EXPECTED" ]; then
    echo "SHA-256 verification failed for $DOC" >&2
    exit 1
  fi
done
mkdir -p "$INSTALL_DIR" "$DOC_DIR"
install -m 0755 "$TEMP_DIR/$ASSET" "$INSTALL_DIR/codex-chatgpt-web"
for DOC in LICENSE NOTICE.md OpenCodex-MIT.txt Bun-1.3.11.md THIRD_PARTY_NOTICES.txt; do
  install -m 0644 "$TEMP_DIR/$DOC" "$DOC_DIR/$DOC"
done
echo "Installed $INSTALL_DIR/codex-chatgpt-web"

if [ "$#" -gt 0 ]; then
  exec "$INSTALL_DIR/codex-chatgpt-web" setup "$@"
fi

echo "Next: $INSTALL_DIR/codex-chatgpt-web setup --pro-only --acknowledge-unofficial"
