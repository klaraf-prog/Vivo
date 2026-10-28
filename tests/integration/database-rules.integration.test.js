'use strict';
/**
 * Firebase RTDB rules tests for database.rules.proposed.json
 *
 * Tests PROPOSED rules (not current production).
 * Run via: npx firebase-tools emulators:exec --only database,auth "jest tests/database-rules.test.js"
 *
 * Status:
 * ✅ Technically specified and structured
 * ✅ All test cases documented
 * ⚠ Requires Firebase emulator running to actually execute
 * ⚠ Not yet run against live emulator in CI (prerequisite for production deployment)
 */

const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'vivo-mvp-rules-test';
const RULES_PATH = path.join(__dirname, '..', 'database.rules.proposed.json');

let testEnv;

beforeAll(async () => {
  const rulesFile = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  // The emulator expects the full {"rules": {...}} wrapper as a JSON string.
  const rulesString = JSON.stringify({ rules: rulesFile.rules });
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: {
      host: '127.0.0.1',
      port: 9000,
      rules: rulesString,
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

afterEach(async () => {
  await testEnv.clearDatabase();
});

// Helper: auth'd user context
const asUser = (uid, customClaims = {}) =>
  testEnv.authenticatedContext(uid, customClaims).database();

// Helper: unauthenticated context
const asAnon = () => testEnv.unauthenticatedContext().database();

// Helper: superadmin context
const asSuperadmin = (uid = 'admin1') =>
  asUser(uid, { studioRole: 'superadmin' });

// Helper: seed data directly (bypasses rules)
const seed = async (path, value) => {
  await testEnv.withSecurityRulesDisabled(async ctx => {
    await ctx.database().ref(path).set(value);
  });
};

// ── users ────────────────────────────────────────────────────────────────────

describe('users', () => {
  beforeEach(async () => {
    await seed('users/uid1', { displayName: 'Alice', email: 'alice@test.com' });
    await seed('users/uid2', { displayName: 'Bob',   email: 'bob@test.com'   });
  });

  test('user can read own profile', async () => {
    await assertSucceeds(asUser('uid1').ref('users/uid1').once('value'));
  });

  test('user cannot read another user\'s profile', async () => {
    await assertFails(asUser('uid1').ref('users/uid2').once('value'));
  });

  test('unauthenticated user cannot read any profile', async () => {
    await assertFails(asAnon().ref('users/uid1').once('value'));
  });

  test('superadmin can read any profile', async () => {
    await assertSucceeds(asSuperadmin().ref('users/uid1').once('value'));
    await assertSucceeds(asSuperadmin().ref('users/uid2').once('value'));
  });

  test('user can write own profile', async () => {
    await assertSucceeds(asUser('uid1').ref('users/uid1').set({ displayName: 'Alice Updated' }));
  });

  test('user cannot write another user\'s profile', async () => {
    await assertFails(asUser('uid1').ref('users/uid2').set({ displayName: 'Hacked' }));
  });
});

// ── usernames ────────────────────────────────────────────────────────────────

describe('usernames', () => {
  test('any authenticated user can read usernames index', async () => {
    await assertSucceeds(asUser('uid1').ref('usernames').once('value'));
  });

  test('unauthenticated user cannot read usernames', async () => {
    await assertFails(asAnon().ref('usernames').once('value'));
  });

  test('authenticated user can claim a free username', async () => {
    await assertSucceeds(asUser('uid1').ref('usernames/alice').set('uid1'));
  });

  test('cannot claim a username already owned by another', async () => {
    await seed('usernames/alice', 'uid1');
    await assertFails(asUser('uid2').ref('usernames/alice').set('uid2'));
  });

  test('owner can reclaim their own username', async () => {
    await seed('usernames/alice', 'uid1');
    await assertSucceeds(asUser('uid1').ref('usernames/alice').set('uid1'));
  });
});

// ── events ───────────────────────────────────────────────────────────────────

describe('events', () => {
  beforeEach(async () => {
    await seed('events/ev1', { title: 'Test Event', createdBy: 'uid1' });
  });

  test('authenticated user can read events', async () => {
    await assertSucceeds(asUser('uid2').ref('events/ev1').once('value'));
  });

  test('unauthenticated user cannot read events', async () => {
    await assertFails(asAnon().ref('events/ev1').once('value'));
  });

  test('authenticated user can create a new event', async () => {
    await assertSucceeds(asUser('uid1').ref('events/ev_new').set({ title: 'New', createdBy: 'uid1' }));
  });

  test('creator can update their event', async () => {
    await assertSucceeds(asUser('uid1').ref('events/ev1/title').set('Updated'));
  });

  test('non-creator cannot update an existing event', async () => {
    await assertFails(asUser('uid2').ref('events/ev1/title').set('Hacked'));
  });
});

// ── userEvents ───────────────────────────────────────────────────────────────

describe('userEvents', () => {
  beforeEach(async () => {
    await seed('userEvents/uid1/ev1', 'dabei');
  });

  test('user can read own userEvents', async () => {
    await assertSucceeds(asUser('uid1').ref('userEvents/uid1').once('value'));
  });

  test('user cannot read another user\'s userEvents', async () => {
    await assertFails(asUser('uid2').ref('userEvents/uid1').once('value'));
  });

  test('user can write own userEvents', async () => {
    await assertSucceeds(asUser('uid1').ref('userEvents/uid1/ev2').set('dabei'));
  });

  test('user cannot write another user\'s userEvents', async () => {
    await assertFails(asUser('uid2').ref('userEvents/uid1/ev1').set('dabei'));
  });
});

// ── spaces ───────────────────────────────────────────────────────────────────

describe('spaces', () => {
  beforeEach(async () => {
    await seed('spaces/sp1', {
      name: 'Weekend Crew',
      members: { uid1: true },
    });
  });

  test('space member can read the space', async () => {
    await assertSucceeds(asUser('uid1').ref('spaces/sp1').once('value'));
  });

  test('non-member cannot read the space', async () => {
    await assertFails(asUser('uid2').ref('spaces/sp1').once('value'));
  });

  test('unauthenticated user cannot read a space', async () => {
    await assertFails(asAnon().ref('spaces/sp1').once('value'));
  });

  test('studio admin (any studioRole) can read any space', async () => {
    await assertSucceeds(asUser('uid2', { studioRole: 'editor' }).ref('spaces/sp1').once('value'));
  });

  test('member can update the space', async () => {
    await assertSucceeds(asUser('uid1').ref('spaces/sp1/name').set('New Name'));
  });

  test('non-member cannot update an existing space', async () => {
    await assertFails(asUser('uid2').ref('spaces/sp1/name').set('Hacked'));
  });

  test('authenticated user can create a new space (data does not exist yet)', async () => {
    await assertSucceeds(asUser('uid3').ref('spaces/sp_new').set({ name: 'New Space', members: { uid3: true } }));
  });
});

// ── spaceEvents ──────────────────────────────────────────────────────────────

describe('spaceEvents', () => {
  beforeEach(async () => {
    await seed('spaces/sp1/members/uid1', true);
    await seed('spaceEvents/sp1/ev1', true);
  });

  test('space member can read spaceEvents', async () => {
    await assertSucceeds(asUser('uid1').ref('spaceEvents/sp1').once('value'));
  });

  test('non-member cannot read spaceEvents', async () => {
    await assertFails(asUser('uid2').ref('spaceEvents/sp1').once('value'));
  });

  test('studio admin can read spaceEvents', async () => {
    await assertSucceeds(asUser('uid2', { studioRole: 'editor' }).ref('spaceEvents/sp1').once('value'));
  });

  test('space member can write spaceEvents', async () => {
    await assertSucceeds(asUser('uid1').ref('spaceEvents/sp1/ev2').set(true));
  });

  test('non-member cannot write spaceEvents', async () => {
    await assertFails(asUser('uid2').ref('spaceEvents/sp1/ev2').set(true));
  });
});

// ── notifications ─────────────────────────────────────────────────────────────

describe('notifications', () => {
  beforeEach(async () => {
    await seed('notifications/uid1/n1', { msg: 'Hello' });
  });

  test('user can read own notifications', async () => {
    await assertSucceeds(asUser('uid1').ref('notifications/uid1').once('value'));
  });

  test('user cannot read another user\'s notifications', async () => {
    await assertFails(asUser('uid2').ref('notifications/uid1').once('value'));
  });

  test('any authenticated user can write notifications to another user (invite system)', async () => {
    await assertSucceeds(asUser('uid2').ref('notifications/uid1/n2').set({ msg: 'Hi' }));
  });
});

// ── invites ───────────────────────────────────────────────────────────────────

describe('invites', () => {
  test('user can read own invites', async () => {
    await seed('invites/uid1/ev1', true);
    await assertSucceeds(asUser('uid1').ref('invites/uid1').once('value'));
  });

  test('user cannot read another user\'s invites', async () => {
    await seed('invites/uid1/ev1', true);
    await assertFails(asUser('uid2').ref('invites/uid1').once('value'));
  });

  test('any authenticated user can send an invite', async () => {
    await assertSucceeds(asUser('uid2').ref('invites/uid1/ev1').set(true));
  });
});

// ── activities (public read, no write) ────────────────────────────────────────

describe('activities', () => {
  beforeEach(async () => {
    await seed('activities/act1', { name: 'Pottery' });
  });

  test('unauthenticated user can read activities', async () => {
    await assertSucceeds(asAnon().ref('activities/act1').once('value'));
  });

  test('nobody can write activities (even authenticated)', async () => {
    await assertFails(asUser('uid1').ref('activities/act1/name').set('Hacked'));
  });
});

// ── suggestions ───────────────────────────────────────────────────────────────

describe('suggestions', () => {
  test('user without studioRole cannot read suggestions', async () => {
    await assertFails(asUser('uid1').ref('suggestions').once('value'));
  });

  test('user with studioRole can read suggestions', async () => {
    await assertSucceeds(asUser('uid1', { studioRole: 'researcher' }).ref('suggestions').once('value'));
  });

  test('editor can write any suggestion', async () => {
    await assertSucceeds(
      asUser('uid1', { studioRole: 'editor' }).ref('suggestions/sug1').set({ title: 'Test', status: 'submitted' })
    );
  });

  test('researcher can write own draft suggestion', async () => {
    await assertSucceeds(
      asUser('uid1', { studioRole: 'researcher' }).ref('suggestions/sug1').set({ title: 'Test', status: 'draft' })
    );
  });

  test('researcher cannot write non-draft suggestion', async () => {
    await seed('suggestions/sug1', { title: 'Existing', status: 'approved' });
    await assertFails(
      asUser('uid1', { studioRole: 'researcher' }).ref('suggestions/sug1/title').set('Hacked')
    );
  });

  test('regular user cannot write suggestions', async () => {
    await assertFails(asUser('uid1').ref('suggestions/sug1').set({ title: 'Injected' }));
  });
});
