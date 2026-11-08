'use strict';
/**
 * Security audit: Firebase RTDB rules for database.rules.json (production rules).
 *
 * Covers every path in the rules file, including positive AND negative cases.
 * Tests permission escalation vectors.
 *
 * Run via: npm run test:rules:audit
 */

const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs   = require('fs');
const path = require('path');

const PROJECT_ID = 'vivo-mvp-rules-test';
const RULES_PATH = path.join(__dirname, '../../database.rules.json');

let testEnv;

beforeAll(async () => {
  const rulesContent = fs.readFileSync(RULES_PATH, 'utf8');
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: {
      host: '127.0.0.1',
      port: 9000,
      rules: rulesContent,
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

afterEach(async () => {
  await testEnv.clearDatabase();
});

// ── helpers ──────────────────────────────────────────────────────────────────

const asUser  = (uid, claims = {}) => testEnv.authenticatedContext(uid, claims).database();
const asAnon  = ()                 => testEnv.unauthenticatedContext().database();
const asAdmin = (uid = 'adm1')    => asUser(uid, { studioRole: 'superadmin' });
const asEditor= (uid = 'ed1')     => asUser(uid, { studioRole: 'editor' });

const seed = async (p, value) => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.database().ref(p).set(value);
  });
};

// ── users ─────────────────────────────────────────────────────────────────────

describe('users', () => {
  beforeEach(async () => {
    await seed('users/uid1', { displayName: 'Alice' });
    await seed('users/uid2', { displayName: 'Bob'   });
  });

  test('user can read own profile', async () =>
    assertSucceeds(asUser('uid1').ref('users/uid1').once('value')));

  test('user cannot read another profile', async () =>
    assertFails(asUser('uid1').ref('users/uid2').once('value')));

  test('unauthenticated cannot read any profile', async () =>
    assertFails(asAnon().ref('users/uid1').once('value')));

  test('user can write own profile', async () =>
    assertSucceeds(asUser('uid1').ref('users/uid1').set({ displayName: 'Alice2' })));

  test('user cannot write another profile', async () =>
    assertFails(asUser('uid1').ref('users/uid2').set({ displayName: 'Hacked' })));

  // Permission escalation: writing own profile does NOT grant Firebase custom claims
  // (those come from Auth tokens, not RTDB).  Still, verify no RTDB-side studioRole
  // written by a regular user is honoured for access gating.
  test('user writing studioRole to own profile does NOT gain studio read access', async () => {
    // Write studioRole into their own RTDB profile
    await asUser('uid1').ref('users/uid1').set({ studioRole: 'superadmin' });
    // This should still fail — rules check auth.token.studioRole (JWT claim), not RTDB
    await assertFails(asUser('uid1').ref('studioAdminUsers').once('value'));
  });
});

// ── usernames ─────────────────────────────────────────────────────────────────

describe('usernames', () => {
  test('authenticated user can read usernames', async () =>
    assertSucceeds(asUser('uid1').ref('usernames').once('value')));

  test('unauthenticated cannot read usernames', async () =>
    assertFails(asAnon().ref('usernames').once('value')));

  test('authenticated user can claim a free username', async () =>
    assertSucceeds(asUser('uid1').ref('usernames/alice').set('uid1')));

  test('cannot steal a username owned by another', async () => {
    await seed('usernames/alice', 'uid1');
    await assertFails(asUser('uid2').ref('usernames/alice').set('uid2'));
  });

  test('owner can reclaim own username entry', async () => {
    await seed('usernames/alice', 'uid1');
    await assertSucceeds(asUser('uid1').ref('usernames/alice').set('uid1'));
  });

  test('unauthenticated cannot claim a username', async () =>
    assertFails(asAnon().ref('usernames/anon').set('uid_anon')));
});

// ── events (write: false in production) ──────────────────────────────────────

