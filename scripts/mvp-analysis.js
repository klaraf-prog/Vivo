'use strict';
/**
 * Someday MVP Usage Analysis — Read-Only
 *
 * Liest Daten direkt aus der Firebase RTDB über den Admin SDK und berechnet
 * alle Kennzahlen für das Investor Pitch Deck.
 *
 * Ausführung:
 *   FIREBASE_SERVICE_ACCOUNT_JSON='<json>' FIREBASE_RTDB_URL='<url>' node scripts/mvp-analysis.js
 *
 * WICHTIG: Dieses Script nimmt KEINE Schreibzugriffe vor.
 * Es gibt ausschließlich aggregierte Daten aus — keine personenbezogenen Informationen.
 */

// ─── KONFIGURATION: Interne Accounts ausschließen ────────────────────────────
//
// Trage hier die UIDs aller eigenen / internen / Test-Accounts ein.
// Du findest deine UID im Firebase Auth-Tab oder über:
//   firebase auth:export --format=json | grep -A2 'klara.faiss'
//
// Accounts mit einem studioRole-Custom-Claim werden IMMER zusätzlich ausgeschlossen.
//
const INTERNAL_UIDS = new Set([
  // Beispiel: 'ABC123defGHI456jkl', 'XYZabc789...'
  // Füge hier alle eigenen und Test-UIDs ein:
]);

// Analysezeitraum "begleitete MVP-Testphase"
const MVP_START_MS = new Date('2026-05-01T00:00:00Z').getTime();
const MVP_END_MS   = new Date('2026-05-31T23:59:59Z').getTime();
const TODAY_ISO    = new Date().toISOString().slice(0, 10);

// ─── Firebase Admin SDK initialisieren ───────────────────────────────────────

const admin = require('firebase-admin');

