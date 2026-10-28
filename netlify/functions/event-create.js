'use strict';
// Creates a new event in Firebase RTDB and links it to spaces and invites.
// Writes: events/$newId, userEvents/$uid/$newId='created',
//         events/$newId/rsvps/$key (creator RSVP),
//         spaceEvents/$spaceId/$newId=true (for each spaceId),
//         invites/$inviteeUid/$newId=true (for each inviteeUid)
const { initAdmin, verifyUserToken, json, makeId } = require('./_studio-shared');

const ALLOWED_FIELDS = ['emoji','title','date','time','location','details','activityRef'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const { decoded, errorStatus, errorCode } = await verifyUserToken(event.headers['authorization'] || '');
  if (!decoded) {
    if (errorStatus === 503) return json(503, { error: 'Service temporarily unavailable. Check server configuration.' });
    return json(401, { error: errorCode === 'missing-token' ? 'Unauthorized' : 'Invalid token' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const { title, spaceIds = [], inviteUids = [] } = body;
  if (!title || !String(title).trim()) return json(400, { error: 'title required' });
  if (!Array.isArray(spaceIds)   || spaceIds.length   > 20)  return json(400, { error: 'spaceIds must be array (max 20)' });
  if (!Array.isArray(inviteUids) || inviteUids.length > 100) return json(400, { error: 'inviteUids must be array (max 100)' });

  const uid = decoded.uid;
  const db  = initAdmin().database();

  const profile = (await db.ref(`users/${uid}`).once('value')).val() || {};
  const name    = profile.displayName || decoded.email || uid;

  const eventId  = makeId('ev');
  const rsvpKey  = makeId('rsvp');
  const now      = Date.now();

  const newEvent = { createdBy: uid, creatorName: name, createdAt: now };
  ALLOWED_FIELDS.forEach(f => { if (body[f] != null) newEvent[f] = body[f]; });
  // Embed creator RSVP inside the event object to avoid ancestor/descendant path conflict
  newEvent.rsvps = { [rsvpKey]: { name, status: 'dabei', userId: uid, ts: now } };

  const updates = {
    [`events/${eventId}`]:            newEvent,
    [`userEvents/${uid}/${eventId}`]: 'created',
  };

  // Verify spaceIds exist AND caller is a member — prevents creating events in foreign spaces
  if (spaceIds.length) {
    const [spaceSnaps, memberSnaps] = await Promise.all([
      Promise.all(spaceIds.map(id => db.ref(`spaces/${id}`).once('value'))),
      Promise.all(spaceIds.map(id => db.ref(`spaces/${id}/members/${uid}`).once('value'))),
    ]);
    spaceIds.forEach((id, i) => {
      if (spaceSnaps[i].exists() && memberSnaps[i].exists()) {
        updates[`spaceEvents/${id}/${eventId}`] = true;
      }
    });
  }

  // Verify all inviteeUids exist
  if (inviteUids.length) {
    const invSnaps = await Promise.all(inviteUids.map(id => db.ref(`users/${id}`).once('value')));
    inviteUids.forEach((id, i) => {
      if (invSnaps[i].exists()) updates[`invites/${id}/${eventId}`] = true;
    });
  }

  await db.ref().update(updates);
  return json(201, { ok: true, eventId });
};
