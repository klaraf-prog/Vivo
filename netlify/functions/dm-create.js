'use strict';
// POST { targetUid } — creates or retrieves a DM thread between the caller and targetUid.
// Sets dms/$dmId/members for both users and updates userDMs index for both.
// DM ID is deterministic: [uid1, uid2].sort().join('_')
const { initAdmin, verifyUserToken, json } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const { decoded, errorStatus, errorCode } = await verifyUserToken(event.headers['authorization'] || '');
  if (!decoded) {
    if (errorStatus === 503) return json(503, { error: 'Service temporarily unavailable. Check server configuration.' });
    return json(401, { error: errorCode === 'missing-token' ? 'Unauthorized' : 'Invalid token' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const { targetUid } = body;
  if (!targetUid || typeof targetUid !== 'string') return json(400, { error: 'targetUid is required' });

  const uid = decoded.uid;
  if (uid === targetUid) return json(400, { error: 'Cannot create DM with yourself' });

  const db = initAdmin().database();

  // Verify target user exists
  const targetSnap = await db.ref(`users/${targetUid}`).once('value');
  if (!targetSnap.exists()) return json(404, { error: 'User not found' });

  const dmId = [uid, targetUid].sort().join('_');

  const existingSnap = await db.ref(`dms/${dmId}`).once('value');
  if (existingSnap.exists()) {
    return json(200, { dmId, created: false });
  }

  await db.ref('/').update({
    [`dms/${dmId}/members/${uid}`]: true,
    [`dms/${dmId}/members/${targetUid}`]: true,
    [`userDMs/${uid}/${dmId}`]: true,
    [`userDMs/${targetUid}/${dmId}`]: true,
  });

  return json(200, { dmId, created: true });
};
