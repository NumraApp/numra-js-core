import http from 'node:http';

/* A stand-in for api.numra.ma that answers exactly what openapi.yaml says it
   will. Tests run against a real socket rather than a stubbed fetch, so the
   client's timeout, abort and retry paths are actually exercised — a stubbed
   fetch would let a broken AbortController pass. */

export function startMockServer(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const call = { path: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
      calls.push(call);
      const out = handler(call, calls.length);
      if (out === 'HANG') return; // never answer, for timeout tests
      res.writeHead(out.status ?? 200, {
        'Content-Type': 'application/json',
        ...(out.headers ?? {}),
      });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        close: () => new Promise((r) => {
          /* Node's fetch (undici) keeps sockets alive, so a bare
             server.close() waits for connections that will never drain and
             the test process hangs instead of exiting. */
          server.closeAllConnections?.();
          server.close(r);
        }),
      });
    });
  });
}

/** A complete lookup response, matching the LookupResponse schema. */
export const LOOKUP_OK = {
  ok: true,
  phone: '+212600000000',
  country: 'MA',
  carrier: { code: 'IAM', label: 'Maroc Telecom' },
  verdict: 'RATED',
  verdict_source: 'events',
  risk_score: 72,
  risk_score_raw: 68.4,
  risk_level: 'HIGH',
  trust_score: 28,
  confidence: 61,
  is_rated: true,
  total_events: 9,
  customer_style: {
    code: 'reactive', label: 'Reactive', icon: '⚡',
    color: '#F26D6D', risk_sensitivity: 1.2,
  },
  is_blacklisted: false,
  blacklisted_reason: null,
  last_risk_update_at: '2026-09-01T10:00:00.000Z',
  cache_ttl_seconds: 3600,
  timeline: null,
};
