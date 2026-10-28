'use strict';
// POST { displayName?, username?, bio? } — write/merge the authenticated user's profile.
// Preserves createdAt if already set. Validates username uniqueness via usernames index.
const { initAdmin, json } = require('./_studio-shared');

const USERNAME_RE = /^[a-z0-9_]{2,30}$/;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const authHeader = event.headers['authorization'] || '';
  const idToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!idToken) return json(401, { error: 'Unauthorized' });

  let decoded;
  try {
    decoded = await initAdmin().auth().verifyIdToken(idToken);
  } catch {
    return json(401, { error: 'Invalid token' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const { displayName, username, bio } = body;
  if (!displayName && !username && bio === undefined) return json(400, { error: 'No profile fields provided' });

  if (displayName !== undefined) {
    if (typeof displayName !== 'string' || !displayName.trim()) return json(400, { error: 'displayName must be a non-empty string' });
    if (displayName.trim().length > 80) return json(400, { error: 'displayName too long (max 80 chars)' });
  }
  if (username !== undefined) {
    if (!USERNAME_RE.test(username)) return json(400, { error: 'username must be 2-30 lowercase alphanumeric/underscore characters' });
  }
  if (bio !== undefined) {
    if (typeof bio !== 'string') return json(400, { error: 'bio must be a string' });
    if (bio.length > 500) return json(400, { error: 'bio too long (max 500 chars)' });
  }

  const uid = decoded.uid;
  const db  = initAdmin().database();

  // Check username uniqueness
  if (username !== undefined) {
    const usernameSnap = await db.ref(`usernames/${username}`).once('value');
    if (usernameSnap.exists() && usernameSnap.val() !== uid) {
      return json(409, { error: 'Username already taken' });
    }
  }

  // Read existing profile to preserve createdAt
  const profileSnap = await db.ref(`users/${uid}`).once('value');
  const existing    = profileSnap.val() || {};

  const profileUpdate = { ...existing };
  if (displayName !== undefined)  profileUpdate.displayName = displayName.trim();
  if (username !== undefined)     profileUpdate.username    = username;
  if (bio !== undefined)          profileUpdate.bio         = bio;
  if (!profileUpdate.createdAt)   profileUpdate.createdAt   = Date.now();
  profileUpdate.updatedAt = Date.now();
  if (profileUpdate.displayName)  profileUpdate.displayNameLower = profileUpdate.displayName.toLowerCase();

  const update = { [`users/${uid}`]: profileUpdate };
  if (username !== undefined) {
    // Remove old username index entry if username changed
    if (existing.username && existing.username !== username) {
      update[`usernames/${existing.username}`] = null;
    }
    update[`usernames/${username}`] = uid;
  }

  await db.ref('/').update(update);
  return json(200, { ok: true, uid, displayName: profileUpdate.displayName || null, username: profileUpdate.username || null });
};