describe('events', () => {
  beforeEach(async () => {
    await seed('events/ev1', { title: 'Test', createdBy: 'uid1' });
    await seed('invites/uid2/ev1', true);
    await seed('userEvents/uid3/ev1', 'dabei');
  });

  test('creator can read own event', async () =>
    assertSucceeds(asUser('uid1').ref('events/ev1').once('value')));

  test('invited user can read event', async () =>
    assertSucceeds(asUser('uid2').ref('events/ev1').once('value')));

  test('user with userEvents entry can read event', async () =>
    assertSucceeds(asUser('uid3').ref('events/ev1').once('value')));

  test('user with grantedEvent claim can read event', async () =>
    assertSucceeds(asUser('uid4', { grantedEvent: 'ev1' }).ref('events/ev1').once('value')));

  test('unrelated authenticated user cannot read event', async () =>
    assertFails(asUser('uid5').ref('events/ev1').once('value')));

  test('unauthenticated cannot read event', async () =>
    assertFails(asAnon().ref('events/ev1').once('value')));

  test('nobody can write to events (write: false)', async () =>
    assertFails(asUser('uid1').ref('events/ev1/title').set('Hacked')));

  test('nobody can create a new event from client', async () =>
    assertFails(asUser('uid1').ref('events/ev_new').set({ title: 'New', createdBy: 'uid1' })));
});

// ── userEvents (write: false) ─────────────────────────────────────────────────

describe('userEvents', () => {
  beforeEach(async () => { await seed('userEvents/uid1/ev1', 'dabei'); });

  test('user can read own userEvents', async () =>
    assertSucceeds(asUser('uid1').ref('userEvents/uid1').once('value')));

  test('user cannot read another user\'s userEvents', async () =>
    assertFails(asUser('uid2').ref('userEvents/uid1').once('value')));

  test('user cannot write own userEvents (write: false)', async () =>
    assertFails(asUser('uid1').ref('userEvents/uid1/ev2').set('dabei')));
});

// ── invites (write: false) ────────────────────────────────────────────────────

describe('invites', () => {
  beforeEach(async () => { await seed('invites/uid1/ev1', true); });

  test('user can read own invites', async () =>
    assertSucceeds(asUser('uid1').ref('invites/uid1').once('value')));

  test('user cannot read another user\'s invites', async () =>
    assertFails(asUser('uid2').ref('invites/uid1').once('value')));

  test('nobody can write invites (write: false)', async () =>
    assertFails(asUser('uid2').ref('invites/uid1/ev2').set(true)));
});

// ── friends (write: false) ────────────────────────────────────────────────────

describe('friends', () => {
  beforeEach(async () => { await seed('friends/uid1/uid2', true); });

  test('user can read own friends list', async () =>
    assertSucceeds(asUser('uid1').ref('friends/uid1').once('value')));

  test('user cannot read another user\'s friends', async () =>
    assertFails(asUser('uid2').ref('friends/uid1').once('value')));

  test('unauthenticated cannot read friends', async () =>
    assertFails(asAnon().ref('friends/uid1').once('value')));

  test('nobody can write friends from client', async () =>
    assertFails(asUser('uid1').ref('friends/uid1/uid3').set(true)));
});

// ── friendRequests (write: false) ─────────────────────────────────────────────

describe('friendRequests', () => {
  beforeEach(async () => { await seed('friendRequests/uid1/uid2', true); });

  test('user can read own friendRequests', async () =>
    assertSucceeds(asUser('uid1').ref('friendRequests/uid1').once('value')));

  test('user cannot read another user\'s friendRequests', async () =>
    assertFails(asUser('uid2').ref('friendRequests/uid1').once('value')));

  test('nobody can write friendRequests from client', async () =>
    assertFails(asUser('uid2').ref('friendRequests/uid1/uid2').set(true)));
});

// ── spaces (write: false; read via userSpaces) ────────────────────────────────

describe('spaces', () => {
  beforeEach(async () => {
    await seed('spaces/sp1', { name: 'Weekend Crew', members: { uid1: true } });
    await seed('userSpaces/uid1/sp1', true);
  });

  test('member (userSpaces entry) can read space', async () =>
    assertSucceeds(asUser('uid1').ref('spaces/sp1').once('value')));

  test('non-member cannot read space', async () =>
    assertFails(asUser('uid2').ref('spaces/sp1').once('value')));

  test('unauthenticated cannot read space', async () =>
    assertFails(asAnon().ref('spaces/sp1').once('value')));

  test('nobody can write to spaces from client', async () =>
    assertFails(asUser('uid1').ref('spaces/sp1/name').set('Hacked')));

  test('non-member cannot create a space', async () =>
    assertFails(asUser('uid2').ref('spaces/sp_new').set({ name: 'Evil', members: { uid2: true } })));

  // Escalation: user cannot write to userSpaces to gain access to a space
  test('user cannot write to own userSpaces to gain space access', async () =>
    assertFails(asUser('uid2').ref('userSpaces/uid2/sp1').set(true)));
});

