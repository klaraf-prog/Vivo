'use strict';
// Unit tests for netlify/functions/register.js
// Covers validation, handle uniqueness, concurrent claims, and cleanup on failure.

const FAKE_SA_JSON = JSON.stringify({
  type: 'service_account', project_id: 'someday-test',
  private_key_id: 'k1',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4VB\n-----END RSA PRIVATE KEY-----\n',
  client_email: 'firebase-adminsdk@someday-test.iam.gserviceaccount.com',
  client_id: '1', auth_uri: '', token_uri: '',
});

const mockVerifyIdToken = jest.fn();
const mockTransaction   = jest.fn();
const mockUpdate        = jest.fn();
const mockOnce          = jest.fn();
const mockRemove        = jest.fn();

const mockRef = jest.fn(() => ({
  transaction: mockTransaction,
  once: mockOnce,
  remove: mockRemove,
}));
const mockDatabase = jest.fn(() => ({ ref: mockRef }));
const mockAuth_    = jest.fn(() => ({ verifyIdToken: mockVerifyIdToken }));
const mockInitializeApp = jest.fn(() => ({ auth: mockAuth_, database: mockDatabase }));

// Root ref mock for multi-path update
const mockRootRef = { update: mockUpdate };

jest.mock('firebase-admin', () => ({
  apps: [],
  credential: { cert: jest.fn() },
  initializeApp: (...a) => mockInitializeApp(...a),
}));

beforeEach(() => {
  jest.resetModules();
  require('firebase-admin').apps.length = 0;
  mockVerifyIdToken.mockReset();
  mockTransaction.mockReset();
  mockUpdate.mockReset();
  mockOnce.mockReset();
  mockRemove.mockReset();
  mockInitializeApp.mockReset();
  mockInitializeApp.mockReturnValue({ auth: mockAuth_, database: mockDatabase });

  // Default: ref('/') returns the root mock
  mockRef.mockImplementation((path) => {
    if (path === '/') return mockRootRef;
    return { transaction: mockTransaction, once: mockOnce, remove: mockRemove };
  });
  mockUpdate.mockResolvedValue();

  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = FAKE_SA_JSON;
  process.env.FIREBASE_RTDB_URL             = 'https://someday-test.firebaseio.com';
});

function load() { return require('../netlify/functions/register'); }

function makeEvent(body, token = 'Bearer tok') {
  return {
    httpMethod: 'POST',
    headers: { authorization: token },
    body: JSON.stringify(body),
  };
}

// ── R1: method guard ──────────────────────────────────────────────────────────

test('R1 GET → 405', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  const { handler } = load();
  const r = await handler({ httpMethod: 'GET', headers: {}, body: '' });
  expect(r.statusCode).toBe(405);
});

// ── R2: auth guard ────────────────────────────────────────────────────────────

test('R2 missing token → 401', async () => {
  const { handler } = load();
  const r = await handler({ httpMethod: 'POST', headers: {}, body: '{}' });
  expect(r.statusCode).toBe(401);
});

// ── R3–R6: input validation ───────────────────────────────────────────────────

test('R3 missing displayName → 400', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  const { handler } = load();
  const r = await handler(makeEvent({ handle: 'klara', birthdate: '1995-06-15' }));
  expect(r.statusCode).toBe(400);
  expect(JSON.parse(r.body).error).toMatch(/displayName/);
});

test('R4 invalid handle (too short) → 400', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  const { handler } = load();
  const r = await handler(makeEvent({ displayName: 'Klara', handle: 'x', birthdate: '1995-06-15' }));
  expect(r.statusCode).toBe(400);
  expect(JSON.parse(r.body).error).toMatch(/handle/);
});

test('R4b handle with special chars → 400', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  const { handler } = load();
  const r = await handler(makeEvent({ displayName: 'Klara', handle: 'kla ra!', birthdate: '1995-06-15' }));
  expect(r.statusCode).toBe(400);
});

