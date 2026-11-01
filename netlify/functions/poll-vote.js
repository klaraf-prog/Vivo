'use strict';
// Toggles a user's vote on a poll option. Handles both authenticated users and
// guests arriving via invite link.
// Writes: events/$eventId/poll/options/$optionId/votes/$voterKey
// Auth'd users:  voterKey = uid,           value = true
// Guests:        voterKey = "g_" + guestId, value = { name, ts }
const { initAdmin, verifyUserToken, json } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const { eventId, optionId, inviteToken, guestId, guestName } = body;
  if (!eventId || typeof eventId !== 'string') return json(400, { error: 'eventId required' });
  if (!optionId || typeof optionId !== 'string') return json(400, { error: 'optionId required' });

  let app;
  try { app = initAdmin(); }
  catch (e) { return json(503, { error: 'Service temporarily unavailable. Check server configuration.' }); }
  const db = app.database();

  // Verify event exists and poll is active
  const evSnap = await db.ref(`events/${eventId}`).once('value');
  if (!evSnap.exists()) return json(404, { error: 'Event not found' });
  const ev = evSnap.val();
  if (!ev.poll || !ev.poll.active) return json(400, { error: 'No active poll on this event' });
  if (!ev.poll.options || !ev.poll.options[optionId]) return json(400, { error: 'Poll option not found' });

  const now  = Date.now();
  let voterKey, voteValue;

  const authHeader = event.headers['authorization'] || '';
  if (/^Bearer\s+\S/i.test(authHeader)) {
    // ── Authenticated path ───────────────────────────────────────────────────
    const { decoded, errorStatus, errorCode } = await verifyUserToken(authHeader);
    if (!decoded) {
      if (errorStatus === 503) return json(503, { error: 'Service temporarily unavailable. Check server configuration.' });
      return json(401, { error: errorCode === 'missing-token' ? 'Unauthorized' : 'Invalid token' });
    }
    const uid = decoded.uid;

    // Access check: creator, custom claim, invited, or existing RSVP
    if (ev.createdBy !== uid && decoded.grantedEvent !== eventId) {
      const [inviteSnap, rsvpSnap] = await Promise.all([
        db.ref(`invites/${uid}/${eventId}`).once('value'),
        db.ref(`userEvents/${uid}/${eventId}`).once('value'),
      ]);
      if (!inviteSnap.exists() && !rsvpSnap.exists()) {
        // Authenticated user arriving via invite link: validate token and register
        if (inviteToken) {
          const tokenSnap = await db.ref(`inviteTokens/${eventId}`).once('value');
          if (!tokenSnap.exists() || tokenSnap.val() !== inviteToken) {
            return json(403, { error: 'Access denied' });
          }
          await db.ref(`invites/${uid}/${eventId}`).set(true);
        } else {
          return json(403, { error: 'Access denied: not invited to this event' });
        }
      }
    }

    voterKey  = uid;
    voteValue = true;

  } else {
    // ── Guest path ───────────────────────────────────────────────────────────
    if (!inviteToken) return json(401, { error: 'Unauthorized: authentication or invite token required' });
    if (!guestId || typeof guestId !== 'string' || guestId.length < 4 || guestId.length > 128) {
      return json(400, { error: 'guestId required (4–128 chars)' });
    }
    if (!guestName || !String(guestName).trim()) return json(400, { error: 'guestName required' });

    // Validate invite token
    const tokenSnap = await db.ref(`inviteTokens/${eventId}`).once('value');
    if (!tokenSnap.exists() || tokenSnap.val() !== inviteToken) {
      return json(403, { error: 'Invalid or expired invite token' });
    }

    voterKey  = `g_${guestId}`;
    voteValue = { name: String(guestName).trim().slice(0, 100), ts: now };
  }

  // Toggle vote
  const voteRef  = db.ref(`events/${eventId}/poll/options/${optionId}/votes/${voterKey}`);
  const voteSnap = await voteRef.once('value');

  if (voteSnap.exists()) {
    await voteRef.remove();
    return json(200, { ok: true, voted: false, voterKey });
  } else {
    await voteRef.set(voteValue);
    return json(200, { ok: true, voted: true, voterKey });
  }
};
