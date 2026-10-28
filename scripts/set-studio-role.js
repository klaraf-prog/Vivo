#!/usr/bin/env node
/**
 * Einmalig ausführbares Hilfsskript:
 * Setzt studioRole auf einem bestehenden Firebase-Account im Projekt vivo-mvp.
 *
 * Voraussetzungen:
 *   export FIREBASE_SERVICE_ACCOUNT_JSON='{ ... }'   (Inhalt der Service-Account-JSON-Datei)
 *   node scripts/set-studio-role.js <email-oder-uid> [rolle]
 *
 * Beispiele:
 *   node scripts/set-studio-role.js klara@example.com
 *   node scripts/set-studio-role.js klara@example.com superadmin
 *   node scripts/set-studio-role.js uid_abc123xyz   editor
 *
 * Standardrolle: superadmin
 * Erlaubte Rollen: researcher | editor | superadmin
 *
 * Das Skript:
 *   1. Sucht den Account (per E-Mail oder UID)
 *   2. Zeigt vorhandene Custom Claims an
 *   3. Fragt vor der Änderung nach Bestätigung
 *   4. Erhält alle bestehenden Claims und fügt nur studioRole hinzu/überschreibt sie
 *   5. Schreibt zur Nachvollziehbarkeit einen Eintrag in studioAdminUsers/$uid
 */

'use strict';

const admin    = require('firebase-admin');
const readline = require('readline');

// ── Argumente einlesen ────────────────────────────────────────────────────────
const [,, identifier, roleArg] = process.argv;

const ALLOWED_ROLES = ['researcher', 'editor', 'superadmin'];
const role          = roleArg || 'superadmin';

if (!identifier) {
  console.error('Fehler: Kein Account angegeben.');
  console.error('Aufruf: node scripts/set-studio-role.js <email-oder-uid> [rolle]');
  process.exit(1);
}
if (!ALLOWED_ROLES.includes(role)) {
  console.error(`Fehler: Unbekannte Rolle "${role}". Erlaubt: ${ALLOWED_ROLES.join(', ')}`);
  process.exit(1);
}

// ── Firebase Admin initialisieren ─────────────────────────────────────────────
const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!saJson) {
  console.error('');
  console.error('Fehler: Umgebungsvariable FIREBASE_SERVICE_ACCOUNT_JSON nicht gesetzt.');
  console.error('');
  console.error('Anleitung:');
  console.error('  1. Firebase Console → Projekteinstellungen → Dienstkonten');
  console.error('     → "Neuen privaten Schlüssel generieren" → JSON-Datei herunterladen');
  console.error('  2. export FIREBASE_SERVICE_ACCOUNT_JSON=$(cat /pfad/zur/datei.json)');
  console.error('  3. Dieses Skript erneut ausführen.');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(saJson);
} catch {
  console.error('Fehler: FIREBASE_SERVICE_ACCOUNT_JSON ist kein gültiges JSON.');
  process.exit(1);
}

const app = admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const auth = app.auth();
const db   = app.database();

// ── Hilfsfunktion: Account per E-Mail oder UID laden ─────────────────────────
async function lookupUser(id) {
  if (id.includes('@')) {
    return auth.getUserByEmail(id);
  }
  return auth.getUser(id);
}

// ── Bestätigung abfragen ──────────────────────────────────────────────────────
function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ── Hauptprogramm ─────────────────────────────────────────────────────────────
async function main() {
  // 1. Account suchen
  let user;
  try {
    user = await lookupUser(identifier);
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      console.error(`\nFehler: Kein Account gefunden für "${identifier}" im Projekt "${serviceAccount.project_id}".`);
      console.error('Bitte E-Mail-Adresse oder UID prüfen.');
    } else {
      console.error('\nFehler beim Abrufen des Accounts:', e.message);
    }
    await app.delete();
    process.exit(1);
  }

  // 2. Vorhandene Claims anzeigen
  const existingClaims = user.customClaims || {};
  const newClaims      = { ...existingClaims, studioRole: role };

  console.log('');
  console.log('═'.repeat(50));
  console.log('  Account gefunden');
  console.log('─'.repeat(50));
  console.log(`  UID:          ${user.uid}`);
  console.log(`  E-Mail:       ${user.email || '(keine)'}`);
  console.log(`  Name:         ${user.displayName || '(kein)'}`);
  console.log(`  Projekt:      ${serviceAccount.project_id}`);
  console.log('─'.repeat(50));
  console.log('  Vorhandene Custom Claims:');
  console.log(' ', JSON.stringify(existingClaims, null, 2).replace(/\n/g, '\n  '));
  console.log('─'.repeat(50));
  console.log('  Neue Custom Claims (nach Änderung):');
  console.log(' ', JSON.stringify(newClaims, null, 2).replace(/\n/g, '\n  '));
  console.log('═'.repeat(50));
  console.log('');

  // 3. Bestätigung einholen
  const answer = await confirm(`  studioRole "${role}" setzen? [ja/nein]: `);
  if (answer !== 'ja') {
    console.log('\n  Abgebrochen. Keine Änderungen vorgenommen.\n');
    await app.delete();
    process.exit(0);
  }

  // 4. Custom Claims setzen (alle bestehenden Claims bleiben erhalten)
  await auth.setCustomUserClaims(user.uid, newClaims);
  console.log('\n  ✓  Custom Claims gesetzt.');

  // 5. Eintrag in Datenbank für Audit-Trail
  await db.ref(`studioAdminUsers/${user.uid}`).set({
    email:     user.email || null,
    role,
    updatedAt: Date.now(),
    updatedBy: 'set-studio-role-script',
  });
  console.log('  ✓  studioAdminUsers/$uid aktualisiert.');

  console.log('');
  console.log('═'.repeat(50));
  console.log(`  Fertig. "${user.email || user.uid}" ist jetzt ${role}.`);
  console.log('─'.repeat(50));
  console.log('  Nächster Schritt: ID-Token aktualisieren');
  console.log('  (siehe Schritt-für-Schritt-Anleitung)');
  console.log('═'.repeat(50));
  console.log('');

  await app.delete();
}

main().catch(async (err) => {
  console.error('\nUnerwarteter Fehler:', err.message);
  await app.delete().catch(() => {});
  process.exit(1);
});
