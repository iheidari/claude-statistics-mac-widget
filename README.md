# Claude Statistics — macOS Desktop Widget

A desktop widget for your Mac that shows your **Claude Code** usage statistics —
sessions, messages, tokens, estimated cost, streaks, peak hour, and favorite
model — right on your wallpaper.

It uses **both** approaches you asked for:

1. **Parses your local files** — `~/.claude/projects/**/*.jsonl`,
   `~/.claude/history.jsonl`, and `~/.claude/stats-cache.json`. This is the only
   way to get the full picture (streaks, peak hour, favorite model).
2. **Receives live OpenTelemetry metrics** — Claude Code can emit
   `claude_code.token.usage`, `claude_code.cost.usage`, `claude_code.session.count`,
   `claude_code.active_time.total`, etc. The helper ingests them live so the
   widget updates as you work.

```
┌───────────────────────────┐        ┌──────────────────────────┐
│  ~/.claude/*.jsonl         │──parse─▶│  helper service          │
│  history.jsonl             │        │  (Node, zero deps)       │
│  stats-cache.json          │        │                          │
└───────────────────────────┘        │   GET  /stats  ──────────┼──▶ Übersicht widget
                                      │   POST /v1/metrics ◀─────┼── Claude Code (OTEL)
Claude Code ──OTEL http/json─────────▶│                          │
                                      └──────────────────────────┘
```

The helper is **pure Node.js with no dependencies** — nothing to `npm install`.

---

## Requirements

