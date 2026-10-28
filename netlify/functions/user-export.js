'use strict';
// GDPR Art. 20 — data portability.
// GET with Authorization: Bearer <idToken>
// Returns a JSON file containing all personal data for the authenticated user:
//   profile, userEvents, userSpaces, friends, friendRequests, notifications, invites
const { initAdmin, verifyUserToken, json } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const { decoded, errorStatus, errorCode } = await verifyUserToken(event.headers['authorization'] || '');
  if (!decoded) {
    if (errorStatus === 503) return json(503, { error: 'Service temporarily unavailable. Check server configuration.' });
    return json(401, { error: errorCode === 'missing-token' ? 'Unauthorized' : 'Invalid token' });
  }

  const uid = decoded.uid;
  const db  = initAdmin().database();

  const [profile, userEvents, userSpaces, friends, friendRequests, notifications, invites] = await Promise.all([
    db.ref(`users/${uid}`).once('value'),
    db.ref(`userEvents/${uid}`).once('value'),
    db.ref(`userSpaces/${uid}`).once('value'),
    db.ref(`friends/${uid}`).once('value'),
    db.ref(`friendRequests/${uid}`).once('value'),
    db.ref(`notifications/${uid}`).once('value'),
    db.ref(`invites/${uid}`).once('value'),
  ]);

  const export_ = {
    exportedAt: new Date().toISOString(),
    uid,
    profile:        profile.val()        || null,
    userEvents:     userEvents.val()     || null,
    userSpaces:     userSpaces.val()     || null,
    friends:        friends.val()        || null,
    friendRequests: friendRequests.val() || null,
    notifications:  notifications.val()  || null,
    invites:        invites.val()        || null,
  };

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="someday-data.json"',
    },
    body: JSON.stringify(export_, null, 2),
  };
};
