'use strict';
// POST { action, spaceId, inviteeUid? }
// action: 'invite' — member invites a friend (creates spaceInvites entry, requires consent)
// action: 'accept' — invitee accepts and joins the space
// action: 'decline' — invitee declines and invite is removed
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

  const { action, spaceId, inviteeUid } = body;
  if (!action || !spaceId) return json(400, { error: 'Missing action or spaceId' });

  const db  = initAdmin().database();
  const now = Date.now();

  // ── INVITE ────────────────────────────────────────────────────────────────
  if (action === 'invite') {
    if (!inviteeUid) return json(400, { error: 'Missing inviteeUid' });
    if (inviteeUid === uid) return json(400, { error: 'Cannot invite yourself' });

    const memberSnap = await db.ref(`spaces/${spaceId}/members/${uid}`).once('value');
    if (!memberSnap.exists()) return json(403, { error: 'Not a member of this space' });

    const targetMemberSnap = await db.ref(`spaces/${spaceId}/members/${inviteeUid}`).once('value');
    if (targetMemberSnap.exists()) return json(409, { error: 'already_member' });

    const existingInvite = await db.ref(`spaceInvites/${inviteeUid}/${spaceId}`).once('value');
    if (existingInvite.exists()) return json(409, { error: 'already_invited' });

    const [spaceSnap, callerSnap] = await Promise.all([
      db.ref(`spaces/${spaceId}/name`).once('value'),
      db.ref(`users/${uid}/displayName`).once('value'),
    ]);
    if (!spaceSnap.exists()) return json(404, { error: 'Space not found' });

    await db.ref(`spaceInvites/${inviteeUid}/${spaceId}`).set({
      spaceName:     spaceSnap.val(),
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

    const spaceSnap = await db.ref(`spaces/${spaceId}`).once('value');
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

  return json(400, { error: 'Unknown action' });
};
