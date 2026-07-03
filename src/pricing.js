'use strict';

// Approximate public list pricing in USD per 1,000,000 tokens.
// Keys are matched as substrings of the model id reported in the JSONL files,
// so date suffixes (`-20260101`) and provider prefixes (`anthropic.`) still match.
// Longest matching key wins. Prices are a best effort and can be overridden by
// dropping a `pricing.json` next to this file (same shape as PRICING below).
const PRICING = {
  // Current models
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },

  // Legacy / retired models (historical list pricing)
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-3-opus': { input: 15, output: 75 },
  'claude-3-7-sonnet': { input: 3, output: 15 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
};

// Cache tokens are billed relative to the model's input price.
const CACHE_WRITE_MULTIPLIER = 1.25; // 5-minute ephemeral write
const CACHE_READ_MULTIPLIER = 0.1;

let overrides = null;
try {
  // Optional user override file (not required).
  overrides = require('./pricing.json');
} catch (_) {
  overrides = null;
}

function tableFor() {
  return overrides && typeof overrides === 'object' ? { ...PRICING, ...overrides } : PRICING;
}

// Find the price entry whose key is the longest substring of `model`.
function priceForModel(model) {
  if (!model) return null;
  const table = tableFor();
  const id = String(model).toLowerCase();
  let best = null;
  let bestLen = 0;
  for (const key of Object.keys(table)) {
    if (id.includes(key) && key.length > bestLen) {
      best = table[key];
      bestLen = key.length;
    }
  }
  return best;
}

// Estimate cost (USD) for one usage record on a given model.
// usage = { input, output, cacheCreation, cacheRead }
function costForUsage(model, usage) {
  const price = priceForModel(model);
  if (!price) return 0;
  const perToken = {
    input: price.input / 1e6,
    output: price.output / 1e6,
    cacheWrite: (price.input * CACHE_WRITE_MULTIPLIER) / 1e6,
    cacheRead: (price.input * CACHE_READ_MULTIPLIER) / 1e6,
  };
  return (
    (usage.input || 0) * perToken.input +
    (usage.output || 0) * perToken.output +
    (usage.cacheCreation || 0) * perToken.cacheWrite +
    (usage.cacheRead || 0) * perToken.cacheRead
  );
}

module.exports = {
  PRICING,
  CACHE_WRITE_MULTIPLIER,
  CACHE_READ_MULTIPLIER,
  priceForModel,
  costForUsage,
  isKnownModel: (m) => priceForModel(m) !== null,
};
