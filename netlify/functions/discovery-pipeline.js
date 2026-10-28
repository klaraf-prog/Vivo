'use strict';
// Discovery pipeline — dry-run and live (LLM extraction) modes.
// POST: fetches up to MAX_SOURCES active sources for a city, detects structured
//       data signals via regex, and in live mode calls Claude Haiku to extract
//       activity suggestions (written as status:'draft', never auto-published).
//       Writes a run report to discoveryPipelineRuns/.
// GET:  returns the last 10 pipeline run reports.
// Env:  ANTHROPIC_API_KEY required for live mode (set in Netlify → Deploy previews scope).
const { initAdmin, verifyStudioToken, json, makeId, duplicateHash } = require('./_studio-shared');

const MAX_SOURCES     = 5;
const MAX_SUGGESTIONS = 20;
const MAX_LLM_CALLS   = 10;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES   = 150_000;

// LLM constants
const LLM_MODEL            = 'claude-haiku-5-5';
const LLM_TEXT_LIMIT       = 40_000;  // chars sent to LLM per source (after condensing)
const PRICE_INPUT_PER_MTOK = 0.10;    // USD per million input tokens
const PRICE_OUTPUT_PER_MTOK = 0.50;   // USD per million output tokens
const LLM_TIMEOUT_MS       = 24_000;  // stay under Netlify's 26s function limit

// Only these cities may be processed; expand deliberately when ready.
const ALLOWED_CITIES = ['Köln'];

const VALID_CATEGORIES = [
  'market', 'festival', 'concert', 'exhibition', 'sport',
  'outdoor', 'food', 'culture', 'family', 'nightlife', 'other',
];

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

