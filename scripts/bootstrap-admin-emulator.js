#!/usr/bin/env node
/**
 * Erstellt einen lokalen Superadmin-Testaccount im Firebase-Emulator.
 *
 * Kann direkt aufgerufen werden (wenn Emulatoren bereits laufen)
 * oder wird automatisch von start-studio-local.js gestartet.
 *
 * Voraussetzung für direkten Aufruf:
 *   firebase emulators:start --only auth,database --project demo-vivo-test
 *
 * Aufruf:
 *   node scripts/bootstrap-admin-emulator.js
 *
 * Sicherheit: Verwendet ausschließlich Dummy-Zugangsdaten, die vom
 * Emulator ignoriert werden. Keine produktiven Schlüssel erforderlich.
 */

'use strict';

const admin  = require('firebase-admin');
const crypto = require('crypto');

const PROJECT_ID = 'demo-vivo-test';
const AUTH_HOST  = process.env.FIREBASE_AUTH_EMULATOR_HOST  || '127.0.0.1:9099';
const RTDB_HOST  = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';

const TEST_EMAIL    = 'studio-admin@test.local';
const TEST_PASSWORD = 'StudioTest123!';

// Emulator-Hosts in process.env setzen (erforderlich für Admin SDK)
process.env.FIREBASE_AUTH_EMULATOR_HOST     = AUTH_HOST;
process.env.FIREBASE_DATABASE_EMULATOR_HOST = RTDB_HOST;

// Service Account aus Umgebung übernehmen oder Dummy generieren
// (Emulator ignoriert Zugangsdaten vollständig)
function getServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    type:           'service_account',
    project_id:     PROJECT_ID,
    private_key_id: 'local-emulator-only',
    private_key:    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email:   `local-test@${PROJECT_ID}.iam.gserviceaccount.com`,
    client_id:      '000000000000',
    auth_uri:       'https://accounts.google.com/o/oauth2/auth',
    token_uri:      'https://oauth2.googleapis.com/token',
  };
}

async function main() {
  const app = admin.initializeApp({
    credential:  admin.credential.cert(getServiceAccount()),
    databaseURL: `http://127.0.0.1:9000/?ns=${PROJECT_ID}`,
    projectId:   PROJECT_ID,
  }, 'bootstrap-emulator-' + Date.now());

  const auth = app.auth();
  const db   = app.database();

  try {
    // Testbenutzer anlegen oder wiederverwenden
    let user;
    try {
      user = await auth.getUserByEmail(TEST_EMAIL);
      console.log(`  Testbenutzer vorhanden (uid: ${user.uid})`);
    } catch {
      user = await auth.createUser({
        email:       TEST_EMAIL,
        password:    TEST_PASSWORD,
        displayName: 'Studio Test Admin',
      });
      console.log(`  Testbenutzer erstellt (uid: ${user.uid})`);
    }

    await auth.setCustomUserClaims(user.uid, { studioRole: 'superadmin' });

    await db.ref().update({
      [`studioAdminUsers/${user.uid}`]: {
        email:     TEST_EMAIL,
        role:      'superadmin',
        updatedAt: Date.now(),
        updatedBy: 'bootstrap-emulator',
      },
    });

    console.log('');
    console.log('  ═'.repeat(27));
    console.log('  ✓  Testaccount bereit');
    console.log('  ─'.repeat(27));
    console.log(`  E-Mail:    ${TEST_EMAIL}`);
    console.log(`  Passwort:  ${TEST_PASSWORD}`);
    console.log(`  Rolle:     superadmin`);
    console.log('  ═'.repeat(27));
    console.log('');
    console.log('  Studio öffnen → http://127.0.0.1:8888/studio.html');
    console.log('');
  } finally {
    await app.delete();
  }
}

main().catch(err => {
  if (err.code === 'ECONNREFUSED' || (err.message && err.message.includes('ECONNREFUSED'))) {
    console.error('');
    console.error('  Fehler: Firebase-Emulatoren nicht erreichbar.');
    console.error('  Zuerst starten:');
    console.error('    firebase emulators:start --only auth,database --project demo-vivo-test');
  } else {
    console.error('  Fehler:', err.message);
  }
  process.exit(1);
});