function initFirebase() {
  if (admin.apps.length > 0) return admin.apps[0];
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const dbUrl  = process.env.FIREBASE_RTDB_URL;
  if (!saJson) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON nicht gesetzt');
  if (!dbUrl)  throw new Error('FIREBASE_RTDB_URL nicht gesetzt');
  return admin.initializeApp({
    credential:   admin.credential.cert(JSON.parse(saJson)),
    databaseURL:  dbUrl,
  });
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function isMvpPeriod(tsMs) {
  return tsMs >= MVP_START_MS && tsMs <= MVP_END_MS;
}

function formatMs(ms) {
  if (!ms) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

// ─── Hauptanalyse ─────────────────────────────────────────────────────────────

async function main() {
  const app = initFirebase();
  const db  = app.database();
  const auth = app.auth();

  console.log('⏳ Lade Daten aus Firebase RTDB …\n');

  // ── 1. Alle Firebase Auth-User laden (für studioRole-Filter) ───────────────
  const authListResult = await auth.listUsers(1000);
  const internalUids = new Set(INTERNAL_UIDS);
  for (const u of authListResult.users) {
    if (u.customClaims?.studioRole) {
      internalUids.add(u.uid);
    }
  }
  console.log(`→ Firebase Auth: ${authListResult.users.length} Accounts gesamt`);
  console.log(`→ Ausgeschlossen (studioRole + manuell): ${internalUids.size} UIDs\n`);

  // ── 2. RTDB-Snapshots laden ────────────────────────────────────────────────
  const [
    usersSnap,
    eventsSnap,
    userEventsSnap,
    spacesSnap,
    spaceEventsSnap,
    invitesSnap,
    spaceMessagesSnap,
  ] = await Promise.all([
    db.ref('users').once('value'),
    db.ref('events').once('value'),
    db.ref('userEvents').once('value'),
    db.ref('spaces').once('value'),
    db.ref('spaceEvents').once('value'),
    db.ref('invites').once('value'),
    db.ref('spaceMessages').once('value'),
  ]);

  const allUsers       = usersSnap.val()        || {};
  const allEvents      = eventsSnap.val()        || {};
  const allUserEvents  = userEventsSnap.val()    || {};
  const allSpaces      = spacesSnap.val()        || {};
  const allSpaceEvents = spaceEventsSnap.val()   || {};
  const allInvites     = invitesSnap.val()        || {};
  const allMessages    = spaceMessagesSnap.val() || {};

  // ── 3. Externe Nutzer bestimmen ────────────────────────────────────────────
  // Kriterien: registrationComplete === true, nicht in internalUids
  const extUsers = {};
  for (const [uid, profile] of Object.entries(allUsers)) {
    if (internalUids.has(uid)) continue;
    if (!profile.registrationComplete) continue;
    extUsers[uid] = profile;
  }
  const extUidSet = new Set(Object.keys(extUsers));

  // ── 4. Externe Events bestimmen ────────────────────────────────────────────
  // Externe Events: createdBy ist ein externer Nutzer
  const extEvents    = {};  // alle externen Events
  const mvpEvents    = {};  // externe Events im MVP-Zeitraum
  for (const [eid, ev] of Object.entries(allEvents)) {
    if (!extUidSet.has(ev.createdBy)) continue;
    extEvents[eid] = ev;
    if (ev.createdAt && isMvpPeriod(ev.createdAt)) {
      mvpEvents[eid] = ev;
    }
  }

  // ── 5. RSVP-Analyse ────────────────────────────────────────────────────────
  // Für jedes externe Event: alle RSVPs aus events/$id/rsvps
  // Unterscheide: Creator-RSVP (immer dabei) vs. echte Fremd-RSVPs

  function analyzeRsvps(eventSubset) {
    const result = {
      totalInviteEntries:  0,  // invites/$uid/$eid = true (Datensatz-Einträge)
      rsvpDabei:           0,  // userEvents/$uid/$eid = 'dabei' (exkl. Creator)
      rsvpVielleicht:      0,
      rsvpNein:            0,
      uniqueDabeiUsers:    new Set(),
      eventsWithExternalDabei: new Set(),  // Events mit mind. 1 Fremd-Zusage
      dabeiPerEvent:       [],             // für Durchschnitt (exkl. Creator)
    };

    for (const [eid, ev] of Object.entries(eventSubset)) {
      const creatorUid = ev.createdBy;
      const rsvps = ev.rsvps || {};
      let externalDabei = 0;

      for (const rsvp of Object.values(rsvps)) {
        if (!rsvp.userId) continue;             // anonyme Poll-Votes überspringen
        const uid = rsvp.userId;
        if (!extUidSet.has(uid)) continue;       // nur externe Nutzer zählen
        if (uid === creatorUid) continue;         // Creator-RSVP ausschließen

        if (rsvp.status === 'dabei') {
          result.rsvpDabei++;
          result.uniqueDabeiUsers.add(uid);
          externalDabei++;
        } else if (rsvp.status === 'vielleicht') {
          result.rsvpVielleicht++;
        } else if (rsvp.status === 'nein') {
          result.rsvpNein++;
        }
      }

      if (externalDabei > 0) {
        result.eventsWithExternalDabei.add(eid);
        result.dabeiPerEvent.push(externalDabei);
      }

      // Invite-Einträge (invites/$uid/$eid = true) für dieses Event zählen
      for (const [uid, userInvs] of Object.entries(allInvites)) {
        if (!extUidSet.has(uid)) continue;
        if (userInvs[eid]) result.totalInviteEntries++;
      }
    }

    return result;
  }

  const rsvpAll = analyzeRsvps(extEvents);
  const rsvpMvp = analyzeRsvps(mvpEvents);

  // ── 6. Wiederkehrende Nutzung ──────────────────────────────────────────────

  function analyzeRepeatUsage(eventSubset) {
    const eventIds = new Set(Object.keys(eventSubset));
    const createdCount  = {};  // uid → Anzahl erstellter Events
    const dabeiCount    = {};  // uid → Anzahl "dabei"-Events (exkl. eigene)
    const activityLog   = {};  // uid → [timestamps der Event-Interaktionen]

    for (const [eid, ev] of Object.entries(eventSubset)) {
      if (!eventIds.has(eid)) continue;
      const uid = ev.createdBy;
      if (!extUidSet.has(uid)) continue;
      createdCount[uid] = (createdCount[uid] || 0) + 1;
      if (!activityLog[uid]) activityLog[uid] = [];
      if (ev.createdAt) activityLog[uid].push(ev.createdAt);
    }

    // "dabei"-RSVPs anderer Events (nicht eigene)
    for (const [eid, ev] of Object.entries(eventSubset)) {
      if (!eventIds.has(eid)) continue;
      const rsvps = ev.rsvps || {};
      for (const rsvp of Object.values(rsvps)) {
        if (!rsvp.userId || !extUidSet.has(rsvp.userId)) continue;
        if (rsvp.userId === ev.createdBy) continue;  // Creator ausschließen
        if (rsvp.status !== 'dabei') continue;
        dabeiCount[rsvp.userId] = (dabeiCount[rsvp.userId] || 0) + 1;
        if (!activityLog[rsvp.userId]) activityLog[rsvp.userId] = [];
        if (rsvp.ts) activityLog[rsvp.userId].push(rsvp.ts);
      }
    }

    const multiCreators   = Object.values(createdCount).filter(n => n >= 2).length;
    const multiDabei      = Object.values(dabeiCount).filter(n => n >= 2).length;
    const bothCreateRsvp  = Object.keys(createdCount).filter(uid => dabeiCount[uid] >= 1).length;

    // Zeitlicher Abstand zwischen Nutzungsaktivitäten (Tage)
    const gaps = [];
    for (const timestamps of Object.values(activityLog)) {
      if (timestamps.length < 2) continue;
      const sorted = [...timestamps].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        gaps.push((sorted[i] - sorted[i - 1]) / 86400000);
      }
    }
    const medianGapDays = median(gaps);

    return { createdCount, dabeiCount, multiCreators, multiDabei, bothCreateRsvp, medianGapDays, gaps };
  }

  const repeatAll = analyzeRepeatUsage(extEvents);
  const repeatMvp = analyzeRepeatUsage(mvpEvents);

  // ── 7. Spaces-Analyse ──────────────────────────────────────────────────────

  function analyzeSpaces(eventSubset) {
    const eventIds = new Set(Object.keys(eventSubset));

    // Spaces mit externen Mitgliedern
    let totalExtSpaces       = 0;
    let spacesMultiMember    = 0;
    let spacesWithInteraction = 0;
    let spacesWithEvent       = 0;
    let pollEventsCount       = 0;

    for (const [sid, sp] of Object.entries(allSpaces)) {
      const members = Object.keys(sp.members || {}).filter(uid => extUidSet.has(uid));
      if (members.length === 0) continue;
      totalExtSpaces++;
      if (members.length >= 2) spacesMultiMember++;

      // Hat dieser Space Events im Analyseset?
      const spEvts = allSpaceEvents[sid] || {};
      const relevantSpEvts = Object.keys(spEvts).filter(eid => eventIds.has(eid));
      if (relevantSpEvts.length > 0) spacesWithEvent++;

      // Chat-Interaktion: unterschiedliche Sender in spaceMessages/$sid
      const msgs = allMessages[sid] || {};
      const senders = new Set(
        Object.values(msgs)
          .filter(m => m.senderUid && extUidSet.has(m.senderUid) && m.type !== 'event')
          .map(m => m.senderUid)
      );
      if (senders.size >= 2) spacesWithInteraction++;
    }

    // Poll-Events im Subset
    for (const ev of Object.values(eventSubset)) {
      if (ev.poll) pollEventsCount++;
    }

    return { totalExtSpaces, spacesMultiMember, spacesWithInteraction, spacesWithEvent, pollEventsCount };
  }

  const spacesAll = analyzeSpaces(extEvents);
  const spacesMvp = analyzeSpaces(mvpEvents);

  // ── 8. Aktive Nutzer ───────────────────────────────────────────────────────

  function activeUsers(eventSubset) {
    const eventIds = new Set(Object.keys(eventSubset));
    const active = new Set();
    for (const ev of Object.values(eventSubset)) {
      if (extUidSet.has(ev.createdBy)) active.add(ev.createdBy);
    }
    for (const [eid, ev] of Object.entries(eventSubset)) {
      if (!eventIds.has(eid)) continue;
      for (const rsvp of Object.values(ev.rsvps || {})) {
        if (rsvp.userId && extUidSet.has(rsvp.userId)) active.add(rsvp.userId);
      }
    }
    return active;
  }

  const activeAll = activeUsers(extEvents);
  const activeMvp = activeUsers(mvpEvents);

  // ── 9. Vergangene Events (Datum in der Vergangenheit) ──────────────────────
  const pastExtEvents = Object.entries(extEvents).filter(([, ev]) => ev.date && ev.date < TODAY_ISO);
  const pastMvpEvents = Object.entries(mvpEvents).filter(([, ev]) => ev.date && ev.date < TODAY_ISO);

  // ── 10. Ergebnis ausgeben ──────────────────────────────────────────────────

  const divider = '─'.repeat(120);
  const col = (s, w) => String(s ?? '—').slice(0, w).padEnd(w);

  console.log('\n' + '═'.repeat(120));
  console.log(' SOMEDAY MVP NUTZUNGSANALYSE');
  console.log(` Analysezeitraum MVP: 2026-05-01 bis 2026-05-31`);
  console.log(` Datenstand: ${TODAY_ISO}`);
  console.log(` Externe Nutzer (registrationComplete, kein studioRole): ${extUidSet.size}`);
  console.log(` Ausgeschlossene interne UIDs: ${internalUids.size}`);
  console.log('═'.repeat(120) + '\n');

  // ─── TABELLE ────────────────────────────────────────────────────────────────
  const rows = [
    // ── 1. Nutzerbasis ──────────────────────────────────────────────────────
    ['NUTZERBASIS', '', '', '', ''],
    [
      'Registrierte externe Nutzer',
      extUidSet.size,
      extUidSet.size,
      'users/$uid.registrationComplete === true; ohne studioRole-Claim; ohne INTERNAL_UIDS',
      'Zählt alle abgeschlossenen Registrierungen (Handle gewählt). Spiegelt nicht zwingend aktive Nutzung wider.',
    ],
    [
      'Aktive externe Nutzer (Event erstellt oder RSVP)',
      activeMvp.size,
      activeAll.size,
      'Nutzer mit mind. 1 Event in events/ (createdBy) ODER mind. 1 RSVP-Eintrag in events/$id/rsvps',
      'Belastbarer Aktivitätsindikator. Doppelzählungen ausgeschlossen.',
    ],
    [
      'Externe Event-Ersteller',
      new Set(Object.values(mvpEvents).map(e => e.createdBy).filter(uid => extUidSet.has(uid))).size,
      new Set(Object.values(extEvents).map(e => e.createdBy).filter(uid => extUidSet.has(uid))).size,
      'Distinct createdBy-UIDs über alle externen Events',
      'Direkt ermittelbar. Aussagekräftig für Erstellungsverhalten.',
    ],

    // ── 2. Events ───────────────────────────────────────────────────────────
    ['', '', '', '', ''],
    ['EVENTS', '', '', '', ''],
    [
      'Erstellte externe Events (gesamt)',
      Object.keys(mvpEvents).length,
      Object.keys(extEvents).length,
      'events/$id; Filter: createdBy in extUidSet; MVP: createdAt in [2026-05-01, 2026-05-31]',
      'Direkt zählbar. Zuverlässig.',
    ],
    [
      '  davon: Events mit festem Datum (kein Poll)',
      Object.values(mvpEvents).filter(e => e.date && !e.poll).length,
      Object.values(extEvents).filter(e => e.date && !e.poll).length,
      'events/$id.date !== null AND events/$id.poll fehlt oder null',
      'Terminfestgesetzte Events ohne laufende Abstimmung.',
    ],
    [
      '  davon: Events mit Terminabstimmung (Poll)',
      spacesMvp.pollEventsCount,
      spacesAll.pollEventsCount,
      'events/$id.poll !== null',
      'Events mit aktivem oder abgeschlossenem Date Poll.',
    ],
    [
      '  davon: Events mit vergangenem Datum',
      pastMvpEvents.length,
      pastExtEvents.length,
      'events/$id.date < ' + TODAY_ISO + '; Datum ist vergangen, kein Nachweis ob tatsächlich stattgefunden',
      'EINSCHRÄNKUNG: Vergangenes Datum ≠ tatsächlich stattgefunden. Keine Post-Event-Bestätigung in der DB.',
    ],

    // ── 3. Einladungen und Teilnahme ────────────────────────────────────────
    ['', '', '', '', ''],
    ['EINLADUNGEN UND TEILNAHME', '', '', '', ''],
    [
      'Invite-Datenbankeinträge (invites/$uid/$eid)',
      rsvpMvp.totalInviteEntries,
      rsvpAll.totalInviteEntries,
      'invites/$uid/$eid = true; pro externem Nutzer und externem Event gezählt',
      'Zählt Einladungen die über event-create.js gespeichert wurden. Nicht identisch mit versendeten Nachrichten.',
    ],
    [
      'RSVP "dabei" (exkl. Event-Ersteller)',
      rsvpMvp.rsvpDabei,
      rsvpAll.rsvpDabei,
      'events/$id/rsvps/$key.status === "dabei" AND userId !== createdBy; nur externe Nutzer',
      'Stärkster Partizipationsindikator. Doppelzählungen ausgeschlossen.',
    ],
    [
      'RSVP "vielleicht" (exkl. Ersteller)',
      rsvpMvp.rsvpVielleicht,
      rsvpAll.rsvpVielleicht,
      'events/$id/rsvps/$key.status === "vielleicht"; nur externe Nutzer',
      'Schwächeres Engagement. Aussagekraft begrenzt.',
    ],
    [
      'RSVP "nein"',
      rsvpMvp.rsvpNein,
      rsvpAll.rsvpNein,
      'events/$id/rsvps/$key.status === "nein"',
      'Aussagekraft gering für Pitch. Belegt aber aktive Auseinandersetzung mit Event-Einladung.',
    ],
    [
      'Eindeutige Nutzer mit mind. 1 Fremd-Zusage ("dabei")',
      rsvpMvp.uniqueDabeiUsers.size,
      rsvpAll.uniqueDabeiUsers.size,
      'distinct userId über alle events/$id/rsvps wo status=dabei AND userId≠createdBy',
      'Gut für Pitch: zeigt wie viele unterschiedliche Personen aktiv zugesagt haben.',
    ],
    [
      'Events mit mind. 1 externen Fremd-Zusage',
      rsvpMvp.eventsWithExternalDabei.size,
      rsvpAll.eventsWithExternalDabei.size,
      'Events wo mind. 1 rsvp.status=dabei AND userId≠createdBy AND userId in extUidSet',
      'Zeigt Conversion von "Event erstellt" zu "Event mit Reaktion". Gut für Pitch.',
    ],
    [
      'Ø externe "dabei"-Zusagen pro Event (Events mit ≥1 Zusage)',
      rsvpMvp.dabeiPerEvent.length
        ? (rsvpMvp.dabeiPerEvent.reduce((a, b) => a + b, 0) / rsvpMvp.dabeiPerEvent.length).toFixed(1)
        : '—',
      rsvpAll.dabeiPerEvent.length
        ? (rsvpAll.dabeiPerEvent.reduce((a, b) => a + b, 0) / rsvpAll.dabeiPerEvent.length).toFixed(1)
        : '—',
      'Nur Events mit eventsWithExternalDabei; exkl. Creator-RSVP',
      'Konservativer Durchschnitt, da Nenner nur Events mit mind. 1 Fremd-Zusage sind.',
    ],

    // ── 4. Wiederkehrende Nutzung ────────────────────────────────────────────
    ['', '', '', '', ''],
    ['WIEDERKEHRENDE NUTZUNG', '', '', '', ''],
    [
      'Nutzer mit ≥ 2 erstellten Events',
      repeatMvp.multiCreators,
      repeatAll.multiCreators,
      'createdCount[uid] >= 2 über externe Events im jeweiligen Zeitraum',
      'Starker Retention-Indikator für Ersteller.',
    ],
    [
      'Nutzer mit ≥ 2 "dabei"-Zusagen bei fremden Events',
      repeatMvp.multiDabei,
      repeatAll.multiDabei,
      'dabeiCount[uid] >= 2; nur Fremd-Events (uid ≠ createdBy)',
      'Zeigt wiederkehrendes Engagement als Teilnehmer.',
    ],
    [
      'Nutzer die sowohl erstellt als auch zugesagt haben',
      repeatMvp.bothCreateRsvp,
      repeatAll.bothCreateRsvp,
      'createdCount[uid] >= 1 AND dabeiCount[uid] >= 1',
      'Zeigt beidseitige Rollennutzung (Creator + Participant). Stark für soziale Engagement-These.',
    ],
    [
      'Medianer Abstand zwischen Aktivitäten (Tage)',
      repeatMvp.medianGapDays !== null ? repeatMvp.medianGapDays.toFixed(1) : '—',
      repeatAll.medianGapDays !== null ? repeatAll.medianGapDays.toFixed(1) : '—',
      'Median der Abstände zwischen aufeinanderfolgenden Nutzungsaktivitäten pro Nutzer (Event-Creation- und RSVP-Timestamps)',
      'Nur aussagekräftig bei ≥10 Datenpunkten. Kleines N = hohe Varianz.',
    ],

    // ── 5. Spaces und kollaborative Nutzung ──────────────────────────────────
    ['', '', '', '', ''],
    ['SPACES UND KOLLABORATIVE NUTZUNG', '', '', '', ''],
    [
      'Spaces mit mind. 1 externem Mitglied',
      spacesMvp.totalExtSpaces,
      spacesAll.totalExtSpaces,
      'spaces/$id.members enthält mind. 1 uid in extUidSet',
      'Zuverlässig. Spaces ohne externe Mitglieder sind interne/Test-Spaces.',
    ],
    [
      'Spaces mit ≥ 2 externen Mitgliedern',
      spacesMvp.spacesMultiMember,
      spacesAll.spacesMultiMember,
      'distinct extUidSet-Mitglieder in spaces/$id.members >= 2',
      'Belegt soziale Netzwerk-Funktion: mind. 2 externe Personen nutzen den Space gemeinsam.',
    ],
    [
      'Spaces mit Text-Chat-Interaktion (≥ 2 verschiedene Sender)',
      spacesMvp.spacesWithInteraction,
      spacesAll.spacesWithInteraction,
      'spaceMessages/$id: type=text, distinct senderUid in extUidSet >= 2',
      'Stärkster Interaktionsnachweis. Belegt echten Austausch zwischen verschiedenen Nutzern.',
    ],
    [
      'Spaces mit mind. 1 Event',
      spacesMvp.spacesWithEvent,
      spacesAll.spacesWithEvent,
      'spaceEvents/$id enthält mind. 1 eventId aus dem Event-Subset',
      'Zeigt Feature-Adoption: Spaces werden zur gemeinsamen Eventplanung genutzt.',
    ],

    // ── 6. Tatsächlich stattgefundene Erlebnisse ─────────────────────────────
    ['', '', '', '', ''],
    ['STATTGEFUNDENE ERLEBNISSE (SCHÄTZUNG MIT EINSCHRÄNKUNGEN)', '', '', '', ''],
    [
      'Events mit vergangenem Datum UND mind. 1 externer Fremd-Zusage',
      (() => {
        const ids = rsvpMvp.eventsWithExternalDabei;
        return Object.entries(mvpEvents).filter(([eid, ev]) => ev.date && ev.date < TODAY_ISO && ids.has(eid)).length;
      })(),
      (() => {
        const ids = rsvpAll.eventsWithExternalDabei;
        return Object.entries(extEvents).filter(([eid, ev]) => ev.date && ev.date < TODAY_ISO && ids.has(eid)).length;
      })(),
      'events/$id.date < TODAY AND event in eventsWithExternalDabei',
      'EINSCHRÄNKUNG: Vergangenes Datum + Zusage ≠ nachweislich stattgefunden. Keine Post-Event-Bestätigung in der DB. Konservative Schätzung eines Mindest-Outputs.',
    ],
  ];

  // ─── Tabellenausgabe ───────────────────────────────────────────────────────
  const W = [45, 10, 12, 50, 65];
  const header = [
    col('Kennzahl', W[0]),
    col('Mai 2026', W[1]),
    col('Gesamt', W[2]),
    col('Berechnungsgrundlage', W[3]),
    col('Aussagekraft / Einschränkungen', W[4]),
  ].join(' | ');

  console.log(header);
  console.log(divider);

  for (const row of rows) {
    if (row[0] && !row[1] && !row[2]) {
      // Abschnittsüberschrift
      console.log('\n' + row[0].toUpperCase());
      console.log('─'.repeat(80));
    } else if (row[0]) {
      console.log([
        col(row[0], W[0]),
        col(row[1], W[1]),
        col(row[2], W[2]),
        col(row[3], W[3]),
        col(row[4], W[4]),
      ].join(' | '));
    }
  }

  // ─── Empfehlungen für Pitch Deck ──────────────────────────────────────────
  console.log('\n\n' + '═'.repeat(120));
  console.log(' TOP-KENNZAHLEN FÜR DEN PITCH (Empfehlung)');
  console.log('═'.repeat(120));
  console.log(`
Die folgenden 5 Kennzahlen sind am stärksten, weil sie unterschiedliche Dimensionen
des Nutzerverhaltens belegen und methodisch sauber herleitbar sind:

1. EXTERNE EVENT-ERSTELLER (Mai 2026)
   → Zeigt Adoption der Kernaktion: Wie viele unterschiedliche Personen haben Someday
     tatsächlich genutzt, um einen Termin zu initiieren?
   → Belegt: Erstnutzung der Hauptfunktion

2. NUTZER MIT ≥2 ERSTELLTEN EVENTS (Mai 2026)
   → Stärkster Retention-Indikator, der mit kleiner Nutzerbasis möglich ist.
   → "10 von 16 Erstellern haben mehrfach genutzt" ist ein belastbarer Beweis für
     Habit-Bildung, nicht nur Einmalerleichterung.
   → Belegt: Wiederkehrende Nutzung

3. EVENTS MIT MIND. 1 EXTERNER FREMD-ZUSAGE
   → Belegt, dass die soziale Schleife geschlossen wird: Ein Event erhält eine Reaktion.
   → Conversion-Rate "erstellt → Reaktion erhalten" besser als absolute Zahl.
   → Belegt: Soziale Interaktion

4. EINDEUTIGE NUTZER MIT MIND. 1 "DABEI"-ZUSAGE (exkl. Ersteller)
   → Trennt Ersteller- von Teilnehmer-Adoption. Zeigt, dass nicht nur Ersteller aktiv sind.
   → Belegt: Beidseitige Nutzung des Netzwerkeffekts

5. SPACES MIT ≥2 EXTERNEN MITGLIEDERN (oder mit Chat-Interaktion)
   → Belegt die kollaborative Dimension: Someday wird nicht nur solo,
     sondern als gemeinsamer Planungsraum genutzt.
   → Belegt: Gruppenplanung / soziale Vernetzung

─── WICHTIGE EINSCHRÄNKUNGEN FÜR DAS PITCH DECK ────────────────────────────────

• "Tatsächlich stattgefunden": Die Datenbank enthält KEINE Post-Event-Bestätigung.
  Vergangenes Datum + Zusage = berechtigte Schätzung, kein Nachweis.
  → Formulierung empfohlen: "Events mit einem vergangenen Datum und mind. einer Zusage"

• Kleine Datenbasis: Alle Kennzahlen stammen aus einer begleiteten Testphase mit
  bewusst kleiner Gruppe. N < 50 schränkt statistische Generaliserbarkeit ein.
  → Formulierung empfohlen: "Begleitete Erstnutzung mit ${extUidSet.size} externen Nutzern"

• Accounts: Das Script schließt alle Nutzer mit studioRole-Claim und die in
  INTERNAL_UIDS konfigurierten UIDs aus. Bitte konfiguriere alle eigenen UIDs
  vollständig, um Doppelzählungen zu vermeiden.
`);

  // ─── Rohzahlen für Verifikation ───────────────────────────────────────────
  console.log('ROHZAHLEN ZUR VERIFIKATION DER BEKANNTEN KENNZAHLEN');
  console.log(divider);
  const mvpCreators = new Set(Object.values(mvpEvents).map(e => e.createdBy).filter(uid => extUidSet.has(uid)));
  const mvpCreatorCounts = {};
  for (const ev of Object.values(mvpEvents)) {
    if (extUidSet.has(ev.createdBy)) {
      mvpCreatorCounts[ev.createdBy] = (mvpCreatorCounts[ev.createdBy] || 0) + 1;
    }
  }
  const multiCreateMvp = Object.values(mvpCreatorCounts).filter(n => n >= 2).length;

  console.log(`Externe Events (Mai 2026):       ${Object.keys(mvpEvents).length}  (bekannt: 42)`);
  console.log(`Externe Event-Ersteller (Mai):   ${mvpCreators.size}  (bekannt: 16)`);
  console.log(`Ersteller mit ≥2 Events (Mai):   ${multiCreateMvp}  (bekannt: 10)`);
  console.log(`\n→ Abweichungen von den bekannten Zahlen deuten auf:`);
  console.log(`  a) Fehlende INTERNAL_UIDS-Konfiguration (interne Accounts nicht ausgeschlossen)`);
  console.log(`  b) Abweichende Zeitraumgrenzen (Mai = exakt 2026-05-01 bis 2026-05-31?)`);
  console.log(`  c) Events die über andere Pfade erstellt wurden\n`);

  await app.delete();
  console.log('✅ Analyse abgeschlossen.');
}

main().catch(err => {
  console.error('❌ Fehler:', err.message);
  process.exit(1);
});
