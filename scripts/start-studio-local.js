#!/usr/bin/env node
/**
 * Someday Studio — Lokaler Teststart (plattformübergreifend)
 *
 * Was dieses Skript tut:
 *   1. Voraussetzungen prüfen (Node.js, Firebase CLI, Netlify CLI, npm install)
 *   2. Firebase Auth- + RTDB-Emulator starten
 *   3. Superadmin-Testaccount einrichten
 *   4. Netlify Dev starten (zeigt URL + Zugangsdaten)
 *
 * Verwendung:
 *   npm run studio:local
 *
 * Beenden: Ctrl+C
 *
 * Sicherheitshinweise:
 *   - Verbindet sich ausschließlich mit lokalen Emulatoren.
 *   - Verwendet automatisch generierte Dummy-Zugangsdaten, die nur im
 *     laufenden Prozess existieren. Keine Dateien mit Secrets werden
 *     geschrieben oder ins Repository übernommen.
 *   - Keine Verbindung zur produktiven Firebase-Datenbank.
 */

'use strict';

const { spawnSync, spawn } = require('child_process');
const http   = require('http');
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

const ROOT   = path.join(__dirname, '..');
const isWin  = process.platform === 'win32';

// Auf Windows CLI-Tools als .cmd ausführen
const cli = name => (isWin ? `${name}.cmd` : name);

// ─────────────────────────────────────────────────────────────────
// Hilfsfunktionen
// ─────────────────────────────────────────────────────────────────

function header(msg)  { console.log(`\n▸ ${msg}`); }
function ok(msg)      { console.log(`  ✓  ${msg}`); }
function err(msg)     { console.error(`  ✗  ${msg}`); }
function separator()  { console.log('─'.repeat(55)); }
function bold(msg)    { return `\x1b[1m${msg}\x1b[0m`; }

function abort(msg) {
  console.error(`\n${bold('Abbruch:')} ${msg}\n`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────
// 1. Voraussetzungen prüfen
// ─────────────────────────────────────────────────────────────────

function checkPrereqs() {
  separator();
  console.log(bold('Someday Studio — Lokaler Teststart'));
  separator();

  const tools = [
    {
      bin: 'node', args: ['--version'], label: 'Node.js',
      minMajor: 18,
      hint: 'Mindestens Node.js 18 benötigt → https://nodejs.org',
    },
    {
      bin: 'firebase', args: ['--version'], label: 'Firebase CLI',
      hint: 'Installieren: npm install -g firebase-tools',
    },
    {
      bin: 'netlify', args: ['--version'], label: 'Netlify CLI',
      hint: 'Installieren: npm install -g netlify-cli',
    },
  ];

  let allOk = true;

  for (const { bin, args, label, minMajor, hint } of tools) {
    const r = spawnSync(cli(bin), args, { encoding: 'utf8', shell: isWin });
    if (r.error || r.status !== 0) {
      err(`${label} — nicht gefunden`);
      console.error(`       ${hint}`);
      allOk = false;
      continue;
    }
    const versionLine = (r.stdout || r.stderr || '').trim().split('\n')[0];
    if (minMajor) {
      const major = parseInt((versionLine.replace(/^v/, '') + '.0').split('.')[0], 10);
      if (isNaN(major) || major < minMajor) {
        err(`${label} ${versionLine} — Mindestversion: ${minMajor}.x`);
        console.error(`       ${hint}`);
        allOk = false;
        continue;
      }
    }
    ok(`${label}: ${versionLine}`);
  }

  const nmPath = path.join(ROOT, 'node_modules', 'firebase-admin');
  if (!fs.existsSync(nmPath)) {
    err('node_modules fehlen');
    console.error('       Abhängigkeiten installieren: npm install');
    allOk = false;
  } else {
    ok('node_modules vorhanden');
  }

  if (!allOk) {
    abort('Bitte fehlende Voraussetzungen installieren und erneut starten.');
  }
  ok('Alle Voraussetzungen erfüllt');
}

// ─────────────────────────────────────────────────────────────────
// 2. Fake-Service-Account generieren (nur im Speicher, nie auf Disk)
// ─────────────────────────────────────────────────────────────────

function generateEphemeralEnv() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const fakeServiceAccount = {
    type:           'service_account',
    project_id:     'demo-vivo-test',
    private_key_id: 'local-emulator-only',
    private_key:    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email:   'local-test@demo-vivo-test.iam.gserviceaccount.com',
    client_id:      '000000000000',
    auth_uri:       'https://accounts.google.com/o/oauth2/auth',
    token_uri:      'https://oauth2.googleapis.com/token',
  };

  // In process.env setzen, damit alle Kindprozesse die Werte erben.
  // Kein Schreiben in Dateien.
  process.env.FIREBASE_AUTH_EMULATOR_HOST     = '127.0.0.1:9099';
  process.env.FIREBASE_DATABASE_EMULATOR_HOST = '127.0.0.1:9000';
  process.env.FIREBASE_RTDB_URL               = 'http://127.0.0.1:9000/?ns=demo-vivo-test';
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON   = JSON.stringify(fakeServiceAccount);
  process.env.STUDIO_RESEARCHER_KEY           = 'test-researcher-key-local';
}

// ─────────────────────────────────────────────────────────────────
// 3. Auf Emulator-Port warten
// ─────────────────────────────────────────────────────────────────

function waitForPort(port, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function probe() {
      const req = http.get(
        { hostname: '127.0.0.1', port, path: '/', timeout: 800 },
        () => { req.destroy(); resolve(); }
      );
      req.on('error', () => {
        if (Date.now() >= deadline) {
          reject(new Error(
            `Emulator (Port ${port}) nicht erreichbar nach ${timeoutMs / 1000} Sekunden.\n` +
            'Mögliche Ursache: firebase-tools nicht installiert oder Port belegt.'
          ));
          return;
        }
        setTimeout(probe, 1_000);
      });
      req.on('timeout', () => req.destroy());
    }
    probe();
  });
}

