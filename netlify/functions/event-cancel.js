'use strict';
// Cancels an event. Only the event creator may call this.
// Sets events/$eventId/cancelled = true, removes spaceEvents entries,
// and marks spaceMessages event cards as cancelled so live listeners update.
// Uses Admin SDK — bypasses RTDB security rules (server-side only).
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

  const { eventId } = body;
  if (!eventId || typeof eventId !== 'string') return json(400, { error: 'eventId required' });

  const uid = decoded.uid;
  const db  = initAdmin().database();

  // Server-side permission check: only the creator may cancel
  const evSnap = await db.ref(`events/${eventId}`).once('value');
  if (!evSnap.exists()) return json(404, { error: 'Event not found' });

  const ev = evSnap.val();
  if (ev.createdBy !== uid) return json(403, { error: 'Only the event creator can cancel this event' });

  if (ev.cancelled) return json(200, { ok: true, already: true });

  // Find spaces linked to this event via the creator's space memberships
  const userSpacesSnap = await db.ref(`userSpaces/${uid}`).once('value');
  const spaceIds       = Object.keys(userSpacesSnap.val() || {});

  const spaceEventSnaps = await Promise.all(
    spaceIds.map(id => db.ref(`spaceEvents/${id}/${eventId}`).once('value'))
  );
  const linkedSpaceIds = spaceIds.filter((_, i) => spaceEventSnaps[i].exists());

  const updates = {
    [`events/${eventId}/cancelled`]:   true,
    [`events/${eventId}/cancelledAt`]: Date.now(),
  };

  for (const spaceId of linkedSpaceIds) {
    updates[`spaceEvents/${spaceId}/${eventId}`]                  = null; // delete
    updates[`spaceMessages/${spaceId}/event_${eventId}/cancelled`] = true;
  }

  await db.ref().update(updates);
  return json(200, { ok: true, cancelledSpaces: linkedSpaceIds.length });
};