// ── spaceEvents (write: false; read via userSpaces) ───────────────────────────

describe('spaceEvents', () => {
  beforeEach(async () => {
    await seed('userSpaces/uid1/sp1', true);
    await seed('spaceEvents/sp1/ev1', true);
  });

  test('space member can read spaceEvents', async () =>
    assertSucceeds(asUser('uid1').ref('spaceEvents/sp1').once('value')));

  test('non-member cannot read spaceEvents', async () =>
    assertFails(asUser('uid2').ref('spaceEvents/sp1').once('value')));

  test('nobody can write spaceEvents from client', async () =>
    assertFails(asUser('uid1').ref('spaceEvents/sp1/ev2').set(true)));
});

// ── userSpaces (write: false) ──────────────────────────────────────────────────

describe('userSpaces', () => {
  beforeEach(async () => { await seed('userSpaces/uid1/sp1', true); });

  test('user can read own userSpaces', async () =>
    assertSucceeds(asUser('uid1').ref('userSpaces/uid1').once('value')));

  test('user cannot read another user\'s userSpaces', async () =>
    assertFails(asUser('uid2').ref('userSpaces/uid1').once('value')));

  test('nobody can write to userSpaces from client', async () =>
    assertFails(asUser('uid1').ref('userSpaces/uid1/sp2').set(true)));
});

// ── notifications (write: false) ─────────────────────────────────────────────

describe('notifications', () => {
  beforeEach(async () => { await seed('notifications/uid1/n1', { msg: 'Hello' }); });

  test('user can read own notifications', async () =>
    assertSucceeds(asUser('uid1').ref('notifications/uid1').once('value')));

  test('user cannot read another user\'s notifications', async () =>
    assertFails(asUser('uid2').ref('notifications/uid1').once('value')));

  test('nobody can write notifications from client', async () =>
    assertFails(asUser('uid2').ref('notifications/uid1/n2').set({ msg: 'Injected' })));
});

// ── activities (public read, write: false) ────────────────────────────────────

describe('activities', () => {
  beforeEach(async () => { await seed('activities/act1', { name: 'Pottery' }); });

  test('unauthenticated user can read activities', async () =>
    assertSucceeds(asAnon().ref('activities/act1').once('value')));

  test('authenticated user can read activities', async () =>
    assertSucceeds(asUser('uid1').ref('activities/act1').once('value')));

  test('nobody can write activities', async () =>
    assertFails(asUser('uid1').ref('activities/act1/name').set('Hacked')));
});

// ── dms (write: false; read requires membership) ─────────────────────────────

describe('dms', () => {
  beforeEach(async () => {
    await seed('dms/dm1', { members: { uid1: true, uid2: true } });
  });

  test('dm member can read dm metadata', async () =>
    assertSucceeds(asUser('uid1').ref('dms/dm1').once('value')));

  test('other dm member can also read dm metadata', async () =>
    assertSucceeds(asUser('uid2').ref('dms/dm1').once('value')));

  test('non-member cannot read dm metadata', async () =>
    assertFails(asUser('uid3').ref('dms/dm1').once('value')));

  test('unauthenticated cannot read dm metadata', async () =>
    assertFails(asAnon().ref('dms/dm1').once('value')));

  test('nobody can write to dms from client', async () =>
    assertFails(asUser('uid1').ref('dms/dm2').set({ members: { uid1: true } })));

  // Escalation: user cannot add themselves to dm members
  test('user cannot add themselves to dm members', async () =>
    assertFails(asUser('uid3').ref('dms/dm1/members/uid3').set(true)));
});

// ── dmMessages (read: dm member; write: member + senderUid + !overwrite) ─────

