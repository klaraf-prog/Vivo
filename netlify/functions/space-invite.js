'use strict';
// POST { action, spaceId, inviteeUid? }
// action: 'invite'          — send invite (admin-only by default; respects invitePermission)
// action: 'accept'          — invitee accepts space invite → joins
// action: 'decline'         — invitee declines space invite
// action: 'grant-admin'     — admin promotes member to admin
// action: 'revoke-admin'    — admin demotes another admin (last admin protected)
// action: 'remove-member'   — admin removes a member (cannot remove yourself)
// action: 'update-settings' — admin changes name or invitePermission
const { initAdmin, verifyUserToken, json } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const { decoded, errorStatus, errorCode } = await verifyUserToken(event.headers['authorization'] || '');
  if (!decoded) {
    if (errorStatus === 503) return json(503, { error: 'Service temporarily unavailable.' });
    return json(401, { error: errorCode === 'missing-token' ? 'Unauthorized' : 'Invalid token' });
  }
  const uid = decoded.uid;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const { action, spaceId } = body;
  if (!action || !spaceId) return json(400, { error: 'Missing action or spaceId' });

  const db  = initAdmin().database();
  const now = Date.now();

  // Helper: load full space snapshot
  const loadSpace = () => db.ref(`spaces/${spaceId}`).once('value');

  // ── INVITE ────────────────────────────────────────────────────────────────
  if (action === 'invite') {
    const inviteeUid = body.inviteeUid;
    if (!inviteeUid) return json(400, { error: 'Missing inviteeUid' });
    if (inviteeUid === uid) return json(400, { error: 'Cannot invite yourself' });

    const spaceSnap = await loadSpace();
    if (!spaceSnap.exists()) return json(404, { error: 'Space not found' });
    const sp = spaceSnap.val();

    // Must be a member
    if (!sp.members || !sp.members[uid]) return json(403, { error: 'Not a member of this space' });

    // Check invite permission
    const perm = sp.invitePermission || 'admins_only';
    if (perm === 'admins_only' && !(sp.admins && sp.admins[uid])) {
      return json(403, { error: 'Only admins can invite in this space' });
    }

    if (sp.members[inviteeUid]) return json(409, { error: 'already_member' });

    const existingInvite = await db.ref(`spaceInvites/${inviteeUid}/${spaceId}`).once('value');
    if (existingInvite.exists()) return json(409, { error: 'already_invited' });

    const callerSnap = await db.ref(`users/${uid}/displayName`).once('value');
    await db.ref(`spaceInvites/${inviteeUid}/${spaceId}`).set({
      spaceName:     sp.name,
      invitedBy:     uid,
      invitedByName: callerSnap.val() || null,
      timestamp:     now,
    });
    return json(200, { ok: true });
  }

  // ── ACCEPT ────────────────────────────────────────────────────────────────
  if (action === 'accept') {
    const inviteSnap = await db.ref(`spaceInvites/${uid}/${spaceId}`).once('value');
    if (!inviteSnap.exists()) return json(404, { error: 'Invite not found' });

    const spaceSnap = await loadSpace();
    if (!spaceSnap.exists()) return json(404, { error: 'Space not found' });

    await db.ref('/').update({
      [`spaces/${spaceId}/members/${uid}`]: true,
      [`userSpaces/${uid}/${spaceId}`]:     true,
      [`spaceInvites/${uid}/${spaceId}`]:   null,
    });
    return json(200, { ok: true });
  }

  // ── DECLINE ───────────────────────────────────────────────────────────────
  if (action === 'decline') {
    await db.ref(`spaceInvites/${uid}/${spaceId}`).remove();
    return json(200, { ok: true });
  }

  // ── GRANT-ADMIN ────────────────────────────────────────────────────────────
  if (action === 'grant-admin') {
    const targetUid = body.targetUid;
    if (!targetUid || targetUid === uid) return json(400, { error: 'Missing or invalid targetUid' });

    const spaceSnap = await loadSpace();
    if (!spaceSnap.exists()) return json(404, { error: 'Space not found' });
    const sp = spaceSnap.val();

    if (!(sp.admins && sp.admins[uid])) return json(403, { error: 'Admin only' });
    if (!sp.members || !sp.members[targetUid]) return json(404, { error: 'Target is not a member' });
    if (sp.admins && sp.admins[targetUid]) return json(409, { error: 'already_admin' });

    await db.ref(`spaces/${spaceId}/admins/${targetUid}`).set(true);
    return json(200, { ok: true });
  }

  // ── REVOKE-ADMIN ───────────────────────────────────────────────────────────
  if (action === 'revoke-admin') {
    const targetUid = body.targetUid;
    if (!targetUid) return json(400, { error: 'Missing targetUid' });

    const spaceSnap = await loadSpace();
    if (!spaceSnap.exists()) return json(404, { error: 'Space not found' });
    const sp = spaceSnap.val();

    if (!(sp.admins && sp.admins[uid])) return json(403, { error: 'Admin only' });
    if (!(sp.admins && sp.admins[targetUid])) return json(404, { error: 'Target is not an admin' });

    // Protect last admin
    const adminCount = Object.keys(sp.admins || {}).length;
    if (adminCount <= 1) return json(409, { error: 'last_admin' });

    await db.ref(`spaces/${spaceId}/admins/${targetUid}`).remove();
    return json(200, { ok: true });
  }

  // ── REMOVE-MEMBER ──────────────────────────────────────────────────────────
  if (action === 'remove-member') {
    const targetUid = body.targetUid;
    if (!targetUid || targetUid === uid) return json(400, { error: 'Cannot remove yourself' });

    const spaceSnap = await loadSpace();
    if (!spaceSnap.exists()) return json(404, { error: 'Space not found' });
    const sp = spaceSnap.val();

    if (!(sp.admins && sp.admins[uid])) return json(403, { error: 'Admin only' });
    if (!sp.members || !sp.members[targetUid]) return json(404, { error: 'Not a member' });

    await db.ref('/').update({
      [`spaces/${spaceId}/members/${targetUid}`]: null,
      [`spaces/${spaceId}/admins/${targetUid}`]:  null,
      [`userSpaces/${targetUid}/${spaceId}`]:     null,
    });
    return json(200, { ok: true });
  }

  // ── UPDATE-SETTINGS ───────────────────────────────────────────────────────
  if (action === 'update-settings') {
    const spaceSnap = await loadSpace();
    if (!spaceSnap.exists()) return json(404, { error: 'Space not found' });
    const sp = spaceSnap.val();

    if (!(sp.admins && sp.admins[uid])) return json(403, { error: 'Admin only' });

    const patch = {};

    if (body.name !== undefined) {
      const newName = typeof body.name === 'string' ? body.name.trim() : '';
      if (!newName) return json(400, { error: 'name required' });
      if (newName.length > 80) return json(400, { error: 'name too long' });
      patch[`spaces/${spaceId}/name`] = newName;
    }

    if (body.invitePermission !== undefined) {
      if (!['admins_only', 'all_members'].includes(body.invitePermission)) {
        return json(400, { error: 'Invalid invitePermission value' });
      }
      patch[`spaces/${spaceId}/invitePermission`] = body.invitePermission;
    }

    if (Object.keys(patch).length === 0) return json(400, { error: 'Nothing to update' });

    await db.ref('/').update(patch);
    return json(200, { ok: true });
  }

  return json(400, { error: 'Unknown action' });
};
