/**
 * One-shot Discovery migration: vivo-mvp → someday-3edba
 *
 * Written as Netlify Functions v2 (ESM, export default) so it runs on
 * Netlify's own runtime instead of AWS Lambda — this bypasses the 4 KB
 * Lambda environment-variable limit that would otherwise block two large
 * Firebase service-account JSON blobs from coexisting.
 *
 * Security model (identical to studio-bootstrap):
 *   - Returns 503 if MIGRATION_TOKEN env var is absent → inert by default
 *   - Caller must supply matching X-Migration-Token header
 *   - Writes RTDB flag migrationState/discoveryMigration on success → prevents re-run
 *   - Remove MIGRATION_TOKEN + SOURCE_FIREBASE_SA + SOURCE_RTDB_URL after done
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const admin = require('firebase-admin');

const MIGRATE_PATHS = [
  'activities',
  'suggestions',
  'suggestionHashes',
  'providers',
  'discoverySources',
  'discoverySourceUrls',
];

function jsonRes(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getOrInitApp(name, credential, databaseURL) {
  try { return admin.app(name); }
  catch { return admin.initializeApp({ credential, databaseURL }, name); }
}

export default async (req) => {
  if (req.method !== 'POST') return jsonRes(405, { error: 'Method Not Allowed' });

  // ── Guard: only active when MIGRATION_TOKEN is configured ─────────────────
  const expectedToken = process.env.MIGRATION_TOKEN;
  if (!expectedToken) {
    return jsonRes(503, { error: 'Migration not configured or already deactivated.' });
  }

  // ── Token check ───────────────────────────────────────────────────────────
  const suppliedToken = req.headers.get('x-migration-token');
  if (!suppliedToken || suppliedToken !== expectedToken) {
    return jsonRes(403, { error: 'Invalid or missing X-Migration-Token.' });
  }

  // ── Source credentials check ──────────────────────────────────────────────
  const sourceSaRaw   = process.env.SOURCE_FIREBASE_SA;
  const sourceRtdbUrl = process.env.SOURCE_RTDB_URL;
  if (!sourceSaRaw || !sourceRtdbUrl) {
    return jsonRes(503, { error: 'SOURCE_FIREBASE_SA or SOURCE_RTDB_URL not configured.' });
  }

  // ── Target DB (someday-3edba) ─────────────────────────────────────────────
  let tgtSa;
  try { tgtSa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON); }
  catch { return jsonRes(500, { error: 'FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.' }); }

  const tgtApp = getOrInitApp(
    'migration-target',
    admin.credential.cert(tgtSa),
    process.env.FIREBASE_RTDB_URL,
  );
  const tgtDb = tgtApp.database();

  // ── Idempotency: refuse if already run ────────────────────────────────────
  const flagSnap = await tgtDb.ref('migrationState/discoveryMigration').once('value');
  if (flagSnap.exists()) {
    return jsonRes(409, {
      error: 'Migration already completed.',
      completedAt: flagSnap.val().completedAt,
    });
  }

  // ── Source DB (vivo-mvp) ──────────────────────────────────────────────────
  let sourceSa;
  try { sourceSa = JSON.parse(sourceSaRaw); }
  catch { return jsonRes(500, { error: 'SOURCE_FIREBASE_SA is not valid JSON.' }); }

  const srcApp = getOrInitApp(
    'migration-source',
    admin.credential.cert(sourceSa),
    sourceRtdbUrl,
  );
  const srcDb = srcApp.database();

  // ── Migrate path by path ──────────────────────────────────────────────────
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

  return jsonRes(200, {
    ok: true,
    report,
    warnings,
    message: 'Migration complete. Remove MIGRATION_TOKEN, SOURCE_FIREBASE_SA and SOURCE_RTDB_URL from Netlify now.',
  });
};
