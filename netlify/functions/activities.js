'use strict';
// Public endpoint — no auth required.
// Returns activities with status "active" from RTDB.
// Works in local emulator (via FIREBASE_DATABASE_EMULATOR_HOST env var)
// and in production (via FIREBASE_RTDB_URL + service account).
const { initAdmin, json } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const db   = initAdmin().database();
  const snap = await db.ref('activities')
    .orderByChild('status').equalTo('active')
    .once('value');

  const activities = {};
  snap.forEach(child => { activities[child.key] = child.val(); });

  return json(200, { activities });
};
