'use strict';
const { verifyStudioToken, initAdmin, json } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method-not-allowed' });

  const decoded = await verifyStudioToken(event.headers.authorization, ['editor', 'superadmin']);
  if (!decoded) return json(401, { error: 'unauthorized' });

  const { from, to } = event.queryStringParameters || {};
  const fromDate = from || null;
  const toDate   = to   || null;

  try {
    const app = initAdmin();
    const db  = app.database();

    const [usersSnap, eventsSnap, userEventsSnap, spacesSnap, spaceEventsSnap, invitesSnap] = await Promise.all([
      db.ref('users').once('value'),
      db.ref('events').once('value'),
      db.ref('userEvents').once('value'),
      db.ref('spaces').once('value'),
      db.ref('spaceEvents').once('value'),
      db.ref('invites').once('value'),
    ]);

    const users         = usersSnap.val()       || {};
    const events        = eventsSnap.val()       || {};
    const userEventsAll = userEventsSnap.val()   || {};
    const spaces        = spacesSnap.val()       || {};
    const spaceEvents   = spaceEventsSnap.val()  || {};
    const invites       = invitesSnap.val()      || {};

    const today        = new Date().toISOString().slice(0, 10);
    const eventEntries = Object.entries(events);

    const eventsInPeriod = (fromDate && toDate)
      ? eventEntries.filter(([, e]) => e.date && e.date >= fromDate && e.date <= toDate)
      : eventEntries;

    const eventsInPeriodIds = new Set(eventsInPeriod.map(([id]) => id));
    const completedEvents   = eventsInPeriod.filter(([, e]) => e.date && e.date < today);
    const upcomingEvents    = eventsInPeriod.filter(([, e]) => e.date && e.date >= today);

    let dabeiTotal = 0, vielleichtTotal = 0, neinTotal = 0, createdTotal = 0;
    let dabeiPeriod = 0, vielleichtPeriod = 0, neinPeriod = 0;
    const usersDabeiTotal   = new Set();
    const usersDabeiPeriod  = new Set();
    const usersAnyRsvp      = new Set();
    const usersCreatedEvs   = new Set();

    for (const [uid, userEvs] of Object.entries(userEventsAll)) {
      for (const [eventId, rsvp] of Object.entries(userEvs || {})) {
        usersAnyRsvp.add(uid);
        if (rsvp === 'dabei')       { dabeiTotal++;     usersDabeiTotal.add(uid); }
        else if (rsvp === 'vielleicht') vielleichtTotal++;
        else if (rsvp === 'nein')       neinTotal++;
        else if (rsvp === 'created')    { createdTotal++; usersCreatedEvs.add(uid); }

        if (eventsInPeriodIds.has(eventId)) {
          if (rsvp === 'dabei')           { dabeiPeriod++;      usersDabeiPeriod.add(uid); }
          else if (rsvp === 'vielleicht') vielleichtPeriod++;
          else if (rsvp === 'nein')       neinPeriod++;
        }
      }
    }

    let invitesTotal = 0;
    for (const userInvites of Object.values(invites)) {
      invitesTotal += Object.keys(userInvites || {}).length;
    }

    const timeBuckets = buildTimeBuckets(
      fromDate, toDate,
      eventsInPeriod.map(([, e]) => e.date).filter(Boolean)
    );

    return json(200, {
      period: { from: fromDate, to: toDate },
      users: {
        total:               Object.keys(users).length,
        withAnyRsvpActivity: usersAnyRsvp.size,
        whoCreatedEvents:    usersCreatedEvs.size,
      },
      events: {
        total:                eventEntries.length,
        inPeriodByEventDate:  eventsInPeriod.length,
        completedByEventDate: completedEvents.length,
        upcomingByEventDate:  upcomingEvents.length,
        timeBuckets,
      },
      rsvps: {
        dabei:                  dabeiTotal,
        vielleicht:             vielleichtTotal,
        nein:                   neinTotal,
        created:                createdTotal,
        dabeiPeriod,
        vielleichtPeriod,
        neinPeriod,
        uniqueUsersDabei:       usersDabeiTotal.size,
        uniqueUsersDabeiPeriod: usersDabeiPeriod.size,
        uniqueUsersAnyRsvp:     usersAnyRsvp.size,
      },
      spaces: {
        total:           Object.keys(spaces).length,
        withSpaceEvents: Object.keys(spaceEvents).length,
      },
      invites: { total: invitesTotal },
    });
  } catch (e) {
    console.error('[analytics-b2c]', e.message);
    return json(500, { error: 'internal-error' });
  }
};

function buildTimeBuckets(fromDate, toDate, eventDates) {
  if (!fromDate || !toDate || !eventDates.length) return [];

  const from     = new Date(fromDate);
  const to       = new Date(toDate);
  const diffDays = Math.ceil((to - from) / 86400000);

  if (diffDays <= 14) {
    const buckets = [];
    for (const d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      buckets.push({ label: d.toISOString().slice(0, 10), count: 0 });
    }
    for (const date of eventDates) {
      const b = buckets.find(b => b.label === date);
      if (b) b.count++;
    }
    return buckets;
  }

  if (diffDays <= 92) {
    const buckets = [];
    for (const ws = new Date(from); ws <= to; ws.setDate(ws.getDate() + 7)) {
      const we = new Date(ws); we.setDate(we.getDate() + 6);
      buckets.push({ label: ws.toISOString().slice(0, 10), wsStr: ws.toISOString().slice(0, 10), weStr: we.toISOString().slice(0, 10), count: 0 });
    }
    for (const date of eventDates) {
      const b = buckets.find(b => date >= b.wsStr && date <= b.weStr);
      if (b) b.count++;
    }
    return buckets.map(({ label, count }) => ({ label, count }));
  }

  // Monthly
  const startM = from.getFullYear() * 12 + from.getMonth();
  const endM   = to.getFullYear()   * 12 + to.getMonth();
  const buckets = [];
  for (let m = startM; m <= endM; m++) {
    const y = Math.floor(m / 12), mo = m % 12;
    buckets.push({ label: `${y}-${String(mo + 1).padStart(2, '0')}`, count: 0 });
  }
  for (const date of eventDates) {
    const b = buckets.find(b => b.label === date.slice(0, 7));
    if (b) b.count++;
  }
  return buckets;
}
