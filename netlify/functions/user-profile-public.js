const { initAdmin, json } = require('./_studio-shared');

// Returns the public display fields (displayName, username) for a given UID.
// Requires a valid Firebase ID token — returns no data to unauthenticated callers.
// Intentionally exposes only non-sensitive fields; email is never returned.
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const auth = event.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return json(401, { error: 'Unauthorized' });

  const uid = event.queryStringParameters && event.queryStringParameters.uid;
  if (!uid || uid.length > 128) return json(400, { error: 'Missing or invalid uid' });

  try {
    const admin = initAdmin();
    // Verify caller is authenticated (any valid user may look up display info)
    await admin.auth().verifyIdToken(auth.slice(7));

    const snap = await admin.database().ref(`users/${uid}`).once('value');
    if (!snap.exists()) return json(404, { error: 'User not found' });

    const { displayName, username } = snap.val();
    return json(200, {
      displayName: displayName || null,
      username:    username    || null,
    });
  } catch (e) {
    if (e.code && e.code.startsWith('auth/')) return json(401, { error: 'Unauthorized' });
    return json(500, { error: 'Internal error' });
  }
};
