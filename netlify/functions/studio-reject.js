const { initAdmin, verifyStudioToken, json, makeId } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const actor = await verifyStudioToken(event.headers['authorization'], ['editor', 'superadmin']);
  if (!actor) return json(403, { error: 'Forbidden' });

  let payload;
  try { payload = JSON.parse(event.body); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { suggestionId, reason } = payload;
  if (!suggestionId || !reason) return json(400, { error: 'suggestionId and reason required' });

  const db = initAdmin().database();
  const sugSnap = await db.ref(`suggestions/${suggestionId}`).once('value');
  if (!sugSnap.exists()) return json(404, { error: 'Suggestion not found' });

  const sug = sugSnap.val();

  // Guard: if approve already ran (activityId set), refuse to reject to prevent
  // inconsistent state. This protects against sequential conflicts; a true parallel
  // approve+reject race is a documented residual risk (requires RTDB transactions).
  if (sug.activityId) {
    return json(409, { error: 'Cannot reject: suggestion was already approved' });
  }

  if (!['submitted', 'draft'].includes(sug.status)) {
    return json(409, { error: `Cannot reject suggestion with status: ${sug.status}` });
  }

  const now = Date.now();
  const logId = makeId('log');

  await db.ref().update({
    [`suggestions/${suggestionId}/status`]: 'rejected',
    [`suggestions/${suggestionId}/reviewedBy`]: actor.uid,
    [`suggestions/${suggestionId}/reviewedAt`]: now,
    [`suggestions/${suggestionId}/reviewNotes`]: reason,
    [`suggestions/${suggestionId}/updatedAt`]: now,
    [`studioAuditLog/${logId}`]: {
      action: 'reject',
      actorUid: actor.uid,
      actorEmail: actor.email || null,
      actorRole: actor.studioRole,
      suggestionId,
      activityId: null,
      details: reason,
      timestamp: now,
    },
  });

  return json(200, { ok: true });
};