describe('dmMessages', () => {
  beforeEach(async () => {
    await seed('dms/dm1', { members: { uid1: true, uid2: true } });
    await seed('dmMessages/dm1/msg1', { senderUid: 'uid1', text: 'Hi', timestamp: 1 });
  });

  test('dm member can read messages', async () =>
    assertSucceeds(asUser('uid1').ref('dmMessages/dm1').once('value')));

  test('other dm member can also read messages', async () =>
    assertSucceeds(asUser('uid2').ref('dmMessages/dm1').once('value')));

  test('non-member cannot read dm messages', async () =>
    assertFails(asUser('uid3').ref('dmMessages/dm1').once('value')));

  test('unauthenticated cannot read dm messages', async () =>
    assertFails(asAnon().ref('dmMessages/dm1').once('value')));

  test('dm member can write a new message with correct senderUid', async () =>
    assertSucceeds(asUser('uid1').ref('dmMessages/dm1/msg2').set({
      senderUid: 'uid1', text: 'Hello', timestamp: 2
    })));

  test('dm member cannot write message with wrong senderUid', async () =>
    assertFails(asUser('uid2').ref('dmMessages/dm1/msg3').set({
      senderUid: 'uid1', text: 'Spoof', timestamp: 3
    })));

  test('dm member cannot overwrite an existing message', async () =>
    assertFails(asUser('uid1').ref('dmMessages/dm1/msg1').set({
      senderUid: 'uid1', text: 'Edited', timestamp: 99
    })));

  test('non-member cannot write a message', async () =>
    assertFails(asUser('uid3').ref('dmMessages/dm1/msg4').set({
      senderUid: 'uid3', text: 'Inject', timestamp: 4
    })));

  test('unauthenticated cannot write a message', async () =>
    assertFails(asAnon().ref('dmMessages/dm1/msg5').set({
      senderUid: '', text: 'Anon', timestamp: 5
    })));
});

// ── spaceMessages (read/write via userSpaces membership) ─────────────────────

describe('spaceMessages', () => {
  beforeEach(async () => {
    await seed('userSpaces/uid1/sp1', true);
    await seed('userSpaces/uid2/sp1', true);
    await seed('spaceMessages/sp1/msg1', { senderUid: 'uid1', text: 'Hi', timestamp: 1 });
  });

  test('space member can read space messages', async () =>
    assertSucceeds(asUser('uid1').ref('spaceMessages/sp1').once('value')));

  test('other space member can also read messages', async () =>
    assertSucceeds(asUser('uid2').ref('spaceMessages/sp1').once('value')));

  test('non-member cannot read space messages', async () =>
    assertFails(asUser('uid3').ref('spaceMessages/sp1').once('value')));

  test('unauthenticated cannot read space messages', async () =>
    assertFails(asAnon().ref('spaceMessages/sp1').once('value')));

  test('space member can post a new message with correct senderUid', async () =>
    assertSucceeds(asUser('uid1').ref('spaceMessages/sp1/msg2').set({
      senderUid: 'uid1', text: 'Hello', timestamp: 2
    })));

  test('space member cannot post with spoofed senderUid', async () =>
    assertFails(asUser('uid2').ref('spaceMessages/sp1/msg3').set({
      senderUid: 'uid1', text: 'Spoof', timestamp: 3
    })));

  test('space member cannot overwrite an existing message', async () =>
    assertFails(asUser('uid1').ref('spaceMessages/sp1/msg1').set({
      senderUid: 'uid1', text: 'Edited', timestamp: 99
    })));

  test('non-member cannot post to a space', async () =>
    assertFails(asUser('uid3').ref('spaceMessages/sp1/msg4').set({
      senderUid: 'uid3', text: 'Inject', timestamp: 4
    })));

  // Escalation: user cannot write to userSpaces then read messages
  test('user cannot self-add to userSpaces to gain message read access', async () => {
    // attempt to add themselves (write should fail on userSpaces)
    await assertFails(asUser('uid3').ref('userSpaces/uid3/sp1').set(true));
    // confirm they still can't read messages
    await assertFails(asUser('uid3').ref('spaceMessages/sp1').once('value'));
  });
});

// ── userDMs (write: false) ────────────────────────────────────────────────────

describe('userDMs', () => {
  beforeEach(async () => { await seed('userDMs/uid1/dm1', true); });

  test('user can read own userDMs', async () =>
    assertSucceeds(asUser('uid1').ref('userDMs/uid1').once('value')));

  test('user cannot read another user\'s userDMs', async () =>
    assertFails(asUser('uid2').ref('userDMs/uid1').once('value')));

  test('nobody can write to userDMs from client', async () =>
    assertFails(asUser('uid1').ref('userDMs/uid1/dm2').set(true)));
});

// ── spaceInvites (no rules ⇒ default deny) ───────────────────────────────────

