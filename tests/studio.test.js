'use strict';

// ─── Shared mock functions (hoisted before jest.mock) ────────────────────────
const mockVerifyStudioToken = jest.fn();
const mockInitAdmin = jest.fn();
const mockMakeId = jest.fn((prefix) => `${prefix}_test_id`);
const mockDuplicateHash = jest.fn((city, cat, title) => `${city}:${cat}:${title}`);

jest.mock('../netlify/functions/_studio-shared', () => ({
  verifyStudioToken: (...args) => mockVerifyStudioToken(...args),
  initAdmin: (...args) => mockInitAdmin(...args),
  json: (statusCode, body) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  makeId: (...args) => mockMakeId(...args),
  duplicateHash: (...args) => mockDuplicateHash(...args),
}));

// ─── Handlers (loaded after mock is registered) ──────────────────────────────
const approveHandler = require('../netlify/functions/studio-approve').handler;
const rejectHandler  = require('../netlify/functions/studio-reject').handler;
const submitHandler  = require('../netlify/functions/studio-submit').handler;
const setRoleHandler = require('../netlify/functions/studio-set-role').handler;
const authHandler    = require('../netlify/functions/studio-auth').handler;
const updateHandler  = require('../netlify/functions/studio-update').handler;
const usersHandler   = require('../netlify/functions/studio-users').handler;

// ─── DB mock factory ─────────────────────────────────────────────────────────
function makeDbMock(snapData) {
  const mockUpdate = jest.fn().mockResolvedValue(undefined);
  const mockOnce = jest.fn().mockResolvedValue({
    exists: () => snapData !== null && snapData !== undefined,
    val: () => snapData,
  });
  const refObj = { once: mockOnce, update: mockUpdate };
  const mockRef = jest.fn().mockReturnValue(refObj);
  return { ref: mockRef, _mockOnce: mockOnce, _mockUpdate: mockUpdate };
}

function makeAuthAdminMock() {
  return { setCustomUserClaims: jest.fn().mockResolvedValue(undefined) };
}

function post(body, headers = {}) {
  return {
    httpMethod: 'POST',
    headers: { 'authorization': 'Bearer valid_token', ...headers },
    body: JSON.stringify(body),
  };
}

