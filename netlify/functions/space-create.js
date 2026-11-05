'use strict';
// POST { name, memberUids? } — create a new space (group).
// Writes: spaces/$id, userSpaces/$uid/$id, userSpaces/$memberId/$id for each member
const { initAdmin, verifyUserToken, json, makeId } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const { decoded, errorStatus, errorCode } = await verifyUserToken(event.headers['authorization'] || '');
  if (!decoded) {
    if (errorStatus === 503) return json(503, { error: 'Service temporarily unavailable. Check server configuration.' });
    return json(401, { error: errorCode === 'missing-token' ? 'Unauthorized' : 'Invalid token' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const { name, memberUids } = body;
  if (!name || typeof name !== 'string' || !name.trim()) return json(400, { error: 'name is required' });
  if (name.trim().length > 80) return json(400, { error: 'name too long (max 80 chars)' });

  const uid   = decoded.uid;
  const app   = initAdmin();
  const db    = app.database();

  // Load creator profile; bootstrap from Firebase Auth if the RTDB node is missing.
  // This covers Google-login users whose profile was never explicitly written.
  let creatorSnap = await db.ref(`users/${uid}`).once('value');
  if (!creatorSnap.exists() || !creatorSnap.val()) {
    try {
      const authUser    = await app.auth().getUser(uid);
      const bootstrapped = { createdAt: Date.now(), updatedAt: Date.now() };
      if (authUser.displayName) {
        bootstrapped.displayName      = authUser.displayName;
        bootstrapped.displayNameLower = authUser.displayName.toLowerCase();
      }
      await db.ref(`users/${uid}`).set(bootstrapped);
      creatorSnap = await db.ref(`users/${uid}`).once('value');
    } catch (e) {
      console.error('[someday] space-create: cannot bootstrap creator profile:', e.message);
      return json(404, { error: 'Creator user not found' });
    }
  }
  const creatorName = (creatorSnap.val() || {}).displayName || null;

  // Validate member uids (deduplicated, excluding creator) — they receive invites, not direct membership
  const extraMembers = [...new Set((memberUids || []).filter(id => id && id !== uid))];
  const memberChecks = await Promise.all(extraMembers.map(id => db.ref(`users/${id}`).once('value')));
  const validMembers = extraMembers.filter((id, i) => memberChecks[i].exists());

  const spaceId = makeId('sp');
  const now     = Date.now();

  // Creator is first member and first admin
  const update = {
    [`spaces/${spaceId}`]: {
      name:             name.trim(),
      createdBy:        uid,
      createdAt:        now,
      members:          { [uid]: true },
      admins:           { [uid]: true },
      invitePermission: 'admins_only', // 'admins_only' | 'all_members'
      visibility:       'private',     // 'private' | 'public' — public Communities not yet implemented
    },
    [`userSpaces/${uid}/${spaceId}`]: true,
  };

  // Write invite entries (no direct membership without consent)
  for (const memberId of validMembers) {
    update[`spaceInvites/${memberId}/${spaceId}`] = {
      spaceName:     name.trim(),
      invitedBy:     uid,
      invitedByName: creatorName,
      timestamp:     now,
    };
  }

  await db.ref('/').update(update);
  return json(201, { ok: true, spaceId, name: name.trim(), memberCount: 1, invitesSent: validMembers.length });
};
