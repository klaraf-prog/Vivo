'use strict';
// Unit tests for notification-related Netlify functions.

const FAKE_SA_JSON = JSON.stringify({
  type: 'service_account', project_id: 'someday-test',
  private_key_id: 'k1',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4VB\n-----END RSA PRIVATE KEY-----\n',
  client_email: 'firebase-adminsdk@someday-test.iam.gserviceaccount.com',
  client_id: '1', auth_uri: '', token_uri: '',
});

const mockVerifyIdToken = jest.fn();
const mockOnce  = jest.fn();
const mockSet   = jest.fn();
const mockUpdate = jest.fn();
const mockPush  = jest.fn(() => ({ key: 'newKey123' }));
const mockRemove = jest.fn();

const mockRef = jest.fn(() => ({
  once: mockOnce,
  set: mockSet,
  update: mockUpdate,
  push: mockPush,
  remove: mockRemove,
}));
const mockDatabase = jest.fn(() => ({ ref: mockRef }));
const mockAuth_    = jest.fn(() => ({ verifyIdToken: mockVerifyIdToken }));
const mockInitializeApp = jest.fn(() => ({ auth: mockAuth_, database: mockDatabase }));
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
  mockOnce.mockReset();
  mockSet.mockReset();
  mockUpdate.mockReset();
  mockPush.mockReset();
  mockPush.mockReturnValue({ key: 'newKey123' });
  mockRemove.mockReset();
  mockInitializeApp.mockReset();
  mockInitializeApp.mockReturnValue({ auth: mockAuth_, database: mockDatabase });

  mockRef.mockImplementation((path) => {
    if (path === '/' || path === undefined) return mockRootRef;
    return { once: mockOnce, set: mockSet, update: mockUpdate, push: mockPush, remove: mockRemove };
  });
  mockUpdate.mockResolvedValue();
  mockSet.mockResolvedValue();

  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = FAKE_SA_JSON;
  process.env.FIREBASE_RTDB_URL             = 'https://someday-test.firebaseio.com';
});

function makeEvent(body, token = 'Bearer tok') {
  return { httpMethod: 'POST', headers: { authorization: token }, body: JSON.stringify(body) };
}

// ── notify-mark-read ──────────────────────────────────────────────────────────

describe('notify-mark-read', () => {
  function load() { return require('../netlify/functions/notify-mark-read'); }

  test('GET → 405', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
    const { handler } = load();
    const r = await handler({ httpMethod: 'GET', headers: {}, body: '' });
    expect(r.statusCode).toBe(405);
  });

  test('missing token → 401', async () => {
    const { handler } = load();
    const r = await handler({ httpMethod: 'POST', headers: {}, body: '{}' });
    expect(r.statusCode).toBe(401);
  });

  test('missing notifId → 400', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
    const { handler } = load();
    const r = await handler(makeEvent({}));
    expect(r.statusCode).toBe(400);
  });

  test('notification not found → 404', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
    mockOnce.mockResolvedValue({ exists: () => false });
    const { handler } = load();
    const r = await handler(makeEvent({ notifId: 'notif_123' }));
    expect(r.statusCode).toBe(404);
  });

  test('marks notification as read → 200', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
    mockOnce.mockResolvedValue({ exists: () => true });
    const { handler } = load();
    const r = await handler(makeEvent({ notifId: 'notif_123' }));
    expect(r.statusCode).toBe(200);
    expect(mockSet).toHaveBeenCalledTimes(1);
    // set() was called with a number (timestamp)
    expect(typeof mockSet.mock.calls[0][0]).toBe('number');
  });
});

// ── notify-reminders ──────────────────────────────────────────────────────────

