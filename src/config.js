'use strict';

const os = require('os');
const path = require('path');

// Root of the local Claude Code data directory. Overridable for testing.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

module.exports = {
  CLAUDE_DIR,
  PROJECTS_DIR: path.join(CLAUDE_DIR, 'projects'),
  HISTORY_FILE: path.join(CLAUDE_DIR, 'history.jsonl'),
  STATS_CACHE_FILE: path.join(CLAUDE_DIR, 'stats-cache.json'),

  // The helper service listens here. Claude Code's OTEL exporter posts to
  // <PORT>/v1/metrics and the widget reads <PORT>/stats — same port, one server.
  PORT: Number(process.env.CLAUDE_STATS_PORT) || 4318,
  HOST: process.env.CLAUDE_STATS_HOST || '127.0.0.1',

  // How long parsed file stats stay cached before a re-parse (ms).
  STATS_TTL_MS: Number(process.env.CLAUDE_STATS_TTL_MS) || 30_000,
};
