'use strict';
// POST { action, targetUid|requesterUid } — manage friend relationships.
// Actions: request | accept | decline | remove
// friendRequests/$uid/$senderUid = { displayName, timestamp }
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

  const { action } = body;
  if (!action || !VALID_ACTIONS.has(action)) return json(400, { error: 'action must be one of: request, accept, decline, remove' });

  // accept/decline use requesterUid (who sent the request); request/remove use targetUid
  const otherUid = body.requesterUid || body.targetUid;
  if (!otherUid || typeof otherUid !== 'string') return json(400, { error: 'targetUid (or requesterUid for accept/decline) is required' });

  const uid = decoded.uid;
  if (uid === otherUid) return json(400, { error: 'Cannot perform friend action on yourself' });

  const db = initAdmin().database();

  // Verify other user exists
  const otherSnap = await db.ref(`users/${otherUid}`).once('value');
  if (!otherSnap.exists()) return json(404, { error: 'User not found' });

  const update = {};

  if (action === 'request') {
    // Check if already friends
    const alreadyFriendSnap = await db.ref(`friends/${uid}/${otherUid}`).once('value');
    if (alreadyFriendSnap.exists()) return json(409, { error: 'Already friends' });
    // Include sender's displayName in the request entry
    const myProfile = (await db.ref(`users/${uid}`).once('value')).val() || {};
    const displayName = myProfile.displayName || null;
    update[`friendRequests/${otherUid}/${uid}`] = { displayName, timestamp: Date.now() };

  } else if (action === 'accept') {
    // Verify the request exists (request FROM otherUid TO me)
    const reqSnap = await db.ref(`friendRequests/${uid}/${otherUid}`).once('value');
    if (!reqSnap.exists()) return json(404, { error: 'Friend request not found' });
    // Accept: create bidirectional friendship, remove request
    update[`friends/${uid}/${otherUid}`]       = true;
    update[`friends/${otherUid}/${uid}`]        = true;
    update[`friendRequests/${uid}/${otherUid}`] = null;

  } else if (action === 'decline') {
    // Remove incoming request from otherUid
    const reqSnap = await db.ref(`friendRequests/${uid}/${otherUid}`).once('value');
    if (!reqSnap.exists()) return json(404, { error: 'Friend request not found' });
    update[`friendRequests/${uid}/${otherUid}`] = null;

  } else if (action === 'remove') {
    // Remove bidirectional friendship
    update[`friends/${uid}/${otherUid}`] = null;
    update[`friends/${otherUid}/${uid}`] = null;
  }

  await db.ref('/').update(update);
  return json(200, { ok: true, action });
};