describe('notify-reminders', () => {
  function load() { return require('../netlify/functions/notify-reminders'); }

  test('GET → 405', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
    const { handler } = load();
    const r = await handler({ httpMethod: 'GET', headers: {}, body: '' });
    expect(r.statusCode).toBe(405);
  });

  test('missing token → 401', async () => {
    const { handler } = load();
    const r = await handler({ httpMethod: 'POST', headers: {}, body: '' });
    expect(r.statusCode).toBe(401);
  });

  test('no dabei events → 200 created:0', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
    // userEvents snap: empty
    mockOnce.mockResolvedValueOnce({ val: () => ({}) });
    const { handler } = load();
    const r = await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: '' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).created).toBe(0);
  });

  test('dabei event in future outside 25h window → no reminder', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
    const farFuture = new Date(Date.now() + 48 * 3600 * 1000);
    const dateStr = farFuture.toISOString().slice(0, 10);
    mockOnce
      .mockResolvedValueOnce({ val: () => ({ ev1: 'dabei' }) }) // userEvents
      .mockResolvedValueOnce({ val: () => ({}) })                // existing notifications
      .mockResolvedValueOnce({ exists: () => true, val: () => ({ title: 'Test', date: dateStr, time: '18:00' }) }); // event
    const { handler } = load();
    const r = await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: '' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).created).toBe(0);
  });

  test('dabei event within 25h window → reminder created', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
    // Event is 2 hours from now
    const soon = new Date(Date.now() + 2 * 3600 * 1000);
    const dateStr = soon.toISOString().slice(0, 10);
    const timeStr = `${String(soon.getHours()).padStart(2,'0')}:${String(soon.getMinutes()).padStart(2,'0')}`;
    mockOnce
      .mockResolvedValueOnce({ val: () => ({ ev1: 'dabei' }) }) // userEvents
      .mockResolvedValueOnce({ val: () => ({}) })                // existing notifications
      .mockResolvedValueOnce({ exists: () => true, val: () => ({ title: 'Pottery', date: dateStr, time: timeStr }) }); // event
    const { handler } = load();
    const r = await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: '' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).created).toBe(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const written = mockUpdate.mock.calls[0][0];
    const notifKey = Object.keys(written)[0];
    expect(notifKey).toMatch(/^notifications\/u1\//);
    expect(written[notifKey].type).toBe('reminder');
    expect(written[notifKey].eventId).toBe('ev1');
    expect(written[notifKey].readAt).toBeNull();
  });

  test('reminder already exists → no duplicate', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
    const soon = new Date(Date.now() + 2 * 3600 * 1000);
    const dateStr = soon.toISOString().slice(0, 10);
    const timeStr = `${String(soon.getHours()).padStart(2,'0')}:00`;
    mockOnce
      .mockResolvedValueOnce({ val: () => ({ ev1: 'dabei' }) })
      .mockResolvedValueOnce({ val: () => ({              // existing notifications with reminder for ev1
        n1: { type: 'reminder', eventId: 'ev1', readAt: null, createdAt: Date.now() }
      }) })
      .mockResolvedValueOnce({ exists: () => true, val: () => ({ title: 'Pottery', date: dateStr, time: timeStr }) });
    const { handler } = load();
    const r = await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: '' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).created).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('cancelled event → no reminder', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
    const soon = new Date(Date.now() + 2 * 3600 * 1000);
    const dateStr = soon.toISOString().slice(0, 10);
    mockOnce
      .mockResolvedValueOnce({ val: () => ({ ev1: 'dabei' }) })
      .mockResolvedValueOnce({ val: () => ({}) })
      .mockResolvedValueOnce({ exists: () => true, val: () => ({ title: 'Pottery', date: dateStr, time: '18:00', cancelled: true }) });
    const { handler } = load();
    const r = await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: '' });
    expect(JSON.parse(r.body).created).toBe(0);
  });

  test('past event → no reminder', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1' });
    const past = new Date(Date.now() - 2 * 3600 * 1000);
    const dateStr = past.toISOString().slice(0, 10);
    const timeStr = `${String(past.getHours()).padStart(2,'0')}:00`;
    mockOnce
      .mockResolvedValueOnce({ val: () => ({ ev1: 'dabei' }) })
      .mockResolvedValueOnce({ val: () => ({}) })
      .mockResolvedValueOnce({ exists: () => true, val: () => ({ title: 'Pottery', date: dateStr, time: timeStr }) });
    const { handler } = load();
    const r = await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: '' });
    expect(JSON.parse(r.body).created).toBe(0);
  });
});
