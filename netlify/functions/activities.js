'use strict';
// Public endpoint — no auth required.
// Returns activities with status "active" from RTDB.
// Works in local emulator (via FIREBASE_DATABASE_EMULATOR_HOST env var)
// and in production (via FIREBASE_RTDB_URL + service account).
const { initAdmin, json } = require('./_studio-shared');

// Only these fields are exposed publicly. Internal fields (suggestionId,
// publishedBy, updatedAt, etc.) are stripped before the response is sent.
const PUBLIC_FIELDS = [
  'title', 'tagline', 'description', 'category', 'eyebrow',
  'city', 'district', 'location', 'lat', 'lng',
  'providerName', 'website', 'instagram',
  'price', 'schedule', 'bookingUrl', 'imageUrls',
  'publishedAt',
];

function toPublic(record) {
  const out = {};
  for (const field of PUBLIC_FIELDS) {
    if (record[field] != null) out[field] = record[field];
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const db   = initAdmin().database();
  const snap = await db.ref('activities')
    .orderByChild('status').equalTo('active')
    .once('value');

  const activities = {};
  snap.forEach(child => { activities[child.key] = toPublic(child.val()); });

  return json(200, { activities });
};
