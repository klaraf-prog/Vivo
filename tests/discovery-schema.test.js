'use strict';

/**
 * Tests for the offering schema extensions across studio-submit,
 * studio-approve and event-create.
 *
 * Verifies that the new fields (operatingPeriod, openingHours,
 * exceptionalHours, sourceAttribution, missingFields) flow correctly
 * through the pipeline, and that activityRef is accepted by event-create.
 *
 * Firebase Admin / _studio-shared are mocked — no real DB calls.
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

// ── Mock _studio-shared ───────────────────────────────────────────────────────
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
            return { exists: () => val !== undefined && val !== null, val: () => val ?? null };
          },
          update: jest.fn(async (updates) => {
            for (const [k, v] of Object.entries(updates)) _set(k.replace(/^\//, ''), v);
          }),
        }),
      }),
    }),
    verifyStudioToken: jest.fn(),
    verifyUserToken:   jest.fn(),
    json:   (status, body) => ({ statusCode: status, _body: body, body: JSON.stringify(body) }),
    makeId: (prefix) => `${prefix}_test`,
    duplicateHash: (city, cat, title) =>
      `${(city||'').toLowerCase()}:${(cat||'').toLowerCase()}:${(title||'').toLowerCase().replace(/[^a-z0-9]+/g,'-')}`,
  };
});

const submitHandler  = require('../netlify/functions/studio-submit').handler;
const approveHandler = require('../netlify/functions/studio-approve').handler;
const createHandler  = require('../netlify/functions/event-create').handler;
const shared = require('../netlify/functions/_studio-shared');

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeEvent(method, body, authHeader = 'Bearer tok') {
  return {
    httpMethod: method,
    headers: { authorization: authHeader },
    body: body ? JSON.stringify(body) : null,
    queryStringParameters: {},
  };
}

const XMAS_PAYLOAD = {
  title:       'Weihnachtsmarkt Roncalliplatz',
  description: 'Traditioneller Weihnachtsmarkt am Kölner Dom.',
  category:    'Seasonal',
  city:        'Köln',
  providerName: 'Köln Tourismus GmbH',
  sourceAttribution: 'Köln Tourismus GmbH',
  operatingPeriod: { from: '2024-11-21', to: '2024-12-23' },
  openingHours: {
    mon: [{ open: '11:00', close: '21:00' }],
    tue: [{ open: '11:00', close: '21:00' }],
    wed: [{ open: '11:00', close: '21:00' }],
    thu: [{ open: '11:00', close: '21:00' }],
    fri: [{ open: '11:00', close: '22:00' }],
    sat: [{ open: '10:00', close: '22:00' }],
    sun: [{ open: '10:00', close: '21:00' }],
  },
  exceptionalHours: [
    { date: '2024-12-24', open: '10:00', close: '14:00', note: 'Heiligabend' },
    { date: '2024-12-25', closed: true, note: '1. Weihnachtstag' },
  ],
};

beforeEach(() => {
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  shared.verifyStudioToken.mockReset();
  shared.verifyUserToken.mockReset();
});

// ── studio-submit: new fields stored ─────────────────────────────────────────
describe('studio-submit — offering schema fields', () => {
  const editor = { uid: 'ed', studioRole: 'editor', email: 'ed@test.com' };

  test('stores operatingPeriod on the suggestion', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    await submitHandler(makeEvent('POST', XMAS_PAYLOAD));
    const sug = mockGet('suggestions/sug_test');
    expect(sug.operatingPeriod).toEqual({ from: '2024-11-21', to: '2024-12-23' });
  });

  test('stores openingHours on the suggestion', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    await submitHandler(makeEvent('POST', XMAS_PAYLOAD));
    const sug = mockGet('suggestions/sug_test');
    expect(sug.openingHours).toBeDefined();
    expect(sug.openingHours.mon).toEqual([{ open: '11:00', close: '21:00' }]);
    expect(sug.openingHours.fri).toEqual([{ open: '11:00', close: '22:00' }]);
  });

  test('stores exceptionalHours on the suggestion', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    await submitHandler(makeEvent('POST', XMAS_PAYLOAD));
    const sug = mockGet('suggestions/sug_test');
    expect(Array.isArray(sug.exceptionalHours)).toBe(true);
    expect(sug.exceptionalHours).toHaveLength(2);
    expect(sug.exceptionalHours[0].date).toBe('2024-12-24');
    expect(sug.exceptionalHours[1].closed).toBe(true);
  });

  test('stores sourceAttribution on the suggestion', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    await submitHandler(makeEvent('POST', XMAS_PAYLOAD));
    const sug = mockGet('suggestions/sug_test');
    expect(sug.sourceAttribution).toBe('Köln Tourismus GmbH');
  });

  test('stores missingFields array when provided', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    await submitHandler(makeEvent('POST', { ...XMAS_PAYLOAD, missingFields: ['price', 'lat'] }));
    const sug = mockGet('suggestions/sug_test');
    expect(sug.missingFields).toEqual(['price', 'lat']);
  });

  test('stores null missingFields when not provided', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    await submitHandler(makeEvent('POST', XMAS_PAYLOAD));
    const sug = mockGet('suggestions/sug_test');
    expect(sug.missingFields).toBeNull();
  });

  test('ignores missingFields when not an array', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    await submitHandler(makeEvent('POST', { ...XMAS_PAYLOAD, missingFields: 'price' }));
    const sug = mockGet('suggestions/sug_test');
    expect(sug.missingFields).toBeNull();
  });

  test('stores null for new fields when not provided', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    const minimal = { title: 'T', description: 'D', category: 'Art', city: 'Köln' };
    await submitHandler(makeEvent('POST', minimal));
    const sug = mockGet('suggestions/sug_test');
    expect(sug.operatingPeriod).toBeNull();
    expect(sug.openingHours).toBeNull();
    expect(sug.exceptionalHours).toBeNull();
    expect(sug.sourceAttribution).toBeNull();
    expect(sug.missingFields).toBeNull();
  });
});

// ── studio-approve: new fields copied to activity ────────────────────────────
describe('studio-approve — offering fields propagated to activity', () => {
  const editor = { uid: 'ed', studioRole: 'editor', email: 'ed@test.com' };

  beforeEach(() => {
    // Pre-populate a submitted suggestion with the full offering schema
    mockSet('suggestions/sug_xmas', {
      ...XMAS_PAYLOAD,
      duplicateHash: 'köln:seasonal:weihnachtsmarkt-roncalliplatz',
      status: 'submitted',
      activityId: null,
      missingFields: null,
    });
  });

  test('copies operatingPeriod to activity', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    await approveHandler(makeEvent('POST', { suggestionId: 'sug_xmas' }));
    const act = mockGet('activities/act_sug_xmas');
    expect(act.operatingPeriod).toEqual({ from: '2024-11-21', to: '2024-12-23' });
  });

  test('copies openingHours to activity', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    await approveHandler(makeEvent('POST', { suggestionId: 'sug_xmas' }));
    const act = mockGet('activities/act_sug_xmas');
    expect(act.openingHours).toBeDefined();
    expect(act.openingHours.sat).toEqual([{ open: '10:00', close: '22:00' }]);
  });

  test('copies exceptionalHours to activity', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    await approveHandler(makeEvent('POST', { suggestionId: 'sug_xmas' }));
    const act = mockGet('activities/act_sug_xmas');
    expect(Array.isArray(act.exceptionalHours)).toBe(true);
    expect(act.exceptionalHours[1].closed).toBe(true);
  });

  test('copies sourceAttribution to activity', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    await approveHandler(makeEvent('POST', { suggestionId: 'sug_xmas' }));
    const act = mockGet('activities/act_sug_xmas');
    expect(act.sourceAttribution).toBe('Köln Tourismus GmbH');
  });

  test('does NOT copy missingFields to activity', async () => {
    mockSet('suggestions/sug_xmas/missingFields', ['price']);
    shared.verifyStudioToken.mockResolvedValue(editor);
    await approveHandler(makeEvent('POST', { suggestionId: 'sug_xmas' }));
    const act = mockGet('activities/act_sug_xmas');
    expect(act.missingFields).toBeUndefined();
  });

  test('activity gets null for missing offering fields', async () => {
    // Suggestion without new fields
    mockSet('suggestions/sug_min', {
      title: 'T', description: 'D', category: 'Art', city: 'Köln',
      status: 'submitted', activityId: null,
    });
    shared.verifyStudioToken.mockResolvedValue(editor);
    await approveHandler(makeEvent('POST', { suggestionId: 'sug_min' }));
    const act = mockGet('activities/act_sug_min');
    expect(act.operatingPeriod).toBeNull();
    expect(act.openingHours).toBeNull();
    expect(act.exceptionalHours).toBeNull();
    expect(act.sourceAttribution).toBeNull();
  });
});

// ── event-create: activityRef stored ─────────────────────────────────────────
describe('event-create — activityRef field', () => {
  const userDecoded = { uid: 'u1' };

  beforeEach(() => {
    // Provide a minimal user profile
    mockSet('users/u1', { displayName: 'Tester' });
    shared.verifyUserToken.mockResolvedValue({ decoded: userDecoded, errorStatus: null, errorCode: null });
  });

  test('stores activityRef when provided', async () => {
    const res = await createHandler(makeEvent('POST', {
      title: 'Weihnachtsmarkt-Besuch',
      activityRef: 'act_sug_xmas',
    }));
    expect(res.statusCode).toBe(201);
    const ev = mockGet('events/ev_test');
    expect(ev.activityRef).toBe('act_sug_xmas');
  });

  test('stores no activityRef when not provided (backward-compatible)', async () => {
    const res = await createHandler(makeEvent('POST', { title: 'Spontanes Treffen' }));
    expect(res.statusCode).toBe(201);
    const ev = mockGet('events/ev_test');
    expect(ev.activityRef).toBeUndefined();
  });

  test('event without activityRef still succeeds', async () => {
    const res = await createHandler(makeEvent('POST', { title: 'Geburtstagsfeier' }));
    expect(res.statusCode).toBe(201);
  });
});
