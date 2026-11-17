'use strict';
// Unit tests for netlify/functions/notify-list.js
// NL0: module loads, NL1: method guard, NL2: auth guard,
// NL3: returns sorted notifications, NL4: empty result, NL5: DB error handled

const FAKE_SA_JSON = JSON.stringify({
  type: 'service_account', project_id: 'someday-test',
  private_key_id: 'k1',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4VB\n-----END RSA PRIVATE KEY-----\n',
  client_email: 'firebase-adminsdk@someday-test.iam.gserviceaccount.com',
  client_id: '1', auth_uri: '', token_uri: '',
});

const mockVerifyIdToken = jest.fn();
const mockOnce          = jest.fn();
const mockOrderByChild  = jest.fn();
const mockLimitToLast   = jest.fn();

const mockRef = jest.fn(() => ({
  orderByChild: mockOrderByChild.mockReturnThis(),
  limitToLast:  mockLimitToLast.mockReturnThis(),
  once:         mockOnce,
}));
const mockDatabase      = jest.fn(() => ({ ref: mockRef }));
const mockAuth_         = jest.fn(() => ({ verifyIdToken: mockVerifyIdToken }));
const mockInitializeApp = jest.fn(() => ({ auth: mockAuth_, database: mockDatabase }));

jest.mock('firebase-admin', () => ({
  apps: [],
  credential: { cert: jest.fn() },
  initializeApp: (...a) => mockInitializeApp(...a),
}));

beforeEach(() => {
  jest.resetModules();
  require('firebase-admin').apps.length = 0;
  mockVerifyIdToken.mockReset();
  mockOnce.mockReset();
  mockInitializeApp.mockReset();
  mockInitializeApp.mockReturnValue({ auth: mockAuth_, database: mockDatabase });

  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = FAKE_SA_JSON;
  process.env.FIREBASE_RTDB_URL             = 'https://someday-test.firebaseio.com';
});

function load() { return require('../netlify/functions/notify-list'); }

function makeEvent(token = 'Bearer valid') {
  return { httpMethod: 'GET', headers: { authorization: token }, body: '' };
}

// ── NL0: module loads ─────────────────────────────────────────────────────────

test('NL0 module loads without SyntaxError', () => {
  expect(() => load()).not.toThrow();
});

// ── NL1: method guard ─────────────────────────────────────────────────────────

test('NL1 POST → 405', async () => {
  const { handler } = load();
  const r = await handler({ httpMethod: 'POST', headers: {}, body: '' });
  expect(r.statusCode).toBe(405);
});

// ── NL2: auth guard ───────────────────────────────────────────────────────────

test('NL2 missing token → 401', async () => {
  const { handler } = load();
  const r = await handler({ httpMethod: 'GET', headers: {}, body: '' });
  expect(r.statusCode).toBe(401);
});

test('NL2b invalid token → 401', async () => {
  mockVerifyIdToken.mockRejectedValue(Object.assign(new Error('bad token'), { code: 'auth/invalid-id-token' }));
  const { handler } = load();
  const r = await handler(makeEvent());
  expect(r.statusCode).toBe(401);
});

// ── NL3: returns notifications sorted by createdAt desc ──────────────────────

test('NL3 returns notifications sorted newest first', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  const raw = {
    notif_a: { type: 'invite', message: 'A', createdAt: 1000 },
    notif_b: { type: 'invite', message: 'B', createdAt: 3000 },
    notif_c: { type: 'invite', message: 'C', createdAt: 2000 },
  };
  mockOnce.mockResolvedValue({ val: () => raw });

  const { handler } = load();
  const r = await handler(makeEvent());
  expect(r.statusCode).toBe(200);
  const { notifs } = JSON.parse(r.body);
  expect(Array.isArray(notifs)).toBe(true);
  expect(notifs.length).toBe(3);
  expect(notifs[0].createdAt).toBe(3000);
  expect(notifs[1].createdAt).toBe(2000);
  expect(notifs[2].createdAt).toBe(1000);
  // Each entry must carry its key as id
  expect(notifs[0].id).toBe('notif_b');
});

// ── NL4: empty notifications ──────────────────────────────────────────────────

test('NL4 no notifications returns empty array', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  mockOnce.mockResolvedValue({ val: () => null });

  const { handler } = load();
  const r = await handler(makeEvent());
  expect(r.statusCode).toBe(200);
  const { notifs } = JSON.parse(r.body);
  expect(notifs).toEqual([]);
});

// ── NL5: DB read error → 500 ──────────────────────────────────────────────────

test('NL5 DB read error returns 500', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  mockOnce.mockRejectedValue(new Error('DB unavailable'));

  const { handler } = load();
  const r = await handler(makeEvent());
  expect(r.statusCode).toBe(500);
});
