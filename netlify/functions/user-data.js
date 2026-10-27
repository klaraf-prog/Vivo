'use strict';
// Returns the authenticated user's personal data from RTDB:
//   profile    — users/$uid
//   userEvents — userEvents/$uid  (personal calendar events)
//   userSpaces — userSpaces/$uid  (space memberships)
const { initAdmin, json } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const authHeader = event.headers['authorization'] || '';
  const idToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!idToken) return json(401, { error: 'Unauthorized' });

  let decoded;
  try {
    decoded = await initAdmin().auth().verifyIdToken(idToken);
  } catch {
    return json(401, { error: 'Invalid token' });
  }

  const uid = decoded.uid;
  const db  = initAdmin().database();

  const [profileSnap, eventsSnap, spacesSnap] = await Promise.all([
    db.ref(`users/${uid}`).once('value'),
    db.ref(`userEvents/${uid}`).once('value'),
    db.ref(`userSpaces/${uid}`).once('value'),
  ]);

  return json(200, {
    uid,
    profile:    profileSnap.val()  || null,
    userEvents: eventsSnap.val()   || {},
    userSpaces: spacesSnap.val()   || {},
  });
};