test('R5 future birthdate → 400', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  const { handler } = load();
  const future = new Date(); future.setFullYear(future.getFullYear() + 1);
  const r = await handler(makeEvent({ displayName: 'Klara', handle: 'klara', birthdate: future.toISOString().slice(0, 10) }));
  expect(r.statusCode).toBe(400);
  expect(JSON.parse(r.body).error).toMatch(/future/i);
});

test('R6 implausible birthdate (> 150 years ago) → 400', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  const { handler } = load();
  const r = await handler(makeEvent({ displayName: 'Klara', handle: 'klara', birthdate: '1800-01-01' }));
  expect(r.statusCode).toBe(400);
  expect(JSON.parse(r.body).error).toMatch(/implausible/i);
});

// ── R7: handle taken (transaction does not commit) ────────────────────────────

test('R7 handle already taken → 409', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  // Simulate transaction abort: committed = false
  mockTransaction.mockImplementation(async (updateFn) => {
    updateFn('other-uid'); // existing value → update fn returns undefined → abort
    return { committed: false, snapshot: null };
  });
  const { handler } = load();
  const r = await handler(makeEvent({ displayName: 'Klara', handle: 'klara', birthdate: '1995-06-15' }));
  expect(r.statusCode).toBe(409);
  expect(JSON.parse(r.body).error).toBe('handle-taken');
});

// ── R8: uppercase handle is normalized ───────────────────────────────────────

test('R8 uppercase handle is lowercased before claim', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  let claimedWith = null;
  mockTransaction.mockImplementation(async (updateFn) => {
    claimedWith = updateFn(null); // null = available
    return { committed: true, snapshot: null };
  });
  const { handler } = load();
  await handler(makeEvent({ displayName: 'Klara', handle: 'KLARA', birthdate: '1995-06-15' }));
  expect(claimedWith).toBe('u1');
  // Verify the ref path used by checking mockRef call args
  const handlePath = mockRef.mock.calls.find(([p]) => p && p.startsWith('handles/'))?.[0];
  expect(handlePath).toBe('handles/klara');
});

// ── R9: successful registration ───────────────────────────────────────────────

test('R9 successful registration returns 200 with handle', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u42' });
  mockTransaction.mockImplementation(async (updateFn) => {
    updateFn(null); return { committed: true, snapshot: null };
  });
  const { handler } = load();
  const r = await handler(makeEvent({ displayName: 'Klara Faiss', handle: 'klara', birthdate: '1995-06-15' }));
  expect(r.statusCode).toBe(200);
  const body = JSON.parse(r.body);
  expect(body.ok).toBe(true);
  expect(body.handle).toBe('klara');
  expect(body.uid).toBe('u42');
});

test('R9b successful registration writes profile + userPrivate', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u42' });
  mockTransaction.mockImplementation(async (updateFn) => {
    updateFn(null); return { committed: true, snapshot: null };
  });
  const { handler } = load();
  await handler(makeEvent({ displayName: 'Klara Faiss', handle: 'klara', birthdate: '1995-06-15' }));
  expect(mockUpdate).toHaveBeenCalledTimes(1);
  const updateArg = mockUpdate.mock.calls[0][0];
  expect(updateArg).toHaveProperty('users/u42');
  expect(updateArg).toHaveProperty('userPrivate/u42/birthdate', '1995-06-15');
  expect(updateArg['users/u42'].handle).toBe('klara');
  expect(updateArg['users/u42'].registrationComplete).toBe(true);
  // Birthdate must NOT be in the public user profile
  expect(updateArg['users/u42']).not.toHaveProperty('birthdate');
});

// ── R10: cleanup on profile-write failure ─────────────────────────────────────

test('R10 handle is released if profile write fails', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  mockTransaction.mockImplementation(async (updateFn) => {
    updateFn(null); return { committed: true, snapshot: null };
  });
  mockUpdate.mockRejectedValue(new Error('DB write failed'));
  mockRemove.mockResolvedValue();
  const { handler } = load();
  const r = await handler(makeEvent({ displayName: 'Klara', handle: 'klara', birthdate: '1995-06-15' }));
  expect(r.statusCode).toBe(500);
  expect(mockRemove).toHaveBeenCalledTimes(1);
});
