'use strict';

const fs = require('fs');
const readline = require('readline');

// Stream a .jsonl file line by line, invoking `onRecord(obj, lineNumber)` for
// each parseable JSON line. Malformed lines are counted and skipped rather than
// throwing — the Claude Code schema is internal and occasionally writes partial
// or non-JSON lines. Returns { lines, parsed, skipped }.
async function forEachRecord(filePath, onRecord) {
  const stats = { lines: 0, parsed: 0, skipped: 0 };
  let stream;
  try {
    stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  } catch (_) {
    return stats;
  }

  await new Promise((resolve) => {
    stream.on('error', resolve); // unreadable file -> just stop
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      stats.lines += 1;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch (_) {
        stats.skipped += 1;
        return;
      }
      stats.parsed += 1;
      try {
        onRecord(obj, stats.lines);
      } catch (_) {
        // A bad handler on one record shouldn't abort the whole file.
      }
    });
    rl.on('close', resolve);
    rl.on('error', resolve);
  });

  return stats;
}

module.exports = { forEachRecord };