// ── Text condensing ───────────────────────────────────────────────────────────
// Removes navigation noise before LLM extraction.
// On long pages (> 20K chars): skips the opening nav/header area.
// Deduplicates repeated short fragments (nav links, breadcrumbs, footer items).
function condensePipelineText(text, limit) {
  // Skip the first 3 % (max 3 K chars) of long pages — almost always navigation.
  const skipStart = text.length > 20_000 ? Math.min(3_000, Math.floor(text.length * 0.03)) : 0;
  let t = text.slice(skipStart);

  // Split into rough phrases at double-space boundaries or after sentence punctuation.
  const fragments = t.split(/\s{2,}|(?<=[.!?])\s+/);

  // Count occurrences of each short fragment (case-insensitive key).
  const counts = new Map();
  for (const f of fragments) {
    const key = f.trim().toLowerCase();
    if (key.length > 0 && key.length <= 60) counts.set(key, (counts.get(key) || 0) + 1);
  }

  // Keep a fragment if it is long (likely real content) or appears only 1–2 times.
  t = fragments
    .filter(f => {
      const trimmed = f.trim();
      if (trimmed.length === 0) return false;
      if (trimmed.length > 60) return true;            // long = content
      return (counts.get(trimmed.toLowerCase()) || 0) <= 2; // rare short = keep
    })
    .join(' ');

  return t.slice(0, limit);
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
      text,                    // included for LLM extraction; stripped before report storage
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

// ── LLM extraction prompt ─────────────────────────────────────────────────────
function buildExtractionPrompt(text, city) {
  const condensed = condensePipelineText(text, LLM_TEXT_LIMIT);
  const system = `You are a structured data extraction assistant. Extract individual activity/event listings from website text for the city of ${city}.

The text may contain navigation menus, cookie notices, breadcrumbs and footer content — ignore these entirely and focus only on distinct activity or event listings.

Output ONLY a valid JSON object with this exact shape:
{
  "activities": [
    {
      "title": "string (required, max 120 chars — name of this specific activity, not the website name)",
      "description": "string (required, max 500 chars — describe this specific activity only)",
      "category": "one of: market|festival|concert|exhibition|sport|outdoor|food|culture|family|nightlife|other",
      "tagline": "string or null (max 80 chars)",
      "eyebrow": "string or null (max 60 chars, e.g. season label)",
      "location": { "address": "string" } or null,
      "providerName": "string or null",
      "website": "string (URL) or null",
      "price": "string or null (human-readable, e.g. 'kostenlos' or '5–10 €')",
      "operatingPeriod": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" } or null,
      "openingHours": "string or null (human-readable summary, e.g. 'täglich 11–21 Uhr')",
      "exceptionalHours": "string or null",
      "sourceAttribution": "string or null (display name of source website)"
    }
  ]
}

Rules:
- Extract each distinct activity as a SEPARATE entry — an overview page listing multiple markets must produce one entry per market.
- Each activity entry must be SELF-CONTAINED: only fill in data explicitly stated for that specific activity. Never copy data from one activity to another.
- Only include activities clearly located in or explicitly associated with ${city}.
- NEVER invent, guess or infer data. If a field is not explicitly stated for this specific activity, set it to null.
- Do not include lat/lng coordinates.
- Dates must be ISO-8601 (YYYY-MM-DD). If only month+year known, use the first day of "from" and last day of "to" month.
- Maximum ${MAX_SUGGESTIONS} activities per response.
- If no clear activities are found, return { "activities": [] }.
- Output only the JSON object, no explanation, no markdown code fences.`;

  const user = `Extract all individual activities from the following website text:\n\n${condensed}`;
  return { system, user };
}

// ── JSON extraction from LLM response ────────────────────────────────────────
// Handles models that wrap JSON in markdown code fences or add a brief preamble.
function extractJsonFromLLMResponse(raw) {
  let text = raw.trim();
  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  // If there is still a non-JSON preamble, seek the first opening brace
  const start = text.indexOf('{');
  if (start > 0) text = text.slice(start);
  // Trim any trailing content after the last closing brace
  const end = text.lastIndexOf('}');
  if (end >= 0 && end < text.length - 1) text = text.slice(0, end + 1);
  return text;
}

// ── Call Anthropic API ────────────────────────────────────────────────────────
async function callAnthropicAPI(text, city, apiKey) {
  const { system, user } = buildExtractionPrompt(text, city);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 4096,  // up to ~20 JSON activity objects with full details
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return { activities: [], inputTokens: 0, outputTokens: 0, error: `Anthropic HTTP ${res.status}: ${errBody.slice(0, 200)}` };
    }

    const data = await res.json();
    const inputTokens  = data.usage?.input_tokens  || 0;
    const outputTokens = data.usage?.output_tokens || 0;

    const rawText = data.content?.[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(extractJsonFromLLMResponse(rawText));
    } catch {
      // Include a brief snippet (no PII, no API keys) to aid debugging
      const snippet = rawText.slice(0, 120).replace(/\n/g, ' ');
      return { activities: [], inputTokens, outputTokens, error: `LLM response is not valid JSON. Preview: ${snippet}` };
    }

    if (!Array.isArray(parsed?.activities)) {
      return { activities: [], inputTokens, outputTokens, error: 'LLM response missing activities array' };
    }

    return { activities: parsed.activities, inputTokens, outputTokens, error: null };
  } catch (err) {
    clearTimeout(timer);
    const msg = err.name === 'AbortError' ? `LLM timeout after ${LLM_TIMEOUT_MS}ms` : String(err.message || err);
    return { activities: [], inputTokens: 0, outputTokens: 0, error: msg };
  }
}

