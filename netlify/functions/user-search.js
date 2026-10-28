'use strict';
// GET /?q=<query> — search users by displayName prefix or exact username.
// Returns up to 10 matches, excluding the caller's own uid.
const { initAdmin, verifyUserToken, json } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const { decoded, errorStatus, errorCode } = await verifyUserToken(event.headers['authorization'] || '');
  if (!decoded) {
    if (errorStatus === 503) return json(503, { error: 'Service temporarily unavailable. Check server configuration.' });
    return json(401, { error: errorCode === 'missing-token' ? 'Unauthorized' : 'Invalid token' });
  }

  const qRaw = ((event.queryStringParameters || {}).q || '').trim();
  const q    = qRaw.toLowerCase();
  if (!q || q.length < 2) return json(400, { error: 'Query must be at least 2 characters' });
  if (q.length > 50)      return json(400, { error: 'Query too long' });

  const uid = decoded.uid;
  const db  = initAdmin().database();

  // Search by username (exact), displayNameLower index, and displayName directly
  const HIGH = '';
  const [byUsername, byDisplayNameLower, byDisplayName] = await Promise.all([
    db.ref('usernames').orderByKey().equalTo(q).once('value'),
    db.ref('users').orderByChild('displayNameLower').startAt(q).endAt(q + HIGH).limitToFirst(10).once('value'),
    db.ref('users').orderByChild('displayName').startAt(qRaw).endAt(qRaw + HIGH).limitToFirst(10).once('value'),
  ]);

  const results = {};

  const usernameVal = byUsername.val() || {};
  for (const [username, matchUid] of Object.entries(usernameVal)) {
    if (matchUid === uid) continue;
    if (!results[matchUid]) {
      const snap = await db.ref(`users/${matchUid}`).once('value');
      const profile = snap.val();
      if (profile) results[matchUid] = { uid: matchUid, displayName: profile.displayName || null, username };
    }
  }

  for (const [matchUid, profile] of Object.entries(byDisplayNameLower.val() || {})) {
    if (matchUid === uid) continue;
    if (!results[matchUid]) {
      results[matchUid] = {
        uid: matchUid,
        displayName: profile.displayName || null,
        username: profile.username || null,
      };
    }
  }

  for (const [matchUid, profile] of Object.entries(byDisplayName.val() || {})) {
    if (matchUid === uid) continue;
    if (!results[matchUid]) {
      results[matchUid] = {
        uid: matchUid,
        displayName: profile.displayName || null,
        username: profile.username || null,
      };
    }
  }

  const users = Object.values(results).slice(0, 10);
  return json(200, { users });
};
