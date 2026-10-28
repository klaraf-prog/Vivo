'use strict';
// Tests for verifyUserToken() in _studio-shared.js
// Mocks firebase-admin directly; does NOT use the module-level mock from studio.test.js

const FAKE_SA_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'vivo-mvp',
  private_key_id: 'key1',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4VB\n-----END RSA PRIVATE KEY-----\n',
  client_email: 'firebase-adminsdk@vivo-mvp.iam.gserviceaccount.com',
  client_id: '123',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
});

const mockVerifyIdToken = jest.fn();
const mockInitializeApp = jest.fn();
const mockAuth          = jest.fn(() => ({ verifyIdToken: mockVerifyIdToken }));

jest.mock('firebase-admin', () => ({
  apps: [],
  credential: { cert: jest.fn(sa => ({ type: 'cert', sa })) },
  initializeApp: (...args) => mockInitializeApp(...args),
}));

// Reset module between tests so _app / _initError singletons are cleared
beforeEach(() => {
  jest.resetModules();
  // Reset apps array
  require('firebase-admin').apps.length = 0;
  mockVerifyIdToken.mockReset();
  mockInitializeApp.mockReset();
  mockInitializeApp.mockReturnValue({ auth: mockAuth });
});

function load() {
  return require('../netlify/functions/_studio-shared');
}

// ── A1-A3: missing / malformed Authorization header ──────────────────────────

test('A1 no Authorization header → 401 missing-token', async () => {
  const { verifyUserToken } = load();
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = FAKE_SA_JSON;
  process.env.FIREBASE_RTDB_URL             = 'https://vivo-mvp-default-rtdb.firebaseio.com';
  const r = await verifyUserToken('');
  expect(r).toMatchObject({ decoded: null, errorStatus: 401, errorCode: 'missing-token' });
});

test('A2 Authorization without Bearer → 401 missing-token', async () => {
  const { verifyUserToken } = load();
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = FAKE_SA_JSON;
  process.env.FIREBASE_RTDB_URL             = 'https://vivo-mvp-default-rtdb.firebaseio.com';
  const r = await verifyUserToken('Basic sometoken');
  expect(r).toMatchObject({ decoded: null, errorStatus: 401, errorCode: 'missing-token' });
});

test('A3 Bearer with only whitespace → 401 missing-token', async () => {
  const { verifyUserToken } = load();
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = FAKE_SA_JSON;
  process.env.FIREBASE_RTDB_URL             = 'https://vivo-mvp-default-rtdb.firebaseio.com';
  const r = await verifyUserToken('Bearer   ');
  expect(r).toMatchObject({ decoded: null, errorStatus: 401, errorCode: 'missing-token' });
});

// ── A4-A6: missing env vars → 503 ────────────────────────────────────────────

test('A4 missing FIREBASE_SERVICE_ACCOUNT_JSON → 503', async () => {
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  process.env.FIREBASE_RTDB_URL = 'https://vivo-mvp-default-rtdb.firebaseio.com';
  const { verifyUserToken } = load();
  const r = await verifyUserToken('Bearer validtoken');
  expect(r).toMatchObject({ decoded: null, errorStatus: 503, errorCode: 'missing-env' });
});

test('A5 missing FIREBASE_RTDB_URL → 503', async () => {
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = FAKE_SA_JSON;
  delete process.env.FIREBASE_RTDB_URL;
  const { verifyUserToken } = load();
  const r = await verifyUserToken('Bearer validtoken');
  expect(r).toMatchObject({ decoded: null, errorStatus: 503, errorCode: 'missing-env' });
});

test('A6 malformed FIREBASE_SERVICE_ACCOUNT_JSON → 503', async () => {
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = 'not-valid-json{{{';
  process.env.FIREBASE_RTDB_URL             = 'https://vivo-mvp-default-rtdb.firebaseio.com';
  const { verifyUserToken } = load();
  const r = await verifyUserToken('Bearer validtoken');
  expect(r).toMatchObject({ decoded: null, errorStatus: 503, errorCode: 'invalid-config' });
});

// ── A7: init error caching ────────────────────────────────────────────────────

test('A7 initializeApp called at most once after first failure', async () => {
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  process.env.FIREBASE_RTDB_URL = 'https://vivo-mvp-default-rtdb.firebaseio.com';
  const { verifyUserToken } = load();
  await verifyUserToken('Bearer t1');
  await verifyUserToken('Bearer t2');
  await verifyUserToken('Bearer t3');
  // initializeApp should never be called when env vars are missing
  expect(mockInitializeApp).not.toHaveBeenCalled();
});

// ── A8-A10: Firebase token errors → 401 ──────────────────────────────────────

test('A8 expired token → 401', async () => {
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = FAKE_SA_JSON;
  process.env.FIREBASE_RTDB_URL             = 'https://vivo-mvp-default-rtdb.firebaseio.com';
  mockVerifyIdToken.mockRejectedValue(Object.assign(new Error('Token expired'), { errorInfo: { code: 'auth/id-token-expired' } }));
  const { verifyUserToken } = load();
  const r = await verifyUserToken('Bearer expiredtoken');
  expect(r).toMatchObject({ decoded: null, errorStatus: 401, errorCode: 'auth/id-token-expired' });
});

test('A9 wrong-project token → 401', async () => {
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = FAKE_SA_JSON;
  process.env.FIREBASE_RTDB_URL             = 'https://vivo-mvp-default-rtdb.firebaseio.com';
  mockVerifyIdToken.mockRejectedValue(Object.assign(new Error('Wrong project'), { errorInfo: { code: 'auth/argument-error' } }));
  const { verifyUserToken } = load();
  const r = await verifyUserToken('Bearer wrongprojecttoken');
  expect(r).toMatchObject({ decoded: null, errorStatus: 401, errorCode: 'auth/argument-error' });
});

test('A10 revoked token → 401', async () => {
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = FAKE_SA_JSON;
  process.env.FIREBASE_RTDB_URL             = 'https://vivo-mvp-default-rtdb.firebaseio.com';
  mockVerifyIdToken.mockRejectedValue(Object.assign(new Error('Revoked'), { errorInfo: { code: 'auth/id-token-revoked' } }));
  const { verifyUserToken } = load();
  const r = await verifyUserToken('Bearer revokedtoken');
  expect(r).toMatchObject({ decoded: null, errorStatus: 401, errorCode: 'auth/id-token-revoked' });
});

// ── A11: valid token ──────────────────────────────────────────────────────────

test('A11 valid token → decoded user returned', async () => {
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = FAKE_SA_JSON;
  process.env.FIREBASE_RTDB_URL             = 'https://vivo-mvp-default-rtdb.firebaseio.com';
  const fakeDecoded = { uid: 'user123', email: 'test@example.com' };
  mockVerifyIdToken.mockResolvedValue(fakeDecoded);
  const { verifyUserToken } = load();
  const r = await verifyUserToken('Bearer validtoken123');
  expect(r).toMatchObject({ decoded: fakeDecoded, errorStatus: null, errorCode: null });
});
