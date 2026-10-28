'use strict';
// Discovery pipeline — dry-run mode only.
// POST: fetches up to MAX_SOURCES active sources for a city, detects structured
//       data signals via regex, writes a run report to discoveryPipelineRuns/,
//       returns the report. No LLM calls, no suggestions written.
// GET:  returns the last 10 pipeline run reports.
const { initAdmin, verifyStudioToken, json, makeId } = require('./_studio-shared');

const MAX_SOURCES     = 5;
const MAX_SUGGESTIONS = 20; // enforced limit for future use
const MAX_LLM_CALLS   = 10; // enforced limit for future use
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES   = 150_000;

// ── Signal detection patterns (German + common formats) ──────────────────────
const SIGNAL_PATTERNS = {
  operatingPeriod: [
    /\b\d{1,2}\.\s*\d{1,2}\.\s*(?:\d{2,4})?\s*(?:bis|–|-|to)\s*\d{1,2}\.\s*\d{1,2}\.\s*\d{2,4}/i,
    /\b(?:vom?|von)\s+\d{1,2}\.\s*\d{1,2}\.?\s*(?:bis|–|-)\s*\d{1,2}\.\s*\d{1,2}\.\s*\d{2,4}/i,
    /\d{4}-\d{2}-\d{2}\s*(?:bis|to|–|-)\s*\d{4}-\d{2}-\d{2}/i,
    /(?:november|dezember|januar|februar|märz|april|mai|juni|juli|august|september|oktober)\s+\d{4}\s*(?:bis|–|-)/i,
  ],
  openingHours: [
    /\b(?:mo(?:ntag)?|di(?:enstag)?|mi(?:ttwoch)?|do(?:nnerstag)?|fr(?:eitag)?|sa(?:mstag)?|so(?:nntag)?)\s*[-–:]\s*\d{1,2}[:.]\d{2}/i,
    /\b\d{1,2}[:.]\d{2}\s*(?:uhr|h|Uhr)\s*[-–]\s*\d{1,2}[:.]\d{2}/i,
    /\b(?:geöffnet|öffnungszeiten|opening\s*hours?)\b/i,
    /\b(?:täglich|montags?|dienstags?|mittwochs?|donnerstags?|freitags?|samstags?|sonntags?)\s+\d{1,2}[:.]\d{2}/i,
    /\b\d{1,2}[:.]\d{2}\s*-\s*\d{1,2}[:.]\d{2}\s*Uhr/i,
  ],
  exceptionalHours: [
    /\b(?:heiligabend|christmas\s*eve|silvester|new\s*year['s]*\s*eve)\b/i,
    /\b(?:feiertag(?:en?)?|holiday|geschlossen|closed)\b/i,
    /\b(?:sonderöffnungszeiten?|ausnahme|abweichend|exception)\b/i,
    /\b(?:24\.|25\.|26\.)\s*dezember\b/i,
  ],
  location: [
    /\b(?:straße|str\.|platz|gasse|allee|weg|ring|damm|ufer)\b/i,
    /\b\d{5}\s+[A-ZÄÖÜ][a-zäöüß]+/,
    /\b(?:dom|markt|platz|hauptbahnhof|hbf)\b/i,
  ],
  price: [
    /\b(?:eintritt|eintrittspreis|ticketpreis|preis)\b/i,
    /\b(?:kostenlos|frei|free)\b/i,
    /\b\d+[,.]?\d*\s*€/,
    /€\s*\d+/,
  ],
  provider: [
    /\b(?:veranstalter|anbieter|organisator|impressum|kontakt)\b/i,
    /\b(?:gmbh|ag|ev|e\.v\.|ug|gbr)\b/i,
    /\b(?:tourismus|stadtmarketing|kulturamt|stadtwerke)\b/i,
  ],
};

// ── HTML stripping ────────────────────────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#?\w+;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Signal detection ──────────────────────────────────────────────────────────
function detectSignals(text) {
  const found = {};
  for (const [signal, patterns] of Object.entries(SIGNAL_PATTERNS)) {
    const matches = [];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) matches.push(m[0].slice(0, 120));
    }
    found[signal] = { detected: matches.length > 0, examples: matches.slice(0, 3) };
  }
  return found;
}

