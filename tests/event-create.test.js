'use strict';
// Unit tests for netlify/functions/event-create.js
// Covers both creation flows: (1) from a Discovery activity, (2) own event in a Space.
// Also covers poll (date poll), invite notifications, and error paths.

const FAKE_SA_JSON = JSON.stringify({
  type: 'service_account', project_id: 'someday-test',
  private_key_id: 'k1',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4VB\n-----END RSA PRIVATE KEY-----\n',
  client_email: 'firebase-adminsdk@someday-test.iam.gserviceaccount.com',
  client_id: '1', auth_uri: '', token_uri: '',
});

const mockVerifyIdToken  = jest.fn();
const mockRootUpdate     = jest.fn();
const mockOnce           = jest.fn();
const mockPushKey        = jest.fn(() => ({ key: 'rsvp_push_key' }));

// Per-path ref mock
const makeRef = (overrides = {}) => ({
  once: mockOnce,
  update: mockRootUpdate,
  push: mockPushKey,
  ...overrides,
});

// ref('/') and ref() both need .update()
const mockRef = jest.fn((path) => {
  if (!path || path === '/') return makeRef({ update: mockRootUpdate });
  return makeRef();
});

const mockDatabase = jest.fn(() => ({ ref: mockRef }));
const mockAuth_    = jest.fn(() => ({ verifyIdToken: mockVerifyIdToken }));
const mockInitializeApp = jest.fn(() => ({ auth: mockAuth_, database: mockDatabase }));

jest.mock('firebase-admin', () => ({
  apps: [],
  credential: { cert: jest.fn() },
  initializeApp: (...a) => mockInitializeApp(...a),
}));

// Stub crypto so eventId / inviteToken are deterministic
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomBytes: () => Buffer.from('aabbccdd11223344556677889900aabbccdd1122', 'hex'),
}));

beforeEach(() => {
  jest.resetModules();
  require('firebase-admin').apps.length = 0;
  mockVerifyIdToken.mockReset();
  mockRootUpdate.mockReset();
  mockOnce.mockReset();
  mockInitializeApp.mockReset();
  mockInitializeApp.mockReturnValue({ auth: mockAuth_, database: mockDatabase });
  mockRootUpdate.mockResolvedValue();

  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = FAKE_SA_JSON;
  process.env.FIREBASE_RTDB_URL             = 'https://someday-test.firebaseio.com';
});

function load() { return require('../netlify/functions/event-create'); }

function makeEvent(body, token = 'Bearer valid') {
  return {
    httpMethod: 'POST',
    headers: { authorization: token },
    body: JSON.stringify(body),
  };
}

// ── EC0: syntax / module loads ────────────────────────────────────────────────

test('EC0 module loads without SyntaxError', () => {
  expect(() => load()).not.toThrow();
});

// ── EC1: method guard ─────────────────────────────────────────────────────────

test('EC1 GET → 405', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  const { handler } = load();
  const r = await handler({ httpMethod: 'GET', headers: {}, body: '' });
  expect(r.statusCode).toBe(405);
});

// ── EC2: auth guard ───────────────────────────────────────────────────────────

test('EC2 missing token → 401', async () => {
  const { handler } = load();
  const r = await handler({ httpMethod: 'POST', headers: {}, body: '{}' });
  expect(r.statusCode).toBe(401);
});

test('EC2b invalid token → 401', async () => {
  mockVerifyIdToken.mockRejectedValue(Object.assign(new Error('invalid'), { code: 'auth/invalid-id-token' }));
  const { handler } = load();
  const r = await handler(makeEvent({ title: 'Test' }));
  expect(r.statusCode).toBe(401);
});

// ── EC3: title validation ─────────────────────────────────────────────────────

test('EC3 missing title → 400', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  mockOnce.mockResolvedValue({ val: () => ({ displayName: 'Alice' }), exists: () => true });
  const { handler } = load();
  const r = await handler(makeEvent({ spaceIds: [] }));
  expect(r.statusCode).toBe(400);
  expect(JSON.parse(r.body).error).toMatch(/title/);
});

test('EC3b blank title → 400', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  mockOnce.mockResolvedValue({ val: () => ({ displayName: 'Alice' }), exists: () => true });
  const { handler } = load();
  const r = await handler(makeEvent({ title: '   ' }));
  expect(r.statusCode).toBe(400);
});

// ── EC4: Flow 1 — basic event creation (Activity → "Termin planen") ───────────

test('EC4 creates event with activityRef → 201', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  mockOnce.mockResolvedValue({ val: () => ({ displayName: 'Alice' }), exists: () => true });

  const { handler } = load();
  const r = await handler(makeEvent({
    title: 'Schwanensee',
    emoji: '🩰',
    date: '2026-12-01',
    time: '19:30',
    activityRef: 'act_ballet_123',
  }));

  expect(r.statusCode).toBe(201);
  const body = JSON.parse(r.body);
  expect(body.ok).toBe(true);
  expect(typeof body.eventId).toBe('string');
  expect(typeof body.inviteToken).toBe('string');

  // Should have written events/ and userEvents/
  const updateCalls = mockRootUpdate.mock.calls.flat();
  const writtenPaths = updateCalls.flatMap(arg => Object.keys(arg));
  expect(writtenPaths.some(p => p.startsWith('events/'))).toBe(true);
  expect(writtenPaths.some(p => p.startsWith('userEvents/'))).toBe(true);
  expect(writtenPaths.some(p => p.startsWith('inviteTokens/'))).toBe(true);
});

// ── EC5: Flow 2 — event in a Space (Own event with RSVP share) ────────────────

