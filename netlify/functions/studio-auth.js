'use strict';
const { initAdmin, json } = require('./_studio-shared');

// Server-side sign-in for Codespaces environments.
// The Firebase Auth Client SDK cannot reach the emulator from an HTTPS page
// (port 9099 is private and cross-origin requests are rejected).
// This function runs inside the container and calls the emulator directly.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { email, password } = payload;
  if (!email || !password) return json(400, { error: 'email and password required' });

  const emulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!emulatorHost) return json(503, { error: 'Auth emulator not configured' });

  const signInUrl =
    `http://${emulatorHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`;

  let signInRes;
  try {
    signInRes = await fetch(signInUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
  } catch (e) {
    return json(503, { error: 'Auth service unreachable: ' + e.message });
  }

  const signInData = await signInRes.json();
  if (!signInRes.ok) {
    return json(401, { error: signInData.error?.message || 'INVALID_CREDENTIAL' });
  }

  let decoded;
  try {
    decoded = await initAdmin().auth().verifyIdToken(signInData.idToken);
  } catch (e) {
    return json(500, { error: 'Token verification failed' });
  }

  if (!decoded.studioRole) {
    return json(403, { error: 'No studio role assigned' });
  }

  return json(200, {
    idToken: signInData.idToken,
    email:   decoded.email,
    role:    decoded.studioRole,
    uid:     decoded.uid,
  });
};
