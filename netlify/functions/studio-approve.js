const { initAdmin, verifyStudioToken, json } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const actor = await verifyStudioToken(event.headers['authorization'], ['editor', 'superadmin']);
  if (!actor) return json(403, { error: 'Forbidden' });

  let payload;
  try { payload = JSON.parse(event.body); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { suggestionId, notes } = payload;
  if (!suggestionId) return json(400, { error: 'suggestionId required' });

  const db = initAdmin().database();
  const sugSnap = await db.ref(`suggestions/${suggestionId}`).once('value');
  if (!sugSnap.exists()) return json(404, { error: 'Suggestion not found' });

  const sug = sugSnap.val();

  // Idempotency check: if an activityId is already set (by a prior or concurrent approve),
  // return the existing result without writing again.
  if (sug.activityId) {
    return json(200, { activityId: sug.activityId, idempotent: true });
  }

  if (sug.status !== 'submitted') {
    return json(409, { error: `Cannot approve suggestion with status: ${sug.status}` });
  }

  const now = Date.now();
  // Deterministic IDs derived from suggestionId: parallel requests write identical data
  // to identical paths, making concurrent approves idempotent via RTDB last-write-wins.
  const activityId = 'act_' + suggestionId;
  const logId = 'log_approve_' + suggestionId;

  await db.ref().update({
    [`activities/${activityId}`]: {
      title: sug.title,
      description: sug.description,
      category: sug.category,
      city: sug.city,
      district: sug.district || null,
      location: sug.location || null,
      providerId: sug.providerId || null,
      providerName: sug.providerName || null,
      website: sug.website || null,
      instagram: sug.instagram || null,
      price: sug.price || null,
      schedule: sug.schedule || null,
      bookingUrl: sug.bookingUrl || null,
      imageUrls: sug.imageUrls || null,
      suggestionId,
      publishedAt: now,
      publishedBy: actor.uid,
      status: 'active',
      updatedAt: now,
    },
    [`suggestions/${suggestionId}/status`]: 'approved',
    [`suggestions/${suggestionId}/activityId`]: activityId,
    [`suggestions/${suggestionId}/reviewedBy`]: actor.uid,
    [`suggestions/${suggestionId}/reviewedAt`]: now,
    [`suggestions/${suggestionId}/reviewNotes`]: notes || null,
    [`suggestions/${suggestionId}/updatedAt`]: now,
    [`studioAuditLog/${logId}`]: {
      action: 'approve',
      actorUid: actor.uid,
      actorEmail: actor.email || null,
      actorRole: actor.studioRole,
      suggestionId,
      activityId,
      details: notes || null,
      timestamp: now,
    },
  });

  return json(200, { activityId });
};
