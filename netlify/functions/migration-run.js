'use strict';
/**
 * One-shot Discovery migration: vivo-mvp → someday-3edba
 *
 * Security model (identical to studio-bootstrap):
 *   - Returns 503 if MIGRATION_TOKEN env var is absent → function is inert by default
 *   - Caller must supply matching X-Migration-Token header
 *   - After success, writes RTDB flag migrationState/discoveryMigration → prevents re-run
 *   - Remove MIGRATION_TOKEN + SOURCE_FIREBASE_SA + SOURCE_RTDB_URL from Netlify after done
 *
 * Never call this from client code. Trigger via curl or Netlify function invocation UI.
 */

const admin = require('firebase-admin');
const { initAdmin, json } = require('./_studio-shared');

const MIGRATE_PATHS = [
  'activities',
  'suggestions',
  'suggestionHashes',
  'providers',
  'discoverySources',
  'discoverySourceUrls',
];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  // ── Guard: only active when MIGRATION_TOKEN is configured ─────────────────
  const expectedToken = process.env.MIGRATION_TOKEN;
  if (!expectedToken) {
    return json(503, { error: 'Migration not configured or already deactivated.' });
  }

  // ── Token check ───────────────────────────────────────────────────────────
  const suppliedToken = event.headers['x-migration-token'];
  if (!suppliedToken || suppliedToken !== expectedToken) {
    return json(403, { error: 'Invalid or missing X-Migration-Token.' });
  }

  // ── Source credentials check ───────────────────────────────────────────────
  const sourceSaRaw  = process.env.SOURCE_FIREBASE_SA;
  const sourceRtdbUrl = process.env.SOURCE_RTDB_URL;
  if (!sourceSaRaw || !sourceRtdbUrl) {
    return json(503, { error: 'SOURCE_FIREBASE_SA or SOURCE_RTDB_URL not configured.' });
  }

  // ── Target DB (someday-3edba via existing shared init) ─────────────────────
  const tgtDb = initAdmin().database();

  // ── Idempotency: refuse if already run ────────────────────────────────────
  const flagSnap = await tgtDb.ref('migrationState/discoveryMigration').once('value');
  if (flagSnap.exists()) {
    return json(409, {
      error: 'Migration already completed.',
      completedAt: flagSnap.val().completedAt,
    });
  }

  // ── Source DB (vivo-mvp) ──────────────────────────────────────────────────
  let sourceSa;
  try { sourceSa = JSON.parse(sourceSaRaw); }
  catch { return json(500, { error: 'SOURCE_FIREBASE_SA is not valid JSON.' }); }

  let srcApp;
  try {
    // Use a unique app name so it doesn't clash with the target app
    srcApp = admin.initializeApp(
      { credential: admin.credential.cert(sourceSa), databaseURL: sourceRtdbUrl },
      'migration-source',
    );
  } catch (e) {
    // App may already exist if the function is retried mid-run
    srcApp = admin.app('migration-source');
  }
  const srcDb = srcApp.database();

  // ── Migrate ────────────────────────────────────────────────────────────────
  const report   = {};
  const warnings = [];

  for (const p of MIGRATE_PATHS) {
    const [srcSnap, tgtSnap] = await Promise.all([
      srcDb.ref(p).once('value'),
      tgtDb.ref(p).once('value'),
    ]);

    const src = srcSnap.val() || {};
    const tgt = tgtSnap.val() || {};

    if (Object.keys(src).length === 0) {
      report[p] = { migrated: 0, skipped: 0 };
      continue;
    }

    const toWrite = {};
    let migrated = 0;
    let skipped  = 0;

    for (const [id, val] of Object.entries(src)) {
      if (tgt[id] !== undefined) {
        skipped++;
        warnings.push(`${p}/${id} already exists — skipped`);
      } else {
        toWrite[`${p}/${id}`] = val;
        migrated++;
      }
    }

    if (Object.keys(toWrite).length > 0) {
      await tgtDb.ref().update(toWrite);
    }

    report[p] = { migrated, skipped };
  }

  // ── Write completion flag ─────────────────────────────────────────────────
  await tgtDb.ref('migrationState/discoveryMigration').set({
    completedAt: Date.now(),
    report,
  });

  return json(200, {
    ok: true,
    report,
    warnings,
    message: 'Migration complete. Remove MIGRATION_TOKEN, SOURCE_FIREBASE_SA and SOURCE_RTDB_URL from Netlify now.',
  });
};
