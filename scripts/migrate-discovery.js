'use strict';
/**
 * Discovery data migration: vivo-mvp → someday-3edba
 *
 * Usage:
 *   SOURCE_SA=./vivo-mvp-sa.json       SOURCE_RTDB=https://vivo-mvp-default-rtdb.firebaseio.com \
 *   TARGET_SA=./someday-3edba-sa.json  TARGET_RTDB=https://someday-3edba-default-rtdb.europe-west1.firebasedatabase.app \
 *   node scripts/migrate-discovery.js
 *
 * Backups are written to ./backups/ before any write.
 * Existing records in the target are never overwritten — conflicts are logged and skipped.
 * No user accounts, auth data, or audit logs are migrated.
 */

const admin = require('firebase-admin');
const fs    = require('fs');
const path  = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const SOURCE_SA   = process.env.SOURCE_SA;
const SOURCE_RTDB = process.env.SOURCE_RTDB;
const TARGET_SA   = process.env.TARGET_SA;
const TARGET_RTDB = process.env.TARGET_RTDB;

if (!SOURCE_SA || !SOURCE_RTDB || !TARGET_SA || !TARGET_RTDB) {
  console.error('Missing env vars. Required: SOURCE_SA, SOURCE_RTDB, TARGET_SA, TARGET_RTDB');
  process.exit(1);
}

// Paths to migrate (no user data, no audit logs)
const MIGRATE_PATHS = [
  'activities',
  'suggestions',
  'suggestionHashes',
  'providers',
  'discoverySources',
  'discoverySourceUrls',
  'studioAdminUsers',
];

// ── Firebase init ─────────────────────────────────────────────────────────────

const sourceApp = admin.initializeApp({
  credential:  admin.credential.cert(JSON.parse(fs.readFileSync(SOURCE_SA, 'utf8'))),
  databaseURL: SOURCE_RTDB,
}, 'source');

const targetApp = admin.initializeApp({
  credential:  admin.credential.cert(JSON.parse(fs.readFileSync(TARGET_SA, 'utf8'))),
  databaseURL: TARGET_RTDB,
}, 'target');

const srcDb = sourceApp.database();
const tgtDb = targetApp.database();

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureBackupDir() {
  const dir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const ts      = timestamp();
  const backDir = ensureBackupDir();
  const report  = { migrated: {}, skipped: {}, errors: [] };

  console.log('=== Someday Discovery Migration ===');
  console.log(`Source: ${SOURCE_RTDB}`);
  console.log(`Target: ${TARGET_RTDB}`);
  console.log('');

  // ── 1. Backup both databases ───────────────────────────────────────────────

  console.log('--- Step 1: Backup source and target ---');
  const sourceBackup = {};
  const targetBackup = {};

  for (const p of MIGRATE_PATHS) {
    const [srcSnap, tgtSnap] = await Promise.all([
      srcDb.ref(p).once('value'),
      tgtDb.ref(p).once('value'),
    ]);
    sourceBackup[p] = srcSnap.val();
    targetBackup[p] = tgtSnap.val();
    const srcCount = srcSnap.val() ? Object.keys(srcSnap.val()).length : 0;
    const tgtCount = tgtSnap.val() ? Object.keys(tgtSnap.val()).length : 0;
    console.log(`  ${p}: source=${srcCount}, target=${tgtCount}`);
  }

  const srcFile = path.join(backDir, `source-vivo-mvp-${ts}.json`);
  const tgtFile = path.join(backDir, `target-someday-3edba-${ts}.json`);
  fs.writeFileSync(srcFile, JSON.stringify(sourceBackup, null, 2));
  fs.writeFileSync(tgtFile, JSON.stringify(targetBackup, null, 2));
  console.log(`\nBackup saved:\n  ${srcFile}\n  ${tgtFile}\n`);

  // ── 2. Migrate path by path ────────────────────────────────────────────────

  console.log('--- Step 2: Migrate ---');

  for (const p of MIGRATE_PATHS) {
    const src = sourceBackup[p];
    const tgt = targetBackup[p] || {};

    if (!src || Object.keys(src).length === 0) {
      console.log(`  ${p}: empty in source, skipping`);
      report.migrated[p] = 0;
      report.skipped[p]  = 0;
      continue;
    }

    const toWrite   = {};
    let migratedN = 0;
    let skippedN  = 0;

    for (const [id, val] of Object.entries(src)) {
      if (tgt[id] !== undefined) {
        // Record already exists in target — skip to avoid overwriting
        skippedN++;
      } else {
        toWrite[`${p}/${id}`] = val;
        migratedN++;
      }
    }

    if (Object.keys(toWrite).length > 0) {
      await tgtDb.ref().update(toWrite);
    }

    report.migrated[p] = migratedN;
    report.skipped[p]  = skippedN;

    console.log(`  ${p}: migrated=${migratedN}, skipped (already existed)=${skippedN}`);
  }

  // ── 3. Verify ─────────────────────────────────────────────────────────────

  console.log('\n--- Step 3: Verify ---');
  for (const p of MIGRATE_PATHS) {
    const snap = await tgtDb.ref(p).once('value');
    const n    = snap.val() ? Object.keys(snap.val()).length : 0;
    const expected = (report.migrated[p] || 0) + Object.keys(targetBackup[p] || {}).length;
    const ok = n >= expected ? '✓' : '✗';
    console.log(`  ${ok} ${p}: ${n} records in target (expected ≥ ${expected})`);
  }

  // ── 4. Summary ────────────────────────────────────────────────────────────

  console.log('\n=== Summary ===');
  let totalMigrated = 0;
  let totalSkipped  = 0;
  for (const p of MIGRATE_PATHS) {
    totalMigrated += report.migrated[p] || 0;
    totalSkipped  += report.skipped[p]  || 0;
  }
  console.log(`Total migrated : ${totalMigrated}`);
  console.log(`Total skipped  : ${totalSkipped} (already existed in target)`);
  if (report.errors.length > 0) {
    console.log(`Errors         : ${report.errors.length}`);
    report.errors.forEach(e => console.log('  -', e));
  } else {
    console.log('Errors         : 0');
  }

  await Promise.all([
    srcDb.goOffline(),
    tgtDb.goOffline(),
  ]);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
