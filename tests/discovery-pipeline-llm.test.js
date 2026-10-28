'use strict';

/**
 * LLM integration tests for discovery-pipeline.js:
 * - _validateActivity: field sanitisation, missing-field tracking, invalid inputs
 * - _buildExtractionPrompt: prompt shape and constraints
 * - _callAnthropicAPI: mocked fetch — success, HTTP error, JSON parse error, timeout
 * - handler live mode: deduplication, draft writing, cost tracking, limits
 *
 * No real API calls are made. global.fetch is mocked throughout.
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
          once: async () => {
            const val = _get(path ?? '');
            return {
              exists: () => val !== undefined && val !== null,
              val:    () => val ?? null,
              forEach: (fn) => {
                if (val && typeof val === 'object') {
                  for (const [k, v] of Object.entries(val)) fn({ key: k, val: () => v });
                }
              },
            };
          },
          update: jest.fn(async (updates) => {
            for (const [k, v] of Object.entries(updates)) _set(k.replace(/^\//, ''), v);
          }),
          orderByChild: () => ({
            equalTo: (filterVal) => ({
              once: async () => {
                const all = _get(path ?? '');
                const filtered = {};
                if (all && typeof all === 'object') {
                  for (const [k, v] of Object.entries(all)) {
                    if (v && v.city === filterVal) filtered[k] = v;
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
                return { forEach: (fn) => { for (const [k, v] of last) fn({ key: k, val: () => v }); } };
              },
            }),
          }),
        }),
      }),
    }),
    verifyStudioToken: jest.fn(),
    json: (status, body) => ({ statusCode: status, _body: body, body: JSON.stringify(body) }),
    makeId: jest.fn().mockImplementation((prefix) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`),
    duplicateHash: jest.fn().mockImplementation((city, category, title) =>
      `${city}:${category}:${title.toLowerCase().replace(/\s+/g, '-')}`
    ),
  };
});

const {
  handler,
  _validateActivity,
  _buildExtractionPrompt,
  _callAnthropicAPI,
} = require('../netlify/functions/discovery-pipeline');
const shared = require('../netlify/functions/_studio-shared');

function makeEvent(method, body, authHeader = 'Bearer tok') {
  return {
    httpMethod: method,
    headers: { authorization: authHeader },
    body: body ? JSON.stringify(body) : null,
    queryStringParameters: {},
  };
}

// minimal valid raw activity from LLM
const VALID_RAW = {
  title: 'Kölner Weihnachtsmarkt',
  description: 'Traditioneller Weihnachtsmarkt am Kölner Dom mit über 160 Ständen.',
  category: 'market',
  tagline: 'Advent am Dom',
  eyebrow: 'Winter 2024',
  location: { address: 'Roncalliplatz, 50667 Köln' },
  providerName: 'Köln Tourismus GmbH',
  website: 'https://koeln-tourismus.de/weihnachtsmarkt',
  price: 'kostenlos',
  operatingPeriod: { from: '2024-11-25', to: '2024-12-23' },
  openingHours: 'täglich 11:00 – 22:00 Uhr',
  exceptionalHours: 'Heiligabend 10:00 – 14:00 Uhr',
  sourceAttribution: 'Köln Tourismus',
};

// helper: mock a successful Anthropic API response
function mockAnthropicSuccess(activities, inputTokens = 500, outputTokens = 400) {
  const content = JSON.stringify({ activities });
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: content }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }),
  });
}

// helper: mock an HTTP-error Anthropic response
function mockAnthropicHttpError(status, body = '') {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => body,
  });
}

// helper: mock a source fetch returning fetchable text
function mockSourceFetch(text = 'Weihnachtsmarkt 21.11. bis 23.12.2024 Roncalliplatz') {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  let called = false;
  global.fetch = jest.fn().mockImplementation((url) => {
    if (url.includes('anthropic.com')) {
      // handled separately; caller overwrites after this
      return Promise.resolve({ ok: false, status: 500, text: async () => '' });
    }
    return Promise.resolve({
      ok: true,
      headers: { get: () => 'text/html; charset=utf-8' },
      body: {
        getReader: () => ({
          read: jest.fn()
            .mockResolvedValueOnce({ done: false, value: bytes })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          cancel: jest.fn().mockResolvedValue(undefined),
        }),
      },
    });
  });
}

beforeEach(() => {
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  shared.verifyStudioToken.mockReset();
  shared.makeId.mockClear();
  shared.duplicateHash.mockClear();
  delete global.fetch;
});

// ── _validateActivity ─────────────────────────────────────────────────────────
describe('_validateActivity', () => {
  test('accepts a fully-specified valid activity', () => {
    const { valid, activity, errors } = _validateActivity(VALID_RAW, 'https://example.com', 'TestSource');
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
    expect(activity.title).toBe('Kölner Weihnachtsmarkt');
    expect(activity.category).toBe('market');
  });

  test('rejects when title is missing', () => {
    const { valid, errors } = _validateActivity({ ...VALID_RAW, title: '' }, 'https://x.com', null);
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('title'))).toBe(true);
  });

  test('rejects when description is missing', () => {
    const { valid, errors } = _validateActivity({ ...VALID_RAW, description: '' }, 'https://x.com', null);
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('description'))).toBe(true);
  });

  test('rejects an invalid category', () => {
    const { valid, errors } = _validateActivity({ ...VALID_RAW, category: 'unknown' }, 'https://x.com', null);
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('category'))).toBe(true);
  });

  test('rejects null input', () => {
    const { valid } = _validateActivity(null, 'https://x.com', null);
    expect(valid).toBe(false);
  });

  test('strips lat/lng — coordinates are never set by LLM', () => {
    const raw = { ...VALID_RAW, lat: 50.938, lng: 6.96 };
    const { valid, activity } = _validateActivity(raw, 'https://x.com', null);
    expect(valid).toBe(true);
    expect(activity.lat).toBeNull();
    expect(activity.lng).toBeNull();
    expect(activity.geoQuality).toBe('missing');
  });

  test('normalises location to { address } or null', () => {
    const { valid, activity } = _validateActivity(VALID_RAW, 'https://x.com', null);
    expect(valid).toBe(true);
    expect(activity.location).toEqual({ address: 'Roncalliplatz, 50667 Köln' });
  });

  test('sets location null when location is absent', () => {
    const { activity } = _validateActivity({ ...VALID_RAW, location: null }, 'https://x.com', null);
    expect(activity.location).toBeNull();
    expect(activity.missingFields).toContain('location');
  });

  test('rejects website with non-http scheme (no javascript:)', () => {
    const raw = { ...VALID_RAW, website: 'javascript:alert(1)' };
    const { activity } = _validateActivity(raw, 'https://x.com', null);
    expect(activity.website).toBeNull();
  });

  test('accepts https website', () => {
    const { activity } = _validateActivity(VALID_RAW, 'https://x.com', null);
    expect(activity.website).toBe('https://koeln-tourismus.de/weihnachtsmarkt');
  });

  test('rejects operatingPeriod with non-ISO dates', () => {
    const raw = { ...VALID_RAW, operatingPeriod: { from: '25.11.2024', to: '23.12.2024' } };
    const { activity } = _validateActivity(raw, 'https://x.com', null);
    expect(activity.operatingPeriod).toBeNull();
    expect(activity.missingFields).toContain('operatingPeriod');
  });

  test('accepts valid ISO operatingPeriod', () => {
    const { activity } = _validateActivity(VALID_RAW, 'https://x.com', null);
    expect(activity.operatingPeriod).toEqual({ from: '2024-11-25', to: '2024-12-23' });
  });

  test('tracks missing fields when optional fields are absent', () => {
    const raw = { title: 'Test', description: 'A test activity.', category: 'other' };
    const { activity } = _validateActivity(raw, 'https://x.com', null);
    expect(activity.missingFields).toContain('location');
    expect(activity.missingFields).toContain('operatingPeriod');
    expect(activity.missingFields).toContain('price');
    expect(activity.missingFields).toContain('website');
    expect(activity.missingFields).toContain('providerName');
  });

  test('sets missingFields null when all optional fields are present', () => {
    const { activity } = _validateActivity(VALID_RAW, 'https://x.com', null);
    expect(activity.missingFields).toBeNull();
  });

  test('sets sourceAttribution from sourceName when not provided by LLM', () => {
    const raw = { ...VALID_RAW, sourceAttribution: null };
    const { activity } = _validateActivity(raw, 'https://x.com', 'MySource');
    expect(activity.sourceAttribution).toBe('MySource');
  });

  test('truncates title to 120 chars', () => {
    const raw = { ...VALID_RAW, title: 'A'.repeat(200) };
    const { activity } = _validateActivity(raw, 'https://x.com', null);
    expect(activity.title.length).toBeLessThanOrEqual(120);
  });

  test('truncates description to 500 chars', () => {
    const raw = { ...VALID_RAW, description: 'B'.repeat(600) };
    const { activity } = _validateActivity(raw, 'https://x.com', null);
    expect(activity.description.length).toBeLessThanOrEqual(500);
  });

  test('includes source URL in sources array', () => {
    const { activity } = _validateActivity(VALID_RAW, 'https://example.org/events', null);
    expect(activity.sources).toContain('https://example.org/events');
  });
});

// ── _buildExtractionPrompt ────────────────────────────────────────────────────
describe('_buildExtractionPrompt', () => {
  test('returns system and user strings', () => {
    const { system, user } = _buildExtractionPrompt('some text', 'Köln');
    expect(typeof system).toBe('string');
    expect(typeof user).toBe('string');
    expect(system.length).toBeGreaterThan(0);
    expect(user.length).toBeGreaterThan(0);
  });

  test('system prompt contains city name', () => {
    const { system } = _buildExtractionPrompt('text', 'Köln');
    expect(system).toContain('Köln');
  });

  test('truncates text to LLM_TEXT_LIMIT (8000 chars)', () => {
    const longText = 'x'.repeat(20_000);
    const { user } = _buildExtractionPrompt(longText, 'Köln');
    // user prompt contains the truncated text
    expect(user.length).toBeLessThan(longText.length);
    expect(user).toContain('x'.repeat(100));
  });

  test('system prompt forbids lat/lng coordinates', () => {
    const { system } = _buildExtractionPrompt('text', 'Köln');
    expect(system).toMatch(/lat|lng|coord/i);
  });

  test('system prompt requires JSON output only', () => {
    const { system } = _buildExtractionPrompt('text', 'Köln');
    expect(system).toMatch(/JSON/i);
    expect(system).toMatch(/no.*explanation|only.*JSON|Output only/i);
  });
});

// ── _callAnthropicAPI ─────────────────────────────────────────────────────────
describe('_callAnthropicAPI', () => {
  test('returns activities and token counts on success', async () => {
    mockAnthropicSuccess([VALID_RAW], 300, 200);
    const result = await _callAnthropicAPI('some website text', 'Köln', 'sk-test');
    expect(result.error).toBeNull();
    expect(Array.isArray(result.activities)).toBe(true);
    expect(result.activities).toHaveLength(1);
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(200);
  });

  test('sends correct model and API key header', async () => {
    mockAnthropicSuccess([]);
    await _callAnthropicAPI('text', 'Köln', 'my-test-key');
    const call = global.fetch.mock.calls[0];
    const [url, options] = call;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(options.headers['x-api-key']).toBe('my-test-key');
    const body = JSON.parse(options.body);
    expect(body.model).toBe('claude-haiku-5-5');
  });

  test('returns error on HTTP 401', async () => {
    mockAnthropicHttpError(401, 'Unauthorized');
    const result = await _callAnthropicAPI('text', 'Köln', 'bad-key');
    expect(result.error).toMatch(/401/);
    expect(result.activities).toHaveLength(0);
    expect(result.inputTokens).toBe(0);
  });

  test('returns error on HTTP 429 (rate limit)', async () => {
    mockAnthropicHttpError(429, 'Rate limit exceeded');
    const result = await _callAnthropicAPI('text', 'Köln', 'sk-test');
    expect(result.error).toMatch(/429/);
  });

  test('returns error when LLM response is not valid JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'This is not JSON at all.' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    });
    const result = await _callAnthropicAPI('text', 'Köln', 'sk-test');
    expect(result.error).toMatch(/not valid JSON/i);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });

  test('returns error when activities array is missing from LLM response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '{"result": "ok"}' }],
        usage: { input_tokens: 80, output_tokens: 30 },
      }),
    });
    const result = await _callAnthropicAPI('text', 'Köln', 'sk-test');
    expect(result.error).toMatch(/activities array/i);
  });

  test('returns empty activities array when LLM finds nothing', async () => {
    mockAnthropicSuccess([]);
    const result = await _callAnthropicAPI('empty text', 'Köln', 'sk-test');
    expect(result.error).toBeNull();
    expect(result.activities).toHaveLength(0);
  });
});

// ── handler: live mode ────────────────────────────────────────────────────────
describe('handler live mode', () => {
  const editor = { uid: 'ed', studioRole: 'editor', email: 'ed@test.com' };

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete global.fetch;
  });

  test('returns 500 when ANTHROPIC_API_KEY is not set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    shared.verifyStudioToken.mockResolvedValue(editor);
    const res = await handler(makeEvent('POST', { city: 'Köln', mode: 'live' }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toMatch(/ANTHROPIC_API_KEY/);
  });

  test('live mode with no sources produces empty report', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    global.fetch = jest.fn();
    const res = await handler(makeEvent('POST', { city: 'Köln', mode: 'live' }));
    expect(res.statusCode).toBe(200);
    const { report } = JSON.parse(res.body);
    expect(report.mode).toBe('live');
    expect(report.llmCallsUsed).toBe(0);
    expect(report.suggestionsSaved).toBe(0);
    expect(report.estimatedCostUSD).toBe(0);
  });

  test('live mode writes draft suggestions, not activities', async () => {
    // seed an active source
    mockSet('discoverySources/src1', { city: 'Köln', url: 'https://example.com/events', name: 'TestSource', active: true });
    shared.verifyStudioToken.mockResolvedValue(editor);

    // first call: source fetch; second call: Anthropic
    const encoder = new TextEncoder();
    const pageBytes = encoder.encode('Weihnachtsmarkt 25.11. bis 23.12.2024 Roncalliplatz Köln');
    let fetchCallIndex = 0;

    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('anthropic.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            content: [{ type: 'text', text: JSON.stringify({ activities: [VALID_RAW] }) }],
            usage: { input_tokens: 400, output_tokens: 300 },
          }),
        });
      }
      // source fetch
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'text/html' },
        body: {
          getReader: () => ({
            read: jest.fn()
              .mockResolvedValueOnce({ done: false, value: pageBytes })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            cancel: jest.fn().mockResolvedValue(undefined),
          }),
        },
      });
    });

    const res = await handler(makeEvent('POST', { city: 'Köln', mode: 'live' }));
    expect(res.statusCode).toBe(200);
    const { report } = JSON.parse(res.body);

    expect(report.llmCallsUsed).toBe(1);
    expect(report.suggestionsSaved).toBe(1);
    expect(report.suggestionsProposed).toBe(1);

    // draft written to suggestions/
    const suggestions = mockGet('suggestions');
    expect(suggestions).toBeDefined();
    const saved = Object.values(suggestions)[0];
    expect(saved.status).toBe('draft');
    expect(saved.discoveredBy).toBe('discovery-pipeline');
    expect(saved.city).toBe('Köln');

    // activities/ must NOT be written
    expect(mockGet('activities')).toBeUndefined();
  });

  test('deduplicates: second run with same title skips writing', async () => {
    mockSet('discoverySources/src1', { city: 'Köln', url: 'https://example.com/events', name: 'TestSource', active: true });
    shared.verifyStudioToken.mockResolvedValue(editor);

    const encoder = new TextEncoder();
    const pageBytes = encoder.encode('Weihnachtsmarkt am Dom');
    const anthropicResponse = {
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ activities: [VALID_RAW] }) }],
        usage: { input_tokens: 200, output_tokens: 150 },
      }),
    };
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('anthropic.com')) return Promise.resolve(anthropicResponse);
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'text/html' },
        body: {
          getReader: () => ({
            read: jest.fn()
              .mockResolvedValueOnce({ done: false, value: pageBytes })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            cancel: jest.fn().mockResolvedValue(undefined),
          }),
        },
      });
    });

    // first run: saves the suggestion and hash
    await handler(makeEvent('POST', { city: 'Köln', mode: 'live' }));
    const afterFirst = Object.keys(mockGet('suggestions') || {}).length;
    expect(afterFirst).toBe(1);

    // second run: same source, same activity title → should dedup
    // Re-mock source fetch since reads are sequential
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('anthropic.com')) return Promise.resolve(anthropicResponse);
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'text/html' },
        body: {
          getReader: () => ({
            read: jest.fn()
              .mockResolvedValueOnce({ done: false, value: pageBytes })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            cancel: jest.fn().mockResolvedValue(undefined),
          }),
        },
      });
    });

    const res2 = await handler(makeEvent('POST', { city: 'Köln', mode: 'live' }));
    const { report } = JSON.parse(res2.body);
    expect(report.suggestionsDeduplicated).toBe(1);
    expect(report.suggestionsSaved).toBe(0);

    // still only one suggestion in store
    expect(Object.keys(mockGet('suggestions') || {}).length).toBe(1);
  });

  test('report includes cost estimate based on token usage', async () => {
    mockSet('discoverySources/src1', { city: 'Köln', url: 'https://example.com', name: 'S', active: true });
    shared.verifyStudioToken.mockResolvedValue(editor);

    const encoder = new TextEncoder();
    const bytes = encoder.encode('Markt November');

    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('anthropic.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            content: [{ type: 'text', text: JSON.stringify({ activities: [] }) }],
            usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'text/html' },
        body: {
          getReader: () => ({
            read: jest.fn()
              .mockResolvedValueOnce({ done: false, value: bytes })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            cancel: jest.fn().mockResolvedValue(undefined),
          }),
        },
      });
    });

    const res = await handler(makeEvent('POST', { city: 'Köln', mode: 'live' }));
    const { report } = JSON.parse(res.body);

    // 1M input @ $0.10 + 1M output @ $0.50 = $0.60
    expect(report.estimatedCostUSD).toBeCloseTo(0.60, 5);
    expect(report.totalInputTokens).toBe(1_000_000);
    expect(report.totalOutputTokens).toBe(1_000_000);
  });

  test('dry-run mode keeps estimatedCostUSD at zero even with sources', async () => {
    mockSet('discoverySources/src1', { city: 'Köln', url: 'https://example.com', name: 'S', active: true });
    shared.verifyStudioToken.mockResolvedValue(editor);

    const encoder = new TextEncoder();
    const bytes = encoder.encode('Weihnachtsmarkt');

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/html' },
      body: {
        getReader: () => ({
          read: jest.fn()
            .mockResolvedValueOnce({ done: false, value: bytes })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          cancel: jest.fn().mockResolvedValue(undefined),
        }),
      },
    });

    const res = await handler(makeEvent('POST', { city: 'Köln', mode: 'dry-run' }));
    const { report } = JSON.parse(res.body);
    expect(report.estimatedCostUSD).toBe(0);
    expect(report.llmCallsUsed).toBe(0);
  });

  test('live mode: source text is stripped from stored run report', async () => {
    mockSet('discoverySources/src1', { city: 'Köln', url: 'https://example.com', name: 'S', active: true });
    shared.verifyStudioToken.mockResolvedValue(editor);

    const secretText = 'SECRET_INTERNAL_CONTENT';
    const encoder = new TextEncoder();
    const bytes = encoder.encode(secretText);

    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('anthropic.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            content: [{ type: 'text', text: JSON.stringify({ activities: [] }) }],
            usage: { input_tokens: 10, output_tokens: 10 },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'text/html' },
        body: {
          getReader: () => ({
            read: jest.fn()
              .mockResolvedValueOnce({ done: false, value: bytes })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            cancel: jest.fn().mockResolvedValue(undefined),
          }),
        },
      });
    });

    const res = await handler(makeEvent('POST', { city: 'Köln', mode: 'live' }));
    const { report } = JSON.parse(res.body);

    // Raw fetched text must not appear in the stored report
    const reportStr = JSON.stringify(report);
    expect(reportStr).not.toContain(secretText);

    // Also verify nothing leaked into the RTDB store
    const storedRun = Object.values(mockGet('discoveryPipelineRuns') || {})[0];
    expect(JSON.stringify(storedRun)).not.toContain(secretText);
  });

  test('live mode records LLM error in report without crashing', async () => {
    mockSet('discoverySources/src1', { city: 'Köln', url: 'https://example.com', name: 'S', active: true });
    shared.verifyStudioToken.mockResolvedValue(editor);

    const encoder = new TextEncoder();
    const bytes = encoder.encode('Markt');

    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('anthropic.com')) {
        return Promise.resolve({ ok: false, status: 500, text: async () => 'Server error' });
      }
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'text/html' },
        body: {
          getReader: () => ({
            read: jest.fn()
              .mockResolvedValueOnce({ done: false, value: bytes })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            cancel: jest.fn().mockResolvedValue(undefined),
          }),
        },
      });
    });

    const res = await handler(makeEvent('POST', { city: 'Köln', mode: 'live' }));
    expect(res.statusCode).toBe(200);
    const { report } = JSON.parse(res.body);
    expect(report.llmErrors).not.toBeNull();
    expect(report.llmErrors.length).toBeGreaterThan(0);
    expect(report.suggestionsSaved).toBe(0);
  });

  test('live mode audit log entry is written for each draft', async () => {
    mockSet('discoverySources/src1', { city: 'Köln', url: 'https://example.com/events', name: 'S', active: true });
    shared.verifyStudioToken.mockResolvedValue(editor);

    const encoder = new TextEncoder();
    const bytes = encoder.encode('Weihnachtsmarkt Köln');

    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('anthropic.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            content: [{ type: 'text', text: JSON.stringify({ activities: [VALID_RAW] }) }],
            usage: { input_tokens: 100, output_tokens: 80 },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'text/html' },
        body: {
          getReader: () => ({
            read: jest.fn()
              .mockResolvedValueOnce({ done: false, value: bytes })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            cancel: jest.fn().mockResolvedValue(undefined),
          }),
        },
      });
    });

    await handler(makeEvent('POST', { city: 'Köln', mode: 'live' }));

    const logs = mockGet('studioAuditLog');
    expect(logs).toBeDefined();
    const logEntries = Object.values(logs);
    const draftLog = logEntries.find(l => l.action === 'draft');
    expect(draftLog).toBeDefined();
    expect(draftLog.actorUid).toBe('ed');
    expect(draftLog.details).toContain('Discovery draft');
  });
});
