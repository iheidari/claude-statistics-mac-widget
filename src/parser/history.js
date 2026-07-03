'use strict';

const { HISTORY_FILE } = require('../config');
const { forEachRecord } = require('./jsonl');

// Parse ~/.claude/history.jsonl — one entered prompt/command per line.
// Schema is loose across versions; we only need a count and a rough recency.
async function parseHistory(historyFile = HISTORY_FILE) {
  let total = 0;
  let lastTs = null;
  const perProject = new Map();

  await forEachRecord(historyFile, (record) => {
    total += 1;
    const proj = record.project || record.cwd || null;
    if (proj) perProject.set(proj, (perProject.get(proj) || 0) + 1);
    const t = record.timestamp || record.ts || null;
    if (t) {
      const d = new Date(t);
      if (!isNaN(d.getTime()) && (!lastTs || d > lastTs)) lastTs = d;
    }
  });

  const projects = {};
  for (const [k, v] of Array.from(perProject.entries()).sort((a, b) => b[1] - a[1])) {
    projects[k] = v;
  }

  return {
    totalPrompts: total,
    lastPromptAt: lastTs ? lastTs.toISOString() : null,
    promptsByProject: projects,
  };
}

module.exports = { parseHistory };
