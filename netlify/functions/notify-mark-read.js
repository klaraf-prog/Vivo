'use strict';
// POST { notifId }
// Marks a single notification as read for the authenticated user.
// Sets notifications/{uid}/{notifId}/readAt = now.
const { initAdmin, verifyUserToken, json } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const { decoded, errorStatus } = await verifyUserToken(event.headers['authorization'] || '');
  if (!decoded) {
    if (errorStatus === 503) return json(503, { error: 'Service temporarily unavailable.' });
    return json(401, { error: 'Unauthorized' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const { notifId } = body;
  if (!notifId || typeof notifId !== 'string') return json(400, { error: 'notifId required' });

  const uid = decoded.uid;
  const db  = initAdmin().database();

  // Verify the notification exists and belongs to this user
  const snap = await db.ref(`notifications/${uid}/${notifId}`).once('value');
  if (!snap.exists()) return json(404, { error: 'Notification not found' });

  await db.ref(`notifications/${uid}/${notifId}/readAt`).set(Date.now());

  return json(200, { ok: true });
};
