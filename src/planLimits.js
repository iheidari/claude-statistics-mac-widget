'use strict';

// Live "Plan usage limits" (the /usage panel: current-session + weekly bars).
//
// IMPORTANT: this uses an UNDOCUMENTED mechanism. Anthropic exposes no official
// personal-usage API, so — like the community tools (Claude-Usage-Tracker,
// Claude-Code-Usage-Monitor) — we read the OAuth token Claude Code stored and
// GET the same `/api/oauth/usage` endpoint the `/usage` panel uses, which returns
// per-window utilization percentages. It can break if Anthropic changes that
// endpoint. If no token is found we make NO network call and simply report the
// feature as unavailable.

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

// ---- Usage endpoint ---------------------------------------------------------

// Turn a reset value into { resetAt(ISO), resetInSeconds }. The endpoint returns
// RFC3339 today, but the source is undocumented — stay defensive and also accept
// numeric epoch (ms/seconds) and seconds-from-now, whether typed as number or string.
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
  const rawReset = w.resets_at || w.resetsAt || null;
  if (usedPercent == null && !rawReset) return null;
  const { resetAt, resetInSeconds } = parseReset(rawReset);
  // `order` is a sort key only — stripped before serialization (see usageToBars).
  return { id, label, usedPercent, resetAt, resetInSeconds, order };
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
  // `overage` reflects whether extra/overage usage is turned on for the account
  // ('enabled' | 'disabled'). NOTE: this is not the old header-path meaning
  // ('allowed' | 'rejected', i.e. whether a request was blocked) — the value now
  // describes a setting, not a per-request outcome.
  let overage = null;
  if (json.extra_usage && typeof json.extra_usage === 'object') {
    overage = json.extra_usage.is_enabled ? 'enabled' : 'disabled';
  }
  bars.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  // `order` is internal to the sort above — drop it so it never leaks into the
  // /stats JSON contract the widget consumes.
  for (const b of bars) delete b.order;
  return { bars, overage };
}

// Perform one live fetch. Returns a normalized planLimits object. `findCred` and
// `fetchUsageFn` are injected so the rotation-retry path and failure classification
// can be tested without a real keychain or network (see test/run.js).
async function runFetch(findCred, fetchUsageFn) {
  if (process.env.CLAUDE_STATS_PLAN_LIMITS === 'off') {
    return { available: false, error: 'disabled', bars: [] };
  }
  let cred = findCred();
  if (!cred) {
    return { available: false, error: 'no Claude Code credential found', bars: [] };
  }

  let res = await fetchUsageFn(cred.accessToken);

  // Rotation race: Claude Code owns the keychain credential and rotates the OAuth
  // token on refresh, which invalidates the PREVIOUS access token server-side
  // immediately — before its expiresAt. If we happened to read a token that was
  // just superseded, the endpoint 401s even though the credential looks valid.
  // Re-read the keychain and retry ONCE, but only if the token actually changed,
  // so a genuinely-bad token can't spin the endpoint.
  if (res.status === 401 || res.status === 403) {
    const fresh = findCred();
    if (fresh && fresh.accessToken && fresh.accessToken !== cred.accessToken) {
      cred = fresh;
      res = await fetchUsageFn(cred.accessToken);
    }
  }

  // Carry the HTTP status onto failures too (the success path already does) so the
  // cache can classify backoff structurally instead of re-parsing the error prose.
  const fail = (error, status = null) => ({ available: false, error, bars: [], source: cred.source, status });
  if (res.error) return fail(res.error);
  if (res.status === 401 || res.status === 403) {
    return fail(`token rejected (${res.status}) — run any Claude Code command to refresh it`, res.status);
  }
  if (res.status === 429) {
    return fail('rate limited (429) — usage endpoint polled too fast; backing off', res.status);
  }
  let json;
  try {
    json = JSON.parse(res.body);
  } catch (_) {
    return fail(`usage endpoint returned non-JSON (status ${res.status})`, res.status);
  }

  const { bars, overage } = usageToBars(json);
  return {
    available: bars.length > 0,
    error: bars.length ? null : 'usage endpoint returned no windows',
    bars,
    overage,
    plan: cred.plan || null,
    source: cred.source,
    status: res.status,
    updatedAt: new Date().toISOString(),
  };
}

// Live fetch against the real keychain + network.
async function fetchPlanLimits() {
  return runFetch(findCredential, fetchUsage);
}

// ---- Adaptive cache ---------------------------------------------------------

let cache = { value: null, at: 0, inflight: null };
// Success TTL: the /api/oauth/usage endpoint is aggressively rate-limited; ~180s
// is the safe floor. We enforce that minimum even if a smaller value is configured.
const TTL_MS = Math.max(180_000, Number(process.env.CLAUDE_STATS_LIMITS_TTL_MS) || 180_000);

// Error TTL: a transient failure (a token-rotation 401/403, a timeout, or "no
// credential yet") must NOT be pinned for the full 180s — otherwise one blip keeps
// the widget reporting an error for minutes after the keychain already holds a
// working token. Re-checking soon is cheap for these. Unlike TTL_MS (frozen at load),
// this re-reads the env each call so a test can flip CLAUDE_STATS_LIMITS_ERROR_TTL_MS.
function errorTtlMs() {
  const v = Number(process.env.CLAUDE_STATS_LIMITS_ERROR_TTL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 20_000;
}

// How long a resolved value stays fresh: successes get the full window, and so does
// a 429 (it means "you polled too fast" — keep backing off). Every other failure is
// treated as transient and expires quickly. Derived from the value, not stored.
function ttlFor(value) {
  if (!value) return 0;
  if (value.available || value.status === 429) return TTL_MS;
  return errorTtlMs();
}

// `_fetch` is injectable so the adaptive-TTL behavior can be tested without a real
// keychain or network (see test/run.js).
async function getPlanLimitsCached(_fetch = fetchPlanLimits) {
  const now = Date.now();
  if (cache.value && now - cache.at < ttlFor(cache.value)) return cache.value;
  if (cache.inflight) return cache.inflight;
  cache.inflight = _fetch()
    .then((value) => {
      cache = { value, at: Date.now(), inflight: null };
      return value;
    })
    // fetchPlanLimits catches all its own failures and always resolves a
    // normalized object, so this .catch is effectively unreachable. It's kept
    // deliberately to mirror the shared memoization shape in parser/index.js
    // (see CLAUDE.md "Caching") — do not remove it as dead code. The value has no
    // `status`, so ttlFor treats it as a short-lived error — it never pins the cache.
    .catch((err) => {
      const value = { available: false, error: String((err && err.message) || err), bars: [] };
      cache = { value, at: Date.now(), inflight: null };
      return value;
    });
  return cache.inflight;
}

// Test hook: drop the memoized value so cache-behavior tests start clean.
function _resetCache() {
  cache = { value: null, at: 0, inflight: null };
}

module.exports = {
  getPlanLimitsCached,
  fetchPlanLimits,
  // exported for testing:
  runFetch,
  ttlFor,
  _resetCache,
  usageToBars,
  parseReset,
  extractToken,
  findCredential,
};
