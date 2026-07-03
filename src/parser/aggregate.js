'use strict';

const { costForUsage } = require('../pricing');

// Pull a usage object out of a session record regardless of where the schema
// happens to place it. Returns normalized { input, output, cacheCreation, cacheRead }.
function extractUsage(record) {
  const u =
    (record.message && record.message.usage) ||
    record.usage ||
    (record.data && record.data.usage) ||
    null;
  if (!u || typeof u !== 'object') return null;
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheCreation: num(u.cache_creation_input_tokens),
    cacheRead: num(u.cache_read_input_tokens),
  };
}

function extractModel(record) {
  return (
    (record.message && record.message.model) ||
    record.model ||
    (record.data && record.data.model) ||
    null
  );
}

function extractTimestamp(record) {
  const t = record.timestamp || (record.message && record.message.timestamp) || null;
  if (!t) return null;
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

function extractRole(record) {
  if (record.type === 'user' || record.type === 'assistant') return record.type;
  if (record.message && record.message.role) return record.message.role;
  return record.role || null;
}

function dayKey(date) {
  // Local calendar day, YYYY-MM-DD.
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Accumulates statistics across every record from every session file.
class Aggregator {
  constructor() {
    this.sessionIds = new Set();
    this.projects = new Set();
    this.userMessages = 0;
    this.assistantMessages = 0;
    this.totalRecords = 0;
    this.tokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    this.cost = 0;
    this.byModel = new Map(); // model -> { messages, tokens{...}, cost }
    this.perDay = new Map(); // dayKey -> message count
    this.perHour = new Array(24).fill(0); // local hour -> activity count
    this.firstActivity = null;
    this.lastActivity = null;
  }

  add(record, sessionIdFromFile) {
    this.totalRecords += 1;

    const sid = record.sessionId || record.session_id || sessionIdFromFile;
    if (sid) this.sessionIds.add(sid);
    if (record.cwd) this.projects.add(record.cwd);

    const role = extractRole(record);
    if (role === 'user') this.userMessages += 1;
    else if (role === 'assistant') this.assistantMessages += 1;

    const ts = extractTimestamp(record);
    if (ts) {
      if (!this.firstActivity || ts < this.firstActivity) this.firstActivity = ts;
      if (!this.lastActivity || ts > this.lastActivity) this.lastActivity = ts;
      const key = dayKey(ts);
      this.perDay.set(key, (this.perDay.get(key) || 0) + 1);
      this.perHour[ts.getHours()] += 1;
    }

    const usage = extractUsage(record);
    const model = extractModel(record);
    if (usage) {
      this.tokens.input += usage.input;
      this.tokens.output += usage.output;
      this.tokens.cacheCreation += usage.cacheCreation;
      this.tokens.cacheRead += usage.cacheRead;
      const c = costForUsage(model, usage);
      this.cost += c;

      if (model) {
        let entry = this.byModel.get(model);
        if (!entry) {
          entry = { messages: 0, tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }, cost: 0 };
          this.byModel.set(model, entry);
        }
        entry.messages += 1;
        entry.tokens.input += usage.input;
        entry.tokens.output += usage.output;
        entry.tokens.cacheCreation += usage.cacheCreation;
        entry.tokens.cacheRead += usage.cacheRead;
        entry.cost += c;
      }
    }
  }

  // Compute streaks from the set of active calendar days.
  _streaks() {
    const days = Array.from(this.perDay.keys()).sort();
    if (days.length === 0) return { current: 0, longest: 0, activeDays: 0 };

    const toNum = (k) => {
      const [y, m, d] = k.split('-').map(Number);
      return Date.UTC(y, m - 1, d) / 86_400_000; // day index
    };

    let longest = 1;
    let run = 1;
    for (let i = 1; i < days.length; i++) {
      if (toNum(days[i]) - toNum(days[i - 1]) === 1) {
        run += 1;
        if (run > longest) longest = run;
      } else {
        run = 1;
      }
    }

    // Current streak: consecutive days ending today or yesterday.
    const todayIdx = Math.floor(Date.now() / 86_400_000);
    const lastIdx = toNum(days[days.length - 1]);
    let current = 0;
    if (todayIdx - lastIdx <= 1) {
      current = 1;
      for (let i = days.length - 1; i > 0; i--) {
        if (toNum(days[i]) - toNum(days[i - 1]) === 1) current += 1;
        else break;
      }
    }

    return { current, longest, activeDays: days.length };
  }

  _peakHour() {
    let peak = 0;
    let max = -1;
    for (let h = 0; h < 24; h++) {
      if (this.perHour[h] > max) {
        max = this.perHour[h];
        peak = h;
      }
    }
    return max <= 0 ? null : peak;
  }

  _favoriteModel() {
    let fav = null;
    let max = -1;
    for (const [model, entry] of this.byModel) {
      if (entry.messages > max) {
        max = entry.messages;
        fav = model;
      }
    }
    return fav;
  }

  finalize() {
    const streaks = this._streaks();
    const totalTokens =
      this.tokens.input + this.tokens.output + this.tokens.cacheCreation + this.tokens.cacheRead;

    const byModel = {};
    for (const [model, entry] of this.byModel) {
      byModel[model] = {
        messages: entry.messages,
        tokens: { ...entry.tokens, total: entry.tokens.input + entry.tokens.output + entry.tokens.cacheCreation + entry.tokens.cacheRead },
        cost: round(entry.cost),
      };
    }

    const perDay = {};
    for (const [k, v] of Array.from(this.perDay.entries()).sort()) perDay[k] = v;

    return {
      sessions: this.sessionIds.size,
      projects: this.projects.size,
      messages: this.userMessages + this.assistantMessages,
      userMessages: this.userMessages,
      assistantMessages: this.assistantMessages,
      activeDays: streaks.activeDays,
      currentStreak: streaks.current,
      longestStreak: streaks.longest,
      peakHour: this._peakHour(),
      favoriteModel: this._favoriteModel(),
      tokens: { ...this.tokens, total: totalTokens },
      cost: round(this.cost),
      byModel,
      perDay,
      perHour: this.perHour.slice(),
      firstActivity: this.firstActivity ? this.firstActivity.toISOString() : null,
      lastActivity: this.lastActivity ? this.lastActivity.toISOString() : null,
    };
  }
}

function round(n) {
  return Math.round((n + Number.EPSILON) * 1e4) / 1e4;
}

module.exports = { Aggregator, extractUsage, extractModel, extractTimestamp, extractRole, dayKey };
