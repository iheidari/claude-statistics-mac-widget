'use strict';

// Live "Plan usage limits" (the /usage panel: current-session + weekly bars).
//
// IMPORTANT: this uses an UNDOCUMENTED mechanism. Anthropic exposes no official
// personal-usage API, so — like the community tools (Claude-Usage-Tracker,
// Claude-Code-Usage-Monitor) — we read the OAuth token Claude Code stored, make
// one minimal Messages API request, and parse the `anthropic-ratelimit-*`
// response headers. It can break if Anthropic changes those headers. If no token
// is found we make NO network call and simply report the feature as unavailable.

const os = require('os');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFileSync } = require('child_process');

const API_HOST = 'api.anthropic.com';
const OAUTH_BETA = 'oauth-2025-04-20';
const PROBE_MODEL = process.env.CLAUDE_STATS_PROBE_MODEL || 'claude-haiku-4-5';

// ---- Credential discovery ---------------------------------------------------

function extractToken(rawJsonOrToken) {
  if (!rawJsonOrToken) return null;
  const s = String(rawJsonOrToken).trim();
  // Already a bare token?
  if (s.startsWith('sk-ant-')) return { accessToken: s, expiresAt: null, plan: null };
  try {
    const obj = JSON.parse(s);
    const o = obj.claudeAiOauth || obj.oauth || obj;
    const accessToken = o.accessToken || o.access_token;
    if (!accessToken) return null;
    return {
      accessToken,
      expiresAt: o.expiresAt || o.expires_at || null,
      plan: o.subscriptionType || o.subscription_type || null,
    };
  } catch (_) {
    return null;
  }
}

function fromKeychain() {
  if (process.platform !== 'darwin') return null;
  const services = ['Claude Code-credentials', 'Claude Code', 'claude-code'];
  for (const svc of services) {
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', svc, '-w'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const tok = extractToken(out);
      if (tok) return tok;
    } catch (_) {
      // service not found / access denied — try the next candidate
    }
  }
  return null;
}

