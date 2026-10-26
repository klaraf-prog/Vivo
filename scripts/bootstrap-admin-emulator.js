#!/usr/bin/env node
/**
 * Erstellt einen lokalen Superadmin-Testaccount im Firebase-Emulator
 * und schreibt eine .env-Datei für netlify dev.
 *
 * Voraussetzung: Firebase-Emulatoren müssen laufen:
 *   firebase emulators:start --only auth,database --project demo-vivo-test
 *
 * Aufruf:
 *   node scripts/bootstrap-admin-emulator.js
 */

'use strict';

const admin  = require('firebase-admin');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const PROJECT_ID = 'demo-vivo-test';
const AUTH_HOST  = process.env.FIREBASE_AUTH_EMULATOR_HOST  || '127.0.0.1:9099';
const RTDB_HOST  = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';

const TEST_EMAIL          = 'studio-admin@test.local';
const TEST_PASSWORD       = 'StudioTest123!';
const TEST_RESEARCHER_KEY = 'test-researcher-key-local';

process.env.FIREBASE_AUTH_EMULATOR_HOST     = AUTH_HOST;
process.env.FIREBASE_DATABASE_EMULATOR_HOST = RTDB_HOST;

// Fake-Service-Account — der Emulator ignoriert die Zugangsdaten
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const fakeServiceAccount = {
  type:                        'service_account',
  project_id:                  PROJECT_ID,
  private_key_id:              'local-test-key',
  private_key:                 privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email:                `local-test@${PROJECT_ID}.iam.gserviceaccount.com`,
  client_id:                   '000000000000',
  auth_uri:                    'https://accounts.google.com/o/oauth2/auth',
  token_uri:                   'https://oauth2.googleapis.com/token',
};

async function main() {
  console.log('Verbinde mit Firebase-Emulatoren …');

  const app = admin.initializeApp({
    credential:  admin.credential.cert(fakeServiceAccount),
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
      console.log(`  Testbenutzer existiert bereits (uid: ${user.uid})`);
    } catch {
      user = await auth.createUser({
        email:       TEST_EMAIL,
        password:    TEST_PASSWORD,
        displayName: 'Studio Test Admin',
      });
      console.log(`  Testbenutzer erstellt (uid: ${user.uid})`);
    }

    await auth.setCustomUserClaims(user.uid, { studioRole: 'superadmin' });
    console.log('  Rolle superadmin gesetzt');

    const now = Date.now();
    await db.ref().update({
      [`studioAdminUsers/${user.uid}`]: {
        email:     TEST_EMAIL,
        role:      'superadmin',
        updatedAt: now,
        updatedBy: 'bootstrap-emulator',
      },
    });
    console.log('  studioAdminUsers aktualisiert');

    // .env für netlify dev schreiben
    const saJson    = JSON.stringify(fakeServiceAccount);
    const envPath   = path.join(__dirname, '..', '.env');
    const envLines  = [
      '# Lokale Studio-Testumgebung — NUR für Emulator, nie committen!',
      `FIREBASE_AUTH_EMULATOR_HOST=${AUTH_HOST}`,
      `FIREBASE_DATABASE_EMULATOR_HOST=${RTDB_HOST}`,
      `FIREBASE_RTDB_URL=http://127.0.0.1:9000/?ns=${PROJECT_ID}`,
      `FIREBASE_SERVICE_ACCOUNT_JSON=${saJson}`,
      `STUDIO_RESEARCHER_KEY=${TEST_RESEARCHER_KEY}`,
    ];
    fs.writeFileSync(envPath, envLines.join('\n') + '\n', 'utf8');
    console.log(`  .env geschrieben`);

    console.log('');
    console.log('═'.repeat(55));
    console.log('✓  Emulator-Testumgebung bereit');
    console.log('═'.repeat(55));
    console.log(`  E-Mail:    ${TEST_EMAIL}`);
    console.log(`  Passwort:  ${TEST_PASSWORD}`);
    console.log(`  Rolle:     superadmin`);
    console.log('');
    console.log('Nächster Schritt — im selben Terminal:');
    console.log('  netlify dev');
    console.log('');
    console.log('Dann im Browser öffnen:');
    console.log('  http://127.0.0.1:8888/studio.html');
    console.log('═'.repeat(55));
  } finally {
    await app.delete();
  }
}

main().catch(err => {
  if (err.code === 'ECONNREFUSED' || (err.message && err.message.includes('ECONNREFUSED'))) {
    console.error('');
    console.error('Fehler: Firebase-Emulatoren sind nicht erreichbar.');
    console.error('Bitte zuerst in einem anderen Terminal starten:');
    console.error('  firebase emulators:start --only auth,database --project demo-vivo-test');
  } else {
    console.error('Fehler:', err.message);
  }
  process.exit(1);
});
