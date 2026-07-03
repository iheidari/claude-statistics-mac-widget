#!/usr/bin/env bash
#
# Enable Claude Code's OpenTelemetry export and point it at the local helper.
# The helper receives OTLP over HTTP/JSON (no gRPC/protobuf dependency).
#
# Usage:
#   ./scripts/enable-telemetry.sh          # append to ~/.zshrc (or $SHELL rc)
#   ./scripts/enable-telemetry.sh --print  # just print the block, change nothing
#
set -euo pipefail

PORT="${CLAUDE_STATS_PORT:-4318}"

read -r -d '' BLOCK <<EOF || true

# --- claude-statistics-mac-widget: live telemetry ---
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:${PORT}
# Export metrics every 15s so the widget stays fresh (default is 60s).
export OTEL_METRIC_EXPORT_INTERVAL=15000
# --- end claude-statistics-mac-widget ---
EOF

if [[ "${1:-}" == "--print" ]]; then
  echo "$BLOCK"
  exit 0
fi

# Pick the login shell rc file.
case "${SHELL:-}" in
  *zsh) RC="$HOME/.zshrc" ;;
  *bash) RC="$HOME/.bash_profile" ;;
  *) RC="$HOME/.profile" ;;
esac

if grep -q "claude-statistics-mac-widget: live telemetry" "$RC" 2>/dev/null; then
  echo "Telemetry block already present in $RC — nothing to do."
  exit 0
fi

echo "$BLOCK" >> "$RC"
echo "Added telemetry env vars to $RC"
echo "Open a new terminal (or 'source $RC') and run Claude Code to start emitting metrics."
echo "The helper must be running: claude-stats serve"
