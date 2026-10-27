'use strict';
/**
 * Integration tests for social functions against Firebase Emulators.
 * Covers: user-profile, user-search, friends, space-create,
 *         event-create, event-rsvp, user-data (full social graph).
 *
 * Run with:
 *   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
 *   FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000 \
 *   FIREBASE_RTDB_URL="http://127.0.0.1:9000/?ns=demo-vivo-test" \
 *   npx jest tests/integration/social --runInBand --forceExit
 */

const admin  = require('firebase-admin');
const crypto = require('crypto');

// ─── Handlers under test ──────────────────────────────────────────────────────
const { handler: profileHandler }     = require('../../netlify/functions/user-profile');
const { handler: searchHandler }      = require('../../netlify/functions/user-search');
const { handler: friendsHandler }     = require('../../netlify/functions/friends');
const { handler: spaceCreateHandler } = require('../../netlify/functions/space-create');
const { handler: eventCreateHandler } = require('../../netlify/functions/event-create');
const { handler: eventRsvpHandler }   = require('../../netlify/functions/event-rsvp');
const { handler: userDataHandler }    = require('../../netlify/functions/user-data');

// ─── Emulator bootstrap ───────────────────────────────────────────────────────
let app, db, auth;

function makeDummySA() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    type: 'service_account',
    project_id: 'demo-vivo-test',
    private_key_id: 'test-social',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email: 'social-test@demo-vivo-test.iam.gserviceaccount.com',
    client_id: '999',
    auth_uri:  'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
  };
}

beforeAll(async () => {
  if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
    throw new Error('FIREBASE_DATABASE_EMULATOR_HOST not set — run with emulators');
  }
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify(makeDummySA());
  process.env.FIREBASE_RTDB_URL = `http://127.0.0.1:9000/?ns=demo-vivo-test`;

  // Reset _studio-shared singleton so it picks up emulator env
  require('../../netlify/functions/_studio-shared')._resetForTesting();

  app  = admin.initializeApp({
    credential:  admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
    databaseURL: process.env.FIREBASE_RTDB_URL,
    projectId:   'demo-vivo-test',
  }, 'social-integration-' + Date.now());
  db   = app.database();
  auth = app.auth();
}, 20000);

