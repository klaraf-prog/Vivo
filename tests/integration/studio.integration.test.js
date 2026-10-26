'use strict';

/**
 * Integration tests using Firebase Emulator Suite (Auth + RTDB).
 *
 * Run with:
 *   npm run test:integration
 *
 * Which calls:
 *   firebase emulators:exec --only auth,database "jest tests/integration"
 *
 * The emulators set FIREBASE_AUTH_EMULATOR_HOST and FIREBASE_DATABASE_EMULATOR_HOST
 * automatically when launched via `emulators:exec`.
 */

const admin = require('firebase-admin');
const { handler: approveHandler } = require('../../netlify/functions/studio-approve');
const { handler: rejectHandler }  = require('../../netlify/functions/studio-reject');
const { handler: submitHandler }  = require('../../netlify/functions/studio-submit');
const { handler: setRoleHandler } = require('../../netlify/functions/studio-set-role');

// ─── Emulator bootstrap ───────────────────────────────────────────────────────

let app;
let db;
let auth;

beforeAll(async () => {
  // Emulator env vars are set by `firebase emulators:exec`
  if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
    throw new Error('FIREBASE_DATABASE_EMULATOR_HOST not set — run via `npm run test:integration`');
  }

  // Use a dummy service account JSON; the emulator ignores credentials
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    type: 'service_account',
    project_id: 'demo-vivo-test',
    private_key_id: 'test',
    private_key: require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email: 'test@demo-vivo-test.iam.gserviceaccount.com',
    client_id: '123456789',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
  });
  process.env.FIREBASE_RTDB_URL = `http://127.0.0.1:9000/?ns=demo-vivo-test`;
  process.env.STUDIO_RESEARCHER_KEY = 'integration_test_key';

  // Reset singleton in _studio-shared so it picks up emulator env
  const shared = require('../../netlify/functions/_studio-shared');
  shared._resetForTesting();

  app = admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
    databaseURL: process.env.FIREBASE_RTDB_URL,
    projectId: 'demo-vivo-test',
  }, 'integration-test-' + Date.now());

  db = app.database();
  auth = app.auth();
}, 30000);

