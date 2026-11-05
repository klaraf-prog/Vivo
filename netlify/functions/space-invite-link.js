'use strict';
// GET  ?token=…          — validate token, return public space preview (no private content)
// POST { action:'generate', spaceId } — member generates a 7-day invite token
// POST { action:'accept',   token }   — authenticated user joins via token (requires confirmation)
const crypto = require('crypto');
const { initAdmin, verifyUserToken, json } = require('./_studio-shared');

exports.handler = async (event) => {
  const db = initAdmin().database();

  // ── GET: preview ──────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const token = (event.queryStringParameters || {}).token;
    if (!token || token.length > 128) return json(400, { error: 'Missing token' });

    const tokenSnap = await db.ref(`spaceInviteTokens/${token}`).once('value');
    if (!tokenSnap.exists()) return json(404, { error: 'Invalid or expired link' });

    const { spaceId, expiresAt } = tokenSnap.val();
    if (expiresAt && expiresAt < Date.now()) return json(410, { error: 'Link expired' });

    const spaceSnap = await db.ref(`spaces/${spaceId}`).once('value');
    if (!spaceSnap.exists()) return json(404, { error: 'Space not found' });

    const { name, members } = spaceSnap.val();
    return json(200, {
      spaceId,
      spaceName:   name,
      memberCount: members ? Object.keys(members).length : 0,
    });
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    const { decoded, errorStatus, errorCode } = await verifyUserToken(event.headers['authorization'] || '');
    if (!decoded) {
      if (errorStatus === 503) return json(503, { error: 'Service temporarily unavailable.' });
      return json(401, { error: errorCode === 'missing-token' ? 'Unauthorized' : 'Invalid token' });
    }
    const uid = decoded.uid;

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

    // Generate invite link token (respects invitePermission setting)
    if (body.action === 'generate') {
      const { spaceId } = body;
      if (!spaceId) return json(400, { error: 'Missing spaceId' });

      const spaceSnap = await db.ref(`spaces/${spaceId}`).once('value');
      if (!spaceSnap.exists()) return json(404, { error: 'Space not found' });
      const sp = spaceSnap.val();

      if (!sp.members || !sp.members[uid]) return json(403, { error: 'Not a member' });

      const perm = sp.invitePermission || 'admins_only';
      if (perm === 'admins_only' && !(sp.admins && sp.admins[uid])) {
        return json(403, { error: 'Only admins can generate links in this space' });
      }

      // Keep the existing snapshot reference alive via sp — no extra fetch needed

      const token     = crypto.randomBytes(24).toString('hex');
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
      await db.ref(`spaceInviteTokens/${token}`).set({ spaceId, createdBy: uid, expiresAt });
      return json(200, { token });
    }

    // Accept via link (requires explicit user confirmation in the UI)
    if (body.action === 'accept') {
      const { token } = body;
      if (!token) return json(400, { error: 'Missing token' });

      const tokenSnap = await db.ref(`spaceInviteTokens/${token}`).once('value');
      if (!tokenSnap.exists()) return json(404, { error: 'Invalid or expired link' });

      const { spaceId, expiresAt } = tokenSnap.val();
      if (expiresAt && expiresAt < Date.now()) return json(410, { error: 'Link expired' });

      const memberSnap = await db.ref(`spaces/${spaceId}/members/${uid}`).once('value');
      if (memberSnap.exists()) return json(409, { error: 'already_member' });

      const spaceNameSnap = await db.ref(`spaces/${spaceId}/name`).once('value');
      if (!spaceNameSnap.exists()) return json(404, { error: 'Space not found' });

      await db.ref('/').update({
        [`spaces/${spaceId}/members/${uid}`]: true,
        [`userSpaces/${uid}/${spaceId}`]:     true,
        [`spaceInvites/${uid}/${spaceId}`]:   null,
      });
      return json(200, { ok: true, spaceId, spaceName: spaceNameSnap.val() });
    }

    return json(400, { error: 'Unknown action' });
  }

  return json(405, { error: 'Method Not Allowed' });
};
