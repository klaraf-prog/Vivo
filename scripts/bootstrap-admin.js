#!/usr/bin/env node
// One-time local script to create the first superadmin.
// Never deploy this script; never commit service account credentials.
//
// Usage:
//   FIREBASE_SERVICE_ACCOUNT_JSON=$(cat ./service-account.json) \
//   FIREBASE_RTDB_URL=https://vivo-mvp-default-rtdb.europe-west1.firebasedatabase.app \
//   node scripts/bootstrap-admin.js <firebase-uid> [email]
//
// The service-account.json file must be listed in .gitignore and never committed.

const admin = require('firebase-admin');

async function main() {
  const uid   = process.argv[2];
  const email = process.argv[3] || '';

  if (!uid) {
    console.error('Usage: node scripts/bootstrap-admin.js <uid> [email]');
    process.exit(1);
  }

  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const rtdbUrl = process.env.FIREBASE_RTDB_URL;

  if (!saJson || !rtdbUrl) {
    console.error('Missing env vars: FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_RTDB_URL');
    process.exit(1);
  }

  let sa;
  try { sa = JSON.parse(saJson); }
  catch { console.error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON'); process.exit(1); }

  const app = admin.initializeApp({
    credential: admin.credential.cert(sa),
    databaseURL: rtdbUrl,
  });

  try {
    const userRecord = await app.auth().getUser(uid);
    const existing = userRecord.customClaims;

    if (existing?.studioRole === 'superadmin') {
      console.log('Already superadmin — nothing to do.');
      await app.delete();
      process.exit(0);
    }

    await app.auth().setCustomUserClaims(uid, { studioRole: 'superadmin' });

    const now = Date.now();
    await app.database().ref().update({
      [`studioAdminUsers/${uid}`]: {
        email: email || userRecord.email || null,
        role: 'superadmin',
        updatedAt: now,
        updatedBy: 'bootstrap-script',
      },
      [`studioAuditLog/log_bootstrap_${now}`]: {
        action: 'bootstrap_superadmin',
        actorUid: 'bootstrap-script',
        actorEmail: null,
        actorRole: null,
        targetUid: uid,
        details: 'First superadmin set via bootstrap script',
        timestamp: now,
      },
    });

    console.log(`✓ ${uid} (${userRecord.email || email || 'no email'}) is now superadmin.`);
    console.log('  Sign out and back in to studio.html for the new claim to take effect.');
  } catch (err) {
    console.error('Error:', err.message);
    await app.delete();
    process.exit(1);
  }

  await app.delete();
  process.exit(0);
}

main();
