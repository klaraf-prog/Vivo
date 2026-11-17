'use strict';
// Unit tests for netlify/functions/event-rsvp.js
// ER0: module loads, ER1: method guard, ER2: auth guard, ER3: validation,
// ER4: creator can RSVP, ER5: invited user can RSVP, ER6: space-member can RSVP,
// ER7: stranger is denied, ER8: writes correct RTDB paths

const FAKE_SA_JSON = JSON.stringify({
  type: 'service_account', project_id: 'someday-test',
  private_key_id: 'k1',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4VB\n-----END RSA PRIVATE KEY-----\n',
  client_email: 'firebase-adminsdk@someday-test.iam.gserviceaccount.com',
  client_id: '1', auth_uri: '', token_uri: '',
});

const mockVerifyIdToken = jest.fn();
const mockRootUpdate    = jest.fn();
const mockPushKey       = jest.fn(() => ({ key: 'rsvp_new_key' }));

// Per-path once responses, set via mockOnceMap before each test
let mockOnceMap = {};

const mockRef = jest.fn((path) => ({
  once: jest.fn().mockImplementation(async () => mockOnceMap[path] || { val: () => null, exists: () => false }),
  update: mockRootUpdate,
  push: mockPushKey,
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
  mockRootUpdate.mockReset().mockResolvedValue();
  mockRef.mockClear();
  mockOnceMap = {};
  mockInitializeApp.mockReset();
  mockInitializeApp.mockReturnValue({ auth: mockAuth_, database: mockDatabase });

  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = FAKE_SA_JSON;
  process.env.FIREBASE_RTDB_URL             = 'https://someday-test.firebaseio.com';
});

function load() { return require('../netlify/functions/event-rsvp'); }

function makeEvent(body, token = 'Bearer valid') {
  return { httpMethod: 'POST', headers: { authorization: token }, body: JSON.stringify(body) };
}

// ── ER0: module loads ─────────────────────────────────────────────────────────

test('ER0 module loads without SyntaxError', () => {
  expect(() => load()).not.toThrow();
});

// ── ER1: method guard ─────────────────────────────────────────────────────────

test('ER1 GET → 405', async () => {
  const { handler } = load();
  const r = await handler({ httpMethod: 'GET', headers: {}, body: '' });
  expect(r.statusCode).toBe(405);
});

// ── ER2: auth guard ───────────────────────────────────────────────────────────

test('ER2 missing token → 401', async () => {
  const { handler } = load();
  const r = await handler({ httpMethod: 'POST', headers: {}, body: '{}' });
  expect(r.statusCode).toBe(401);
});

// ── ER3: validation ───────────────────────────────────────────────────────────

test('ER3 invalid status → 400', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  const { handler } = load();
  const r = await handler(makeEvent({ eventId: 'ev1', status: 'attending' }));
  expect(r.statusCode).toBe(400);
  expect(JSON.parse(r.body).error).toMatch(/status/);
});

test('ER3b missing eventId → 400', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  const { handler } = load();
  const r = await handler(makeEvent({ status: 'dabei' }));
  expect(r.statusCode).toBe(400);
  expect(JSON.parse(r.body).error).toMatch(/eventId/);
});

test('ER3c event not found → 404', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
  // events/ev1 returns null
  const { handler } = load();
  const r = await handler(makeEvent({ eventId: 'ev1', status: 'dabei' }));
  expect(r.statusCode).toBe(404);
});

// ── ER4: creator can RSVP ─────────────────────────────────────────────────────

test('ER4 event creator can RSVP without invite → 200', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'creator1' });
  mockOnceMap['events/ev1'] = { val: () => ({ createdBy: 'creator1', title: 'Test' }), exists: () => true };
  mockOnceMap['users/creator1'] = { val: () => ({ displayName: 'Alice' }), exists: () => true };
  mockOnceMap['events/ev1/rsvps'] = { val: () => null, exists: () => false };

  const { handler } = load();
  const r = await handler(makeEvent({ eventId: 'ev1', status: 'dabei' }));
  expect(r.statusCode).toBe(200);
  expect(JSON.parse(r.body).ok).toBe(true);
});

