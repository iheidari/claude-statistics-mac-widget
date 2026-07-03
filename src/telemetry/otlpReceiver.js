'use strict';

// Minimal receiver for OTLP/HTTP JSON metrics (OTEL_EXPORTER_OTLP_PROTOCOL=http/json).
// Claude Code emits metrics like claude_code.token.usage, claude_code.cost.usage,
// claude_code.session.count, claude_code.active_time.total, etc. We decode the
// JSON payload, flatten each data point, and keep the latest value per series.
//
// We deliberately do NOT implement gRPC (4317) or protobuf (4318 binary) — those
// need heavy dependencies. Point Claude Code at http/json (see scripts/enable-telemetry.sh).

function attrValue(v) {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('boolValue' in v) return v.boolValue;
  if ('arrayValue' in v && v.arrayValue.values) return v.arrayValue.values.map(attrValue);
  return null;
}

function attrsToObject(attributes) {
  const out = {};
  if (Array.isArray(attributes)) {
    for (const a of attributes) {
      if (a && a.key) out[a.key] = attrValue(a.value);
    }
  }
  return out;
}

function pointValue(dp) {
  if ('asInt' in dp) return Number(dp.asInt);
  if ('asDouble' in dp) return dp.asDouble;
  return 0;
}

// Series key = metric name + sorted attribute pairs, so we can accumulate/replace
// per (metric, type) — e.g. token.usage{type=input} vs token.usage{type=output}.
function seriesKey(name, attrs) {
  const parts = Object.keys(attrs)
    .sort()
    .map((k) => `${k}=${attrs[k]}`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
}

class TelemetryStore {
  constructor() {
    this.series = new Map(); // key -> { name, attrs, value, isMonotonic, updatedAt }
    this.lastReceivedAt = null;
    this.payloadCount = 0;
  }

  ingest(payload) {
    if (!payload || !Array.isArray(payload.resourceMetrics)) return;
    this.payloadCount += 1;
    this.lastReceivedAt = new Date().toISOString();

    for (const rm of payload.resourceMetrics) {
      const scopes = rm.scopeMetrics || rm.instrumentationLibraryMetrics || [];
      for (const sm of scopes) {
        for (const metric of sm.metrics || []) {
          const name = metric.name;
          const data = metric.sum || metric.gauge || metric.histogram;
          if (!data || !Array.isArray(data.dataPoints)) continue;
          const isMonotonic = metric.sum ? !!metric.sum.isMonotonic : false;

          for (const dp of data.dataPoints) {
            const attrs = attrsToObject(dp.attributes);
            const key = seriesKey(name, attrs);
            const value = pointValue(dp);
            // Cumulative sums send running totals; replacing with the latest is correct.
            this.series.set(key, {
              name,
              attrs,
              value,
              isMonotonic,
              updatedAt: new Date().toISOString(),
            });
          }
        }
      }
    }
  }

  // Roll the raw series up into the fields the widget cares about.
  snapshot() {
    const sum = (name, attrFilter) => {
      let total = 0;
      let found = false;
      for (const s of this.series.values()) {
        if (s.name !== name) continue;
        if (attrFilter && !attrFilter(s.attrs)) continue;
        total += s.value;
        found = true;
      }
      return found ? total : null;
    };

    const tokenByType = (type) => sum('claude_code.token.usage', (a) => a.type === type);

    const snap = {
      available: this.payloadCount > 0,
      lastReceivedAt: this.lastReceivedAt,
      payloads: this.payloadCount,
      sessionCount: sum('claude_code.session.count'),
      costUsage: sum('claude_code.cost.usage'),
      linesOfCode: sum('claude_code.lines_of_code.count'),
      commits: sum('claude_code.commit.count'),
      pullRequests: sum('claude_code.pull_request.count'),
      activeTimeSeconds: sum('claude_code.active_time.total'),
      tokens: {
        input: tokenByType('input'),
        output: tokenByType('output'),
        cacheRead: tokenByType('cacheRead'),
        cacheCreation: tokenByType('cacheCreation'),
        total: sum('claude_code.token.usage'),
      },
    };
    return snap;
  }

  // Everything, for debugging.
  dump() {
    return Array.from(this.series.values());
  }
}

module.exports = { TelemetryStore };
