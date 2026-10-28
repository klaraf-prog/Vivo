'use strict';
// Updates editable fields on a suggestion (any status) or published activity.
// Requires editor or superadmin role.
const { initAdmin, verifyStudioToken, json, makeId } = require('./_studio-shared');

const SUGGESTION_FIELDS = [
  'title', 'tagline', 'description', 'category', 'eyebrow',
  'city', 'district', 'location', 'lat', 'lng',
  'providerId', 'providerName', 'website', 'instagram',
  'price', 'schedule', 'bookingUrl', 'imageUrls', 'sources',
  'operatingPeriod', 'openingHours', 'exceptionalHours',
  'sourceAttribution', 'missingFields',
  'geoQuality',
];

const ACTIVITY_FIELDS = [
  'title', 'tagline', 'description', 'category', 'eyebrow',
  'city', 'district', 'location', 'lat', 'lng',
  'providerName', 'website', 'instagram',
  'price', 'schedule', 'bookingUrl', 'imageUrls',
  'operatingPeriod', 'openingHours', 'exceptionalHours',
  'sourceAttribution',
  'geoQuality',
];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const actor = await verifyStudioToken(event.headers['authorization'], ['editor', 'superadmin']);
  if (!actor) return json(403, { error: 'Forbidden' });

  let payload;
  try { payload = JSON.parse(event.body); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { target, id, ...fields } = payload;

  if (!id) return json(400, { error: 'id required' });
  if (target !== 'suggestion' && target !== 'activity') {
    return json(400, { error: 'target must be "suggestion" or "activity"' });
  }

  const allowedFields = target === 'suggestion' ? SUGGESTION_FIELDS : ACTIVITY_FIELDS;
  const updates = {};
  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(fields, field)) {
      // Coerce lat/lng to Number or null
      if (field === 'lat' || field === 'lng') {
        updates[field] = fields[field] != null && fields[field] !== '' ? Number(fields[field]) : null;
      } else {
        updates[field] = fields[field] ?? null;
      }
    }
  }

  if (Object.keys(updates).length === 0) {
    return json(400, { error: 'No editable fields provided' });
  }

  const now    = Date.now();
  const path   = target === 'suggestion' ? `suggestions/${id}` : `activities/${id}`;
  const logId  = makeId('log');

  const db = initAdmin().database();
  const snap = await db.ref(path).once('value');
  if (!snap.exists()) return json(404, { error: `${target} not found` });

  updates.updatedAt = now;

  await db.ref().update({
    ...Object.fromEntries(Object.entries(updates).map(([k, v]) => [`${path}/${k}`, v])),
    [`studioAuditLog/${logId}`]: {
      action:    'edit',
      actorUid:  actor.uid,
      actorEmail: actor.email || null,
      actorRole:  actor.studioRole,
      suggestionId: target === 'suggestion' ? id : null,
      activityId:   target === 'activity'   ? id : null,
      details:   `Updated ${target}: ${Object.keys(updates).filter(k => k !== 'updatedAt').join(', ')}`,
      timestamp: now,
    },
  });

  return json(200, { ok: true, updatedFields: Object.keys(updates) });
};
