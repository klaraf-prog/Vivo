'use strict';
// Updates a user's RSVP for a Firebase event.
// Writes: userEvents/$uid/$eventId = status
//         events/$eventId/rsvps/$rsvpKey = { name, status, userId, ts }
// Status values: 'dabei' | 'vielleicht' | 'nein'
const { initAdmin, verifyUserToken, json } = require('./_studio-shared');

const VALID_STATUSES = new Set(['dabei', 'vielleicht', 'nein']);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const { decoded, errorStatus, errorCode } = await verifyUserToken(event.headers['authorization'] || '');
  if (!decoded) {
    if (errorStatus === 503) return json(503, { error: 'Service temporarily unavailable. Check server configuration.' });
    return json(401, { error: errorCode === 'missing-token' ? 'Unauthorized' : 'Invalid token' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const { eventId, status } = body;
  if (!eventId) return json(400, { error: 'eventId required' });
  if (!VALID_STATUSES.has(status)) return json(400, { error: 'status must be dabei|vielleicht|nein' });

  const uid = decoded.uid;
  const db  = initAdmin().database();

  // Verify the event exists
  const evSnap = await db.ref(`events/${eventId}`).once('value');
  if (!evSnap.exists()) return json(404, { error: 'Event not found' });

  // Access check: must be creator, have been invited, or already have an RSVP entry
  const ev = evSnap.val();
  if (ev.createdBy !== uid) {
    const [inviteSnap, existingRsvpSnap] = await Promise.all([
      db.ref(`invites/${uid}/${eventId}`).once('value'),
      db.ref(`userEvents/${uid}/${eventId}`).once('value'),
    ]);
    if (!inviteSnap.exists() && !existingRsvpSnap.exists()) {
      return json(403, { error: 'Access denied: not invited to this event' });
    }
  }

  const profile = (await db.ref(`users/${uid}`).once('value')).val() || {};
  const name    = profile.displayName || decoded.email || uid;

  // Find existing RSVP key for this user, or create new
  const rsvpsSnap = await db.ref(`events/${eventId}/rsvps`).once('value');
  const rsvps     = rsvpsSnap.val() || {};
  const existingKey = Object.entries(rsvps).find(([, r]) => r.userId === uid)?.[0];

  const rsvpKey  = existingKey || db.ref(`events/${eventId}/rsvps`).push().key;
  const updates  = {
    [`userEvents/${uid}/${eventId}`]:             status,
    [`events/${eventId}/rsvps/${rsvpKey}`]:       { name, status, userId: uid, ts: Date.now() },
  };

  await db.ref().update(updates);
  return json(200, { ok: true, eventId, status });
};
