'use strict';
// GET  ?token=<hex>  — preview token (no auth, returns ownerName + ownerUid)
// POST { action:'generate' }          — create a 7-day invite token (auth required)
// POST { action:'accept', token }     — accept invite → direct mutual friendship (auth required)
const crypto = require('crypto');
const { initAdmin, verifyUserToken, json } = require('./_studio-shared');

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

exports.handler = async (event) => {
  const db = initAdmin().database();

  // ── GET: preview token without auth ──────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const token = event.queryStringParameters && event.queryStringParameters.token;
    if (!token || token.length > 128) return json(400, { error: 'Missing or invalid token' });
    const snap = await db.ref(`friendInviteTokens/${token}`).once('value');
    if (!snap.exists()) return json(404, { error: 'Invalid or expired link' });
    const data = snap.val();
    if (data.expiresAt < Date.now()) {
      await db.ref(`friendInviteTokens/${token}`).remove();
      return json(410, { error: 'Link expired' });
    }
    // Return owner display info; fall back to Firebase Auth if RTDB profile is missing
    const ownerSnap = await db.ref(`users/${data.uid}`).once('value');
    const owner = ownerSnap.val() || {};
    let ownerName = owner.displayName || owner.username || null;
    if (!ownerName) {
      try {
        const authUser = await initAdmin().auth().getUser(data.uid);
        ownerName = authUser.displayName || null;
      } catch (_) { /* user may have been deleted */ }
    }
    return json(200, { ownerUid: data.uid, ownerName });
  }

  // ── POST: generate or accept ──────────────────────────────────────────────
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const { decoded, errorStatus, errorCode } = await verifyUserToken(event.headers['authorization'] || '');
  if (!decoded) {
    if (errorStatus === 503) return json(503, { error: 'Service temporarily unavailable. Check server configuration.' });
    return json(401, { error: errorCode === 'missing-token' ? 'Unauthorized' : 'Invalid token' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const uid = decoded.uid;

  // ── generate ─────────────────────────────────────────────────────────────
  if (body.action === 'generate') {
    const token     = makeToken();
    const now       = Date.now();
    const expiresAt = now + TOKEN_TTL_MS;
    await db.ref(`friendInviteTokens/${token}`).set({ uid, createdAt: now, expiresAt });
    return json(201, { token, expiresAt });
  }

  // ── accept ────────────────────────────────────────────────────────────────
  if (body.action === 'accept') {
    const token = body.token;
    if (!token || typeof token !== 'string' || token.length > 128) return json(400, { error: 'Missing token' });

    const snap = await db.ref(`friendInviteTokens/${token}`).once('value');
    if (!snap.exists()) return json(404, { error: 'Invalid or expired link' });
    const data = snap.val();
    if (data.expiresAt < Date.now()) {
      await db.ref(`friendInviteTokens/${token}`).remove();
      return json(410, { error: 'Link expired' });
    }

    const ownerUid = data.uid;
    if (ownerUid === uid) return json(400, { error: 'Cannot connect with yourself' });

    // Check already friends
    const alreadySnap = await db.ref(`friends/${uid}/${ownerUid}`).once('value');
    if (alreadySnap.exists()) return json(409, { error: 'already_friends' });

    // Create bidirectional friendship atomically, remove token
    await db.ref('/').update({
      [`friends/${uid}/${ownerUid}`]:    true,
      [`friends/${ownerUid}/${uid}`]:    true,
      // Remove any pending friend requests between them
      [`friendRequests/${ownerUid}/${uid}`]: null,
      [`friendRequests/${uid}/${ownerUid}`]: null,
      // Invalidate token so it can't be reused
      [`friendInviteTokens/${token}`]:   null,
    });

    return json(200, { ok: true, ownerUid });
  }

  return json(400, { error: 'Unknown action' });
};