// ── Activity validation ───────────────────────────────────────────────────────
function validateActivity(raw, sourceUrl, sourceName) {
  const errors = [];

  if (!raw || typeof raw !== 'object') return { valid: false, errors: ['not an object'] };

  // Required fields
  if (!raw.title || typeof raw.title !== 'string' || raw.title.trim().length === 0) errors.push('title missing');
  if (!raw.description || typeof raw.description !== 'string' || raw.description.trim().length === 0) errors.push('description missing');
  if (!raw.category || !VALID_CATEGORIES.includes(raw.category)) errors.push(`invalid category: ${raw.category}`);

  if (errors.length > 0) return { valid: false, errors };

  // Sanitise strings
  const title       = String(raw.title).trim().slice(0, 120);
  const description = String(raw.description).trim().slice(0, 500);
  const category    = raw.category;
  const tagline     = raw.tagline ? String(raw.tagline).trim().slice(0, 80)  : null;
  const eyebrow     = raw.eyebrow  ? String(raw.eyebrow).trim().slice(0,  60) : null;
  const providerName = raw.providerName ? String(raw.providerName).trim().slice(0, 120) : null;
  const price        = raw.price ? String(raw.price).trim().slice(0, 80) : null;
  const openingHours = raw.openingHours ? String(raw.openingHours).trim().slice(0, 300) : null;
  const exceptionalHours = raw.exceptionalHours ? String(raw.exceptionalHours).trim().slice(0, 300) : null;
  const sourceAttribution = raw.sourceAttribution ? String(raw.sourceAttribution).trim().slice(0, 200) : (sourceName || null);

  // Website URL — only accept http/https
  let website = null;
  if (raw.website) {
    const w = String(raw.website).trim();
    if (/^https?:\/\//i.test(w)) website = w.slice(0, 500);
  }

  // location: must be object with address string, or null
  let location = null;
  if (raw.location && typeof raw.location === 'object' && typeof raw.location.address === 'string' && raw.location.address.trim()) {
    location = { address: raw.location.address.trim().slice(0, 300) };
  }

  // operatingPeriod: { from: YYYY-MM-DD, to: YYYY-MM-DD } or null
  let operatingPeriod = null;
  if (raw.operatingPeriod && typeof raw.operatingPeriod === 'object') {
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    if (ISO_DATE.test(raw.operatingPeriod.from) && ISO_DATE.test(raw.operatingPeriod.to)) {
      operatingPeriod = { from: raw.operatingPeriod.from, to: raw.operatingPeriod.to };
    }
  }

  // Track what the LLM could not determine
  const missingFields = [];
  if (!location) missingFields.push('location');
  if (!operatingPeriod) missingFields.push('operatingPeriod');
  if (!price) missingFields.push('price');
  if (!website) missingFields.push('website');
  if (!providerName) missingFields.push('providerName');

  const activity = {
    title,
    tagline,
    description,
    category,
    eyebrow,
    location,
    lat: null,
    lng: null,
    geoQuality: 'missing',
    providerName,
    website,
    instagram: null,
    price,
    schedule: null,
    bookingUrl: null,
    imageUrls: null,
    operatingPeriod,
    openingHours,
    exceptionalHours,
    sourceAttribution,
    sources: [sourceUrl],
    missingFields: missingFields.length > 0 ? missingFields : null,
  };

  return { valid: true, activity, errors: [] };
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

  // POST: trigger run
  if (method === 'POST') {
    const actor = await verifyStudioToken(event.headers['authorization'], ['editor', 'superadmin']);
    if (!actor) return json(403, { error: 'Forbidden' });

    let payload = {};
    try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

    const city = (payload.city || 'Köln').trim();
    if (!ALLOWED_CITIES.includes(city)) {
      return json(400, { error: `City not supported: ${city}. Allowed: ${ALLOWED_CITIES.join(', ')}` });
    }
    const mode = payload.mode === 'live' ? 'live' : 'dry-run';

    // live mode requires API key
    const apiKey = mode === 'live' ? (process.env.ANTHROPIC_API_KEY || '') : '';
    if (mode === 'live' && !apiKey) {
      return json(500, { error: 'ANTHROPIC_API_KEY not configured' });
    }

    const db = initAdmin().database();

    // Full scan with client-side filter — avoids missing sources due to city
    // value case/whitespace mismatches that an exact RTDB query would drop silently.
    const sourcesSnap = await db.ref('discoverySources').once('value');
    const allSources = [];
    let sourcesSkippedInactive = 0;
    let sourcesSkippedCityMismatch = 0;
    sourcesSnap.forEach(child => {
      const s = child.val();
      if (!s.active) { sourcesSkippedInactive++; return; }
      if (s.city?.trim() !== city) { sourcesSkippedCityMismatch++; return; }
      allSources.push({ ...s, id: child.key });
    });

    const sources = allSources.slice(0, MAX_SOURCES);
    const startedAt = Date.now();
    const runId = makeId('run');

    // Parallel fetch with individual error isolation
    const fetchResults = await Promise.all(sources.map(s => fetchSource(s)));

    // LLM extraction (live mode only)
    let llmCallsUsed = 0;
    let totalInputTokens  = 0;
    let totalOutputTokens = 0;
    let suggestionsProposed      = 0;
    let suggestionsSaved         = 0;
    let suggestionsDeduplicated  = 0;
    const llmErrors = [];
    const savedSuggestionIds = [];

    if (mode === 'live') {
      for (const result of fetchResults) {
        if (!result.ok || !result.text) continue;
        if (llmCallsUsed >= MAX_LLM_CALLS) break;
        if (suggestionsSaved >= MAX_SUGGESTIONS) break;

        llmCallsUsed++;
        const { activities, inputTokens, outputTokens, error } = await callAnthropicAPI(result.text, city, apiKey);
        totalInputTokens  += inputTokens;
        totalOutputTokens += outputTokens;

        if (error) {
          llmErrors.push({ sourceId: result.sourceId, error });
          continue;
        }

        for (const raw of activities) {
          if (suggestionsSaved >= MAX_SUGGESTIONS) break;

          suggestionsProposed++;
          const { valid, activity, errors: valErrors } = validateActivity(raw, result.url, result.name);
          if (!valid) {
            llmErrors.push({ sourceId: result.sourceId, validationErrors: valErrors });
            continue;
          }

          // Dedup check
          const hash = duplicateHash(city, activity.category, activity.title);
          const safeHash = hash.replace(/[.#$[\]]/g, '_');
          const hashSnap = await db.ref(`suggestionHashes/${safeHash}`).once('value');
          if (hashSnap.exists()) {
            suggestionsDeduplicated++;
            continue;
          }

          // Write draft suggestion
          const now          = Date.now();
          const suggestionId = makeId('sug');
          const logId        = makeId('log');

          const suggestion = {
            ...activity,
            city,
            district: null,
            status: 'draft',
            duplicateHash: safeHash,
            discoveredBy: 'discovery-pipeline',
            pipelineRunId: runId,
            researchedAt: now,
            researchedBy: 'discovery-pipeline',
            reviewedBy: null,
            reviewedAt: null,
            reviewNotes: null,
            activityId: null,
            createdAt: now,
            updatedAt: now,
          };

          await db.ref().update({
            [`suggestions/${suggestionId}`]: suggestion,
            [`suggestionHashes/${safeHash}`]: suggestionId,
            [`studioAuditLog/${logId}`]: {
              action: 'draft',
              actorUid: actor.uid,
              actorEmail: actor.email || null,
              actorRole: actor.studioRole,
              suggestionId,
              activityId: null,
              details: `Discovery draft: ${activity.title} (run: ${runId})`,
              timestamp: now,
            },
          });

          suggestionsSaved++;
          savedSuggestionIds.push(suggestionId);
        }
      }
    }

    const finishedAt = Date.now();
    const successCount = fetchResults.filter(r => r.ok).length;
    const errorCount   = fetchResults.filter(r => r.error).length;

    // Aggregate signal summary
    const signalSummary = {};
    for (const signalKey of Object.keys(SIGNAL_PATTERNS)) {
      signalSummary[signalKey] = fetchResults.filter(r => r.signals && r.signals[signalKey]?.detected).length;
    }

    // Cost estimate
    const estimatedCostUSD = mode === 'live'
      ? (totalInputTokens / 1_000_000) * PRICE_INPUT_PER_MTOK
        + (totalOutputTokens / 1_000_000) * PRICE_OUTPUT_PER_MTOK
      : 0;

    // Strip raw text from results before storing (keep signals + metadata)
    const sourceResults = fetchResults.map(({ text: _text, ...rest }) => rest);

    const report = {
      runId,
      city,
      mode,
      limits: { maxSources: MAX_SOURCES, maxSuggestions: MAX_SUGGESTIONS, maxLlmCalls: MAX_LLM_CALLS },
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      sourcesConsidered: allSources.length,
      sourcesFetched: sources.length,
      sourcesSkippedInactive,
      sourcesSkippedCityMismatch,
      successCount,
      errorCount,
      signalSummary,
      sourceResults,
      // LLM stats (zero in dry-run)
      llmCallsUsed,
      totalInputTokens,
      totalOutputTokens,
      estimatedCostUSD,
      suggestionsProposed,
      suggestionsSaved,
      suggestionsDeduplicated,
      savedSuggestionIds,
      llmErrors: llmErrors.length > 0 ? llmErrors : null,
      triggeredBy: actor.uid,
    };

    // Write report — only touches discoveryPipelineRuns/ and (in live) suggestions/
    await db.ref().update({ [`discoveryPipelineRuns/${runId}`]: report });

    return json(200, { ok: true, report });
  }

  return json(405, { error: 'Method Not Allowed' });
};

// ── Exported for testing ──────────────────────────────────────────────────────
exports._stripHtml              = stripHtml;
exports._condensePipelineText   = condensePipelineText;
exports._detectSignals          = detectSignals;
exports._fetchSource            = fetchSource;
exports._buildExtractionPrompt  = buildExtractionPrompt;
exports._extractJsonFromLLMResponse = extractJsonFromLLMResponse;
exports._callAnthropicAPI       = callAnthropicAPI;
exports._validateActivity       = validateActivity;
