'use strict';

/**
 * Tests for discovery-pipeline.js:
 * - _stripHtml: removes tags, decodes entities
 * - _detectSignals: detects operatingPeriod, openingHours, exceptionalHours,
 *                   location, price, provider; returns detected + examples
 * - Auth guards: GET requires researcher+, POST requires editor+
 * - Dry-run: only reads discoverySources and writes discoveryPipelineRuns
 */

const mockStore = {};

function mockGet(path) {
  if (!path) return mockStore;
  return path.split('/').reduce(
    (cur, k) => (cur != null && cur[k] !== undefined ? cur[k] : undefined),
    mockStore,
  );
}
function mockSet(path, val) {
  const parts = path.split('/');
  let cur = mockStore;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  if (val === null) delete cur[parts[parts.length - 1]];
  else              cur[parts[parts.length - 1]] = val;
}

jest.mock('../netlify/functions/_studio-shared', () => {
  function _get(path) {
    if (!path) return mockStore;
    return path.split('/').reduce(
      (cur, k) => (cur != null && cur[k] !== undefined ? cur[k] : undefined),
      mockStore,
    );
  }
  function _set(path, val) {
    const parts = path.split('/');
    let cur = mockStore;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    if (val === null) delete cur[parts[parts.length - 1]];
    else              cur[parts[parts.length - 1]] = val;
  }

  return {
    initAdmin: () => ({
      database: () => ({
        ref: (path) => ({
          once: async (eventType, callback) => {
            const val = _get(path ?? '');
            const snap = {
              exists: () => val !== undefined && val !== null,
              val:    () => val ?? null,
              forEach: (fn) => {
                if (val && typeof val === 'object') {
                  for (const [k, v] of Object.entries(val)) {
                    fn({ key: k, val: () => v });
                  }
                }
              },
            };
            return snap;
          },
          update: jest.fn(async (updates) => {
            for (const [k, v] of Object.entries(updates)) _set(k.replace(/^\//, ''), v);
          }),
          orderByChild: () => ({
            equalTo: (val) => ({
              once: async () => {
                const all = _get(path ?? '');
                const filtered = {};
                if (all && typeof all === 'object') {
                  for (const [k, v] of Object.entries(all)) {
                    if (v && v.city === val) filtered[k] = v;
                  }
                }
                return {
                  forEach: (fn) => {
                    for (const [k, v] of Object.entries(filtered)) fn({ key: k, val: () => v });
                  },
                };
              },
            }),
            limitToLast: (n) => ({
              once: async () => {
                const all = _get(path ?? '');
                const entries = all && typeof all === 'object' ? Object.entries(all) : [];
                const last = entries.slice(-n);
                return {
                  forEach: (fn) => {
                    for (const [k, v] of last) fn({ key: k, val: () => v });
                  },
                };
              },
            }),
          }),
        }),
      }),
    }),
    verifyStudioToken: jest.fn(),
    json: (status, body) => ({ statusCode: status, _body: body, body: JSON.stringify(body) }),
    makeId: (prefix) => `${prefix}_test`,
  };
});

const { handler, _stripHtml, _detectSignals } = require('../netlify/functions/discovery-pipeline');
const shared = require('../netlify/functions/_studio-shared');

function makeEvent(method, body, authHeader = 'Bearer tok') {
  return {
    httpMethod: method,
    headers: { authorization: authHeader },
    body: body ? JSON.stringify(body) : null,
    queryStringParameters: {},
  };
}

beforeEach(() => {
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  shared.verifyStudioToken.mockReset();
});

// ── _stripHtml ────────────────────────────────────────────────────────────────
describe('_stripHtml', () => {
  test('removes HTML tags', () => {
    const result = _stripHtml('<h1>Title</h1><p>Text</p>');
    expect(result).not.toContain('<');
    expect(result).toContain('Title');
    expect(result).toContain('Text');
  });

  test('removes script and style blocks entirely', () => {
    const result = _stripHtml('<script>alert("xss")</script><style>.a{color:red}</style>Hello');
    expect(result).not.toContain('alert');
    expect(result).not.toContain('color:red');
    expect(result).toContain('Hello');
  });

  test('decodes common HTML entities', () => {
    const result = _stripHtml('&amp; &lt;tag&gt; &nbsp;text');
    expect(result).toContain('&');
    expect(result).toContain('text');
  });

  test('collapses whitespace', () => {
    const result = _stripHtml('a   b\n\n\tc');
    expect(result).toBe('a b c');
  });
});

// ── _detectSignals ────────────────────────────────────────────────────────────
describe('_detectSignals', () => {
  test('detects operatingPeriod from German date range', () => {
    const r = _detectSignals('Weihnachtsmarkt vom 21.11. bis 23.12.2024 am Dom');
    expect(r.operatingPeriod.detected).toBe(true);
    expect(r.operatingPeriod.examples.length).toBeGreaterThan(0);
  });

  test('detects openingHours from time ranges', () => {
    const r = _detectSignals('Öffnungszeiten: Mo-Fr 11:00 - 21:00 Uhr, Sa 10:00 - 22:00 Uhr');
    expect(r.openingHours.detected).toBe(true);
  });

  test('detects exceptionalHours from Heiligabend', () => {
    const r = _detectSignals('Heiligabend 24.12. Sonderöffnungszeiten 10:00 - 14:00 Uhr');
    expect(r.exceptionalHours.detected).toBe(true);
  });

  test('detects exceptionalHours from 25. Dezember', () => {
    const r = _detectSignals('Am 25. Dezember geschlossen.');
    expect(r.exceptionalHours.detected).toBe(true);
  });

  test('detects location from German street patterns', () => {
    const r = _detectSignals('Roncalliplatz, 50667 Köln, direkt am Dom');
    expect(r.location.detected).toBe(true);
  });

  test('detects price from Euro symbol', () => {
    const r = _detectSignals('Eintritt frei. VIP-Ticket: 15 €');
    expect(r.price.detected).toBe(true);
  });

  test('detects provider from Impressum keyword', () => {
    const r = _detectSignals('Veranstalter: Köln Tourismus GmbH. Impressum');
    expect(r.provider.detected).toBe(true);
  });

  test('returns no detections for empty text', () => {
    const r = _detectSignals('');
    for (const v of Object.values(r)) expect(v.detected).toBe(false);
  });

  test('returns exactly the signal keys', () => {
    const r = _detectSignals('test');
    expect(Object.keys(r).sort()).toEqual([
      'exceptionalHours', 'location', 'openingHours', 'operatingPeriod', 'price', 'provider',
    ]);
  });

  test('examples are strings capped at 120 chars', () => {
    const longText = 'Öffnungszeiten: ' + 'Mo 11:00 - 21:00 Uhr '.repeat(20);
    const r = _detectSignals(longText);
    for (const ex of r.openingHours.examples) {
      expect(typeof ex).toBe('string');
      expect(ex.length).toBeLessThanOrEqual(120);
    }
  });
});

// ── Auth guards ───────────────────────────────────────────────────────────────
describe('handler auth guards', () => {
  test('GET returns 405 for non-GET/POST', async () => {
    const res = await handler({ httpMethod: 'DELETE', headers: {}, body: null });
    expect(res.statusCode).toBe(405);
  });

  test('GET returns 403 when not authenticated', async () => {
    shared.verifyStudioToken.mockResolvedValue(null);
    const res = await handler(makeEvent('GET', null));
    expect(res.statusCode).toBe(403);
  });

  test('POST returns 403 for researcher role (editor+ required)', async () => {
    shared.verifyStudioToken.mockResolvedValue(null);
    const res = await handler(makeEvent('POST', { city: 'Köln' }));
    expect(res.statusCode).toBe(403);
  });

  test('GET returns 200 for researcher', async () => {
    shared.verifyStudioToken.mockResolvedValue({ uid: 'u1', studioRole: 'researcher' });
    const res = await handler(makeEvent('GET', null));
    expect(res.statusCode).toBe(200);
  });

  test('POST returns 200 for editor with no sources', async () => {
    shared.verifyStudioToken.mockResolvedValue({ uid: 'ed', studioRole: 'editor' });
    const res = await handler(makeEvent('POST', { city: 'Köln' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.report.mode).toBe('dry-run');
  });

  test('POST returns 400 for unsupported city', async () => {
    shared.verifyStudioToken.mockResolvedValue({ uid: 'ed', studioRole: 'editor' });
    const res = await handler(makeEvent('POST', { city: 'Berlin' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/City not supported/);
  });
});

// ── Dry-run: writes only to discoveryPipelineRuns ────────────────────────────
describe('dry-run pipeline', () => {
  const editor = { uid: 'ed', studioRole: 'editor', email: 'ed@test.com' };

  test('writes run report to discoveryPipelineRuns/', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    await handler(makeEvent('POST', { city: 'Köln' }));
    const run = mockGet('discoveryPipelineRuns/run_test');
    expect(run).toBeDefined();
    expect(run.mode).toBe('dry-run');
    expect(run.city).toBe('Köln');
  });

  test('does NOT write to suggestions/', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    await handler(makeEvent('POST', { city: 'Köln' }));
    expect(mockGet('suggestions')).toBeUndefined();
  });

  test('does NOT write to activities/', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    await handler(makeEvent('POST', { city: 'Köln' }));
    expect(mockGet('activities')).toBeUndefined();
  });

  test('report contains enforced limits', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    const res = await handler(makeEvent('POST', { city: 'Köln' }));
    const { report } = JSON.parse(res.body);
    expect(report.limits.maxSources).toBe(5);
    expect(report.limits.maxSuggestions).toBe(20);
    expect(report.limits.maxLlmCalls).toBe(10);
  });

  test('report includes triggeredBy actor uid', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    const res = await handler(makeEvent('POST', { city: 'Köln' }));
    const { report } = JSON.parse(res.body);
    expect(report.triggeredBy).toBe('ed');
  });

  test('GET returns list of runs from discoveryPipelineRuns/', async () => {
    mockSet('discoveryPipelineRuns/run_1', { city: 'Köln', mode: 'dry-run', startedAt: 1000 });
    mockSet('discoveryPipelineRuns/run_2', { city: 'Köln', mode: 'dry-run', startedAt: 2000 });
    shared.verifyStudioToken.mockResolvedValue({ uid: 'r', studioRole: 'researcher' });
    const res = await handler(makeEvent('GET', null));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.runs).toBeDefined();
  });
});