function parseBody(res) {
  return JSON.parse(res.body);
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// APPROVE
// ═══════════════════════════════════════════════════════════════════════════════
describe('studio-approve', () => {
  const editor = { uid: 'uid_editor', email: 'ed@test.com', studioRole: 'editor' };
  const submitted = {
    title: 'Test', description: 'Desc', category: 'kreativ', city: 'Berlin',
    status: 'submitted', activityId: null,
  };

  test('1. returns 405 for non-POST', async () => {
    const res = await approveHandler({ httpMethod: 'GET', headers: {}, body: '' });
    expect(res.statusCode).toBe(405);
  });

  test('2. returns 403 when no auth token', async () => {
    mockVerifyStudioToken.mockResolvedValue(null);
    const res = await approveHandler({ httpMethod: 'POST', headers: {}, body: '{}' });
    expect(res.statusCode).toBe(403);
  });

  test('3. returns 403 when researcher role (not allowed)', async () => {
    mockVerifyStudioToken.mockResolvedValue(null);
    const res = await approveHandler(post({ suggestionId: 'sug1' }));
    expect(res.statusCode).toBe(403);
  });

  test('4. returns 404 when suggestion not found', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const db = makeDbMock(null);
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await approveHandler(post({ suggestionId: 'sug_missing' }));
    expect(res.statusCode).toBe(404);
    expect(parseBody(res).error).toMatch(/not found/i);
  });

  test('5. returns 409 when status is draft (not submitted)', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const db = makeDbMock({ ...submitted, status: 'draft', activityId: null });
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await approveHandler(post({ suggestionId: 'sug1' }));
    expect(res.statusCode).toBe(409);
    expect(parseBody(res).error).toMatch(/draft/);
  });

  test('6. returns 409 when status is rejected (no activityId)', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const db = makeDbMock({ ...submitted, status: 'rejected', activityId: null });
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await approveHandler(post({ suggestionId: 'sug1' }));
    expect(res.statusCode).toBe(409);
  });

  test('7a. returns 200 idempotent when activityId already set (status: submitted)', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const db = makeDbMock({ ...submitted, status: 'submitted', activityId: 'act_sug1' });
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await approveHandler(post({ suggestionId: 'sug1' }));
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.activityId).toBe('act_sug1');
    expect(body.idempotent).toBe(true);
    expect(db._mockUpdate).not.toHaveBeenCalled();
  });

  test('7b. returns 200 idempotent when activityId already set (status: approved — real-world repeat)', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const db = makeDbMock({ ...submitted, status: 'approved', activityId: 'act_sug1' });
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await approveHandler(post({ suggestionId: 'sug1' }));
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.activityId).toBe('act_sug1');
    expect(body.idempotent).toBe(true);
    expect(db._mockUpdate).not.toHaveBeenCalled();
  });

  test('8. returns 200, creates activity with deterministic IDs, updates suggestion, writes audit log', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const db = makeDbMock(submitted);
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await approveHandler(post({ suggestionId: 'sug1', notes: 'Looks good' }));
    expect(res.statusCode).toBe(200);
    expect(parseBody(res).activityId).toBe('act_sug1');
    expect(db._mockUpdate).toHaveBeenCalledTimes(1);
    const updateArg = db._mockUpdate.mock.calls[0][0];
    expect(updateArg['activities/act_sug1']).toBeDefined();
    expect(updateArg['activities/act_sug1'].status).toBe('active');
    expect(updateArg['suggestions/sug1/status']).toBe('approved');
    expect(updateArg['suggestions/sug1/activityId']).toBe('act_sug1');
    expect(updateArg['studioAuditLog/log_approve_sug1']).toBeDefined();
    expect(updateArg['studioAuditLog/log_approve_sug1'].action).toBe('approve');
  });

  test('8c. approve passes new PWA fields (tagline, eyebrow, lat, lng) through to activity', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const sugWithNewFields = {
      ...submitted,
      tagline: 'Make something with your hands.',
      eyebrow: 'GET CREATIVE',
      lat: 50.9496,
      lng: 6.9197,
    };
    const db = makeDbMock(sugWithNewFields);
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await approveHandler(post({ suggestionId: 'sug1' }));
    expect(res.statusCode).toBe(200);
    const updateArg = db._mockUpdate.mock.calls[0][0];
    const act = updateArg['activities/act_sug1'];
    expect(act.tagline).toBe('Make something with your hands.');
    expect(act.eyebrow).toBe('GET CREATIVE');
    expect(act.lat).toBe(50.9496);
    expect(act.lng).toBe(6.9197);
  });

  test('8b. parallel approvals for same suggestion produce identical write payloads (race-safe)', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const db1 = makeDbMock(submitted);
    const db2 = makeDbMock(submitted);
    mockInitAdmin
      .mockReturnValueOnce({ database: () => db1 })
      .mockReturnValueOnce({ database: () => db2 });

    const [res1, res2] = await Promise.all([
      approveHandler(post({ suggestionId: 'sug_parallel' })),
      approveHandler(post({ suggestionId: 'sug_parallel' })),
    ]);

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(parseBody(res1).activityId).toBe('act_sug_parallel');
    expect(parseBody(res2).activityId).toBe('act_sug_parallel');

    // Both write calls use the same paths — RTDB last-write-wins on identical keys = idempotent
    const arg1 = db1._mockUpdate.mock.calls[0][0];
    const arg2 = db2._mockUpdate.mock.calls[0][0];
    expect(Object.keys(arg1)).toEqual(Object.keys(arg2));
    expect(arg1['activities/act_sug_parallel'].suggestionId).toBe('sug_parallel');
    expect(arg2['activities/act_sug_parallel'].suggestionId).toBe('sug_parallel');
    expect(arg1['studioAuditLog/log_approve_sug_parallel']).toBeDefined();
    expect(arg2['studioAuditLog/log_approve_sug_parallel']).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REJECT
// ═══════════════════════════════════════════════════════════════════════════════
describe('studio-reject', () => {
  const editor = { uid: 'uid_editor', email: 'ed@test.com', studioRole: 'editor' };
  const submitted = { title: 'Test', status: 'submitted', activityId: null };

  test('9. returns 403 when no auth', async () => {
    mockVerifyStudioToken.mockResolvedValue(null);
    const res = await rejectHandler({ httpMethod: 'POST', headers: {}, body: '{}' });
    expect(res.statusCode).toBe(403);
  });

  test('10. returns 400 when reason missing', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const db = makeDbMock(submitted);
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await rejectHandler(post({ suggestionId: 'sug1' }));
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toMatch(/reason/i);
  });

  test('11. returns 409 when status is already rejected', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const db = makeDbMock({ ...submitted, status: 'rejected' });
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await rejectHandler(post({ suggestionId: 'sug1', reason: 'duplicate' }));
    expect(res.statusCode).toBe(409);
    expect(parseBody(res).error).toMatch(/rejected/);
  });

  test('11b. returns 409 when activityId is already set (approve won the sequential race)', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const db = makeDbMock({ ...submitted, status: 'approved', activityId: 'act_sug1' });
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await rejectHandler(post({ suggestionId: 'sug1', reason: 'late reject' }));
    expect(res.statusCode).toBe(409);
    expect(parseBody(res).error).toMatch(/already approved/);
    expect(db._mockUpdate).not.toHaveBeenCalled();
  });

  test('12. returns 200 and sets status to rejected with audit log', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const db = makeDbMock(submitted);
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await rejectHandler(post({ suggestionId: 'sug1', reason: 'Not relevant' }));
    expect(res.statusCode).toBe(200);
    expect(parseBody(res).ok).toBe(true);
    const updateArg = db._mockUpdate.mock.calls[0][0];
    expect(updateArg['suggestions/sug1/status']).toBe('rejected');
    expect(updateArg['suggestions/sug1/reviewNotes']).toBe('Not relevant');
    expect(updateArg['studioAuditLog/log_test_id'].action).toBe('reject');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SUBMIT
// ═══════════════════════════════════════════════════════════════════════════════
describe('studio-submit', () => {
  const validPayload = {
    title: 'Töpferkurs', description: 'Keramik für Anfänger',
    category: 'kreativ', city: 'Berlin',
  };

  beforeEach(() => {
    process.env.STUDIO_RESEARCHER_KEY = 'secret_key_123';
  });

  afterEach(() => {
    delete process.env.STUDIO_RESEARCHER_KEY;
  });

  test('13. returns 403 when no auth and no API key', async () => {
    mockVerifyStudioToken.mockResolvedValue(null);
    const res = await submitHandler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify(validPayload),
    });
    expect(res.statusCode).toBe(403);
  });

  test('14. returns 403 when wrong API key', async () => {
    mockVerifyStudioToken.mockResolvedValue(null);
    const res = await submitHandler({
      httpMethod: 'POST',
      headers: { 'x-studio-key': 'wrong_key' },
      body: JSON.stringify(validPayload),
    });
    expect(res.statusCode).toBe(403);
  });

  test('15. returns 201 with valid researcher API key', async () => {
    const db = makeDbMock(null);
    mockInitAdmin.mockReturnValue({ database: () => db });
    mockDuplicateHash.mockReturnValue('berlin:kreativ:topferkurs');
    const res = await submitHandler({
      httpMethod: 'POST',
      headers: { 'x-studio-key': 'secret_key_123' },
      body: JSON.stringify(validPayload),
    });
    expect(res.statusCode).toBe(201);
    expect(parseBody(res).suggestionId).toBe('sug_test_id');
  });

  test('16. returns 400 when required fields missing', async () => {
    mockVerifyStudioToken.mockResolvedValue({ uid: 'u1', studioRole: 'editor' });
    const res = await submitHandler(post({ title: 'Only title' }));
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toMatch(/Missing required field/);
  });

  test('17. returns 409 when duplicate hash exists', async () => {
    mockVerifyStudioToken.mockResolvedValue({ uid: 'u1', studioRole: 'editor' });
    mockDuplicateHash.mockReturnValue('berlin:kreativ:topferkurs');
    const db = makeDbMock('sug_existing_id');
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await submitHandler(post(validPayload));
    expect(res.statusCode).toBe(409);
    expect(parseBody(res).error).toBe('duplicate');
    expect(parseBody(res).existingId).toBe('sug_existing_id');
  });

  test('18. returns 201 and creates suggestion with duplicate hash index', async () => {
    mockVerifyStudioToken.mockResolvedValue({ uid: 'u1', studioRole: 'editor' });
    mockDuplicateHash.mockReturnValue('berlin:kreativ:topferkurs');
    const db = makeDbMock(null);
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await submitHandler(post(validPayload));
    expect(res.statusCode).toBe(201);
    expect(parseBody(res).suggestionId).toBe('sug_test_id');
    const updateArg = db._mockUpdate.mock.calls[0][0];
    expect(updateArg['suggestions/sug_test_id']).toBeDefined();
    expect(updateArg['suggestions/sug_test_id'].status).toBe('submitted');
    expect(updateArg['suggestionHashes/berlin:kreativ:topferkurs']).toBe('sug_test_id');
    expect(updateArg['studioAuditLog/log_test_id'].action).toBe('submit');
  });

  test('18b. stores new optional PWA fields (tagline, eyebrow, lat, lng) when provided', async () => {
    mockVerifyStudioToken.mockResolvedValue({ uid: 'u1', studioRole: 'editor' });
    mockDuplicateHash.mockReturnValue('berlin:kreativ:topferkurs');
    const db = makeDbMock(null);
    mockInitAdmin.mockReturnValue({ database: () => db });
    const payload = {
      ...validPayload,
      tagline: 'Keramik für entspannte Nachmittage.',
      eyebrow: 'KREATIV WERDEN',
      lat: 52.52,
      lng: 13.405,
    };
    const res = await submitHandler(post(payload));
    expect(res.statusCode).toBe(201);
    const sug = db._mockUpdate.mock.calls[0][0]['suggestions/sug_test_id'];
    expect(sug.tagline).toBe('Keramik für entspannte Nachmittage.');
    expect(sug.eyebrow).toBe('KREATIV WERDEN');
    expect(sug.lat).toBe(52.52);
    expect(sug.lng).toBe(13.405);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SET-ROLE
// ═══════════════════════════════════════════════════════════════════════════════
describe('studio-set-role', () => {
  const superadmin = { uid: 'uid_super', email: 'super@test.com', studioRole: 'superadmin' };
  const mockAuthAdmin = makeAuthAdminMock();

  test('19. returns 403 when caller is not superadmin', async () => {
    mockVerifyStudioToken.mockResolvedValue(null);
    const res = await setRoleHandler(post({ targetUid: 'uid_other', role: 'editor' }));
    expect(res.statusCode).toBe(403);
  });

  test('20. returns 403 when trying to change own role', async () => {
    mockVerifyStudioToken.mockResolvedValue(superadmin);
    const res = await setRoleHandler(post({ targetUid: superadmin.uid, role: 'editor' }));
    expect(res.statusCode).toBe(403);
    expect(parseBody(res).error).toMatch(/own role/i);
  });

  test('21. returns 400 when role is invalid', async () => {
    mockVerifyStudioToken.mockResolvedValue(superadmin);
    const res = await setRoleHandler(post({ targetUid: 'uid_other', role: 'wizard' }));
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toMatch(/Invalid role/);
  });

  test('22. returns 200 and sets custom claim for another user', async () => {
    mockVerifyStudioToken.mockResolvedValue(superadmin);
    const db = makeDbMock(null);
    mockInitAdmin.mockReturnValue({
      auth: () => mockAuthAdmin,
      database: () => db,
    });
    const res = await setRoleHandler(post({
      targetUid: 'uid_other',
      targetEmail: 'other@test.com',
      role: 'editor',
    }));
    expect(res.statusCode).toBe(200);
    expect(parseBody(res).ok).toBe(true);
    expect(parseBody(res).role).toBe('editor');
    expect(mockAuthAdmin.setCustomUserClaims).toHaveBeenCalledWith('uid_other', { studioRole: 'editor' });
    const updateArg = db._mockUpdate.mock.calls[0][0];
    expect(updateArg['studioAdminUsers/uid_other'].role).toBe('editor');
    expect(updateArg['studioAuditLog/log_test_id'].action).toBe('set_role');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STUDIO-AUTH (server-side sign-in for Codespaces)
// ═══════════════════════════════════════════════════════════════════════════════
describe('studio-auth', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' };
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  function makeAuthPost(body) {
    return { httpMethod: 'POST', headers: {}, body: JSON.stringify(body) };
  }

  function mockFetch(status, body) {
    return jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
  }

  test('23. returns 405 for non-POST', async () => {
    const res = await authHandler({ httpMethod: 'GET', headers: {}, body: '' });
    expect(res.statusCode).toBe(405);
  });

  test('24. returns 400 when email missing', async () => {
    const res = await authHandler(makeAuthPost({ password: 'pw' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/email/);
  });

  test('25. returns 503 when FIREBASE_AUTH_EMULATOR_HOST not set', async () => {
    delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    const res = await authHandler(makeAuthPost({ email: 'a@b.com', password: 'pw' }));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toMatch(/not configured/);
  });

  test('26. returns 503 when emulator unreachable', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await authHandler(makeAuthPost({ email: 'a@b.com', password: 'pw' }));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toMatch(/unreachable/);
  });

  test('27. returns 401 when emulator rejects credentials', async () => {
    mockFetch(400, { error: { message: 'INVALID_PASSWORD' } });
    const res = await authHandler(makeAuthPost({ email: 'a@b.com', password: 'wrong' }));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('INVALID_PASSWORD');
  });

  test('28. returns 403 when account has no studioRole', async () => {
    mockFetch(200, { idToken: 'tok123', localId: 'uid1' });
    const mockAuth = { verifyIdToken: jest.fn().mockResolvedValue({ uid: 'uid1', email: 'a@b.com' }) };
    mockInitAdmin.mockReturnValue({ auth: () => mockAuth });
    const res = await authHandler(makeAuthPost({ email: 'a@b.com', password: 'pw' }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/studio role/);
  });

  test('29. returns 200 with idToken, email, role, uid on success', async () => {
    mockFetch(200, { idToken: 'tok_abc', localId: 'uid_super' });
    const mockAuth = {
      verifyIdToken: jest.fn().mockResolvedValue({
        uid: 'uid_super', email: 'admin@test.local', studioRole: 'superadmin',
      }),
    };
    mockInitAdmin.mockReturnValue({ auth: () => mockAuth });
    const res = await authHandler(makeAuthPost({ email: 'admin@test.local', password: 'pw' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.idToken).toBe('tok_abc');
    expect(body.email).toBe('admin@test.local');
    expect(body.role).toBe('superadmin');
    expect(body.uid).toBe('uid_super');
  });
});

// ── activities endpoint ───────────────────────────────────────────────────────
describe('activities', () => {
  const activitiesHandler = require('../netlify/functions/activities').handler;

  function makeGet() {
    return { httpMethod: 'GET', headers: {}, body: null };
  }

  beforeEach(() => jest.clearAllMocks());

  test('30. returns 405 for non-GET', async () => {
    const res = await activitiesHandler({ httpMethod: 'POST', headers: {}, body: null });
    expect(res.statusCode).toBe(405);
  });

  test('31. returns active activities without auth', async () => {
    const db = makeDbMock(null);
    const mockOnceActive = jest.fn().mockResolvedValue({
      forEach: (cb) => {
        cb({ key: 'act_1', val: () => ({ title: 'Pottery Workshop', status: 'active' }) });
      },
    });
    db.ref.mockReturnValue({
      orderByChild: () => ({ equalTo: () => ({ once: mockOnceActive }) }),
    });
    mockInitAdmin.mockReturnValue({ database: () => db });

    const res = await activitiesHandler(makeGet());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.activities).toHaveProperty('act_1');
    expect(body.activities.act_1.title).toBe('Pottery Workshop');
  });

  test('33. strips internal fields from public response', async () => {
    const db = makeDbMock(null);
    const mockOnceActive = jest.fn().mockResolvedValue({
      forEach: (cb) => {
        cb({
          key: 'act_1',
          val: () => ({
            title: 'Pottery Workshop',
            status: 'active',
            publishedAt: 1700000000000,
            // internal fields that must not appear in response
            publishedBy: 'uid_editor',
            suggestionId: 'sug_123',
            updatedAt: 1700000001000,
          }),
        });
      },
    });
    db.ref.mockReturnValue({
      orderByChild: () => ({ equalTo: () => ({ once: mockOnceActive }) }),
    });
    mockInitAdmin.mockReturnValue({ database: () => db });

    const res = await activitiesHandler(makeGet());
    const body = JSON.parse(res.body);
    const act  = body.activities.act_1;
    expect(act.title).toBe('Pottery Workshop');
    expect(act.publishedAt).toBe(1700000000000);  // allowed
    expect(act.publishedBy).toBeUndefined();       // stripped
    expect(act.suggestionId).toBeUndefined();      // stripped
    expect(act.updatedAt).toBeUndefined();         // stripped
    expect(act.status).toBeUndefined();            // stripped (always 'active', redundant)
  });

  test('32. returns empty activities object when none exist', async () => {
    const db = makeDbMock(null);
    const mockOnceEmpty = jest.fn().mockResolvedValue({ forEach: () => {} });
    db.ref.mockReturnValue({
      orderByChild: () => ({ equalTo: () => ({ once: mockOnceEmpty }) }),
    });
    mockInitAdmin.mockReturnValue({ database: () => db });

    const res = await activitiesHandler(makeGet());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.activities).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STUDIO-UPDATE
// ═══════════════════════════════════════════════════════════════════════════════
describe('studio-update', () => {
  const editor = { uid: 'uid_editor', email: 'ed@test.com', studioRole: 'editor' };

  test('33. returns 405 for non-POST', async () => {
    const res = await updateHandler({ httpMethod: 'GET', headers: {}, body: '' });
    expect(res.statusCode).toBe(405);
  });

  test('34. returns 403 when unauthenticated', async () => {
    mockVerifyStudioToken.mockResolvedValue(null);
    const res = await updateHandler({ httpMethod: 'POST', headers: {}, body: '{}' });
    expect(res.statusCode).toBe(403);
  });

  test('35. returns 400 when target is invalid', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const res = await updateHandler(post({ target: 'invalid', id: 'sug1', title: 'New' }));
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toMatch(/target/i);
  });

  test('36. returns 400 when id is missing', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const res = await updateHandler(post({ target: 'suggestion', title: 'New' }));
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toMatch(/id/i);
  });

  test('37. returns 400 when no editable fields provided', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const db = makeDbMock({ title: 'Old', status: 'submitted' });
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await updateHandler(post({ target: 'suggestion', id: 'sug1', nonexistentField: 'x' }));
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toMatch(/no editable/i);
  });

  test('38. returns 404 when suggestion not found', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const db = makeDbMock(null);
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await updateHandler(post({ target: 'suggestion', id: 'missing', title: 'New' }));
    expect(res.statusCode).toBe(404);
    expect(parseBody(res).error).toMatch(/not found/i);
  });

  test('39. updates suggestion and returns updated fields', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const db = makeDbMock({ title: 'Old Title', status: 'submitted' });
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await updateHandler(post({
      target: 'suggestion', id: 'sug1',
      title: 'New Title', tagline: 'New Tagline',
    }));
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.ok).toBe(true);
    expect(body.updatedFields).toContain('title');
    expect(body.updatedFields).toContain('tagline');
    expect(body.updatedFields).toContain('updatedAt');
    expect(db._mockUpdate).toHaveBeenCalledTimes(1);
  });

  test('40. coerces lat/lng to Number', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const db = makeDbMock({ title: 'T', status: 'submitted' });
    mockInitAdmin.mockReturnValue({ database: () => db });
    await updateHandler(post({ target: 'suggestion', id: 'sug1', lat: '51.5', lng: '7.1' }));
    const updateArg = db._mockUpdate.mock.calls[0][0];
    expect(typeof updateArg['suggestions/sug1/lat']).toBe('number');
    expect(updateArg['suggestions/sug1/lat']).toBeCloseTo(51.5);
  });

  test('41. updates published activity', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const db = makeDbMock({ title: 'Old Act', status: 'active' });
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await updateHandler(post({
      target: 'activity', id: 'act1',
      title: 'Updated Act', city: 'Köln',
    }));
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.ok).toBe(true);
    expect(body.updatedFields).toContain('title');
    expect(body.updatedFields).toContain('city');
  });

  test('42. writes an audit log entry', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const db = makeDbMock({ title: 'T', status: 'submitted' });
    mockInitAdmin.mockReturnValue({ database: () => db });
    await updateHandler(post({ target: 'suggestion', id: 'sug1', title: 'New' }));
    const updateArg = db._mockUpdate.mock.calls[0][0];
    const auditKey = Object.keys(updateArg).find(k => k.startsWith('studioAuditLog/'));
    expect(auditKey).toBeDefined();
    expect(updateArg[auditKey].action).toBe('edit');
    expect(updateArg[auditKey].actorEmail).toBe('ed@test.com');
  });
});

// ─── studio-users ─────────────────────────────────────────────────────────────
describe('studio-users', () => {
  const superadmin = { uid: 'sa1', email: 'sa@test.com', role: 'superadmin' };
  const editor     = { uid: 'ed1', email: 'ed@test.com', role: 'editor' };

  function get(headers = {}) {
    return { httpMethod: 'GET', headers: { 'authorization': 'Bearer valid_token', ...headers } };
  }

  const sampleUsers = [
    {
      uid: 'u1',
      email: 'a@test.com',
      displayName: 'Alice',
      customClaims: { studioRole: 'editor' },
      metadata: { creationTime: 'Mon, 01 Jan 2024 00:00:00 GMT', lastSignInTime: 'Mon, 01 Jan 2024 10:00:00 GMT' },
    },
    {
      uid: 'u2',
      email: 'b@test.com',
      displayName: null,
      customClaims: null,
      metadata: { creationTime: 'Tue, 02 Jan 2024 00:00:00 GMT', lastSignInTime: null },
    },
  ];

  test('43. returns 405 for non-GET', async () => {
    const res = await usersHandler({ httpMethod: 'POST', headers: {} });
    expect(res.statusCode).toBe(405);
  });

  test('44. returns 403 when unauthenticated', async () => {
    mockVerifyStudioToken.mockResolvedValue(null);
    const res = await usersHandler(get());
    expect(res.statusCode).toBe(403);
  });

  test('45. returns 403 for researcher role', async () => {
    mockVerifyStudioToken.mockResolvedValue({ uid: 'r1', email: 'r@test.com', role: 'researcher' });
    mockInitAdmin.mockReturnValue({ auth: () => ({ listUsers: jest.fn() }) });
    mockVerifyStudioToken.mockResolvedValue(null);
    const res = await usersHandler(get());
    expect(res.statusCode).toBe(403);
  });

  test('46. editor can list users', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    const mockListUsers = jest.fn().mockResolvedValue({ users: sampleUsers });
    mockInitAdmin.mockReturnValue({ auth: () => ({ listUsers: mockListUsers }) });
    const res = await usersHandler(get());
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.users).toHaveLength(2);
    expect(mockListUsers).toHaveBeenCalledWith(1000);
  });

  test('47. returns correct user fields', async () => {
    mockVerifyStudioToken.mockResolvedValue(superadmin);
    mockInitAdmin.mockReturnValue({ auth: () => ({ listUsers: jest.fn().mockResolvedValue({ users: sampleUsers }) }) });
    const res = await usersHandler(get());
    const body = parseBody(res);
    const u1 = body.users.find(u => u.uid === 'u1');
    expect(u1.email).toBe('a@test.com');
    expect(u1.displayName).toBe('Alice');
    expect(u1.studioRole).toBe('editor');
    expect(typeof u1.createdAt).toBe('number');
    expect(typeof u1.lastSignIn).toBe('number');
  });

  test('48. user without claims has null studioRole', async () => {
    mockVerifyStudioToken.mockResolvedValue(editor);
    mockInitAdmin.mockReturnValue({ auth: () => ({ listUsers: jest.fn().mockResolvedValue({ users: sampleUsers }) }) });
    const res = await usersHandler(get());
    const body = parseBody(res);
    const u2 = body.users.find(u => u.uid === 'u2');
    expect(u2.studioRole).toBeNull();
  });
});

