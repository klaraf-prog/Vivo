const { initAdmin, verifyStudioToken, json, makeId } = require('./_studio-shared');

const VALID_ROLES = ['editor', 'researcher', 'superadmin'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const actor = await verifyStudioToken(event.headers['authorization'], ['superadmin']);
  if (!actor) return json(403, { error: 'Forbidden: superadmin required' });

  let payload;
  try { payload = JSON.parse(event.body); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { targetUid, targetEmail, role } = payload;
  if (!targetUid || !role) return json(400, { error: 'targetUid and role required' });
  if (!VALID_ROLES.includes(role)) return json(400, { error: `Invalid role: ${VALID_ROLES.join(', ')}` });
  if (targetUid === actor.uid) return json(403, { error: 'Cannot change your own role' });

  const app = initAdmin();
  await app.auth().setCustomUserClaims(targetUid, { studioRole: role });

  const now = Date.now();
  const logId = makeId('log');

  await app.database().ref().update({
    [`studioAdminUsers/${targetUid}`]: {
      email: targetEmail || null,
      role,
      updatedAt: now,
      updatedBy: actor.uid,
    },
    [`studioAuditLog/${logId}`]: {
      action: 'set_role',
      actorUid: actor.uid,
      actorEmail: actor.email || null,
      actorRole: 'superadmin',
      targetUid,
      details: `Set role to: ${role}`,
      timestamp: now,
    },
  });

  return json(200, { ok: true, targetUid, role });
};
