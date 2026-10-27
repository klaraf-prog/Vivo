#!/usr/bin/env node
/**
 * Erstellt die Test-Suggestion "Sunday Brunch Club" im lokalen Firebase-Emulator
 * über den echten studio-submit API-Endpunkt.
 *
 * Voraussetzung: npm run studio:local muss laufen (Port 8888 + Emulatoren).
 *
 * Aufruf (in einem zweiten Terminal):
 *   node scripts/seed-brunch-club.js
 *
 * Sicherheit: Schreibt ausschließlich in den lokalen Emulator.
 * Kein Zugriff auf produktive Firebase-Daten.
 */

'use strict';

const admin  = require('firebase-admin');
const crypto = require('crypto');

const PROJECT_ID     = 'demo-vivo-test';
const RTDB_HOST      = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const NETLIFY_PORT   = process.env.NETLIFY_PORT || '8888';
const SUBMIT_URL     = `http://127.0.0.1:${NETLIFY_PORT}/.netlify/functions/studio-submit`;
const RESEARCHER_KEY = process.env.STUDIO_RESEARCHER_KEY || 'test-researcher-key-local';

// Keine Koordinaten oder Buchungs-URL — nur belegte Pflicht- und Optionalfelder
const SUGGESTION = {
  title:        'Sunday Brunch Club',
  tagline:      'Good food, better company.',
  description:  'Ein gemeinsamer Brunch zum Kennenlernen.',
  category:     'Food',
  eyebrow:      'GET TOGETHER',
  city:         'Köln',
  district:     'Ehrenfeld',
  providerName: 'Someday Test Kitchen',
  price:        '€25',
};

function sep()  { console.log('─'.repeat(55)); }
function ok(m)  { console.log(`  ✓  ${m}`); }
function err(m) { console.error(`  ✗  ${m}`); }

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
  sep();
  console.log('\x1b[1mSomeday Studio — Seed: Sunday Brunch Club\x1b[0m');
  sep();

  // ── 1. studio-submit via HTTP ─────────────────────────────────
  console.log('\n▸ Rufe studio-submit API auf …');
  console.log(`  URL: ${SUBMIT_URL}`);

  let suggestionId;
  try {
    const res = await fetch(SUBMIT_URL, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-studio-key': RESEARCHER_KEY,
      },
      body: JSON.stringify(SUGGESTION),
    });

    const data = await res.json();

    if (res.status === 409 && data.error === 'duplicate') {
      console.log(`\n  ⚠  Suggestion existiert bereits (ID: ${data.existingId}).`);
      console.log('     Sie wurde beim letzten Aufruf angelegt — im Studio sichtbar.\n');
      suggestionId = data.existingId;
    } else if (!res.ok) {
      err(`HTTP ${res.status}: ${JSON.stringify(data)}`);
      process.exit(1);
    } else {
      suggestionId = data.suggestionId;
      ok(`Suggestion erstellt: ${suggestionId}`);
    }
  } catch (e) {
    if (e.cause?.code === 'ECONNREFUSED' || e.message?.includes('ECONNREFUSED')) {
      err('Port 8888 nicht erreichbar.');
      console.error('     Bitte zuerst in einem anderen Terminal starten:');
      console.error('       npm run studio:local');
      process.exit(1);
    }
    err('Netzwerkfehler: ' + e.message);
    process.exit(1);
  }

  // ── 2. Emulator-Verifikation via Admin SDK ────────────────────
  console.log('\n▸ Verifiziere Daten im RTDB-Emulator …');

  process.env.FIREBASE_DATABASE_EMULATOR_HOST = RTDB_HOST;

  const app = admin.initializeApp({
    credential:  admin.credential.cert(getServiceAccount()),
    databaseURL: `http://127.0.0.1:9000/?ns=${PROJECT_ID}`,
    projectId:   PROJECT_ID,
  }, 'seed-brunch-verify-' + Date.now());

  try {
    const db   = app.database();
    const snap = await db.ref(`suggestions/${suggestionId}`).once('value');

    if (!snap.exists()) {
      err(`suggestions/${suggestionId} nicht gefunden im Emulator.`);
      process.exit(1);
    }

    const sug = snap.val();
    ok(`suggestions/${suggestionId} vorhanden`);
    ok(`  title:    ${sug.title}`);
    ok(`  tagline:  ${sug.tagline}`);
    ok(`  eyebrow:  ${sug.eyebrow}`);
    ok(`  category: ${sug.category}`);
    ok(`  city:     ${sug.city}, ${sug.district}`);
    ok(`  price:    ${sug.price}`);
    ok(`  status:   ${sug.status}`);

    // Verify no coordinates or booking URL were set
    if (sug.lat != null || sug.lng != null) {
      console.warn('  ⚠  Koordinaten wurden unerwartet gesetzt.');
    } else {
      ok('  lat/lng:  nicht gesetzt (korrekt)');
    }
    if (sug.bookingUrl) {
      console.warn('  ⚠  bookingUrl wurde unerwartet gesetzt.');
    } else {
      ok('  bookingUrl: nicht gesetzt (korrekt)');
    }

    if (sug.status !== 'submitted') {
      console.warn(`  ⚠  Status ist '${sug.status}', nicht 'submitted'.`);
    }
  } finally {
    await app.delete();
  }

  // ── 3. Ergebnis ───────────────────────────────────────────────
  console.log('');
  sep();
  console.log('  ✓  Suggestion bereit zur manuellen Freigabe');
  sep();
  console.log(`  ID:         ${suggestionId}`);
  console.log(`  Aktivität:  ${SUGGESTION.title}`);
  console.log(`  Status:     submitted`);
  console.log('');
  console.log('  Nächste Schritte:');
  console.log('  1. Studio öffnen → http://127.0.0.1:8888/studio.html');
  console.log('  2. Einloggen → Tab "Vorschläge"');
  console.log(`  3. "${SUGGESTION.title}" auswählen`);
  console.log('  4. Detailansicht prüfen → "✓ Freigeben" klicken');
  console.log('  5. PWA → http://127.0.0.1:8888');
  console.log('     Discover: beide Aktivitäten erscheinen');
  sep();
  console.log('');
}

main().catch(e => {
  err(e.message);
  process.exit(1);
});
