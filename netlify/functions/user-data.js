'use strict';
// Returns the authenticated user's complete social data from RTDB.
// Stage 1 (parallel): profile, userEvents, userSpaces, friends, invites, friendRequests
// Stage 2 (parallel): full event objects, full space objects, spaceEvents, friend profiles
const { initAdmin, verifyUserToken, json } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const { decoded, errorStatus, errorCode } = await verifyUserToken(event.headers['authorization'] || '');
  if (!decoded) {
    if (errorStatus === 503) return json(503, { error: 'Service temporarily unavailable. Check server configuration.' });
    return json(401, { error: errorCode === 'missing-token' ? 'Unauthorized' : 'Invalid token' });
  }

  const uid = decoded.uid;
  const db  = initAdmin().database();

  // Stage 1: top-level indices
  const [profileSnap, userEventsSnap, userSpacesSnap, friendsSnap, invitesSnap, friendReqsSnap, spaceInvitesSnap] = await Promise.all([
    db.ref(`users/${uid}`).once('value'),
    db.ref(`userEvents/${uid}`).once('value'),
    db.ref(`userSpaces/${uid}`).once('value'),
    db.ref(`friends/${uid}`).once('value'),
    db.ref(`invites/${uid}`).once('value'),
    db.ref(`friendRequests/${uid}`).once('value'),
    db.ref(`spaceInvites/${uid}`).once('value'),
  ]);

  const userEvents     = userEventsSnap.val()    || {};
  const userSpaces     = userSpacesSnap.val()    || {};
  const friends        = friendsSnap.val()        || {};
  const invites        = invitesSnap.val()        || {};
  const friendRequests = friendReqsSnap.val()     || {};
  const spaceInvites   = spaceInvitesSnap.val()   || {};

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

  // Always include every friend entry; fall back to Firebase Auth for missing RTDB profiles
  const admin = initAdmin();
  const friendProfiles = {};
  await Promise.all(friendIds.map(async (id, i) => {
    const v = friendSnaps[i].val();
    let displayName = (v && v.displayName) || null;
    let username    = (v && v.username)    || null;
    if (!displayName && !username) {
      try {
        const authUser = await admin.auth().getUser(id);
        displayName = authUser.displayName || null;
      } catch (_) { /* user may have been deleted */ }
    }
    friendProfiles[id] = { displayName, username };
  }));

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
    spaceInvites,
  });
};