// ── ER5: invited user can RSVP ────────────────────────────────────────────────

test('ER5 invited user can RSVP → 200', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'guest1' });
  mockOnceMap['events/ev1'] = { val: () => ({ createdBy: 'creator1', title: 'Test' }), exists: () => true };
  mockOnceMap['invites/guest1/ev1'] = { val: () => true, exists: () => true };
  mockOnceMap['users/guest1'] = { val: () => ({ displayName: 'Bob' }), exists: () => true };
  mockOnceMap['events/ev1/rsvps'] = { val: () => null, exists: () => false };

  const { handler } = load();
  const r = await handler(makeEvent({ eventId: 'ev1', status: 'dabei' }));
  expect(r.statusCode).toBe(200);
});

// ── ER6: space member (no personal invite) can RSVP ──────────────────────────

test('ER6 space member without personal invite can RSVP → 200', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'member1' });
  mockOnceMap['events/ev1'] = { val: () => ({ createdBy: 'creator1', title: 'Test' }), exists: () => true };
  // No personal invite
  mockOnceMap['invites/member1/ev1']   = { val: () => null, exists: () => false };
  mockOnceMap['userEvents/member1/ev1'] = { val: () => null, exists: () => false };
  // Space membership
  mockOnceMap['userSpaces/member1']            = { val: () => ({ sp1: true }), exists: () => true };
  mockOnceMap['spaceEvents/sp1/ev1']           = { val: () => true, exists: () => true };
  mockOnceMap['users/member1']                 = { val: () => ({ displayName: 'Carol' }), exists: () => true };
  mockOnceMap['events/ev1/rsvps']              = { val: () => null, exists: () => false };

  const { handler } = load();
  const r = await handler(makeEvent({ eventId: 'ev1', status: 'dabei' }));
  expect(r.statusCode).toBe(200);
  expect(JSON.parse(r.body).ok).toBe(true);
});

// ── ER7: stranger is denied ───────────────────────────────────────────────────

test('ER7 stranger with no connection to event → 403', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'stranger1' });
  mockOnceMap['events/ev1'] = { val: () => ({ createdBy: 'creator1', title: 'Test' }), exists: () => true };
  mockOnceMap['invites/stranger1/ev1']    = { val: () => null, exists: () => false };
  mockOnceMap['userEvents/stranger1/ev1'] = { val: () => null, exists: () => false };
  mockOnceMap['userSpaces/stranger1']     = { val: () => null, exists: () => false };

  const { handler } = load();
  const r = await handler(makeEvent({ eventId: 'ev1', status: 'dabei' }));
  expect(r.statusCode).toBe(403);
  expect(JSON.parse(r.body).error).toMatch(/Access denied/);
});

// ── ER8: writes correct RTDB paths ───────────────────────────────────────────

test('ER8 successful RSVP writes userEvents and rsvps paths', async () => {
  mockVerifyIdToken.mockResolvedValue({ uid: 'creator1' });
  mockOnceMap['events/ev1'] = { val: () => ({ createdBy: 'creator1', title: 'Test' }), exists: () => true };
  mockOnceMap['users/creator1'] = { val: () => ({ displayName: 'Alice' }), exists: () => true };
  mockOnceMap['events/ev1/rsvps'] = { val: () => null, exists: () => false };

  const { handler } = load();
  await handler(makeEvent({ eventId: 'ev1', status: 'dabei' }));

  expect(mockRootUpdate).toHaveBeenCalledTimes(1);
  const arg = mockRootUpdate.mock.calls[0][0];
  expect(arg).toHaveProperty('userEvents/creator1/ev1', 'dabei');
  expect(Object.keys(arg).some(p => p.startsWith('events/ev1/rsvps/'))).toBe(true);
});