describe('spaceInvites (default deny — no rules defined)', () => {
  beforeEach(async () => {
    await seed('spaceInvites/uid1/sp1', { spaceName: 'Test', invitedBy: 'uid2', timestamp: 1 });
  });

  test('invite target cannot read their own spaceInvites from client', async () =>
    assertFails(asUser('uid1').ref('spaceInvites/uid1').once('value')));

  test('other user cannot read spaceInvites', async () =>
    assertFails(asUser('uid2').ref('spaceInvites/uid1').once('value')));

  test('unauthenticated cannot read spaceInvites', async () =>
    assertFails(asAnon().ref('spaceInvites/uid1').once('value')));

  test('nobody can write to spaceInvites from client', async () =>
    assertFails(asUser('uid2').ref('spaceInvites/uid1/sp2').set({
      spaceName: 'Fake', invitedBy: 'uid2', timestamp: 2
    })));
});

// ── providers (studioRole required) ──────────────────────────────────────────

describe('providers', () => {
  test('regular user cannot read providers', async () =>
    assertFails(asUser('uid1').ref('providers').once('value')));

  test('user with any studioRole can read providers', async () =>
    assertSucceeds(asUser('uid1', { studioRole: 'editor' }).ref('providers').once('value')));

  test('nobody can write providers', async () =>
    assertFails(asEditor().ref('providers/p1').set({ name: 'Evil' })));
});

// ── suggestions (studioRole required; write: false) ───────────────────────────

describe('suggestions', () => {
  test('regular user cannot read suggestions', async () =>
    assertFails(asUser('uid1').ref('suggestions').once('value')));

  test('user with studioRole can read suggestions', async () =>
    assertSucceeds(asUser('uid1', { studioRole: 'researcher' }).ref('suggestions').once('value')));

  test('nobody can write suggestions from client', async () =>
    assertFails(asEditor().ref('suggestions/sug1').set({ title: 'Injected' })));
});

// ── suggestionHashes (studioRole required; write: false) ──────────────────────

describe('suggestionHashes', () => {
  test('regular user cannot read suggestionHashes', async () =>
    assertFails(asUser('uid1').ref('suggestionHashes').once('value')));

  test('user with studioRole can read suggestionHashes', async () =>
    assertSucceeds(asUser('uid1', { studioRole: 'editor' }).ref('suggestionHashes').once('value')));

  test('nobody can write suggestionHashes', async () =>
    assertFails(asEditor().ref('suggestionHashes/h1').set('abc123')));
});

// ── studioAuditLog (editor+ can read; write: false) ───────────────────────────

describe('studioAuditLog', () => {
  test('regular user cannot read studioAuditLog', async () =>
    assertFails(asUser('uid1').ref('studioAuditLog').once('value')));

  test('editor can read studioAuditLog', async () =>
    assertSucceeds(asEditor().ref('studioAuditLog').once('value')));

  test('superadmin can read studioAuditLog', async () =>
    assertSucceeds(asAdmin().ref('studioAuditLog').once('value')));

  test('nobody can write studioAuditLog', async () =>
    assertFails(asAdmin().ref('studioAuditLog/entry1').set({ action: 'inject' })));
});

// ── studioAdminUsers (superadmin read-only; write: false) ─────────────────────

describe('studioAdminUsers', () => {
  beforeEach(async () => { await seed('studioAdminUsers/uid1', { role: 'superadmin' }); });

  test('superadmin can read studioAdminUsers', async () =>
    assertSucceeds(asAdmin().ref('studioAdminUsers').once('value')));

  test('editor cannot read studioAdminUsers', async () =>
    assertFails(asEditor().ref('studioAdminUsers').once('value')));

  test('regular user cannot read studioAdminUsers', async () =>
    assertFails(asUser('uid1').ref('studioAdminUsers').once('value')));

  test('unauthenticated cannot read studioAdminUsers', async () =>
    assertFails(asAnon().ref('studioAdminUsers').once('value')));

  test('nobody can write studioAdminUsers (even superadmin)', async () =>
    assertFails(asAdmin().ref('studioAdminUsers/uid2').set({ role: 'superadmin' })));
});

// ── inviteTokens (fully locked) ───────────────────────────────────────────────

describe('inviteTokens', () => {
  test('nobody can read inviteTokens', async () =>
    assertFails(asAdmin().ref('inviteTokens').once('value')));

  test('nobody can write inviteTokens', async () =>
    assertFails(asAdmin().ref('inviteTokens/tok1').set('uid1')));
});
