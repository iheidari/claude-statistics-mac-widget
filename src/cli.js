#!/usr/bin/env node
'use strict';

const { PORT, HOST, CLAUDE_DIR } = require('./config');

function fmtNum(n) {
  if (n == null) return '—';
  return n.toLocaleString('en-US');
}
function fmtUsd(n) {
  if (n == null) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtHour(h) {
  if (h == null) return '—';
  const am = h < 12 ? 'AM' : 'PM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${am}`;
}

async function cmdPrint() {
  const { collectStats } = require('./parser');
  const s = await collectStats();
  const line = (label, val) => console.log(label.padEnd(18) + val);

  console.log('\n  Claude Code Statistics');
  console.log('  ' + '─'.repeat(34));
  if (!s.dataAvailable) {
    console.log(`  No data found at ${CLAUDE_DIR}/projects`);
    console.log('  (Have you used Claude Code on this machine yet?)\n');
    return;
  }
  line('  Sessions', fmtNum(s.sessions));
  line('  Messages', fmtNum(s.messages));
  line('  Prompts', fmtNum(s.history.totalPrompts));
  line('  Active days', fmtNum(s.activeDays));
  line('  Current streak', `${fmtNum(s.currentStreak)} day(s)`);
  line('  Longest streak', `${fmtNum(s.longestStreak)} day(s)`);
  line('  Peak hour', fmtHour(s.peakHour));
  line('  Favorite model', s.favoriteModel || '—');
  line('  Total tokens', fmtNum(s.tokens.total));
  line('  Est. cost', fmtUsd(s.cost));
  console.log('  ' + '─'.repeat(34));
  console.log(`  Parsed ${fmtNum(s._meta.records)} records from ${fmtNum(s._meta.files)} session files\n`);
}

async function cmdParse() {
  const { collectStats } = require('./parser');
  const s = await collectStats();
  console.log(JSON.stringify(s, null, 2));
}

async function cmdServe() {
  const { start } = require('./server');
  const { port, host } = await start();
  console.log(`claude-stats helper listening on http://${host}:${port}`);
  console.log(`  • widget reads   http://${host}:${port}/stats`);
  console.log(`  • telemetry into POST http://${host}:${port}/v1/metrics`);
  console.log(`  • reading data from ${CLAUDE_DIR}`);
  console.log('Press Ctrl+C to stop.');
}

async function main() {
  const cmd = process.argv[2] || 'serve';
  switch (cmd) {
    case 'serve':
      return cmdServe();
    case 'parse':
      return cmdParse();
    case 'print':
      return cmdPrint();
    case '-h':
    case '--help':
    case 'help':
      console.log(`
claude-stats — Claude Code usage statistics helper

Usage:
  claude-stats serve     Start the helper service (default). Serves /stats and
                         receives OTEL metrics at /v1/metrics. Port ${PORT}.
  claude-stats print     Print a human-readable summary to the terminal.
  claude-stats parse     Print the full parsed stats as JSON.
  claude-stats help      Show this help.

Env:
  CLAUDE_CONFIG_DIR      Override ~/.claude location.
  CLAUDE_STATS_PORT      Override the listen port (default ${PORT}).
  CLAUDE_STATS_HOST      Override the listen host (default ${HOST}).
`);
      return;
    default:
      console.error(`Unknown command: ${cmd}\nRun "claude-stats help" for usage.`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Error:', (err && err.stack) || err);
  process.exitCode = 1;
});