function fromCredentialsFile() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const file = path.join(dir, '.credentials.json');
  try {
    return extractToken(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function findCredential() {
  // Explicit env token wins (used by the "token I provide" setup, and testing).
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    const tok = extractToken(process.env.CLAUDE_CODE_OAUTH_TOKEN);
    if (tok) return { ...tok, source: 'env' };
  }
  const kc = fromKeychain();
  if (kc) return { ...kc, source: 'keychain' };
  const file = fromCredentialsFile();
  if (file) return { ...file, source: 'file' };
  return null;
}

// ---- Header parsing ---------------------------------------------------------

// Turn a `-reset` header value into { resetAt(ISO), resetInSeconds }.
function parseReset(value) {
  if (value == null) return { resetAt: null, resetInSeconds: null };
  const now = Date.now();
  const asNum = Number(value);
  let ms;
  if (!isNaN(asNum) && String(value).trim() !== '') {
    if (asNum > 1e12) ms = asNum; // epoch ms
    else if (asNum > 1e9) ms = asNum * 1000; // epoch seconds
    else ms = now + asNum * 1000; // seconds-from-now
  } else {
    const d = new Date(value); // RFC3339 timestamp
    if (isNaN(d.getTime())) return { resetAt: null, resetInSeconds: null };
    ms = d.getTime();
  }
  return { resetAt: new Date(ms).toISOString(), resetInSeconds: Math.max(0, Math.round((ms - now) / 1000)) };
}

// Give a friendly label + ordering weight to a rate-limit group key.
function classify(key) {
  const k = key.toLowerCase();
  const model = (k.match(/opus|sonnet|haiku|fable|mythos/) || [])[0];
  if (/(^|[-_])(5h|session|unified$)/.test(k) || k === 'unified') {
    return { label: 'Current session', order: 0 };
  }
  if (/7d|weekly|week/.test(k)) {
    if (model) return { label: `Weekly · ${model[0].toUpperCase()}${model.slice(1)}`, order: 2 };
    return { label: 'Weekly · All models', order: 1 };
  }
  if (model) return { label: `Weekly · ${model[0].toUpperCase()}${model.slice(1)}`, order: 2 };
  return { label: key, order: 3 };
}

// Collapse `anthropic-ratelimit-<key>-<field>` headers into normalized bars.
function headersToBars(headers) {
  const groups = new Map(); // key -> { limit, remaining, reset, status }
  const raw = {};
  for (const [name, value] of Object.entries(headers)) {
    const m = /^anthropic-ratelimit-(.+)-(limit|remaining|reset|status)$/.exec(name);
    if (!m) continue;
    raw[name] = value;
    const key = m[1];
    const field = m[2];
    if (!groups.has(key)) groups.set(key, {});
    groups.get(key)[field] = value;
  }

  const bars = [];
  for (const [key, g] of groups) {
    const limit = Number(g.limit);
    const remaining = Number(g.remaining);
    let usedPercent = null;
    if (isFinite(limit) && limit > 0 && isFinite(remaining)) {
      usedPercent = Math.min(100, Math.max(0, Math.round(((limit - remaining) / limit) * 100)));
    }
    if (usedPercent == null) continue; // nothing meaningful to show for this group
    const { resetAt, resetInSeconds } = parseReset(g.reset);
    const { label, order } = classify(key);
    bars.push({ id: key, label, usedPercent, limit, remaining, resetAt, resetInSeconds, order });
  }

  bars.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return { bars, raw };
}

// ---- Probe ------------------------------------------------------------------

function probe(accessToken, timeoutMs = 8000) {
  const body = JSON.stringify({
    model: PROBE_MODEL,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  });
  const options = {
    host: API_HOST,
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      authorization: `Bearer ${accessToken}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': OAUTH_BETA,
      'user-agent': 'claude-statistics-mac-widget',
    },
  };
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', (err) => resolve({ error: String(err && err.message) }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ error: 'probe timed out' });
    });
    req.write(body);
    req.end();
  });
}

// Perform one live fetch. Returns a normalized planLimits object.
async function fetchPlanLimits() {
  if (process.env.CLAUDE_STATS_PLAN_LIMITS === 'off') {
    return { available: false, error: 'disabled', bars: [] };
  }
  const cred = findCredential();
  if (!cred) {
    return { available: false, error: 'no Claude Code credential found', bars: [] };
  }
  if (cred.expiresAt && Number(cred.expiresAt) < Date.now()) {
    return {
      available: false,
      error: 'token expired — run any Claude Code command to refresh it',
      bars: [],
      plan: cred.plan || null,
      source: cred.source,
    };
  }

  const res = await probe(cred.accessToken);
  if (res.error) {
    return { available: false, error: res.error, bars: [], source: cred.source };
  }
  const { bars, raw } = headersToBars(res.headers || {});
  if (res.status === 401 || res.status === 403) {
    return {
      available: false,
      error: 'token rejected (' + res.status + ') — run a Claude Code command to refresh',
      bars,
      raw,
      source: cred.source,
    };
  }

  return {
    available: bars.length > 0,
    error: bars.length ? null : 'no rate-limit headers returned',
    bars,
    raw,
    plan: cred.plan || null,
    source: cred.source,
    status: res.status,
    updatedAt: new Date().toISOString(),
  };
}

// ---- 60s cache --------------------------------------------------------------

let cache = { value: null, at: 0, inflight: null };
const TTL_MS = Number(process.env.CLAUDE_STATS_LIMITS_TTL_MS) || 60_000;

async function getPlanLimitsCached(ttl = TTL_MS) {
  const now = Date.now();
  if (cache.value && now - cache.at < ttl) return cache.value;
  if (cache.inflight) return cache.inflight;
  cache.inflight = fetchPlanLimits()
    .then((value) => {
      cache = { value, at: Date.now(), inflight: null };
      return value;
    })
    .catch((err) => {
      cache.inflight = null;
      const value = { available: false, error: String((err && err.message) || err), bars: [] };
      cache = { value, at: Date.now(), inflight: null };
      return value;
    });
  return cache.inflight;
}

module.exports = {
  getPlanLimitsCached,
  fetchPlanLimits,
  // exported for testing:
  headersToBars,
  parseReset,
  classify,
  extractToken,
  findCredential,
};
