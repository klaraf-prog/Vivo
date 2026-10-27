'use strict';
// Creates a new event in Firebase RTDB and links it to spaces and invites.
// Writes: events/$newId, userEvents/$uid/$newId='created',
//         events/$newId/rsvps/$key (creator RSVP),
//         spaceEvents/$spaceId/$newId=true (for each spaceId),
//         invites/$inviteeUid/$newId=true (for each inviteeUid)
const { initAdmin, json, makeId } = require('./_studio-shared');

const ALLOWED_FIELDS = ['emoji','title','date','time','location','details'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const authHeader = event.headers['authorization'] || '';
  const idToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!idToken) return json(401, { error: 'Unauthorized' });

  let decoded;
  try {
    decoded = await initAdmin().auth().verifyIdToken(idToken);
  } catch {
    return json(401, { error: 'Invalid token' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const { title, spaceIds = [], inviteUids = [] } = body;
  if (!title || !String(title).trim()) return json(400, { error: 'title required' });

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

  // Verify all spaceIds exist (prevent phantom writes)
  if (spaceIds.length) {
    const spaceSnaps = await Promise.all(spaceIds.map(id => db.ref(`spaces/${id}`).once('value')));
    spaceIds.forEach((id, i) => {
      if (spaceSnaps[i].exists()) updates[`spaceEvents/${id}/${eventId}`] = true;
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