- macOS
- [Node.js 18+](https://nodejs.org) (`brew install node`)
- [Übersicht](https://tracesof.net/uebersicht/) (free desktop-widget host)

---

## Quick start

```bash
git clone <this-repo> claude-statistics-mac-widget
cd claude-statistics-mac-widget

# See your stats right now in the terminal (no service needed):
node src/cli.js print

# Install: runs the helper at login + copies the widget into Übersicht
./scripts/install.sh

# Turn on live telemetry from Claude Code (optional but recommended):
./scripts/enable-telemetry.sh
# then open a new terminal so the env vars take effect
```

Refresh Übersicht (menu-bar icon → **Refresh All**) and the widget appears in the
top-left of your desktop.

---

## Components

| Path | What it is |
|------|-----------|
| `src/cli.js` | CLI: `serve` (default), `print`, `parse`, `help` |
| `src/parser/` | Defensive JSONL parser + statistics engine |
| `src/pricing.js` | Per-model cost estimation (Opus/Sonnet/Haiku/Fable, cache tokens) |
| `src/telemetry/otlpReceiver.js` | OTLP **http/json** metrics receiver |
| `src/server.js` | HTTP server: `/stats`, `/telemetry`, `/health`, `POST /v1/metrics` |
| `widget/claude-stats.widget/` | The Übersicht desktop widget |
| `scripts/install.sh` | launchd service + widget install |
| `scripts/enable-telemetry.sh` | Adds the OTEL env vars to your shell rc |

---

## The CLI

```
claude-stats serve     Start the helper (serves /stats, receives /v1/metrics). Default.
claude-stats print     Human-readable summary in the terminal.
claude-stats parse     Full parsed stats as JSON.
claude-stats help      Usage.
```

Run without installing anything:

```bash
node src/cli.js print
```

```
  Claude Code Statistics
  ──────────────────────────────────
  Sessions        128
  Messages        4,102
  Prompts         1,530
  Active days     43
  Current streak  6 day(s)
  Longest streak  19 day(s)
  Peak hour       10 PM
  Favorite model  claude-opus-4-8
  Total tokens    58,204,113
  Est. cost       $214.87
  ──────────────────────────────────
```

---

## The `/stats` endpoint

`GET http://127.0.0.1:4318/stats` returns everything the widget needs:

```jsonc
{
  "sessions": 128,
  "messages": 4102,
  "userMessages": 1530,
  "assistantMessages": 2572,
  "activeDays": 43,
  "currentStreak": 6,
  "longestStreak": 19,
  "peakHour": 22,
  "favoriteModel": "claude-opus-4-8",
  "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheCreation": 0, "total": 0 },
  "cost": 214.87,
  "byModel": { "claude-opus-4-8": { "messages": 2100, "tokens": {…}, "cost": 190.2 } },
  "perDay": { "2026-06-30": 88 },
  "perHour": [0, 0, …],                 // 24 buckets
  "history": { "totalPrompts": 1530, "promptsByProject": {…} },
  "telemetry": {                         // live OTEL metrics (null-ish until Claude Code emits)
    "available": true,
    "costUsage": 3.11,
    "sessionCount": 4,
    "tokens": { "input": 12000, "output": 3400, … },
    "activeTimeSeconds": 900
  },
  "generatedAt": "2026-07-03T…Z"
}
```

Parsed file results are cached for 30s (`CLAUDE_STATS_TTL_MS`) so polling is cheap.

---

## Live telemetry details

Claude Code exports OTEL metrics when these env vars are set (this is exactly
what `scripts/enable-telemetry.sh` adds):

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json      # important — we accept http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_METRIC_EXPORT_INTERVAL=15000
```

> **Why `http/json`?** OTEL's default is gRPC (port 4317) or protobuf-over-HTTP,
> both of which need heavy dependencies to decode. `http/json` is plain JSON, so
> the helper stays dependency-free. Claude Code posts metrics to
> `…/v1/metrics`, which the helper handles.

The two data paths are complementary: **files** give you the historical,
derived stats (streaks, peak hour, favorite model — never emitted as metrics),
while **telemetry** gives you a live, low-latency feed of tokens/cost/sessions
as you work. The widget's status dot turns green when live telemetry is flowing.

---

## Plan usage limits (live session + weekly bars)

The widget can also show your **plan rate-limit** status — the same bars as
Claude Code's `/usage` panel: current-session %, weekly (all models) %, and
per-model weekly %, each with a reset time.

> ⚠️ **This uses an undocumented mechanism.** Anthropic exposes **no official
> personal-usage API** (the Rate Limits API is org/Admin-only and excludes
> Pro/Max plans). Like the community tools, the helper reads the OAuth token
> Claude Code stored, makes **one minimal Messages API request every 60s**, and
> parses the `anthropic-ratelimit-*` response headers into the bars. It can break
> if Anthropic changes those headers. **If no token is found, the helper makes no
> network call at all** and the section simply doesn't appear.

How the token is located (first match wins):

1. `CLAUDE_CODE_OAUTH_TOKEN` env var (a token from `claude setup-token`, or any
   access token) — set this if you'd rather not have the helper touch Keychain.
2. **macOS Keychain** — the `Claude Code-credentials` item (macOS may show a
   one-time "allow access" prompt the first time).
3. `~/.claude/.credentials.json` (Linux/Windows).

Each 60s refresh makes one tiny authenticated request (Haiku, `max_tokens: 1`) as
you — negligible quota, but it *is* a real call on your account. Turn the whole
feature off with `CLAUDE_STATS_PLAN_LIMITS=off`.

Inspect it directly:

```bash
curl -s http://127.0.0.1:4318/limits | node -e 'process.stdin.on("data",d=>console.log(d.toString()))'
```

```jsonc
{
  "available": true,
  "plan": "max",
  "bars": [
    { "id": "unified-5h",      "label": "Current session",     "usedPercent": 35, "resetInSeconds": 2160 },
    { "id": "unified-7d",      "label": "Weekly · All models",  "usedPercent": 10, "resetAt": "…" },
    { "id": "unified-7d-opus", "label": "Weekly · Opus",        "usedPercent": 3,  "resetAt": "…" }
  ],
  "source": "keychain"
}
```

If the token has expired, the helper reports that (`run any Claude Code command
to refresh it`) instead of failing silently — it does **not** implement token
refresh itself.

---

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where to read the JSONL data from |
| `CLAUDE_STATS_PORT` | `4318` | Helper listen port (widget + OTEL must match) |
| `CLAUDE_STATS_HOST` | `127.0.0.1` | Helper bind address |
| `CLAUDE_STATS_TTL_MS` | `30000` | File-parse cache lifetime |
| `CLAUDE_STATS_PLAN_LIMITS` | (on) | Set to `off` to disable live plan-limit probing entirely |
| `CLAUDE_STATS_LIMITS_TTL_MS` | `60000` | How often to refresh plan limits (one API call per refresh) |
| `CLAUDE_CODE_OAUTH_TOKEN` | (unset) | Provide the OAuth token yourself instead of reading Keychain |
| `CLAUDE_STATS_PROBE_MODEL` | `claude-haiku-4-5` | Model used for the tiny rate-limit probe request |

If you change the port, update `PORT` at the top of
`widget/claude-stats.widget/index.jsx` too.

**Custom pricing:** drop a `src/pricing.json` (same shape as the `PRICING`
table in `src/pricing.js`) to override or add model prices.

---

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.claude-stats.helper.plist
rm ~/Library/LaunchAgents/com.claude-stats.helper.plist
rm -rf "$HOME/Library/Application Support/Übersicht/widgets/claude-stats.widget"
```

Remove the telemetry block from your shell rc file (marked with
`claude-statistics-mac-widget`).

---

## Notes & caveats

- **The JSONL schema is internal to Claude Code and can change between releases.**
  The parser is deliberately defensive (it tolerates missing fields and skips
  malformed lines), but a future format change may need a small update to
  `src/parser/aggregate.js`.
- **Costs are estimates.** They use public list pricing and don't know about
  subscription plans, batch discounts, or promotional rates.
- The helper binds to `127.0.0.1` only — nothing is exposed off your machine.

---

## Development

```bash
node test/run.js     # unit + end-to-end tests (no network, no deps)
```
