'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { PROJECTS_DIR } = require('../config');
const { forEachRecord } = require('./jsonl');
const { Aggregator } = require('./aggregate');

// Recursively collect every *.jsonl file beneath a directory.
async function findSessionFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await findSessionFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

// Parse every session file under projectsDir and return aggregated stats.
async function parseSessions(projectsDir = PROJECTS_DIR) {
  const agg = new Aggregator();
  const files = await findSessionFiles(projectsDir);

  const meta = { files: files.length, records: 0, skipped: 0 };
  for (const file of files) {
    // The session id is the file's basename (Claude Code writes one file per session).
    const sessionId = path.basename(file, '.jsonl');
    const fileStats = await forEachRecord(file, (record) => agg.add(record, sessionId));
    meta.records += fileStats.parsed;
    meta.skipped += fileStats.skipped;
  }

  const result = agg.finalize();
  result._meta = meta;
  return result;
}

function projectsDirExists(projectsDir = PROJECTS_DIR) {
  try {
    return fs.statSync(projectsDir).isDirectory();
  } catch (_) {
    return false;
  }
}

module.exports = { parseSessions, findSessionFiles, projectsDirExists };