test('EC5 creates event linked to space when user is member → 201', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });

  // Provide tailored responses per path
  mockOnce.mockImplementation(async function () {
    const path = this._path || '';
    if (path.startsWith('users/')) return { val: () => ({ displayName: 'Alice' }), exists: () => true };
    if (path.startsWith('spaces/sp1') && !path.includes('members')) return { val: () => ({ name: 'Book Club' }), exists: () => true };
    if (path.includes('members/u1')) return { val: () => true, exists: () => true };
    return { val: () => null, exists: () => false };
  });

  mockRef.mockImplementation((path) => {
    const ref = { once: jest.fn(), update: mockRootUpdate, push: mockPushKey, _path: path };
    ref.once.mockImplementation(async () => {
      if (!path || path === '/') return {};
      if (path === `users/u1`) return { val: () => ({ displayName: 'Alice' }), exists: () => true };
      if (path === `spaces/sp1`) return { val: () => ({ name: 'Book Club' }), exists: () => true };
      if (path === `spaces/sp1/members/u1`) return { val: () => true, exists: () => true };
      return { val: () => null, exists: () => false };
    });
    if (!path || path === '/') ref.update = mockRootUpdate;
    return ref;
  });

  const { handler } = load();
  const r = await handler(makeEvent({
    title: 'Buchclub Treffen',
    date: '2026-12-15',
    spaceIds: ['sp1'],
  }));

  expect(r.statusCode).toBe(201);
  const body = JSON.parse(r.body);
  expect(body.ok).toBe(true);
});

// ── EC6: Flow 2b — event in a Space with date poll ───────────────────────────

test('EC6 creates event with pollOptions (date poll) → 201', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });

  mockRef.mockImplementation((path) => {
    const ref = { once: jest.fn(), update: mockRootUpdate, push: mockPushKey, _path: path };
    ref.once.mockImplementation(async () => {
      if (path === `users/u1`) return { val: () => ({ displayName: 'Alice' }), exists: () => true };
      return { val: () => null, exists: () => false };
    });
    if (!path || path === '/') ref.update = mockRootUpdate;
    return ref;
  });

  const { handler } = load();
  const r = await handler(makeEvent({
    title: 'Gemeinsames Dinner',
    pollOptions: [
      { date: '2026-12-10', time: '19:00' },
      { date: '2026-12-12', time: '20:00' },
    ],
  }));

  expect(r.statusCode).toBe(201);
  const body = JSON.parse(r.body);
  expect(body.ok).toBe(true);
  expect(typeof body.eventId).toBe('string');

  // Poll sub-tree must be written
  const allCalls = mockRootUpdate.mock.calls;
  const writtenPaths = allCalls.flatMap(c => c.flatMap(arg => Object.keys(arg)));
  const pollPath = writtenPaths.find(p => p.includes('/poll'));
  expect(pollPath).toBeTruthy();
});

// ── EC7: pollOptions validation ───────────────────────────────────────────────

test('EC7 single pollOption → 400', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  mockRef.mockImplementation((path) => ({
    once: jest.fn().mockResolvedValue({ val: () => ({ displayName: 'Alice' }), exists: () => true }),
    update: mockRootUpdate,
    push: mockPushKey,
  }));

  const { handler } = load();
  const r = await handler(makeEvent({
    title: 'Test',
    pollOptions: [{ date: '2026-12-10' }],
  }));
  expect(r.statusCode).toBe(400);
  expect(JSON.parse(r.body).error).toMatch(/pollOptions/);
});

test('EC7b invalid pollOption date → 400', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  mockRef.mockImplementation(() => ({
    once: jest.fn().mockResolvedValue({ val: () => ({ displayName: 'Alice' }), exists: () => true }),
    update: mockRootUpdate, push: mockPushKey,
  }));

  const { handler } = load();
  const r = await handler(makeEvent({
    title: 'Test',
    pollOptions: [{ date: 'not-a-date' }, { date: '2026-12-12' }],
  }));
  expect(r.statusCode).toBe(400);
  expect(JSON.parse(r.body).error).toMatch(/pollOption.date/);
});

// ── EC8: invite notifications use correct title ───────────────────────────────

test('EC8 invite notification message contains emoji + title', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });

  mockRef.mockImplementation((path) => {
    const ref = { once: jest.fn(), update: mockRootUpdate, push: mockPushKey };
    ref.once.mockImplementation(async () => {
      if (path === 'users/u1')   return { val: () => ({ displayName: 'Alice' }), exists: () => true };
      if (path === 'users/u2')   return { val: () => ({ displayName: 'Bob' }),   exists: () => true };
      return { val: () => null, exists: () => false };
    });
    if (!path || path === '/') ref.update = mockRootUpdate;
    return ref;
  });

  const { handler } = load();
  const r = await handler(makeEvent({
    title: 'Schwanensee',
    emoji: '🩰',
    date: '2026-12-01',
    inviteUids: ['u2'],
  }));

  expect(r.statusCode).toBe(201);

  // Find notification update call
  const notifCalls = mockRootUpdate.mock.calls;
  const notifPaths = notifCalls.flatMap(c => c.flatMap(arg => Object.keys(arg)));
  const notifPath = notifPaths.find(p => p.startsWith('notifications/'));
  expect(notifPath).toBeTruthy();

  // Verify message text contains emoji and title
  const notifData = notifCalls
    .flatMap(c => c.flatMap(arg => Object.values(arg)))
    .find(v => v && v.message);
  expect(notifData).toBeTruthy();
  expect(notifData.message).toContain('🩰 Schwanensee');
});
