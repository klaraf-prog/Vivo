'use strict';
// POST { action, targetUid } — manage friend relationships.
// Actions: request | accept | decline | remove
// friendRequests/$uid/$senderUid = { status: 'pending', sentAt }
// friends/$uid/$friendUid = true (bidirectional on accept)
const { initAdmin, json } = require('./_studio-shared');

const VALID_ACTIONS = new Set(['request', 'accept', 'decline', 'remove']);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const authHeader = event.headers['authorization'] || '';
  const idToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!idToken) return json(401, { error: 'Unauthorized' });

  let decoded;
  try {
    decoded = await initAdmin().auth().verifyIdToken(idToken);
  } catch {
    return json(401, { error: 'Invalid token' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const { action, targetUid } = body;
  if (!action || !VALID_ACTIONS.has(action)) return json(400, { error: 'action must be one of: request, accept, decline, remove' });
  if (!targetUid || typeof targetUid !== 'string') return json(400, { error: 'targetUid is required' });

  const uid = decoded.uid;
  if (uid === targetUid) return json(400, { error: 'Cannot perform friend action on yourself' });

  const db = initAdmin().database();

  // Verify target user exists
  const targetSnap = await db.ref(`users/${targetUid}`).once('value');
  if (!targetSnap.exists()) return json(404, { error: 'Target user not found' });

  const update = {};

  if (action === 'request') {
    // Check if already friends
    const alreadyFriendSnap = await db.ref(`friends/${uid}/${targetUid}`).once('value');
    if (alreadyFriendSnap.exists()) return json(409, { error: 'Already friends' });
    // Write pending request (from uid to targetUid)
    update[`friendRequests/${targetUid}/${uid}`] = { status: 'pending', sentAt: Date.now() };

  } else if (action === 'accept') {
    // Verify the request exists
    const reqSnap = await db.ref(`friendRequests/${uid}/${targetUid}`).once('value');
    if (!reqSnap.exists()) return json(404, { error: 'Friend request not found' });
    // Accept: create bidirectional friendship, remove request
    update[`friends/${uid}/${targetUid}`]         = true;
    update[`friends/${targetUid}/${uid}`]          = true;
    update[`friendRequests/${uid}/${targetUid}`]   = null;

  } else if (action === 'decline') {
    // Remove incoming request from targetUid
    const reqSnap = await db.ref(`friendRequests/${uid}/${targetUid}`).once('value');
    if (!reqSnap.exists()) return json(404, { error: 'Friend request not found' });
    update[`friendRequests/${uid}/${targetUid}`]   = null;

  } else if (action === 'remove') {
    // Remove bidirectional friendship
    update[`friends/${uid}/${targetUid}`]           = null;
    update[`friends/${targetUid}/${uid}`]           = null;
  }

  await db.ref('/').update(update);
  return json(200, { ok: true, action });
};
