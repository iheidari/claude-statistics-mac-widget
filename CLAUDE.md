# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
node test/run.js          # run the full test suite (also: npm test)
node src/cli.js print     # human-readable stats summary from local ~/.claude files
node src/cli.js parse     # full parsed stats as JSON
node src/cli.js serve     # start the helper HTTP service (default command; npm start)

./scripts/install.sh          # launchd service (runs helper at login) + copy widget into Übersicht
./scripts/enable-telemetry.sh # append OTEL env vars to shell rc so Claude Code emits live metrics
```

There is no build step, no linter, and **zero runtime dependencies** — the helper is pure Node.js (>=18, CommonJS). Keep it that way: do not add npm dependencies. The test runner is hand-rolled on `node:assert` (no Jest/Mocha); there is no single-test filter — `test/run.js` runs everything sequentially and exits non-zero on any failure. Add new tests to that file.

**Known non-hermetic tests:** the three "no credential → unavailable" plan-limits tests assume no Claude Code credential exists. On a real dev machine `findCredential()` falls through the env var to the macOS Keychain / `~/.claude/.credentials.json`, finds a live token, and the assertions flip to expecting `available: false` when it's actually `true`. These failures are an environment artifact, not a regression — do not "fix" them by changing `planLimits.js`. A clean run requires an environment with no discoverable credential.

## Architecture

The helper is a single long-running HTTP server (default `127.0.0.1:4318`) that fuses **three independent data sources** into one `/stats` JSON payload the widget polls:

1. **Local file parsing** (`src/parser/`) — the historical picture (streaks, peak hour, favorite model, lifetime tokens/cost). Reads `~/.claude/projects/**/*.jsonl`, `history.jsonl`, `stats-cache.json`.
2. **Live OTLP telemetry** (`src/telemetry/otlpReceiver.js`) — Claude Code POSTs OpenTelemetry metrics to `/v1/metrics` as they happen. The server holds these in memory only (`TelemetryStore`); nothing is persisted.
3. **Plan usage limits** (`src/planLimits.js`) — live session/weekly rate-limit bars, fetched from Anthropic's `/api/oauth/usage` endpoint.

Data flow: `cli.js` → `server.js` → (`parser/`, `telemetry/`, `planLimits.js`). The Übersicht widget (`widget/claude-stats.widget/index.jsx`) shells out to `curl http://127.0.0.1:4318/stats` — it never imports the source, so **the JSON shape of `/stats` is the contract** between server and widget. Changing a field name in the parser's `finalize()` or the telemetry `snapshot()` means updating `index.jsx` too.

The port `4318` is deliberately the OTLP/HTTP default: one server both receives metrics (`POST /v1/metrics`) and serves the widget (`GET /stats`), so no separate collector is needed. `4318` is hardcoded in three places that must stay in sync: `src/config.js`, `widget/.../index.jsx` (`PORT`), and `scripts/enable-telemetry.sh`.

### Parsing is defensive by design

The Claude Code JSONL schema is internal and undocumented, so the parser never assumes a shape:
- `jsonl.js` skips malformed/partial lines (counts them in `_meta.skipped`) rather than throwing.
- `aggregate.js` has `extractUsage`/`extractModel`/`extractTimestamp`/`extractRole` that each probe several possible locations (`record.message.usage`, `record.usage`, `record.data.usage`, …). When adding a field, follow this multi-location fallback pattern instead of reading one path.
- Everything degrades to `null`/`—` rather than erroring when data is missing.

### Cost estimation (`src/pricing.js`)

Costs are estimated locally from token counts (Anthropic exposes no cost-per-record). Model IDs are matched as **substrings, longest-key-wins**, so date suffixes (`-20260101`) and provider prefixes (`anthropic.`, bedrock) still resolve. Cache tokens are priced relative to the model's input price (write ×1.25, read ×0.1). Prices are best-effort list pricing and can be overridden by dropping a git-ignored `src/pricing.json` (same shape as the `PRICING` table).

### Plan limits use an undocumented endpoint

`planLimits.js` is the fragile part. Anthropic has no official personal-usage API, so it:
- Discovers the Claude Code OAuth token in priority order: `CLAUDE_CODE_OAUTH_TOKEN` env → macOS Keychain (`security find-generic-password`) → `~/.claude/.credentials.json`.
- If **no** credential is found, it makes **no network call** and reports `available: false`. Preserve this — never fetch without a discovered credential.
- Sends a `claude-code/<version>` User-Agent (mandatory; the endpoint 429s without it) and the `anthropic-beta: oauth-2025-04-20` header.
- Is cached with a hard **180s minimum TTL** because the endpoint is aggressively rate-limited. Do not lower this floor.
- `usageToBars()` parses the `/api/oauth/usage` JSON into normalized bars, covered by tests and kept in sync with the widget's bar-rendering expectations. (An earlier `headersToBars()` path that parsed `anthropic-ratelimit-*` response headers was removed when the endpoint switch landed.)

### Caching

Both `parser/index.js` (`getStatsCached`, 30s TTL) and `planLimits.js` (180s TTL) use the same in-flight-dedup memoization pattern: return the cached value if fresh, return the in-flight promise if a fetch is already running, otherwise start one. The widget polls every 10s, so these caches keep re-parsing and network calls cheap.

## Conventions

- All source uses `'use strict'` CommonJS. Match the existing terse, comment-the-why style.
- Env overrides for testing/config: `CLAUDE_CONFIG_DIR` (relocates `~/.claude`), `CLAUDE_STATS_PORT`, `CLAUDE_STATS_HOST`, `CLAUDE_STATS_TTL_MS`, `CLAUDE_STATS_LIMITS_TTL_MS`, `CLAUDE_STATS_PLAN_LIMITS=off`, `CLAUDE_STATS_USER_AGENT`. Tests drive the parser by pointing `CLAUDE_CONFIG_DIR` at a temp fixture.
- The server binds `127.0.0.1` only and reads local files/credentials — treat it as a localhost-only tool, not a network service.
