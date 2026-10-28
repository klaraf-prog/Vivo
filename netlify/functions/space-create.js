'use strict';
// POST { name, memberUids? } — create a new space (group).
// Writes: spaces/$id, userSpaces/$uid/$id, userSpaces/$memberId/$id for each member
const { initAdmin, verifyUserToken, json, makeId } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const { decoded, errorStatus, errorCode } = await verifyUserToken(event.headers['authorization'] || '');
  if (!decoded) {
    if (errorStatus === 503) return json(503, { error: 'Service temporarily unavailable. Check server configuration.' });
    return json(401, { error: errorCode === 'missing-token' ? 'Unauthorized' : 'Invalid token' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const { name, memberUids } = body;
  if (!name || typeof name !== 'string' || !name.trim()) return json(400, { error: 'name is required' });
  if (name.trim().length > 80) return json(400, { error: 'name too long (max 80 chars)' });

  const uid = decoded.uid;
  const db  = initAdmin().database();

  // Verify creator profile exists
  const creatorSnap = await db.ref(`users/${uid}`).once('value');
  if (!creatorSnap.exists()) return json(404, { error: 'Creator user not found' });

  // Validate member uids (deduplicated, excluding creator)
  const extraMembers = [...new Set((memberUids || []).filter(id => id && id !== uid))];
  const memberChecks = await Promise.all(extraMembers.map(id => db.ref(`users/${id}`).once('value')));
  const validMembers = extraMembers.filter((id, i) => memberChecks[i].exists());

  const spaceId  = makeId('sp');
  const now      = Date.now();
  const members  = { [uid]: true };
  validMembers.forEach(id => { members[id] = true; });

  const update = {
    [`spaces/${spaceId}`]: {
      name:      name.trim(),
      createdBy: uid,
      createdAt: now,
      members,
    },
    [`userSpaces/${uid}/${spaceId}`]: true,
  };
  validMembers.forEach(id => {
    update[`userSpaces/${id}/${spaceId}`] = true;
  });

  await db.ref('/').update(update);
  return json(201, { ok: true, spaceId, name: name.trim(), memberCount: Object.keys(members).length });
};
