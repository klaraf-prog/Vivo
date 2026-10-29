'use strict';
// Creator confirms a poll option: closes the poll, sets the event date/time,
// promotes winning voters to 'dabei' RSVP.
// Writes: events/$id.date, events/$id.time, events/$id/poll.active=false,
//         events/$id/poll.confirmedOption, events/$id/rsvps (promote winners)
const { initAdmin, verifyUserToken, json } = require('./_studio-shared');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const { decoded, errorStatus, errorCode } = await verifyUserToken(event.headers['authorization'] || '');
  if (!decoded) {
    if (errorStatus === 503) return json(503, { error: 'Service temporarily unavailable.' });
    return json(401, { error: errorCode === 'missing-token' ? 'Unauthorized' : 'Invalid token' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const { eventId, optionId, date, time } = body;
  if (!eventId || typeof eventId !== 'string') return json(400, { error: 'eventId required' });
  if (!optionId || typeof optionId !== 'string') return json(400, { error: 'optionId required' });
  if (!date || !DATE_RE.test(date)) return json(400, { error: 'date must be YYYY-MM-DD' });
  if (time != null && !TIME_RE.test(time)) return json(400, { error: 'time must be HH:MM' });

  const uid = decoded.uid;
  const db  = initAdmin().database();

  // Verify caller is the event creator
  const evSnap = await db.ref(`events/${eventId}`).once('value');
  if (!evSnap.exists()) return json(404, { error: 'Event not found' });
  const ev = evSnap.val();
  if (ev.createdBy !== uid) return json(403, { error: 'Only the event creator can confirm a poll option' });

  // Verify poll is active and option exists
  const poll = ev.poll;
  if (!poll || !poll.active) return json(400, { error: 'No active poll on this event' });
  if (!poll.options || !poll.options[optionId]) return json(400, { error: 'Poll option not found' });

  const now = Date.now();
  const rsvpsSnap = await db.ref(`events/${eventId}/rsvps`).once('value');
  const rsvps = rsvpsSnap.val() || {};

  // Build existing RSVP index: userId → rsvp push-key
  const rsvpPushKey = {};
  Object.entries(rsvps).forEach(([key, r]) => { if (r.userId) rsvpPushKey[r.userId] = key; });

  // Collect winning votes
  const winVotes = poll.options[optionId].votes || {};
  const updates = {
    [`events/${eventId}/date`]:                  date,
    [`events/${eventId}/time`]:                  time || null,
    [`events/${eventId}/poll/active`]:            false,
    [`events/${eventId}/poll/confirmedOption`]:   optionId,
  };

  // Promote winning logged-in voters to 'dabei'
  const needsName = Object.entries(winVotes)
    .filter(([, val]) => val === true && !rsvpPushKey[/* key */undefined])
    .map(([k]) => k)
    .filter(k => !rsvpPushKey[k]);

  const nameMap = {};
  await Promise.all(needsName.map(async voterUid => {
    const s = await db.ref(`users/${voterUid}/displayName`).once('value');
    nameMap[voterUid] = s.val() || 'Unbekannt';
  }));

  for (const [key, val] of Object.entries(winVotes)) {
    if (val === true) {
      // Logged-in user
      if (rsvpPushKey[key]) {
        updates[`events/${eventId}/rsvps/${rsvpPushKey[key]}/status`] = 'dabei';
      } else {
        const newKey = db.ref(`events/${eventId}/rsvps`).push().key;
        updates[`events/${eventId}/rsvps/${newKey}`] = {
          name: nameMap[key] || 'Unbekannt', status: 'dabei', userId: key, ts: now,
        };
        rsvpPushKey[key] = newKey;
      }
      updates[`userEvents/${key}/${eventId}`] = 'dabei';
    } else if (val && val.name) {
      // Anonymous voter with name
      const isFirebaseUid = !key.startsWith('a_');
      const existingKey   = isFirebaseUid ? rsvpPushKey[key] : null;
      if (existingKey) {
        updates[`events/${eventId}/rsvps/${existingKey}/status`] = 'dabei';
      } else {
        const newKey = db.ref(`events/${eventId}/rsvps`).push().key;
        const entry  = { name: val.name, status: 'dabei', ts: now };
        if (isFirebaseUid) entry.userId = key;
        updates[`events/${eventId}/rsvps/${newKey}`] = entry;
        if (isFirebaseUid) rsvpPushKey[key] = newKey;
      }
      if (isFirebaseUid) updates[`userEvents/${key}/${eventId}`] = 'dabei';
    }
  }

  await db.ref().update(updates);
  return json(200, { ok: true });
};
