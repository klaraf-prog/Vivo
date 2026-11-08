'use strict';
// POST { otherUid } — initialises a direct-message chat between two friends.
// Creates directChats/$chatId/members (idempotent).
// $chatId = [myUid, otherUid].sort().join('_')  — deterministic, no duplicates.
const { initAdmin, verifyUserToken, json } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const { decoded, errorStatus, errorCode } = await verifyUserToken(event.headers['authorization'] || '');
  if (!decoded) {
    if (errorStatus === 503) return json(503, { error: 'Service temporarily unavailable.' });
    return json(401, { error: errorCode === 'missing-token' ? 'Unauthorized' : 'Invalid token' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const { otherUid } = body;
  if (!otherUid || typeof otherUid !== 'string') return json(400, { error: 'otherUid required' });

  const uid = decoded.uid;
  if (uid === otherUid) return json(400, { error: 'Cannot chat with yourself' });

  const db = initAdmin().database();

  // Both users must be friends
  const [myFriendSnap, theirFriendSnap] = await Promise.all([
    db.ref(`friends/${uid}/${otherUid}`).once('value'),
    db.ref(`friends/${otherUid}/${uid}`).once('value'),
  ]);
  if (!myFriendSnap.exists() || !theirFriendSnap.exists()) {
    return json(403, { error: 'Users are not friends' });
  }

  const chatId = [uid, otherUid].sort().join('_');

  // Idempotent: only write if members node does not exist yet
  const membersSnap = await db.ref(`directChats/${chatId}/members`).once('value');
  if (!membersSnap.exists()) {
    await db.ref(`directChats/${chatId}/members`).set({
      [uid]: true,
      [otherUid]: true,
    });
  }

  return json(200, { ok: true, chatId });
};
