'use strict';

const http = require('http');
const { PORT, HOST } = require('./config');
const { getStatsCached } = require('./parser');
const { TelemetryStore } = require('./telemetry/otlpReceiver');
const { getPlanLimitsCached } = require('./planLimits');

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // The Übersicht widget uses a shell `curl`, but allow browser/fetch clients too.
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limitBytes = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createServer() {
  const telemetry = new TelemetryStore();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    try {
      // --- OTLP metrics ingestion (from Claude Code's OTEL exporter) ---
      if (req.method === 'POST' && pathname === '/v1/metrics') {
        const raw = await readBody(req);
        let payload = null;
        try {
          payload = JSON.parse(raw.toString('utf8'));
        } catch (_) {
          // Binary protobuf or malformed JSON — we only accept http/json.
          sendJson(res, 415, {
            error: 'Only OTLP http/json is supported. Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json',
          });
          return;
        }
        telemetry.ingest(payload);
        sendJson(res, 200, { partialSuccess: {} }); // OTLP success shape
        return;
      }

      // OTLP also probes /v1/traces and /v1/logs; accept and ignore them.
      if (req.method === 'POST' && (pathname === '/v1/traces' || pathname === '/v1/logs')) {
        await readBody(req).catch(() => {});
        sendJson(res, 200, { partialSuccess: {} });
        return;
      }

      // --- Combined stats: parsed files + live telemetry + plan limits ---
      if (req.method === 'GET' && pathname === '/stats') {
        const [fileStats, planLimits] = await Promise.all([getStatsCached(), getPlanLimitsCached()]);
        sendJson(res, 200, { ...fileStats, telemetry: telemetry.snapshot(), planLimits });
        return;
      }

      // Live plan usage limits (session + weekly bars). Undocumented source.
      if (req.method === 'GET' && pathname === '/limits') {
        const planLimits = await getPlanLimitsCached();
        sendJson(res, 200, planLimits);
        return;
      }

      if (req.method === 'GET' && pathname === '/telemetry') {
        sendJson(res, 200, { snapshot: telemetry.snapshot(), series: telemetry.dump() });
        return;
      }

      if (req.method === 'GET' && (pathname === '/health' || pathname === '/')) {
        sendJson(res, 200, {
          ok: true,
          service: 'claude-statistics-mac-widget',
          endpoints: ['/stats', '/telemetry', '/limits', '/health', 'POST /v1/metrics'],
          telemetryPayloads: telemetry.snapshot().payloads,
        });
        return;
      }

      sendJson(res, 404, { error: 'not found', path: pathname });
    } catch (err) {
      sendJson(res, 500, { error: String((err && err.message) || err) });
    }
  });

  return { server, telemetry };
}

function start({ port = PORT, host = HOST } = {}) {
  const { server, telemetry } = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const bound = server.address().port; // resolves port 0 to the actual assignment
      resolve({ server, telemetry, port: bound, host });
    });
  });
}

module.exports = { createServer, start };
