'use strict';

/**
 * Tests for discovery-sources Netlify function.
 * Firebase Admin SDK is mocked via _studio-shared, matching the pattern
 * used by analytics.test.js and auth.test.js.
 */

// ── Shared in-memory store accessible from both mock factory and tests ───────
// Variable must be prefixed "mock" to be usable inside jest.mock() factories.
const mockStore = {};

function mockGet(path) {
  return path.split('/').reduce((cur, k) => (cur != null && cur[k] !== undefined ? cur[k] : undefined), mockStore);
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

// ── Mock _studio-shared ───────────────────────────────────────────────────────
jest.mock('../netlify/functions/_studio-shared', () => {
  // Inner helpers — must be self-contained (no out-of-scope non-mock vars)
  function _get(path) {
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

  const mockDb = {
    ref: (path) => ({
      once: async () => {
        const val = _get(path ?? '');
        return { exists: () => val !== undefined && val !== null, val: () => val ?? null };
      },
      update: jest.fn(async (updates) => {
        for (const [k, v] of Object.entries(updates)) {
          _set(k.replace(/^\//, ''), v);
        }
      }),
    }),
  };

  return {
    initAdmin: () => ({ database: () => mockDb }),
    verifyStudioToken: jest.fn(),
    json: (status, body) => ({ statusCode: status, body: JSON.stringify(body), _body: body }),
    makeId: (prefix) => `${prefix}_test`,
  };
});

const { handler } = require('../netlify/functions/discovery-sources');
const shared = require('../netlify/functions/_studio-shared');

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeEvent(method, body = null, authRole = null) {
  const headers = {};
  if (authRole) headers['authorization'] = `Bearer token-${authRole}`;
  return {
    httpMethod: method,
    headers,
    body: body ? JSON.stringify(body) : null,
    queryStringParameters: {},
  };
}

function editorActor() { return { uid: 'editor-uid', studioRole: 'editor', email: 'ed@test.com' }; }
function superActor()  { return { uid: 'super-uid',  studioRole: 'superadmin', email: 'su@test.com' }; }

beforeEach(() => {
  // Clear the in-memory store
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  shared.verifyStudioToken.mockReset();
});

// ── Method guard ─────────────────────────────────────────────────────────────
describe('method guard', () => {
  test('returns 405 for PUT', async () => {
    const res = await handler(makeEvent('PUT', {}));
    expect(res.statusCode).toBe(405);
  });
});

// ── GET ──────────────────────────────────────────────────────────────────────
describe('GET /discovery-sources', () => {
  test('returns 403 when unauthenticated', async () => {
    shared.verifyStudioToken.mockResolvedValue(null);
    const res = await handler(makeEvent('GET'));
    expect(res.statusCode).toBe(403);
  });

  test('returns empty object when no sources exist', async () => {
    shared.verifyStudioToken.mockResolvedValue(editorActor());
    const res = await handler(makeEvent('GET', null, 'editor'));
    expect(res.statusCode).toBe(200);
    expect(res._body.sources).toEqual({});
  });

  test('researcher role is allowed to read', async () => {
    shared.verifyStudioToken.mockResolvedValue({ uid: 'r', studioRole: 'researcher', email: null });
    const res = await handler(makeEvent('GET', null, 'researcher'));
    expect(res.statusCode).toBe(200);
  });

  test('returns existing sources', async () => {
    mockSet('discoverySources/src_1', { url: 'https://example.com', name: 'Test', city: 'Köln', active: true });
    shared.verifyStudioToken.mockResolvedValue(editorActor());
    const res = await handler(makeEvent('GET', null, 'editor'));
    expect(res.statusCode).toBe(200);
    expect(res._body.sources['src_1']).toBeDefined();
  });
});

// ── POST ─────────────────────────────────────────────────────────────────────
describe('POST /discovery-sources', () => {
  const validBody = {
    url: 'https://example.com/events',
    name: 'Example Events',
    city: 'Köln',
    sourceType: 'website',
  };

  test('returns 403 for researcher role', async () => {
    // Real verifyStudioToken returns null when role not in allowedRoles
    shared.verifyStudioToken.mockResolvedValue(null);
    const res = await handler(makeEvent('POST', validBody, 'researcher'));
    expect(res.statusCode).toBe(403);
  });

  test('returns 400 when url is missing', async () => {
    shared.verifyStudioToken.mockResolvedValue(editorActor());
    const { url: _, ...noUrl } = validBody;
    const res = await handler(makeEvent('POST', noUrl, 'editor'));
    expect(res.statusCode).toBe(400);
    expect(res._body.error).toMatch(/url/);
  });

  test('returns 400 for invalid URL', async () => {
    shared.verifyStudioToken.mockResolvedValue(editorActor());
    const res = await handler(makeEvent('POST', { ...validBody, url: 'not-a-url' }, 'editor'));
    expect(res.statusCode).toBe(400);
    expect(res._body.error).toMatch(/valid URL/);
  });

  test('returns 400 for unknown sourceType', async () => {
    shared.verifyStudioToken.mockResolvedValue(editorActor());
    const res = await handler(makeEvent('POST', { ...validBody, sourceType: 'rss' }, 'editor'));
    expect(res.statusCode).toBe(400);
  });

  test('creates source with active=true and returns 201', async () => {
    shared.verifyStudioToken.mockResolvedValue(editorActor());
    const res = await handler(makeEvent('POST', validBody, 'editor'));
    expect(res.statusCode).toBe(201);
    expect(res._body.sourceId).toBe('src_test');
    expect(mockStore.discoverySources?.src_test?.url).toBe('https://example.com/events');
    expect(mockStore.discoverySources?.src_test?.active).toBe(true);
  });

  test('returns 409 for duplicate URL', async () => {
    // safeKey replaces [.#$[]/] with _ but NOT colon, so:
    // 'https://example.com/events' → 'https:__example_com_events'
    mockSet('discoverySourceUrls/https:__example_com_events', 'src_existing');
    shared.verifyStudioToken.mockResolvedValue(editorActor());
    const res = await handler(makeEvent('POST', validBody, 'editor'));
    expect(res.statusCode).toBe(409);
    expect(res._body.error).toBe('duplicate-url');
    expect(res._body.existingId).toBe('src_existing');
  });

  test('writes audit log entry on successful creation', async () => {
    shared.verifyStudioToken.mockResolvedValue(editorActor());
    await handler(makeEvent('POST', validBody, 'editor'));
    const logEntries = Object.values(mockStore.studioAuditLog || {});
    expect(logEntries.length).toBeGreaterThan(0);
    expect(logEntries[0].action).toBe('source-add');
  });

  test('stores notes field when provided', async () => {
    shared.verifyStudioToken.mockResolvedValue(editorActor());
    await handler(makeEvent('POST', { ...validBody, notes: 'Wöchentlich' }, 'editor'));
    expect(mockStore.discoverySources?.src_test?.notes).toBe('Wöchentlich');
  });

  test('stores null for notes when not provided', async () => {
    shared.verifyStudioToken.mockResolvedValue(editorActor());
    await handler(makeEvent('POST', validBody, 'editor'));
    expect(mockStore.discoverySources?.src_test?.notes).toBeNull();
  });
});

// ── PATCH ────────────────────────────────────────────────────────────────────
describe('PATCH /discovery-sources', () => {
  beforeEach(() => {
    mockSet('discoverySources/src_abc', {
      url: 'https://existing.com', normUrl: 'https://existing.com',
      name: 'Existing', city: 'Berlin', active: true,
    });
  });

  test('returns 403 for researcher', async () => {
    shared.verifyStudioToken.mockResolvedValue(null);
    const res = await handler(makeEvent('PATCH', { sourceId: 'src_abc', active: false }));
    expect(res.statusCode).toBe(403);
  });

  test('returns 404 for unknown sourceId', async () => {
    shared.verifyStudioToken.mockResolvedValue(editorActor());
    const res = await handler(makeEvent('PATCH', { sourceId: 'nonexistent', active: false }, 'editor'));
    expect(res.statusCode).toBe(404);
  });

  test('returns 400 when sourceId missing', async () => {
    shared.verifyStudioToken.mockResolvedValue(editorActor());
    const res = await handler(makeEvent('PATCH', { active: false }, 'editor'));
    expect(res.statusCode).toBe(400);
  });

  test('returns 200 for valid toggle', async () => {
    shared.verifyStudioToken.mockResolvedValue(editorActor());
    const res = await handler(makeEvent('PATCH', { sourceId: 'src_abc', active: false }, 'editor'));
    expect(res.statusCode).toBe(200);
  });
});

// ── DELETE ───────────────────────────────────────────────────────────────────
describe('DELETE /discovery-sources', () => {
  beforeEach(() => {
    mockSet('discoverySources/src_del', {
      url: 'https://delete-me.com', normUrl: 'https://delete-me.com', name: 'To delete',
    });
    mockSet('discoverySourceUrls/https___delete-me.com', 'src_del');
  });

  test('returns 403 for researcher', async () => {
    shared.verifyStudioToken.mockResolvedValue(null);
    const res = await handler(makeEvent('DELETE', { sourceId: 'src_del' }));
    expect(res.statusCode).toBe(403);
  });

  test('returns 404 for unknown sourceId', async () => {
    shared.verifyStudioToken.mockResolvedValue(superActor());
    const res = await handler(makeEvent('DELETE', { sourceId: 'nope' }, 'superadmin'));
    expect(res.statusCode).toBe(404);
  });

  test('deletes source and returns 200', async () => {
    shared.verifyStudioToken.mockResolvedValue(superActor());
    const res = await handler(makeEvent('DELETE', { sourceId: 'src_del' }, 'superadmin'));
    expect(res.statusCode).toBe(200);
  });

  test('writes audit log entry on delete', async () => {
    shared.verifyStudioToken.mockResolvedValue(superActor());
    await handler(makeEvent('DELETE', { sourceId: 'src_del' }, 'superadmin'));
    const logEntries = Object.values(mockStore.studioAuditLog || {});
    expect(logEntries.length).toBeGreaterThan(0);
    expect(logEntries[0].action).toBe('source-delete');
  });
});
