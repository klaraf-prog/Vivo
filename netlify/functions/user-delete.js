'use strict';
// GDPR Art. 17 — right to erasure.
// POST (no body) with Authorization: Bearer <idToken>
// Deletes all personal data for the authenticated user:
//   users/$uid, usernames/<username>, userEvents/$uid, userSpaces/$uid,
//   friends/$uid, notifications/$uid, invites/$uid, friendRequests/$uid
// Then deletes the Firebase Auth account.
const { initAdmin, verifyUserToken, json } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const { decoded, errorStatus, errorCode } = await verifyUserToken(event.headers['authorization'] || '');
  if (!decoded) {
    if (errorStatus === 503) return json(503, { error: 'Service temporarily unavailable. Check server configuration.' });
    return json(401, { error: errorCode === 'missing-token' ? 'Unauthorized' : 'Invalid token' });
  }

  const uid = decoded.uid;
  const db  = initAdmin().database();

  // Read username before deleting profile so we can remove the username index entry.
  const profileSnap = await db.ref(`users/${uid}`).once('value');
  const profile     = profileSnap.val() || {};

  const deletions = {
    [`users/${uid}`]:          null,
    [`userEvents/${uid}`]:     null,
    [`userSpaces/${uid}`]:     null,
    [`friends/${uid}`]:        null,
    [`notifications/${uid}`]:  null,
    [`invites/${uid}`]:        null,
    [`friendRequests/${uid}`]: null,
  };
  if (profile.username) {
    deletions[`usernames/${profile.username}`] = null;
  }

  await db.ref('/').update(deletions);
  await initAdmin().auth().deleteUser(uid);

  return json(200, { ok: true });
};
