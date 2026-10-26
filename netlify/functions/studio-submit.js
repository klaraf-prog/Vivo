const { initAdmin, verifyStudioToken, json, makeId, duplicateHash } = require('./_studio-shared');

const REQUIRED = ['title', 'description', 'category', 'city'];

async function authenticateRequest(event) {
  const apiKey = event.headers['x-studio-key'];
  const researcherKey = process.env.STUDIO_RESEARCHER_KEY;
  if (researcherKey && apiKey === researcherKey) {
    return { uid: 'researcher-agent', studioRole: 'researcher', email: null };
  }
  return verifyStudioToken(event.headers['authorization'], ['researcher', 'editor', 'superadmin']);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const actor = await authenticateRequest(event);
  if (!actor) return json(403, { error: 'Forbidden' });

  let payload;
  try { payload = JSON.parse(event.body); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  for (const field of REQUIRED) {
    if (!payload[field]) return json(400, { error: `Missing required field: ${field}` });
  }

  const db = initAdmin().database();
  const hash = duplicateHash(payload.city, payload.category, payload.title);
  const safeHash = hash.replace(/[.#$[\]]/g, '_');

  const hashSnap = await db.ref(`suggestionHashes/${safeHash}`).once('value');
  if (hashSnap.exists()) {
    return json(409, { error: 'duplicate', existingId: hashSnap.val() });
  }

  const now = Date.now();
  const suggestionId = makeId('sug');
  const logId = makeId('log');

  const suggestion = {
    title: payload.title,
    tagline: payload.tagline || null,
    description: payload.description,
    category: payload.category,
    eyebrow: payload.eyebrow || null,
    city: payload.city,
    district: payload.district || null,
    location: payload.location || null,
    lat: payload.lat != null ? Number(payload.lat) : null,
    lng: payload.lng != null ? Number(payload.lng) : null,
    providerId: payload.providerId || null,
    providerName: payload.providerName || null,
    website: payload.website || null,
    instagram: payload.instagram || null,
    price: payload.price || null,
    schedule: payload.schedule || null,
    bookingUrl: payload.bookingUrl || null,
    imageUrls: payload.imageUrls || null,
    sources: payload.sources || null,
    duplicateHash: safeHash,
    status: 'submitted',
    researchedAt: now,
    researchedBy: actor.uid,
    reviewedBy: null,
    reviewedAt: null,
    reviewNotes: null,
    activityId: null,
    createdAt: now,
    updatedAt: now,
  };

  await db.ref().update({
    [`suggestions/${suggestionId}`]: suggestion,
    [`suggestionHashes/${safeHash}`]: suggestionId,
    [`studioAuditLog/${logId}`]: {
      action: 'submit',
      actorUid: actor.uid,
      actorEmail: actor.email || null,
      actorRole: actor.studioRole,
      suggestionId,
      activityId: null,
      details: `Submitted: ${payload.title}`,
      timestamp: now,
    },
  });

  return json(201, { suggestionId });
};
