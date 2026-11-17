'use strict';
// GET — returns the authenticated user's 50 most-recent notifications.
// Uses Admin SDK so no RTDB client-side security-rule is required.
const { initAdmin, verifyUserToken, json } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const { decoded, errorStatus } = await verifyUserToken(event.headers['authorization'] || '');
  if (!decoded) {
    if (errorStatus === 503) return json(503, { error: 'Service temporarily unavailable.' });
    return json(401, { error: 'Unauthorized' });
  }

  const uid = decoded.uid;
  const db  = initAdmin().database();

  try {
    const snap = await db.ref(`notifications/${uid}`)
      .orderByChild('createdAt').limitToLast(50).once('value');
    const raw = snap.val() || {};
    const notifs = Object.entries(raw)
      .map(([id, n]) => ({ id, ...n }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return json(200, { notifs });
  } catch (e) {
    console.error('[someday] notify-list DB read failed:', e.message);
    return json(500, { error: 'Failed to load notifications' });
  }
};
