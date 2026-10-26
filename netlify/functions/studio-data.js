const { initAdmin, verifyStudioToken, json } = require('./_studio-shared');

// Returns all suggestions and activities for the Studio UI.
// Used by studio.html in GitHub Codespaces where the Firebase RTDB Client SDK
// cannot connect to the emulator due to Mixed Content restrictions (HTTPS page
// → HTTP emulator). Server-side Admin SDK has no such constraint.
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const actor = await verifyStudioToken(
    event.headers['authorization'],
    ['editor', 'superadmin', 'researcher'],
  );
  if (!actor) return json(403, { error: 'Forbidden' });

  const db = initAdmin().database();
  const [sugsSnap, actsSnap] = await Promise.all([
    db.ref('suggestions').once('value'),
    db.ref('activities').once('value'),
  ]);

  return json(200, {
    suggestions: sugsSnap.val() || {},
    activities:  actsSnap.val() || {},
  });
};