// ─────────────────────────────────────────────────────────────────
// 4. Prozessverwaltung + Aufräumen
// ─────────────────────────────────────────────────────────────────

const children = [];

function cleanup() {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch {}
  }
}

process.on('SIGINT',  () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

// ─────────────────────────────────────────────────────────────────
// 5. Hauptablauf
// ─────────────────────────────────────────────────────────────────

async function main() {
  checkPrereqs();

  header('Generiere lokale Emulator-Zugangsdaten …');
  generateEphemeralEnv();
  ok('Zugangsdaten erzeugt (nur im Arbeitsspeicher, kein Commit)');

  // ── Emulatoren starten ─────────────────────────────────────────
  header('Starte Firebase-Emulatoren …');

  const emulator = spawn(
    cli('firebase'),
    ['emulators:start', '--only', 'auth,database', '--project', 'demo-vivo-test'],
    { cwd: ROOT, stdio: 'pipe', shell: isWin }
  );
  children.push(emulator);

  emulator.on('error', e => {
    if (e.code === 'ENOENT') {
      abort(
        'Firebase CLI nicht gefunden.\n' +
        '  Installieren: npm install -g firebase-tools'
      );
    }
    abort('Emulator-Fehler: ' + e.message);
  });

  // Emulator-Ausgabe: nur relevante Zeilen zeigen
  const emuFilter = /All emulators ready|auth.*:.*\d+|database.*:.*\d+|Error|error/i;
  emulator.stdout.on('data', data => {
    for (const line of data.toString().split('\n')) {
      if (emuFilter.test(line)) process.stdout.write('  [emulator] ' + line.trim() + '\n');
    }
  });
  emulator.stderr.on('data', data => process.stderr.write(data));

  // ── Auf Auth-Emulator warten (Port 9099) ──────────────────────
  process.stdout.write('  Warte auf Auth-Emulator (Port 9099)');
  const dots = setInterval(() => process.stdout.write('.'), 1_000);
  try {
    await waitForPort(9099);
    clearInterval(dots);
    console.log(' ✓');
  } catch (e) {
    clearInterval(dots);
    cleanup();
    abort(e.message);
  }

  // ── Testaccount einrichten ─────────────────────────────────────
  header('Richte Superadmin-Testaccount ein …');
  const boot = spawnSync(
    process.execPath,
    [path.join(__dirname, 'bootstrap-admin-emulator.js')],
    { cwd: ROOT, stdio: 'inherit', shell: false }
  );
  if (boot.status !== 0) {
    cleanup();
    abort('Fehler beim Einrichten des Testaccounts.');
  }

  // ── Netlify Dev starten ────────────────────────────────────────
  header('Starte Netlify Dev …');
  console.log('  (Beenden mit Ctrl+C)\n');

  const netlify = spawn(
    cli('netlify'),
    ['dev'],
    { cwd: ROOT, stdio: 'inherit', shell: isWin }
  );
  children.push(netlify);

  netlify.on('error', e => {
    if (e.code === 'ENOENT') {
      cleanup();
      abort(
        'Netlify CLI nicht gefunden.\n' +
        '  Installieren: npm install -g netlify-cli'
      );
    }
    cleanup();
    abort('Netlify-Fehler: ' + e.message);
  });

  netlify.on('exit', code => {
    cleanup();
    process.exit(code ?? 0);
  });
}

main().catch(e => {
  cleanup();
  abort(e.message);
});
