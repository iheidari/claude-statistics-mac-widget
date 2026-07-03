#!/usr/bin/env bash
#
# One-shot installer for macOS:
#   1. installs a launchd service so the helper runs at login
#   2. copies the Übersicht widget into place (if Übersicht is installed)
#
# Re-runnable (idempotent). Requires Node 18+.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO_DIR/src/cli.js"
PORT="${CLAUDE_STATS_PORT:-4318}"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Error: node not found on PATH. Install Node 18+ first (e.g. 'brew install node')." >&2
  exit 1
fi

echo "==> Node:   $NODE_BIN"
echo "==> Helper: $CLI"
echo "==> Port:   $PORT"

# --- 1. launchd service ------------------------------------------------------
LOGDIR="$HOME/Library/Logs/claude-stats"
mkdir -p "$LOGDIR"

PLIST_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$PLIST_DIR"
PLIST="$PLIST_DIR/com.claude-stats.helper.plist"

sed -e "s#__NODE__#$NODE_BIN#g" \
    -e "s#__CLI__#$CLI#g" \
    -e "s#__LOGDIR__#$LOGDIR#g" \
    -e "s#__PORT__#$PORT#g" \
    "$REPO_DIR/scripts/com.claude-stats.helper.plist.template" > "$PLIST"

# Reload if already loaded.
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "==> launchd service installed and started ($PLIST)"

# Give it a moment, then verify.
sleep 1
if curl -s --max-time 3 "http://127.0.0.1:$PORT/health" >/dev/null; then
  echo "==> Helper is responding on port $PORT ✅"
else
  echo "==> Helper not responding yet — check logs in $LOGDIR" >&2
fi

# --- 2. Übersicht widget -----------------------------------------------------
UB_DIR="$HOME/Library/Application Support/Übersicht/widgets"
if [[ -d "$UB_DIR" ]]; then
  cp -R "$REPO_DIR/widget/claude-stats.widget" "$UB_DIR/"
  echo "==> Widget copied to Übersicht ($UB_DIR)"
  echo "    Refresh Übersicht (menu bar icon → Refresh All) to see it."
else
  echo "==> Übersicht not found at $UB_DIR"
  echo "    Install Übersicht from https://tracesof.net/uebersicht/ then copy:"
  echo "      cp -R \"$REPO_DIR/widget/claude-stats.widget\" \"$UB_DIR/\""
fi

echo
echo "Done. Next: enable live telemetry with ./scripts/enable-telemetry.sh"
echo "To uninstall the service: launchctl unload \"$PLIST\" && rm \"$PLIST\""
