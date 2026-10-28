'use strict';
/**
 * Einmalige Bootstrap-Funktion zur Superadmin-Einrichtung.
 *
 * Sicherheitsmodell:
 *   - Nur POST
 *   - Erfordert X-Bootstrap-Token-Header (= BOOTSTRAP_TOKEN env var)
 *   - Erfordert gültiges Firebase-ID-Token (Authorization: Bearer ...)
 *   - UID im Token muss exakt mit BOOTSTRAP_TARGET_UID env var übereinstimmen
 *   - Nach einmaliger Ausführung: dauerhaft 409 (RTDB-Flag in bootstrapState/adminBootstrap)
 *   - Ohne BOOTSTRAP_TOKEN in env: dauerhaft 503 (Funktion inaktiv)
 */
const { initAdmin, json } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  // ── 1. Bootstrap konfiguriert? ───────────────────────────────────────────
  const bootstrapToken = process.env.BOOTSTRAP_TOKEN;
  const targetUid      = process.env.BOOTSTRAP_TARGET_UID;

  if (!bootstrapToken || !targetUid) {
    // BOOTSTRAP_TOKEN fehlt → Funktion dauerhaft inaktiv
    return json(503, { error: 'bootstrap-not-configured' });
  }

  // ── 2. Bootstrap-Token prüfen ────────────────────────────────────────────
  const providedToken = event.headers['x-bootstrap-token'] || '';
  if (providedToken !== bootstrapToken) {
    // Kein Logging des Tokens
    return json(403, { error: 'Forbidden' });
  }

  // ── 3. Firebase-ID-Token prüfen ──────────────────────────────────────────
  const authHeader = event.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json(401, { error: 'missing-token' });
  }

  let app;
  try { app = initAdmin(); } catch (e) {
    console.error('[bootstrap] Admin SDK init error:', e.message);
    return json(503, { error: 'server-config-error' });
  }

  let decoded;
  try {
    decoded = await app.auth().verifyIdToken(authHeader.slice(7));
  } catch {
    return json(401, { error: 'invalid-token' });
  }

  // ── 4. UID muss exakt mit Ziel-UID übereinstimmen ───────────────────────
  if (decoded.uid !== targetUid) {
    return json(403, { error: 'Forbidden' });
  }

  // ── 5. Bereits ausgeführt? (RTDB-Flag) ──────────────────────────────────
  const db       = app.database();
  const stateRef = db.ref('bootstrapState/adminBootstrap');

  const existingState = await stateRef.once('value');
  if (existingState.exists()) {
    return json(409, { error: 'already-completed' });
  }

  // ── 6. Bestehende Custom Claims erhalten, studioRole ergänzen ────────────
  let userRecord;
  try {
    userRecord = await app.auth().getUser(decoded.uid);
  } catch (e) {
    console.error('[bootstrap] getUser error:', e.message);
    return json(500, { error: 'user-lookup-failed' });
  }

  const existingClaims = userRecord.customClaims || {};
  const newClaims      = { ...existingClaims, studioRole: 'superadmin' };

  await app.auth().setCustomUserClaims(decoded.uid, newClaims);

  // ── 7. Bootstrap-Flag setzen (weitere Versuche dauerhaft ablehnen) ───────
  await stateRef.set({ completedAt: Date.now(), uid: decoded.uid });

  console.log(`[bootstrap] studioRole:superadmin gesetzt (uid: ${decoded.uid})`);

  return json(200, { success: true, role: 'superadmin' });
};
