'use strict';
// Returns event data and a Firebase Custom Token for guests arriving via invite link.
// The custom token carries grantedEvent: eventId so the RTDB rule allows the read.
// GET /.netlify/functions/guest-event?eventId=...&token=...
const crypto = require('crypto');
const { initAdmin, json } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const { eventId, token: inviteToken } = event.queryStringParameters || {};
  if (!eventId || typeof eventId !== 'string') return json(400, { error: 'eventId required' });
  if (!inviteToken || typeof inviteToken !== 'string') return json(400, { error: 'token required' });

  let app;
  try { app = initAdmin(); }
  catch (e) { return json(503, { error: 'Service temporarily unavailable. Check server configuration.' }); }
  const db = app.database();

  // Validate invite token
  const tokenSnap = await db.ref(`inviteTokens/${eventId}`).once('value');
  if (!tokenSnap.exists() || tokenSnap.val() !== inviteToken) {
    return json(403, { error: 'Invalid or expired invite token' });
  }

  // Get event data
  const evSnap = await db.ref(`events/${eventId}`).once('value');
  if (!evSnap.exists()) return json(404, { error: 'Event not found' });
  const ev = evSnap.val();

  // Issue a deterministic Firebase Custom Token for this invite link.
  // Using a hash of the token as the UID avoids unbounded anonymous-user creation
  // while remaining stable for repeated visits with the same link.
  const guestUid   = 'guest_' + crypto.createHash('sha256').update(inviteToken).digest('hex').slice(0, 20);
  const customToken = await app.auth().createCustomToken(guestUid, {
    grantedEvent: eventId,
  });

  // Return event data without the inviteToken field
  const { inviteToken: _omit, ...safeEv } = ev;
  return json(200, { ok: true, event: { ...safeEv, id: eventId }, customToken });
};