afterAll(async () => {
  // Clean emulator data and close app
  await db.ref('/').remove();
  await app.delete();
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  delete process.env.FIREBASE_RTDB_URL;
  delete process.env.STUDIO_RESEARCHER_KEY;
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createUser(email, role) {
  const user = await auth.createUser({ email, password: 'password123' });
  if (role) {
    await auth.setCustomUserClaims(user.uid, { studioRole: role });
  }
  return user;
}

async function getIdToken(uid) {
  // The Auth emulator's createCustomToken + exchange flow is the standard way
  // to get a valid ID token in emulator tests
  const customToken = await auth.createCustomToken(uid);

  // Exchange custom token for ID token via the emulator's REST endpoint
  const rawHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
  // Emulator binds on 127.0.0.1; strip any IPv6 bracket notation just in case
  const authHost = rawHost.replace(/^\[?::1\]?/, '127.0.0.1');
  const url = `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const data = await res.json();
  if (!data.idToken) throw new Error('Failed to get id token: ' + JSON.stringify(data));
  return data.idToken;
}

function post(token, body) {
  return {
    httpMethod: 'POST',
    headers: { 'authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  };
}

function parseBody(res) {
  return JSON.parse(res.body);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Integration: studio-submit', () => {
  test('researcher API key can submit a suggestion', async () => {
    const res = await submitHandler({
      httpMethod: 'POST',
      headers: { 'x-studio-key': 'integration_test_key' },
      body: JSON.stringify({
        title: 'Töpferkurs Berlin',
        description: 'Keramik für Anfänger',
        category: 'kreativ',
        city: 'Berlin',
      }),
    });
    expect(res.statusCode).toBe(201);
    const body = parseBody(res);
    expect(body.suggestionId).toBeDefined();

    // Verify it exists in RTDB
    const snap = await db.ref(`suggestions/${body.suggestionId}`).once('value');
    expect(snap.exists()).toBe(true);
    expect(snap.val().status).toBe('submitted');
    expect(snap.val().title).toBe('Töpferkurs Berlin');
  });

  test('duplicate submission is rejected with 409', async () => {
    const payload = {
      title: 'Duplicate Activity',
      description: 'This gets submitted twice',
      category: 'sport',
      city: 'Hamburg',
    };
    const res1 = await submitHandler({
      httpMethod: 'POST',
      headers: { 'x-studio-key': 'integration_test_key' },
      body: JSON.stringify(payload),
    });
    expect(res1.statusCode).toBe(201);

    const res2 = await submitHandler({
      httpMethod: 'POST',
      headers: { 'x-studio-key': 'integration_test_key' },
      body: JSON.stringify(payload),
    });
    expect(res2.statusCode).toBe(409);
    expect(parseBody(res2).error).toBe('duplicate');
  });

  test('unauthenticated request is rejected with 403', async () => {
    const res = await submitHandler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ title: 'Nope', description: 'x', category: 'sport', city: 'Berlin' }),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('Integration: studio-approve', () => {
  let editorUser;
  let editorToken;
  let submittedSugId;

  beforeAll(async () => {
    editorUser = await createUser('editor@integration.test', 'editor');
    editorToken = await getIdToken(editorUser.uid);

    // Submit a suggestion to approve
    const res = await submitHandler({
      httpMethod: 'POST',
      headers: { 'x-studio-key': 'integration_test_key' },
      body: JSON.stringify({
        title: 'Yoga im Park',
        description: 'Outdoor Yoga für alle Level',
        category: 'sport',
        city: 'München',
      }),
    });
    submittedSugId = parseBody(res).suggestionId;
  });

  test('editor can approve a submitted suggestion', async () => {
    const res = await approveHandler(post(editorToken, {
      suggestionId: submittedSugId,
      notes: 'Great suggestion',
    }));
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.activityId).toBe('act_' + submittedSugId);

    // Verify activity was created in RTDB
    const actSnap = await db.ref(`activities/${body.activityId}`).once('value');
    expect(actSnap.exists()).toBe(true);
    expect(actSnap.val().title).toBe('Yoga im Park');
    expect(actSnap.val().status).toBe('active');

    // Verify suggestion status updated
    const sugSnap = await db.ref(`suggestions/${submittedSugId}`).once('value');
    expect(sugSnap.val().status).toBe('approved');
    expect(sugSnap.val().activityId).toBe('act_' + submittedSugId);
  });

  test('approving same suggestion again is idempotent', async () => {
    const res = await approveHandler(post(editorToken, { suggestionId: submittedSugId }));
    expect(res.statusCode).toBe(200);
    expect(parseBody(res).idempotent).toBe(true);
    expect(parseBody(res).activityId).toBe('act_' + submittedSugId);
  });

  test('parallel approvals produce exactly one activity', async () => {
    // Submit a fresh suggestion
    const submitRes = await submitHandler({
      httpMethod: 'POST',
      headers: { 'x-studio-key': 'integration_test_key' },
      body: JSON.stringify({
        title: 'Parallel Yoga',
        description: 'Parallel test',
        category: 'sport',
        city: 'Berlin',
      }),
    });
    const parallelSugId = parseBody(submitRes).suggestionId;

    // Fire two concurrent approvals
    const [r1, r2] = await Promise.all([
      approveHandler(post(editorToken, { suggestionId: parallelSugId })),
      approveHandler(post(editorToken, { suggestionId: parallelSugId })),
    ]);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(parseBody(r1).activityId).toBe('act_' + parallelSugId);
    expect(parseBody(r2).activityId).toBe('act_' + parallelSugId);

    // Only one activity node should exist at that deterministic key
    const actSnap = await db.ref(`activities/act_${parallelSugId}`).once('value');
    expect(actSnap.exists()).toBe(true);
    expect(actSnap.val().title).toBe('Parallel Yoga');

    // Audit log: one entry (deterministic key means last-write-wins = same data)
    const logSnap = await db.ref(`studioAuditLog/log_approve_${parallelSugId}`).once('value');
    expect(logSnap.exists()).toBe(true);
    expect(logSnap.val().action).toBe('approve');
  });

  test('researcher cannot approve (403)', async () => {
    const researcher = await createUser('researcher@integration.test', 'researcher');
    const researcherToken = await getIdToken(researcher.uid);
    const res = await approveHandler(post(researcherToken, { suggestionId: submittedSugId }));
    expect(res.statusCode).toBe(403);
  });
});

describe('Integration: studio-reject', () => {
  let editorToken;
  let sugIdToReject;

  beforeAll(async () => {
    const editor = await createUser('editor2@integration.test', 'editor');
    editorToken = await getIdToken(editor.uid);

    const res = await submitHandler({
      httpMethod: 'POST',
      headers: { 'x-studio-key': 'integration_test_key' },
      body: JSON.stringify({
        title: 'Bad Activity',
        description: 'This should be rejected',
        category: 'kreativ',
        city: 'Berlin',
      }),
    });
    sugIdToReject = parseBody(res).suggestionId;
  });

  test('editor can reject a submitted suggestion', async () => {
    const res = await rejectHandler(post(editorToken, {
      suggestionId: sugIdToReject,
      reason: 'Not relevant to the city',
    }));
    expect(res.statusCode).toBe(200);
    expect(parseBody(res).ok).toBe(true);

    const snap = await db.ref(`suggestions/${sugIdToReject}`).once('value');
    expect(snap.val().status).toBe('rejected');
    expect(snap.val().reviewNotes).toBe('Not relevant to the city');
  });

  test('rejecting already-rejected suggestion returns 409', async () => {
    const res = await rejectHandler(post(editorToken, {
      suggestionId: sugIdToReject,
      reason: 'Again',
    }));
    expect(res.statusCode).toBe(409);
  });
});

describe('Integration: approve+reject sequential conflict protection', () => {
  // Note: True parallel approve+reject races require RTDB transactions, which the
  // Firebase RTDB emulator does not support via the Admin SDK. These tests verify
  // the sequential conflict guards that protect against the most common case
  // (approve finishes, then reject is attempted).
  // The parallel race is a documented residual risk in production.

  test('approve then reject: reject returns 409 (activityId guard)', async () => {
    const editor = await createUser('editor3@integration.test', 'editor');
    const token = await getIdToken(editor.uid);

    const submitRes = await submitHandler({
      httpMethod: 'POST',
      headers: { 'x-studio-key': 'integration_test_key' },
      body: JSON.stringify({
        title: 'Conflict Test Activity',
        description: 'Approve then try reject',
        category: 'sport',
        city: 'Berlin',
      }),
    });
    const sugId = parseBody(submitRes).suggestionId;

    // Approve succeeds
    const approveRes = await approveHandler(post(token, { suggestionId: sugId }));
    expect(approveRes.statusCode).toBe(200);

    // Subsequent reject must fail because activityId is now set
    const rejectRes = await rejectHandler(post(token, { suggestionId: sugId, reason: 'too late' }));
    expect(rejectRes.statusCode).toBe(409);
    expect(parseBody(rejectRes).error).toMatch(/already approved/);

    // Activity must still exist and suggestion must be approved
    const actSnap = await db.ref(`activities/act_${sugId}`).once('value');
    expect(actSnap.exists()).toBe(true);
    const sugSnap = await db.ref(`suggestions/${sugId}`).once('value');
    expect(sugSnap.val().status).toBe('approved');
  });

  test('reject then approve: approve returns 409 (status check)', async () => {
    const editor = await createUser('editor4@integration.test', 'editor');
    const token = await getIdToken(editor.uid);

    const submitRes = await submitHandler({
      httpMethod: 'POST',
      headers: { 'x-studio-key': 'integration_test_key' },
      body: JSON.stringify({
        title: 'Reject First Activity',
        description: 'Reject then try approve',
        category: 'kreativ',
        city: 'München',
      }),
    });
    const sugId = parseBody(submitRes).suggestionId;

    // Reject succeeds
    const rejectRes = await rejectHandler(post(token, { suggestionId: sugId, reason: 'not good' }));
    expect(rejectRes.statusCode).toBe(200);

    // Subsequent approve must fail because status is 'rejected'
    const approveRes = await approveHandler(post(token, { suggestionId: sugId }));
    expect(approveRes.statusCode).toBe(409);
    expect(parseBody(approveRes).error).toMatch(/rejected/);

    // No activity should have been created
    const actSnap = await db.ref(`activities/act_${sugId}`).once('value');
    expect(actSnap.exists()).toBe(false);
  });
});

describe('Integration: vivo paths isolation', () => {
  test('existing /users path is not touched by studio functions', async () => {
    // Write a fake vivo user
    await db.ref('users/vivo_user_1').set({ displayName: 'Test Vivo User', createdAt: Date.now() });

    // Submit via studio — should not modify /users
    await submitHandler({
      httpMethod: 'POST',
      headers: { 'x-studio-key': 'integration_test_key' },
      body: JSON.stringify({
        title: 'Isolation Check',
        description: 'Should not touch /users',
        category: 'natur',
        city: 'Berlin',
      }),
    });

    const snap = await db.ref('users/vivo_user_1').once('value');
    expect(snap.val().displayName).toBe('Test Vivo User');
  });
});
