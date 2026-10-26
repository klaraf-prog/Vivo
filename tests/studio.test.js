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
