'use strict';
// POST (no body) — authenticated by user token.
// Checks all future confirmed events the caller RSVPed "dabei" to.
// For each event whose date+time is within the next 24 hours, writes
// a reminder notification to notifications/{uid}/{notifId} unless one
// already exists for that event (idempotent).
//
// Also callable server-side via scheduled cron (see netlify.toml).
// When called without an Authorization header it uses an optional
// NOTIFY_SECRET environment variable as a bearer token so a cron job
// can trigger it for all users — that path is intentionally NOT
// implemented here to keep scope small; this endpoint serves
// per-user lazy triggers on app open.
const { initAdmin, verifyUserToken, json, makeId } = require('./_studio-shared');

const WINDOW_MS = 25 * 60 * 60 * 1000; // 25 h — write reminder up to 25h before event

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const { decoded, errorStatus } = await verifyUserToken(event.headers['authorization'] || '');
  if (!decoded) {
    if (errorStatus === 503) return json(503, { error: 'Service temporarily unavailable.' });
    return json(401, { error: 'Unauthorized' });
  }

  const uid = decoded.uid;
  const db  = initAdmin().database();

  // Load all events the user RSVPed "dabei" to
  const userEventsSnap = await db.ref(`userEvents/${uid}`).once('value');
  const userEvents = userEventsSnap.val() || {};
  const dabeEvents = Object.entries(userEvents)
    .filter(([, status]) => status === 'dabei')
    .map(([id]) => id);

  if (!dabeEvents.length) return json(200, { ok: true, created: 0 });

  // Load existing reminder notifications to avoid duplicates
  const existingSnap = await db.ref(`notifications/${uid}`).once('value');
  const existing = existingSnap.val() || {};
  const reminderEventIds = new Set(
    Object.values(existing)
      .filter(n => n.type === 'reminder')
      .map(n => n.eventId)
  );

  const now = Date.now();
  const writes = {};
  let created = 0;

  for (const eventId of dabeEvents) {
    // Skip if reminder already exists for this event
    if (reminderEventIds.has(eventId)) continue;

    const evSnap = await db.ref(`events/${eventId}`).once('value');
    if (!evSnap.exists()) continue;
    const ev = evSnap.val();

    // Skip cancelled or poll events without a confirmed date
    if (ev.cancelled) continue;
    if (!ev.date) continue;

    // Parse event datetime in UTC (treat date+time as local to avoid TZ drift in notifications)
    const timeStr = ev.time || '00:00';
    const [h, m] = timeStr.split(':').map(Number);
    const eventDate = new Date(`${ev.date}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`);
    const eventMs = eventDate.getTime();

    // Only remind for future events within the next 25 h
    if (eventMs <= now) continue;
    if (eventMs > now + WINDOW_MS) continue;

    const notifId = makeId('notif');
    const title = (ev.emoji ? ev.emoji + ' ' : '') + (ev.title || 'Event');
    const dateLabel = ev.date + (ev.time ? ' · ' + ev.time : '');
    writes[`notifications/${uid}/${notifId}`] = {
      type: 'reminder',
      source: 'personal',
      eventId,
      eventTitle: ev.title || '',
      eventEmoji: ev.emoji || null,
      message: `Erinnerung: ${title} – heute um ${ev.time || ev.date}`,
      dateLabel,
      createdAt: now,
      readAt: null,
    };
    created++;
  }

  if (created > 0) {
    await db.ref('/').update(writes);
  }

  return json(200, { ok: true, created });
};
