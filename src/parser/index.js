'use strict';

const fsp = require('fs/promises');
const { STATS_CACHE_FILE, STATS_TTL_MS } = require('../config');
const { parseSessions, projectsDirExists } = require('./sessions');
const { parseHistory } = require('./history');

async function readStatsCache(file = STATS_CACHE_FILE) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

// Full parse of all local sources. Returns a single stats object.
async function collectStats() {
  const [sessions, history, statsCache] = await Promise.all([
    parseSessions(),
    parseHistory(),
    readStatsCache(),
  ]);

  return {
    ...sessions,
    history,
    statsCache: statsCache || null,
    dataAvailable: projectsDirExists(),
    generatedAt: new Date().toISOString(),
    source: 'files',
  };
}

// Simple time-based memoization so the widget can poll cheaply without
// re-parsing thousands of lines on every request.
let cache = { value: null, at: 0, inflight: null };

async function getStatsCached(ttl = STATS_TTL_MS) {
  const now = Date.now();
  if (cache.value && now - cache.at < ttl) return cache.value;
  if (cache.inflight) return cache.inflight;

  cache.inflight = collectStats()
    .then((value) => {
      cache = { value, at: Date.now(), inflight: null };
      return value;
    })
    .catch((err) => {
      cache.inflight = null;
      throw err;
    });
  return cache.inflight;
}

function invalidateCache() {
  cache = { value: null, at: 0, inflight: null };
}

module.exports = { collectStats, getStatsCached, invalidateCache, readStatsCache };
