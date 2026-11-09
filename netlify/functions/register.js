'use strict';
// POST { handle, displayName, birthdate }
// Atomically claims a handle via RTDB transaction, then writes the user profile
// and private data. Called right after client-side createUserWithEmailAndPassword.
// If anything fails, the caller must delete the Firebase Auth user.
const { initAdmin, verifyUserToken, json } = require('./_studio-shared');

const HANDLE_RE = /^[a-z0-9_]{2,30}$/;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const { decoded, errorStatus } = await verifyUserToken(event.headers['authorization'] || '');
  if (!decoded) {
    if (errorStatus === 503) return json(503, { error: 'Service temporarily unavailable. Check server configuration.' });
    return json(401, { error: 'Unauthorized' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const { handle, displayName, birthdate } = body;

  // Validate displayName
  if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
    return json(400, { error: 'displayName is required' });
  }
  if (displayName.trim().length > 80) return json(400, { error: 'displayName too long (max 80 chars)' });

  // Validate and normalize handle
  if (!handle || typeof handle !== 'string') return json(400, { error: 'handle is required' });
  const normalizedHandle = handle.toLowerCase().replace(/\s/g, '');
  if (!HANDLE_RE.test(normalizedHandle)) {
    return json(400, {
      error: 'handle must be 2–30 characters and may only contain letters (a–z), numbers, and underscores',
    });
  }

  // Validate birthdate
  if (!birthdate || typeof birthdate !== 'string') return json(400, { error: 'birthdate is required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) return json(400, { error: 'birthdate must be YYYY-MM-DD' });
  const bd = new Date(birthdate + 'T12:00:00Z');
  if (isNaN(bd.getTime())) return json(400, { error: 'Invalid birthdate' });
  if (bd >= new Date()) return json(400, { error: 'Birthdate cannot be today or in the future' });
  const minDate = new Date();
  minDate.setFullYear(minDate.getFullYear() - 150);
  if (bd < minDate) return json(400, { error: 'Birthdate is implausible' });

  const uid = decoded.uid;
  const db = initAdmin().database();

  // Atomically reserve the handle. Returns committed=false if already taken.
  const handleRef = db.ref(`handles/${normalizedHandle}`);
  let transactionResult;
  try {
    transactionResult = await handleRef.transaction((current) => {
      if (current !== null) return; // abort: taken
      return uid;                   // commit: claim
    });
  } catch (e) {
    console.error('[someday:register] handle transaction error:', e.message);
    return json(500, { error: 'Could not reserve handle. Please try again.' });
  }

  if (!transactionResult.committed) {
    return json(409, { error: 'handle-taken', message: 'This handle is already taken. Please choose another.' });
  }

  // Write user profile and private data as a single multi-path update.
  // Read existing profile first so Google-OAuth users don't lose their data.
  // If this fails, release the handle so the user can retry.
  const now = Date.now();
  let existingProfile = {};
  try {
    const snap = await db.ref(`users/${uid}`).once('value');
    existingProfile = snap.val() || {};
  } catch { /* non-fatal: proceed with empty base */ }

  try {
    await db.ref('/').update({
      [`users/${uid}`]: {
        ...existingProfile,
        displayName: displayName.trim(),
        displayNameLower: displayName.trim().toLowerCase(),
        handle: normalizedHandle,
        username: normalizedHandle,
        createdAt: existingProfile.createdAt || now,
        updatedAt: now,
        registrationComplete: true,
      },
      [`userPrivate/${uid}/birthdate`]: birthdate,
      [`usernames/${normalizedHandle}`]: uid,
    });
  } catch (profileErr) {
    console.error('[someday:register] profile write error:', profileErr.message);
    // Best-effort cleanup: release the handle so the user can retry.
    try { await handleRef.remove(); } catch {}
    return json(500, { error: 'Profile could not be saved. Please try again.' });
  }

  return json(200, { ok: true, uid, handle: normalizedHandle });
};
