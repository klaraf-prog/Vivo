'use strict';
// Returns the authenticated user's complete social data from RTDB.
// Stage 1 (parallel): profile, userEvents, userSpaces, friends, invites, friendRequests
// Stage 2 (parallel): full event objects, full space objects, spaceEvents, friend profiles
const { initAdmin, json } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const authHeader = event.headers['authorization'] || '';
  const idToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!idToken) return json(401, { error: 'Unauthorized' });

  let decoded;
  try {
    decoded = await initAdmin().auth().verifyIdToken(idToken);
  } catch {
    return json(401, { error: 'Invalid token' });
  }

  const uid = decoded.uid;
  const db  = initAdmin().database();

  // Stage 1: top-level indices
  const [profileSnap, userEventsSnap, userSpacesSnap, friendsSnap, invitesSnap, friendReqsSnap] = await Promise.all([
    db.ref(`users/${uid}`).once('value'),
    db.ref(`userEvents/${uid}`).once('value'),
    db.ref(`userSpaces/${uid}`).once('value'),
    db.ref(`friends/${uid}`).once('value'),
    db.ref(`invites/${uid}`).once('value'),
    db.ref(`friendRequests/${uid}`).once('value'),
  ]);

  const userEvents     = userEventsSnap.val()   || {};
  const userSpaces     = userSpacesSnap.val()   || {};
  const friends        = friendsSnap.val()       || {};
  const invites        = invitesSnap.val()       || {};
  const friendRequests = friendReqsSnap.val()    || {};

  // Stage 2: resolve references
  const eventIds  = [...new Set([...Object.keys(userEvents), ...Object.keys(invites)])];
  const spaceIds  = Object.keys(userSpaces);
  const friendIds = Object.keys(friends);

  const [eventSnaps, spaceSnaps, spaceEventSnaps, friendSnaps] = await Promise.all([
    Promise.all(eventIds.map(id  => db.ref(`events/${id}`).once('value'))),
    Promise.all(spaceIds.map(id  => db.ref(`spaces/${id}`).once('value'))),
    Promise.all(spaceIds.map(id  => db.ref(`spaceEvents/${id}`).once('value'))),
    Promise.all(friendIds.map(id => db.ref(`users/${id}`).once('value'))),
  ]);

  const events = {};
  eventIds.forEach((id, i) => { const v = eventSnaps[i].val(); if (v) events[id] = v; });

  const spaces = {};
  spaceIds.forEach((id, i) => { const v = spaceSnaps[i].val(); if (v) spaces[id] = v; });

  const spaceEvents = {};
  spaceIds.forEach((id, i) => { const v = spaceEventSnaps[i].val(); if (v) spaceEvents[id] = v; });

  const friendProfiles = {};
  friendIds.forEach((id, i) => {
    const v = friendSnaps[i].val();
    if (v) friendProfiles[id] = { displayName: v.displayName || null, username: v.username || null };
  });

  return json(200, {
    uid,
    profile: profileSnap.val() || null,
    userEvents,
    userSpaces,
    events,
    spaces,
    spaceEvents,
    friends,
    friendProfiles,
    invites,
    friendRequests,
  });
};