// ── Fetch one source ──────────────────────────────────────────────────────────
async function fetchSource(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(source.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Someday-Discovery-Bot/1.0 (dry-run)' },
    });
    clearTimeout(timer);
    if (!res.ok) return { sourceId: source.id, url: source.url, error: `HTTP ${res.status}`, durationMs: Date.now() - start };

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/') && !contentType.includes('application/json') && !contentType.includes('xml')) {
      return { sourceId: source.id, url: source.url, error: `Unsupported content-type: ${contentType.split(';')[0]}`, durationMs: Date.now() - start };
    }

    // Stream with byte limit
    const reader = res.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    let truncated = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        chunks.push(value.slice(0, value.byteLength - (totalBytes - MAX_BODY_BYTES)));
        truncated = true;
        reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }

    const decoder = new TextDecoder('utf-8', { fatal: false });
    const raw = chunks.map(c => decoder.decode(c, { stream: true })).join('') + decoder.decode();
    const text = stripHtml(raw);
    const signals = detectSignals(text);
    const detectedCount = Object.values(signals).filter(s => s.detected).length;

    // Extract best address candidate from location signal examples for later LLM use
    const locExamples = signals.location?.examples || [];
    const locationSignal = {
      detected: signals.location?.detected || false,
      extractedText: locExamples.length > 0 ? locExamples[0] : null,
      allExamples: locExamples,
    };

    return {
      sourceId: source.id,
      url: source.url,
      name: source.name || null,
      ok: true,
      bytesFetched: totalBytes,
      truncated,
      textLength: text.length,
      signals,
      locationSignal,
      detectedSignalCount: detectedCount,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    clearTimeout(timer);
    const errMsg = err.name === 'AbortError' ? `Timeout after ${FETCH_TIMEOUT_MS}ms` : String(err.message || err);
    return { sourceId: source.id, url: source.url, error: errMsg, durationMs: Date.now() - start };
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const method = event.httpMethod;

  // GET: return last 10 run reports
  if (method === 'GET') {
    const actor = await verifyStudioToken(event.headers['authorization'], ['researcher', 'editor', 'superadmin']);
    if (!actor) return json(403, { error: 'Forbidden' });

    const db = initAdmin().database();
    const snap = await db.ref('discoveryPipelineRuns').orderByChild('startedAt').limitToLast(10).once('value');
    const runs = {};
    snap.forEach(child => { runs[child.key] = child.val(); });
    return json(200, { runs });
  }

  // POST: trigger dry-run
  if (method === 'POST') {
    const actor = await verifyStudioToken(event.headers['authorization'], ['editor', 'superadmin']);
    if (!actor) return json(403, { error: 'Forbidden' });

    let payload = {};
    try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

    const city = (payload.city || 'Köln').trim();
    const db = initAdmin().database();

    // Fetch active sources for city (up to MAX_SOURCES)
    const sourcesSnap = await db.ref('discoverySources').orderByChild('city').equalTo(city).once('value');
    const allSources = [];
    sourcesSnap.forEach(child => {
      const s = child.val();
      if (s.active) allSources.push({ ...s, id: child.key });
    });

    const sources = allSources.slice(0, MAX_SOURCES);
    const startedAt = Date.now();
    const runId = makeId('run');

    // Parallel fetch with individual error isolation
    const results = await Promise.all(sources.map(s => fetchSource(s)));

    const finishedAt = Date.now();
    const successCount = results.filter(r => r.ok).length;
    const errorCount   = results.filter(r => r.error).length;

    // Aggregate signal summary
    const signalSummary = {};
    for (const signalKey of Object.keys(SIGNAL_PATTERNS)) {
      signalSummary[signalKey] = results.filter(r => r.signals && r.signals[signalKey]?.detected).length;
    }

    const report = {
      runId,
      city,
      mode: 'dry-run',
      limits: { maxSources: MAX_SOURCES, maxSuggestions: MAX_SUGGESTIONS, maxLlmCalls: MAX_LLM_CALLS },
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      sourcesConsidered: allSources.length,
      sourcesFetched: sources.length,
      successCount,
      errorCount,
      signalSummary,
      sourceResults: results,
      triggeredBy: actor.uid,
    };

    // Write report — read-only to suggestions/activities; only writes to discoveryPipelineRuns/
    await db.ref().update({ [`discoveryPipelineRuns/${runId}`]: report });

    return json(200, { ok: true, report });
  }

  return json(405, { error: 'Method Not Allowed' });
};

// ── Exported for testing ──────────────────────────────────────────────────────
exports._stripHtml    = stripHtml;
exports._detectSignals = detectSignals;
exports._fetchSource  = fetchSource;