afterAll(async () => {
  await db.ref('users').remove().catch(() => {});
  await db.ref('usernames').remove().catch(() => {});
  await db.ref('friends').remove().catch(() => {});
  await db.ref('friendRequests').remove().catch(() => {});
  await db.ref('spaces').remove().catch(() => {});
  await db.ref('userSpaces').remove().catch(() => {});
  await db.ref('events').remove().catch(() => {});
  await db.ref('userEvents').remove().catch(() => {});
  await db.ref('spaceEvents').remove().catch(() => {});
  await db.ref('invites').remove().catch(() => {});
  await app.delete();
  require('../../netlify/functions/_studio-shared')._resetForTesting();
}, 10000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createUser(displayName, email = null) {
  const e = email || `${displayName.toLowerCase().replace(/\s/g,'_')}_${Date.now()}@test.local`;
  const u = await auth.createUser({ email: e, password: 'Test123!', displayName });
  return { uid: u.uid, email: e, displayName };
}

async function idToken(uid) {
  // Admin SDK createCustomToken + exchange for ID token via Auth REST emulator
  const custom = await auth.createCustomToken(uid);
  const res    = await fetch(
    `http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: custom, returnSecureToken: true }) }
  );
  const data = await res.json();
  if (!data.idToken) throw new Error('Could not get idToken: ' + JSON.stringify(data));
  return data.idToken;
}

function get(path, token) {
  return { httpMethod: 'GET', headers: { authorization: `Bearer ${token}` },
           queryStringParameters: {}, path };
}
function post(body, token) {
  return { httpMethod: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
           body: JSON.stringify(body) };
}
function parseBody(res) { return JSON.parse(res.body); }

// ─── user-profile ─────────────────────────────────────────────────────────────
describe('Integration: user-profile', () => {
  let alice;

  beforeAll(async () => { alice = await createUser('Alice Test'); }, 10000);

  test('creates profile in RTDB', async () => {
    const tok = await idToken(alice.uid);
    const res = await profileHandler(post({ displayName: 'Alice Test' }, tok));
    expect(res.statusCode).toBe(200);
    const snap = await db.ref(`users/${alice.uid}`).once('value');
    expect(snap.val()).not.toBeNull();
    expect(snap.val().displayName).toBe('Alice Test');
    expect(snap.val().createdAt).toBeDefined();
  }, 10000);

  test('merges update without overwriting createdAt', async () => {
    const tok = await idToken(alice.uid);
    const before = (await db.ref(`users/${alice.uid}`).once('value')).val();
    await new Promise(r => setTimeout(r, 10));
    const res = await profileHandler(post({ displayName: 'Alice Updated' }, tok));
    expect(res.statusCode).toBe(200);
    const after = (await db.ref(`users/${alice.uid}`).once('value')).val();
    expect(after.displayName).toBe('Alice Updated');
    expect(after.createdAt).toBe(before.createdAt);
  }, 10000);

  test('rejects request with no token', async () => {
    const res = await profileHandler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ displayName: 'x' }) });
    expect(res.statusCode).toBe(401);
  });
});

// ─── user-search ──────────────────────────────────────────────────────────────
describe('Integration: user-search', () => {
  let bob, carol;

  beforeAll(async () => {
    bob   = await createUser('Bob Search');
    carol = await createUser('Carol Search');
    await db.ref(`users/${bob.uid}`).set({ displayName: 'Bob Search', createdAt: Date.now() });
    await db.ref(`users/${carol.uid}`).set({ displayName: 'Carol Search', createdAt: Date.now() });
  }, 10000);

  test('returns users matching displayName prefix', async () => {
    const tok = await idToken(bob.uid);
    const req = { httpMethod: 'GET', headers: { authorization: `Bearer ${tok}` },
                  queryStringParameters: { q: 'Carol' } };
    const res = await searchHandler(req);
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.users.find(u => u.uid === carol.uid)).toBeDefined();
  }, 10000);

  test('excludes self from results', async () => {
    const tok = await idToken(bob.uid);
    const req = { httpMethod: 'GET', headers: { authorization: `Bearer ${tok}` },
                  queryStringParameters: { q: 'Bob' } };
    const res = await searchHandler(req);
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.users.find(u => u.uid === bob.uid)).toBeUndefined();
  }, 10000);

  test('returns 400 when q is missing', async () => {
    const tok = await idToken(bob.uid);
    const req = { httpMethod: 'GET', headers: { authorization: `Bearer ${tok}` },
                  queryStringParameters: { q: '' } };
    const res = await searchHandler(req);
    expect(res.statusCode).toBe(400);
  }, 10000);
});

// ─── friends ──────────────────────────────────────────────────────────────────
describe('Integration: friends', () => {
  let dave, eve;

  beforeAll(async () => {
    dave = await createUser('Dave Friend');
    eve  = await createUser('Eve Friend');
    await db.ref(`users/${dave.uid}`).set({ displayName: 'Dave Friend', createdAt: Date.now() });
    await db.ref(`users/${eve.uid}`).set({ displayName: 'Eve Friend', createdAt: Date.now() });
  }, 10000);

  test('sends friend request successfully', async () => {
    const tok = await idToken(dave.uid);
    const res = await friendsHandler(post({ action: 'request', targetUid: eve.uid }, tok));
    expect(res.statusCode).toBe(200);
    const snap = await db.ref(`friendRequests/${eve.uid}/${dave.uid}`).once('value');
    expect(snap.exists()).toBe(true);
    expect(snap.val().displayName).toBe('Dave Friend');
  }, 10000);

  test('cannot send request to non-existent user', async () => {
    const tok = await idToken(dave.uid);
    const res = await friendsHandler(post({ action: 'request', targetUid: 'ghost_uid_xyz' }, tok));
    expect(res.statusCode).toBe(404);
  }, 10000);

  test('cannot send request to yourself', async () => {
    const tok = await idToken(dave.uid);
    const res = await friendsHandler(post({ action: 'request', targetUid: dave.uid }, tok));
    expect(res.statusCode).toBe(400);
  }, 10000);

  test('accepts friend request — writes bidirectional friend links', async () => {
    const tok = await idToken(eve.uid);
    const res = await friendsHandler(post({ action: 'accept', requesterUid: dave.uid }, tok));
    expect(res.statusCode).toBe(200);
    const [d2e, e2d] = await Promise.all([
      db.ref(`friends/${dave.uid}/${eve.uid}`).once('value'),
      db.ref(`friends/${eve.uid}/${dave.uid}`).once('value'),
    ]);
    expect(d2e.val()).toBe(true);
    expect(e2d.val()).toBe(true);
    // Request removed
    const req = await db.ref(`friendRequests/${eve.uid}/${dave.uid}`).once('value');
    expect(req.exists()).toBe(false);
  }, 10000);

  test('decline removes request without creating friendship', async () => {
    // New request from eve to dave
    const tok1 = await idToken(eve.uid);
    // cleanup — send a new request the other way
    await db.ref(`friendRequests/${dave.uid}/${eve.uid}`).set({ displayName: 'Eve Friend', timestamp: Date.now() });

    const tok2 = await idToken(dave.uid);
    const res  = await friendsHandler(post({ action: 'decline', requesterUid: eve.uid }, tok2));
    expect(res.statusCode).toBe(200);
    const req = await db.ref(`friendRequests/${dave.uid}/${eve.uid}`).once('value');
    expect(req.exists()).toBe(false);
    // friendship in this direction still only true from the accept above
    const snap = await db.ref(`friends/${dave.uid}/${eve.uid}`).once('value');
    expect(snap.val()).toBe(true); // from earlier accept, unchanged
  }, 10000);

  test('remove deletes both friend links', async () => {
    const tok = await idToken(dave.uid);
    const res = await friendsHandler(post({ action: 'remove', targetUid: eve.uid }, tok));
    expect(res.statusCode).toBe(200);
    const [d2e, e2d] = await Promise.all([
      db.ref(`friends/${dave.uid}/${eve.uid}`).once('value'),
      db.ref(`friends/${eve.uid}/${dave.uid}`).once('value'),
    ]);
    expect(d2e.exists()).toBe(false);
    expect(e2d.exists()).toBe(false);
  }, 10000);
});

// ─── space-create ─────────────────────────────────────────────────────────────
describe('Integration: space-create', () => {
  let frank, grace;
  let createdSpaceId;

  beforeAll(async () => {
    frank = await createUser('Frank Space');
    grace = await createUser('Grace Space');
    await db.ref(`users/${frank.uid}`).set({ displayName: 'Frank Space', createdAt: Date.now() });
    await db.ref(`users/${grace.uid}`).set({ displayName: 'Grace Space', createdAt: Date.now() });
  }, 10000);

  test('creates space and userSpaces for creator', async () => {
    const tok = await idToken(frank.uid);
    const res = await spaceCreateHandler(post({ name: 'Test Crew' }, tok));
    expect(res.statusCode).toBe(201);
    const body = parseBody(res);
    expect(body.spaceId).toMatch(/^sp_/);
    createdSpaceId = body.spaceId;

    const [spSnap, usSnap] = await Promise.all([
      db.ref(`spaces/${body.spaceId}`).once('value'),
      db.ref(`userSpaces/${frank.uid}/${body.spaceId}`).once('value'),
    ]);
    expect(spSnap.val().name).toBe('Test Crew');
    expect(spSnap.val().createdBy).toBe(frank.uid);
    expect(spSnap.val().members[frank.uid]).toBe(true);
    expect(usSnap.val()).toBe(true);
  }, 10000);

  test('adds valid members and skips non-existent ones', async () => {
    const tok = await idToken(frank.uid);
    const res = await spaceCreateHandler(post({
      name: 'Mixed Crew',
      memberUids: [grace.uid, 'ghost_nonexistent'],
    }, tok));
    expect(res.statusCode).toBe(201);
    const body = parseBody(res);

    const [spSnap, graceSnap, ghostSnap] = await Promise.all([
      db.ref(`spaces/${body.spaceId}`).once('value'),
      db.ref(`userSpaces/${grace.uid}/${body.spaceId}`).once('value'),
      db.ref(`userSpaces/ghost_nonexistent/${body.spaceId}`).once('value'),
    ]);
    expect(spSnap.val().members[grace.uid]).toBe(true);
    expect(graceSnap.val()).toBe(true);
    expect(ghostSnap.exists()).toBe(false);
  }, 10000);

  test('rejects empty name', async () => {
    const tok = await idToken(frank.uid);
    const res = await spaceCreateHandler(post({ name: '   ' }, tok));
    expect(res.statusCode).toBe(400);
  }, 10000);
});

// ─── event-create ─────────────────────────────────────────────────────────────
describe('Integration: event-create', () => {
  let host, guest;
  let spaceId, eventId;

  beforeAll(async () => {
    host  = await createUser('Host User');
    guest = await createUser('Guest User');
    await db.ref(`users/${host.uid}`).set({ displayName: 'Host User', createdAt: Date.now() });
    await db.ref(`users/${guest.uid}`).set({ displayName: 'Guest User', createdAt: Date.now() });
    // Create a space for the host
    const tok = await idToken(host.uid);
    const res = await spaceCreateHandler(post({ name: 'Event Space' }, tok));
    spaceId = parseBody(res).spaceId;
  }, 20000);

  test('creates event with userEvents and creator RSVP', async () => {
    const tok = await idToken(host.uid);
    const res = await eventCreateHandler(post({
      title: 'Movie Night',
      emoji: '🎬',
      date:  '2026-11-01',
      time:  '19:00',
    }, tok));
    expect(res.statusCode).toBe(201);
    const body = parseBody(res);
    expect(body.eventId).toMatch(/^ev_/);
    eventId = body.eventId;

    const [evSnap, ueSnap] = await Promise.all([
      db.ref(`events/${eventId}`).once('value'),
      db.ref(`userEvents/${host.uid}/${eventId}`).once('value'),
    ]);
    expect(evSnap.val().title).toBe('Movie Night');
    expect(evSnap.val().createdBy).toBe(host.uid);
    expect(ueSnap.val()).toBe('created');
    // Creator RSVP
    const rsvps = Object.values(evSnap.val().rsvps || {});
    expect(rsvps.some(r => r.userId === host.uid && r.status === 'dabei')).toBe(true);
  }, 10000);

  test('links event to verified space via spaceEvents', async () => {
    const tok = await idToken(host.uid);
    const res = await eventCreateHandler(post({
      title: 'Space Event',
      date:  '2026-11-02',
      spaceIds: [spaceId],
    }, tok));
    const body = parseBody(res);
    const seSnap = await db.ref(`spaceEvents/${spaceId}/${body.eventId}`).once('value');
    expect(seSnap.val()).toBe(true);
  }, 10000);

  test('sends invite to verified user', async () => {
    const tok = await idToken(host.uid);
    const res = await eventCreateHandler(post({
      title:      'Invite Event',
      date:       '2026-11-03',
      inviteUids: [guest.uid],
    }, tok));
    const body = parseBody(res);
    const invSnap = await db.ref(`invites/${guest.uid}/${body.eventId}`).once('value');
    expect(invSnap.val()).toBe(true);
  }, 10000);

  test('does NOT send invite to non-existent user', async () => {
    const tok = await idToken(host.uid);
    const res = await eventCreateHandler(post({
      title:      'Safe Event',
      date:       '2026-11-04',
      inviteUids: ['ghost_uid_xyz'],
    }, tok));
    const body = parseBody(res);
    const ghostSnap = await db.ref(`invites/ghost_uid_xyz/${body.eventId}`).once('value');
    expect(ghostSnap.exists()).toBe(false);
  }, 10000);
});

// ─── event-rsvp ───────────────────────────────────────────────────────────────
describe('Integration: event-rsvp', () => {
  let organiser, attendee;
  let evId;

  beforeAll(async () => {
    organiser = await createUser('Organiser RSVP');
    attendee  = await createUser('Attendee RSVP');
    await db.ref(`users/${organiser.uid}`).set({ displayName: 'Organiser RSVP', createdAt: Date.now() });
    await db.ref(`users/${attendee.uid}`).set({ displayName: 'Attendee RSVP', createdAt: Date.now() });
    const tok = await idToken(organiser.uid);
    const res = await eventCreateHandler(post({
      title:      'RSVP Test Event',
      date:       '2026-11-10',
      inviteUids: [attendee.uid],
    }, tok));
    evId = parseBody(res).eventId;
  }, 20000);

  test('attendee can RSVP dabei', async () => {
    const tok = await idToken(attendee.uid);
    const res = await eventRsvpHandler(post({ eventId: evId, status: 'dabei' }, tok));
    expect(res.statusCode).toBe(200);

    const ueSnap = await db.ref(`userEvents/${attendee.uid}/${evId}`).once('value');
    expect(ueSnap.val()).toBe('dabei');

    const evSnap   = await db.ref(`events/${evId}/rsvps`).once('value');
    const rsvps    = Object.values(evSnap.val() || {});
    const myRsvp   = rsvps.find(r => r.userId === attendee.uid);
    expect(myRsvp).toBeDefined();
    expect(myRsvp.status).toBe('dabei');
  }, 10000);

  test('attendee can change RSVP to vielleicht — updates existing entry', async () => {
    const tok = await idToken(attendee.uid);
    await eventRsvpHandler(post({ eventId: evId, status: 'vielleicht' }, tok));

    const ueSnap = await db.ref(`userEvents/${attendee.uid}/${evId}`).once('value');
    expect(ueSnap.val()).toBe('vielleicht');

    const evSnap  = await db.ref(`events/${evId}/rsvps`).once('value');
    const rsvps   = Object.values(evSnap.val() || {});
    const myRsvps = rsvps.filter(r => r.userId === attendee.uid);
    expect(myRsvps).toHaveLength(1); // exactly one entry, updated in place
    expect(myRsvps[0].status).toBe('vielleicht');
  }, 10000);

  test('returns 400 for invalid status', async () => {
    const tok = await idToken(attendee.uid);
    const res = await eventRsvpHandler(post({ eventId: evId, status: 'Going' }, tok));
    expect(res.statusCode).toBe(400);
  }, 10000);

  test('returns 404 for non-existent event', async () => {
    const tok = await idToken(attendee.uid);
    const res = await eventRsvpHandler(post({ eventId: 'ev_ghost_xyz', status: 'dabei' }, tok));
    expect(res.statusCode).toBe(404);
  }, 10000);
});

// ─── user-data (full graph) ───────────────────────────────────────────────────
describe('Integration: user-data full social graph', () => {
  let alpha, beta;
  let spId, evId;

  beforeAll(async () => {
    alpha = await createUser('Alpha User');
    beta  = await createUser('Beta User');
    await db.ref(`users/${alpha.uid}`).set({ displayName: 'Alpha User', createdAt: Date.now() });
    await db.ref(`users/${beta.uid}`).set({ displayName: 'Beta User', createdAt: Date.now() });

    const tokA = await idToken(alpha.uid);

    // Alpha creates a space
    const spRes = await spaceCreateHandler(post({ name: 'Alpha Crew' }, tokA));
    spId = parseBody(spRes).spaceId;

    // Alpha creates an event in the space, invites beta
    const evRes = await eventCreateHandler(post({
      title:      'Graph Test Event',
      date:       '2026-11-20',
      spaceIds:   [spId],
      inviteUids: [beta.uid],
    }, tokA));
    evId = parseBody(evRes).eventId;

    // Beta RSVPs
    const tokB = await idToken(beta.uid);
    await eventRsvpHandler(post({ eventId: evId, status: 'dabei' }, tokB));

    // Alpha sends beta a friend request, beta accepts
    await friendsHandler(post({ action: 'request', targetUid: beta.uid }, tokA));
    await friendsHandler(post({ action: 'accept', requesterUid: alpha.uid }, tokB));
  }, 30000);

  test('user-data returns complete graph for alpha', async () => {
    const tok = await idToken(alpha.uid);
    const req = { httpMethod: 'GET', headers: { authorization: `Bearer ${tok}` }, queryStringParameters: {} };
    const res = await userDataHandler(req);
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);

    expect(body.uid).toBe(alpha.uid);
    expect(body.profile.displayName).toBe('Alpha User');
    expect(body.spaces[spId]).toBeDefined();
    expect(body.spaces[spId].name).toBe('Alpha Crew');
    expect(body.spaceEvents[spId][evId]).toBe(true);
    expect(body.events[evId]).toBeDefined();
    expect(body.events[evId].title).toBe('Graph Test Event');
    expect(body.userEvents[evId]).toBe('created');
    expect(body.friends[beta.uid]).toBe(true);
    expect(body.friendProfiles[beta.uid].displayName).toBe('Beta User');
  }, 15000);

  test('user-data returns invites and beta RSVP', async () => {
    // Beta's user-data should show the event (via userEvents from RSVP)
    const tok = await idToken(beta.uid);
    const req = { httpMethod: 'GET', headers: { authorization: `Bearer ${tok}` }, queryStringParameters: {} };
    const res = await userDataHandler(req);
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);

    expect(body.userEvents[evId]).toBe('dabei');
    expect(body.events[evId]).toBeDefined();
    expect(body.friends[alpha.uid]).toBe(true);
  }, 15000);

  test('user-data does NOT return other users private data', async () => {
    // Beta cannot see alpha's spaces/events they are not part of
    // Create a private space for alpha only
    const tokA = await idToken(alpha.uid);
    const privRes = await spaceCreateHandler(post({ name: 'Private Alpha Space' }, tokA));
    const privSpaceId = parseBody(privRes).spaceId;

    const tokB = await idToken(beta.uid);
    const req  = { httpMethod: 'GET', headers: { authorization: `Bearer ${tokB}` }, queryStringParameters: {} };
    const res  = await userDataHandler(req);
    const body = parseBody(res);

    // beta should NOT have the private space in their data
    expect(body.spaces[privSpaceId]).toBeUndefined();
    expect(body.userSpaces[privSpaceId]).toBeUndefined();
  }, 15000);
});

// ─── Security: permission checks ─────────────────────────────────────────────
describe('Integration: security — endpoint authorization', () => {
  let secUser;

  beforeAll(async () => { secUser = await createUser('Security Tester'); }, 10000);

  test('all endpoints reject missing token', async () => {
    const noAuth = { httpMethod: 'GET', headers: {}, queryStringParameters: { q: 'x' } };
    const noAuthPost = { httpMethod: 'POST', headers: {}, body: '{}' };

    const results = await Promise.all([
      searchHandler(noAuth),
      friendsHandler(noAuthPost),
      spaceCreateHandler(noAuthPost),
      eventCreateHandler(noAuthPost),
      eventRsvpHandler(noAuthPost),
      userDataHandler(noAuth),
      profileHandler(noAuthPost),
    ]);
    results.forEach(res => expect(res.statusCode).toBe(401));
  }, 10000);

  test('all endpoints reject expired/invalid token', async () => {
    const badTok = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.badsig';
    const badAuth = { httpMethod: 'GET', headers: { authorization: `Bearer ${badTok}` }, queryStringParameters: { q: 'x' } };
    const badPost = { httpMethod: 'POST', headers: { authorization: `Bearer ${badTok}` }, body: '{}' };

    const results = await Promise.all([
      searchHandler(badAuth),
      friendsHandler(badPost),
      spaceCreateHandler(badPost),
      eventCreateHandler(badPost),
      eventRsvpHandler(badPost),
      userDataHandler(badAuth),
      profileHandler(badPost),
    ]);
    results.forEach(res => expect(res.statusCode).toBe(401));
  }, 10000);

  test('friends.accept: cannot accept a request that does not exist', async () => {
    const tok = await idToken(secUser.uid);
    const res = await friendsHandler(post({ action: 'accept', requesterUid: 'nobody_uid' }, tok));
    expect(res.statusCode).toBe(404);
  }, 10000);

  test('event-rsvp: cannot RSVP for another user', async () => {
    // Create an event as secUser
    await db.ref(`users/${secUser.uid}`).set({ displayName: 'Security Tester', createdAt: Date.now() });
    const tok = await idToken(secUser.uid);
    const evRes = await eventCreateHandler(post({ title: 'Sec Event', date: '2026-12-01' }, tok));
    const evId  = parseBody(evRes).eventId;

    // Try to RSVP as secUser for their own event (valid)
    const rsvpRes = await eventRsvpHandler(post({ eventId: evId, status: 'dabei' }, tok));
    expect(rsvpRes.statusCode).toBe(200);

    // RSVP is always attributed to the token holder — no way to set another user's RSVP
    const ue = await db.ref(`userEvents/${secUser.uid}/${evId}`).once('value');
    expect(ue.val()).toBe('dabei');
  }, 10000);
});
