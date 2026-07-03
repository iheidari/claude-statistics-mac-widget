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
const USAGE_PATH = '/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';

// The usage endpoint gates on a claude-code User-Agent — without it you get
// aggressive 429s. We detect the installed Claude Code version when possible.
let cachedUserAgent = null;
function userAgent() {
  if (process.env.CLAUDE_STATS_USER_AGENT) return process.env.CLAUDE_STATS_USER_AGENT;
  if (cachedUserAgent) return cachedUserAgent;
  let version = '2.1.0';
  try {
    const out = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/(\d+\.\d+\.\d+)/);
    if (m) version = m[1];
  } catch (_) {
    /* claude not on PATH — fall back to default version */
  }
  cachedUserAgent = `claude-code/${version}`;
  return cachedUserAgent;
}

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
// Anthropic's unified headers on subscription plans carry `-status` + `-reset`
// (and sometimes `-limit`/`-remaining`). When limit/remaining are present we can
// show a real % bar; otherwise we still surface the window's reset + status.
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
  let overage = null;
  for (const [key, g] of groups) {
    if (key === 'unified') continue; // overall roll-up — redundant with the 5h/7d windows
    if (/overage/.test(key)) {
      overage = g.status || null;
      continue;
    }

    const limit = Number(g.limit);
    const remaining = Number(g.remaining);
    let usedPercent = null;
    if (isFinite(limit) && limit > 0 && isFinite(remaining)) {
      usedPercent = Math.min(100, Math.max(0, Math.round(((limit - remaining) / limit) * 100)));
    }

    const hasReset = g.reset != null && g.reset !== '';
    const status = g.status || null;
    if (usedPercent == null && !hasReset && !status) continue; // nothing to show

    const { resetAt, resetInSeconds } = parseReset(g.reset);
    const { label, order } = classify(key);
    bars.push({
      id: key,
      label,
      usedPercent, // null when the API doesn't expose a numeric limit
      status, // 'allowed' | 'rejected' | null
      limit: isFinite(limit) ? limit : null,
      remaining: isFinite(remaining) ? remaining : null,
      resetAt,
      resetInSeconds,
      order,
    });
  }

  bars.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return { bars, raw, overage };
}

// ---- Usage endpoint ---------------------------------------------------------

// GET the undocumented /api/oauth/usage endpoint Claude Code's /usage panel uses.
// It's a usage *query* (no message tokens billed) and returns actual percentages.
function fetchUsage(accessToken, timeoutMs = 8000) {
  const options = {
    host: API_HOST,
    path: USAGE_PATH,
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
      'anthropic-beta': OAUTH_BETA,
      'user-agent': userAgent(), // MANDATORY — without a claude-code UA you get 429s
    },
  };
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (err) => resolve({ error: String(err && err.message) }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ error: 'usage request timed out' });
    });
    req.end();
  });
}

function windowBar(id, label, order, w) {
  if (!w || typeof w !== 'object') return null;
  const usedPercent = typeof w.utilization === 'number' ? Math.round(w.utilization) : null;
  const resetAt = w.resets_at || w.resetsAt || null;
  if (usedPercent == null && !resetAt) return null;
  const { resetInSeconds } = parseReset(resetAt);
  return {
    id,
    label,
    usedPercent,
    status: null,
    resetAt: resetAt ? new Date(resetAt).toISOString() : null,
    resetInSeconds,
    order,
  };
}

// Turn the /api/oauth/usage JSON into normalized bars.
function usageToBars(json) {
  const bars = [];
  const push = (id, label, order, w) => {
    const b = windowBar(id, label, order, w);
    if (b) bars.push(b);
  };
  push('five_hour', 'Current session', 0, json.five_hour);
  push('seven_day', 'Weekly · All models', 1, json.seven_day);
  // Per-model weekly windows: seven_day_opus, seven_day_sonnet, seven_day_fable, …
  for (const key of Object.keys(json)) {
    const m = /^seven_day_(.+)$/.exec(key);
    if (!m) continue;
    const model = m[1];
    push(key, `Weekly · ${model.charAt(0).toUpperCase()}${model.slice(1)}`, 2, json[key]);
  }
  let overage = null;
  if (json.extra_usage && typeof json.extra_usage === 'object') {
    overage = json.extra_usage.is_enabled ? 'enabled' : 'disabled';
  }
  bars.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return { bars, overage, raw: json };
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

  const res = await fetchUsage(cred.accessToken);
  if (res.error) {
    return { available: false, error: res.error, bars: [], source: cred.source };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      available: false,
      error: 'token rejected (' + res.status + ') — run any Claude Code command to refresh it',
      bars: [],
      source: cred.source,
    };
  }
  if (res.status === 429) {
    return {
      available: false,
      error: 'rate limited (429) — usage endpoint polled too fast; backing off',
      bars: [],
      source: cred.source,
    };
  }
  let json;
  try {
    json = JSON.parse(res.body);
  } catch (_) {
    return { available: false, error: 'usage endpoint returned non-JSON (status ' + res.status + ')', bars: [], source: cred.source };
  }

  const { bars, overage, raw } = usageToBars(json);
  return {
    available: bars.length > 0,
    error: bars.length ? null : 'usage endpoint returned no windows',
    bars,
    overage,
    raw,
    plan: cred.plan || null,
    source: cred.source,
    status: res.status,
    updatedAt: new Date().toISOString(),
  };
}

// ---- 60s cache --------------------------------------------------------------

let cache = { value: null, at: 0, inflight: null };
// The /api/oauth/usage endpoint is aggressively rate-limited; ~180s is the safe
// floor. We enforce that minimum even if a smaller value is configured.
const TTL_MS = Math.max(180_000, Number(process.env.CLAUDE_STATS_LIMITS_TTL_MS) || 180_000);

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
  usageToBars,
  headersToBars,
  parseReset,
  classify,
  extractToken,
  findCredential,
};