// ─── user-data ────────────────────────────────────────────────────────────────
describe('user-data', () => {
  const userDataHandler = require('../netlify/functions/user-data').handler;

  function get(token = 'valid_token') {
    return { httpMethod: 'GET', headers: { authorization: `Bearer ${token}` } };
  }

  const sampleDbData = {
    profile:    { displayName: 'Klara', city: 'Cologne' },
    userEvents: { ev1: { title: 'Run', date: '2026-10-24' } },
    userSpaces: { 'Weekend Crew': true },
  };

  test('49. returns 405 for non-GET', async () => {
    const res = await userDataHandler({ httpMethod: 'POST', headers: {} });
    expect(res.statusCode).toBe(405);
  });

  test('50. returns 401 when no Authorization header', async () => {
    const res = await userDataHandler({ httpMethod: 'GET', headers: {} });
    expect(res.statusCode).toBe(401);
  });

  test('51. returns 401 when token verification fails', async () => {
    const mockVerifyIdToken = jest.fn().mockRejectedValue(new Error('invalid token'));
    mockInitAdmin.mockReturnValue({ auth: () => ({ verifyIdToken: mockVerifyIdToken }), database: () => ({}) });
    const res = await userDataHandler(get('bad_token'));
    expect(res.statusCode).toBe(401);
  });

  test('52. returns profile, userEvents, userSpaces for valid token', async () => {
    const uid = 'user123';
    const mockVerifyIdToken = jest.fn().mockResolvedValue({ uid });

    const makeSnap = (data) => ({ val: () => data });
    const mockOnce = jest.fn()
      .mockResolvedValueOnce(makeSnap(sampleDbData.profile))
      .mockResolvedValueOnce(makeSnap(sampleDbData.userEvents))
      .mockResolvedValueOnce(makeSnap(sampleDbData.userSpaces));
    const refObj = { once: mockOnce };
    const mockRef = jest.fn().mockReturnValue(refObj);

    mockInitAdmin.mockReturnValue({
      auth: () => ({ verifyIdToken: mockVerifyIdToken }),
      database: () => ({ ref: mockRef }),
    });

    const res = await userDataHandler(get());
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.uid).toBe(uid);
    expect(body.profile).toEqual(sampleDbData.profile);
    expect(body.userEvents).toEqual(sampleDbData.userEvents);
    expect(body.userSpaces).toEqual(sampleDbData.userSpaces);
  });

  test('53. reads correct RTDB paths', async () => {
    const uid = 'user456';
    const mockVerifyIdToken = jest.fn().mockResolvedValue({ uid });

    const makeSnap = (data) => ({ val: () => data });
    const mockOnce = jest.fn().mockResolvedValue(makeSnap(null));
    const refObj = { once: mockOnce };
    const mockRef = jest.fn().mockReturnValue(refObj);

    mockInitAdmin.mockReturnValue({
      auth: () => ({ verifyIdToken: mockVerifyIdToken }),
      database: () => ({ ref: mockRef }),
    });

    await userDataHandler(get());
    const calledPaths = mockRef.mock.calls.map(c => c[0]);
    expect(calledPaths).toContain(`users/${uid}`);
    expect(calledPaths).toContain(`userEvents/${uid}`);
    expect(calledPaths).toContain(`userSpaces/${uid}`);
  });

  test('54. returns empty objects when RTDB paths are null', async () => {
    const uid = 'user789';
    const mockVerifyIdToken = jest.fn().mockResolvedValue({ uid });
    const makeSnap = () => ({ val: () => null });
    const mockOnce = jest.fn().mockResolvedValue(makeSnap());
    const refObj = { once: mockOnce };
    const mockRef = jest.fn().mockReturnValue(refObj);

    mockInitAdmin.mockReturnValue({
      auth: () => ({ verifyIdToken: mockVerifyIdToken }),
      database: () => ({ ref: mockRef }),
    });

    const res = await userDataHandler(get());
    const body = parseBody(res);
    expect(body.profile).toBeNull();
    expect(body.userEvents).toEqual({});
    expect(body.userSpaces).toEqual({});
  });
});
