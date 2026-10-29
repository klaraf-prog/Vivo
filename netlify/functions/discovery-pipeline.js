'use strict';
// Discovery pipeline — dry-run and live (LLM extraction) modes.
// POST: fetches up to MAX_SOURCES active sources for a city, detects structured
//       data signals via regex, and in live mode calls Claude Haiku to extract
//       activity suggestions (written as status:'draft', never auto-published).
//       Writes a run report to discoveryPipelineRuns/.
// GET:  returns the last 10 pipeline run reports.
// Env:  ANTHROPIC_API_KEY required for live mode (set in Netlify → Deploy previews scope).
const { initAdmin, verifyStudioToken, json, makeId, duplicateHash } = require('./_studio-shared');
const { CATEGORY_IDS, LEGACY_CATEGORY_IDS, ALL_TAGS_FLAT, validateTags, splitTags, validateAdditionalCategories } = require('./_taxonomy');

const MAX_SOURCES     = 5;
const MAX_SUGGESTIONS = 20;
const MAX_LLM_CALLS   = 10;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES   = 400_000;

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

// New v2 category IDs for LLM extraction (stable, German-language taxonomy)
const NEW_CATEGORY_IDS = [
  'food_drinks', 'kultur_entertainment', 'sport_bewegung',
  'kreativitaet_workshops', 'outdoor_natur', 'wellness_entspannung',
  'events_nightlife', 'community_social',
];

// Tool schema forces structured output — no JSON.parse needed.
const EXTRACTION_TOOL = {
  name: 'extract_activities',
  description: 'Extract individual activity/event listings from website text.',
  input_schema: {
    type: 'object',
    required: ['activities'],
    properties: {
      activities: {
        type: 'array',
        description: 'Each distinct activity as a separate entry. Empty array if none found.',
        items: {
          type: 'object',
          required: ['title', 'description', 'category'],
          properties: {
            title:             { type: 'string' },
            description:       { type: 'string' },
            category:          { type: 'string', enum: NEW_CATEGORY_IDS },
            tags: {
              anyOf: [
                { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Up to 5 known tag IDs from controlled vocabulary; unknown tags are stored for review.' },
                { type: 'null' },
              ],
            },
            additionalCategories: {
              anyOf: [
                { type: 'array', items: { type: 'string', enum: NEW_CATEGORY_IDS }, description: 'Optional further categories this activity fits into (besides the primary category).' },
                { type: 'null' },
              ],
            },
            tagline:           { type: ['string', 'null'] },
            eyebrow:           { type: ['string', 'null'] },
            providerName:      { type: ['string', 'null'] },
            website:           { type: ['string', 'null'] },
            price:             { type: ['string', 'null'] },
            openingHours:      { type: ['string', 'null'] },
            exceptionalHours:  { type: ['string', 'null'] },
            sourceAttribution: { type: ['string', 'null'] },
            location: {
              anyOf: [
                {
                  type: 'object', required: ['address'],
                  properties: {
                    address: {
                      type: 'string',
                      description: 'Specific venue name OR street address (Straße + Hausnummer, optional PLZ). NEVER set to just the city name. Null if only the city is known.',
                    },
                    venueName: {
                      type: ['string', 'null'],
                      description: 'Named venue or place, e.g. "Kölner Dom", "MediaPark", "Friesenplatz". Null if not mentioned or if address already contains the venue name.',
                    },
                  },
                  additionalProperties: false,
                },
                { type: 'null' },
              ],
            },
            operatingPeriod: {
              anyOf: [
                {
                  type: 'object', required: ['from', 'to'],
                  properties: { from: { type: 'string' }, to: { type: 'string' } },
                  additionalProperties: false,
                },
                { type: 'null' },
              ],
            },
            schedule: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    timezone: { type: ['string', 'null'], description: 'IANA timezone, e.g. "Europe/Berlin". Null if unknown.' },
                    dates: {
                      anyOf: [
                        {
                          type: 'array',
                          description: 'Specific single dates or date+time entries.',
                          items: {
                            type: 'object',
                            required: ['date'],
                            properties: {
                              date:      { type: 'string', description: 'ISO-8601 date YYYY-MM-DD' },
                              startTime: { type: ['string', 'null'], description: 'HH:MM in 24h format' },
                              endTime:   { type: ['string', 'null'] },
                              note:      { type: ['string', 'null'] },
                            },
                            additionalProperties: false,
                          },
                        },
                        { type: 'null' },
                      ],
                    },
                    period: {
                      anyOf: [
                        {
                          type: 'object',
                          required: ['from', 'to'],
                          description: 'Continuous period (e.g. a festival running start–end).',
                          properties: {
                            from: { type: 'string', description: 'ISO-8601 YYYY-MM-DD' },
                            to:   { type: 'string', description: 'ISO-8601 YYYY-MM-DD' },
                          },
                          additionalProperties: false,
                        },
                        { type: 'null' },
                      ],
                    },
                    regularHours: {
                      anyOf: [
                        {
                          type: 'array',
                          description: 'Weekly opening hours by day group.',
                          items: {
                            type: 'object',
                            required: ['days'],
                            properties: {
                              days:  { type: 'array', items: { type: 'string', enum: ['mo','di','mi','do','fr','sa','so'] } },
                              open:  { type: ['string', 'null'], description: 'HH:MM' },
                              close: { type: ['string', 'null'], description: 'HH:MM' },
                              note:  { type: ['string', 'null'] },
                            },
                            additionalProperties: false,
                          },
                        },
                        { type: 'null' },
                      ],
                    },
                    exceptions: {
                      anyOf: [
                        {
                          type: 'array',
                          description: 'Specific dates with deviating hours or closure.',
                          items: {
                            type: 'object',
                            required: ['date'],
                            properties: {
                              date:   { type: 'string', description: 'ISO-8601 YYYY-MM-DD' },
                              closed: { type: ['boolean', 'null'] },
                              open:   { type: ['string', 'null'], description: 'HH:MM' },
                              close:  { type: ['string', 'null'], description: 'HH:MM' },
                              note:   { type: ['string', 'null'] },
                            },
                            additionalProperties: false,
                          },
                        },
                        { type: 'null' },
                      ],
                    },
                    recurrence: {
                      anyOf: [
                        {
                          type: 'object',
                          required: ['pattern'],
                          description: 'Recurring event pattern (e.g. every Saturday at 15:00).',
                          properties: {
                            pattern:   { type: 'string', enum: ['weekly', 'biweekly', 'monthly', 'daily', 'other'] },
                            days:      { anyOf: [{ type: 'array', items: { type: 'string', enum: ['mo','di','mi','do','fr','sa','so'] } }, { type: 'null' }] },
                            startTime: { type: ['string', 'null'], description: 'HH:MM' },
                            endTime:   { type: ['string', 'null'], description: 'HH:MM' },
                            note:      { type: ['string', 'null'] },
                          },
                          additionalProperties: false,
                        },
                        { type: 'null' },
                      ],
                    },
                  },
                  additionalProperties: false,
                },
                { type: 'null' },
              ],
            },
          },
        },
      },
    },
  },
};

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
    // Remove entire head section
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    // Remove navigation-only chrome — NOT <header>/<footer> because they often wrap event content in HTML5
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    // Remove scripts and styles (JSON-LD + embedded data already extracted separately)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // Remove non-text blocks
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    // Remove all remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#?\w+;/g, ' ')
    // Remove only clearly CSS-specific patterns (braces, @-rules) — NOT generic "word: value;" which would destroy German event data
    .replace(/@[a-zA-Z-]+\s*[^;{]*\{[^}]*\}/g, ' ')
    .replace(/\{[^}]{0,200}\}/g, ' ')
    // Normalize whitespace
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Main content selection ────────────────────────────────────────────────────
// Prefer semantic landmark elements over the full document body to reduce noise.
// Falls back to full HTML when no semantic landmark is found or when the landmark
// content would be too short (suggesting the interesting content is elsewhere).
const MAIN_CONTENT_MIN_CHARS = 500;

function selectMainContent(html) {
  // Try <main> first, then [role="main"], then <article> as a narrower fallback
  const patterns = [
    /<main(?:\s[^>]*)?>([\s\S]*?)<\/main>/i,
    /<[a-z][^>]*\srole=["']main["'][^>]*>([\s\S]*?)<\/[a-z]+>/i,
    /<article(?:\s[^>]*)?>([\s\S]*?)<\/article>/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1].length >= MAIN_CONTENT_MIN_CHARS) {
      // Keep the outer tag removed but preserve inner HTML for further stripping
      return { html: m[1], selectedBy: re.source.slice(1, re.source.indexOf('(')) };
    }
  }
  return { html, selectedBy: 'full-document' };
}

// ── HTML structure diagnostics ────────────────────────────────────────────────
// Returns a lightweight report of what the HTML contains at each stripping stage.
// Pure read-only — no side effects on the pipeline data path.
function analyzeHtmlStructure(html) {
  const rawSize = html.length;

  // Step measurements
  const afterHead    = html.replace(/<head[\s\S]*?<\/head>/gi, '');
  const afterScripts = afterHead
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  const afterNav     = afterScripts.replace(/<nav[\s\S]*?<\/nav>/gi, '').replace(/<aside[\s\S]*?<\/aside>/gi, '');
  const stripped     = stripHtml(html);

  // Top-level tag inventory (first 15 distinct tag names by frequency)
  const tagFreq = {};
  for (const m of (html.match(/<([a-zA-Z][a-zA-Z0-9-]*)\b/g) || [])) {
    const tag = m.slice(1).toLowerCase();
    tagFreq[tag] = (tagFreq[tag] || 0) + 1;
  }
  const topTags = Object.entries(tagFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tag, n]) => `${tag}(${n})`);

  // Semantic landmark presence
  const hasMain        = /<main[\s> ]/i.test(html);
  const hasRoleMain    = /role=["']main["']/i.test(html);
  const hasArticle     = /<article[\s>]/i.test(html);
  const scriptTypes    = [...new Set(
    (html.match(/type=["']([^"']+)["']/gi) || []).map(t => t.replace(/type=["']/i, '').replace(/["']/, '').toLowerCase())
  )].slice(0, 10);

  // CSS text leak ratio in final stripped text
  const cssPatternCount = (stripped.match(/\b[a-z-]{3,30}\s*:\s*[^;\n]{3,80}\b/g) || []).length;
  const wordCount       = (stripped.match(/\b\w{3,}\b/g) || []).length;
  const cssRatio        = wordCount > 0 ? Math.round((cssPatternCount / wordCount) * 100) : 0;

  // Which semantic element was selected for extraction
  const { selectedBy } = selectMainContent(html);

  // Was the truncation boundary reached before </head>? (head spans full document)
  const headComplete = /<\/head>/i.test(html);

  // Does a <body> tag appear in the HTML? If not, we never reached page content.
  const bodyIdx = html.search(/<body[\s>]/i);
  const hasBody = bodyIdx >= 0;
  // What percentage through the document does <body> first appear?
  const bodyPositionPercent = hasBody && rawSize > 0 ? Math.round((bodyIdx / rawSize) * 100) : null;

  // Embedded JSON blob signals (before stripping removed them)
  const hasNextData   = /__NEXT_DATA__/.test(html);
  const hasNuxtData   = /__NUXT__|__NUXT_DATA__/.test(html);
  const hasJsonScript = /<script[^>]+type=["']application\/json["']/i.test(html);

  return {
    rawSizeChars:        rawSize,
    afterHeadChars:      afterHead.length,
    afterScriptsChars:   afterScripts.length,
    afterNavChars:       afterNav.length,
    strippedChars:       stripped.length,
    topTags,
    hasMain,
    hasRoleMain,
    hasArticle,
    scriptTypes,
    cssLeakPercent:      cssRatio,
    selectedBy,
    // Truncation diagnostics
    headComplete,        // false = </head> missing → we never got past <head>
    hasBody,             // false = <body> tag not found → content not reached
    bodyPositionPercent, // % through document where <body> starts (null if absent)
    // Embedded structured data signals
    hasNextData,
    hasNuxtData,
    hasJsonScript,
  };
}

// ── Embedded script data extraction ──────────────────────────────────────────
// For JS-rendered sites (Next.js, Nuxt.js etc.) actual event data may live in
// embedded JSON blobs that get deleted with <script> tags. Extract BEFORE stripping.

// Heuristic: does an object look like an event/listing item?
function looksLikeEventObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj).map(k => k.toLowerCase());
  const hasName = keys.some(k => k === 'name' || k === 'title' || k === 'titel' || k === 'headline');
  if (!hasName) return false;
  const hasEventField = keys.some(k =>
    k.includes('date') || k === 'datum' || k === 'begin' || k === 'beginn' || k === 'von' ||
    k === 'location' || k === 'ort' || k === 'venue' || k === 'veranstaltungsort' ||
    k === 'description' || k === 'beschreibung' || k === 'text' || k === 'inhalt'
  );
  return hasEventField;
}

// Recursively search a parsed JSON structure for arrays that look like event listings.
// counter.n limits total nodes visited to prevent runaway traversal on huge objects.
function findEventArraysInData(data, depth, counter) {
  if (!depth) depth = 0;
  if (!counter) counter = { n: 0 };
  counter.n++;
  if (depth > 8 || counter.n > 3000 || !data || typeof data !== 'object') return [];

  if (Array.isArray(data)) {
    if (data.length >= 2) {
      const sample = data.slice(0, 5);
      const eventLike = sample.filter(looksLikeEventObject);
      if (eventLike.length >= Math.max(1, Math.ceil(sample.length * 0.5))) {
        return [data.slice(0, 60)];
      }
    }
    for (const item of data.slice(0, 15)) {
      const found = findEventArraysInData(item, depth + 1, counter);
      if (found.length > 0) return found;
    }
    return [];
  }

  // Plain object: recurse into values, skipping known non-data keys
  const SKIP_KEYS = new Set([
    'html', '__html', 'css', 'src', 'href', 'className', 'style',
    'key', 'ref', 'children', 'type', 'buildId',
    'runtimeConfig', 'assetPrefix', 'isFallback',
  ]);
  for (const [key, val] of Object.entries(data)) {
    if (SKIP_KEYS.has(key) || typeof val !== 'object') continue;
    const found = findEventArraysInData(val, depth + 1, counter);
    if (found.length > 0) return found;
  }
  return [];
}

// Extract event-like arrays from embedded script tags (Next.js, Nuxt, generic JSON).
// Must be called on rawHtml BEFORE stripHtml removes <script> blocks.
function extractEmbeddedScriptData(html) {
  const results = [];

  // Next.js: <script id="__NEXT_DATA__" type="application/json">
  const nextMatch = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextMatch) {
    try {
      const arrays = findEventArraysInData(JSON.parse(nextMatch[1]));
      for (const arr of arrays) results.push({ source: 'next.js', events: arr });
    } catch {}
  }

  // Nuxt.js: window.__NUXT__={...} or __NUXT_DATA__=[...]
  const nuxtMatch = html.match(/(?:window\.__NUXT__|__NUXT_DATA__)\s*=\s*([\[{][\s\S]{200,}?[\]}])\s*;?\s*<\/script>/i);
  if (nuxtMatch && results.length < 3) {
    try {
      const arrays = findEventArraysInData(JSON.parse(nuxtMatch[1]));
      for (const arr of arrays) results.push({ source: 'nuxt.js', events: arr });
    } catch {}
  }

  // Generic: <script type="application/json"> (not JSON-LD)
  if (results.length < 3) {
    const re = /<script[^>]+type=["']application\/json["'](?![^>]*ld\+json)[^>]*>([\s\S]{50,}?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      try {
        const arrays = findEventArraysInData(JSON.parse(m[1]));
        for (const arr of arrays) results.push({ source: 'json-script', events: arr });
        if (results.length >= 3) break;
      } catch {}
    }
  }

  return results; // [{source, events: [...]}]
}

// Format embedded event arrays as readable lines for the LLM prompt.
function formatEmbeddedEventsForPrompt(embeddedArrays, maxEvents) {
  if (!maxEvents) maxEvents = 30;
  const lines = [];
  for (const { events } of embeddedArrays) {
    for (const e of events) {
      if (lines.length >= maxEvents) break;
      const parts = [];
      const name = e.name || e.title || e.titel || e.headline;
      if (name) parts.push(`Name: ${String(name).slice(0, 120)}`);
      const desc = e.description || e.beschreibung || e.text || e.inhalt || e.kurztext;
      if (desc) parts.push(`Beschreibung: ${String(desc).slice(0, 200)}`);
      const start = e.startDate || e.start_date || e.date || e.datum || e.begin || e.beginn || e.von || e.startdate;
      if (start) parts.push(`Beginn: ${String(start).slice(0, 30)}`);
      const end = e.endDate || e.end_date || e.bis || e.end || e.enddate;
      if (end) parts.push(`Ende: ${String(end).slice(0, 30)}`);
      const loc = e.location || e.ort || e.venue || e.veranstaltungsort;
      if (loc) {
        const locStr = typeof loc === 'string' ? loc : (loc.name || loc.address || loc.adresse || '');
        if (locStr) parts.push(`Ort: ${String(locStr).slice(0, 120)}`);
      }
      const url = e.url || e.link || e.detailUrl || e.detailurl;
      if (url && /^https?:\/\//.test(url)) parts.push(`URL: ${String(url).slice(0, 200)}`);
      if (parts.length >= 2) lines.push(parts.join(' | '));
    }
  }
  return lines.join('\n');
}

// ── JSON-LD extraction ────────────────────────────────────────────────────────
// Extracts structured event/place data from <script type="application/ld+json"> blocks.
// Returns an array of JSON-LD items; invalid blocks are silently skipped.
function extractJsonLd(html) {
  const items = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]);
      // Handle both single objects and @graph arrays
      const nodes = parsed['@graph'] ? parsed['@graph'] : [parsed];
      for (const node of nodes) {
        if (node && typeof node === 'object') items.push(node);
      }
    } catch {
      // Skip malformed JSON-LD
    }
  }
  return items;
}

// Returns those JSON-LD items that are schema.org Event (or subtype).
function filterJsonLdEvents(items) {
  const EVENT_TYPES = new Set([
    'Event', 'SocialEvent', 'Festival', 'MusicEvent', 'SportsEvent',
    'ExhibitionEvent', 'TheaterEvent', 'ScreeningEvent', 'ChildrensEvent',
    'ComedyEvent', 'DanceEvent', 'FoodEvent', 'LiteraryEvent', 'SaleEvent',
  ]);
  return items.filter(item => {
    const type = item['@type'];
    if (typeof type === 'string') return EVENT_TYPES.has(type);
    if (Array.isArray(type)) return type.some(t => EVENT_TYPES.has(t));
    return false;
  });
}

// Formats JSON-LD events as readable text for the LLM prompt.
function formatJsonLdEventsForPrompt(events, maxEvents = 30) {
  return events.slice(0, maxEvents).map(e => {
    const parts = [];
    if (e.name) parts.push(`Name: ${e.name}`);
    if (e.description) parts.push(`Beschreibung: ${String(e.description).slice(0, 300)}`);
    if (e.startDate) parts.push(`Beginn: ${e.startDate}`);
    if (e.endDate) parts.push(`Ende: ${e.endDate}`);
    const loc = e.location;
    if (loc) {
      const addr = loc.address;
      if (addr) {
        const addrStr = typeof addr === 'string' ? addr
          : [addr.streetAddress, addr.postalCode, addr.addressLocality].filter(Boolean).join(', ');
        if (addrStr) parts.push(`Ort: ${addrStr}`);
      } else if (loc.name) {
        parts.push(`Ort: ${loc.name}`);
      }
    }
    if (e.offers) {
      const offer = Array.isArray(e.offers) ? e.offers[0] : e.offers;
      if (offer?.price != null) parts.push(`Preis: ${offer.price}${offer.priceCurrency ? ' ' + offer.priceCurrency : ''}`);
      else if (offer?.name) parts.push(`Preis: ${offer.name}`);
    }
    if (e.url) parts.push(`URL: ${e.url}`);
    if (e.organizer) {
      const org = Array.isArray(e.organizer) ? e.organizer[0] : e.organizer;
      if (org?.name) parts.push(`Veranstalter: ${org.name}`);
    }
    return parts.join(' | ');
  }).filter(Boolean).join('\n');
}

// ── Content quality assessment ────────────────────────────────────────────────
// Detects if the stripped text is mostly CSS/navigation instead of real content.
// Returns { skip: bool, issues: string[], hasEventKeywords: bool }
function assessContentQuality(text, jsonLdEventCount) {
  const issues = [];

  // CSS leak: many property:value; patterns remaining after stripHtml
  const cssPatternCount = (text.match(/\b[a-z-]{3,30}\s*:\s*[^;\n]{3,80}\b/g) || []).length;
  const wordCount = (text.match(/\b\w{3,}\b/g) || []).length;
  const cssRatio = wordCount > 0 ? cssPatternCount / wordCount : 0;
  if (cssRatio > 0.15) issues.push(`CSS leak: ${Math.round(cssRatio * 100)}% of tokens look like CSS (${cssPatternCount} patterns)`);

  // Navigation-heavy: many short lines / list items, few sentences
  const sentenceCount = (text.match(/[.!?]\s/g) || []).length;
  if (wordCount > 200 && sentenceCount < 5) issues.push(`Navigation-heavy: ${sentenceCount} sentences in ${wordCount} words`);

  // Very short after stripping
  if (text.length < 200) issues.push(`Very short text: ${text.length} chars after stripping`);

  // Event keywords — a positive signal (no \b: German compound words like "Weihnachtsmarkt" contain these)
  const eventKeywords = /(markt|weihnacht|advent|festival|konzert|ausstellung|veranstaltung|event|messe|theater|museum|ticket|eintrittspreis|öffnungszeit|öffnet|geöffnet)/i;
  const hasEventKeywords = eventKeywords.test(text);

  // Skip LLM if content is clearly CSS/nav or extremely short AND no JSON-LD events AND no event keywords
  const skip = (issues.length > 0 && !hasEventKeywords && jsonLdEventCount === 0)
    || (text.length < 200 && !hasEventKeywords && jsonLdEventCount === 0);

  return { skip, issues, hasEventKeywords };
}

// ── Text condensing ───────────────────────────────────────────────────────────
// Removes navigation noise before LLM extraction.
// Deduplicates repeated short fragments (nav links, breadcrumbs, footer items).
// NOTE: no leading-skip — selectMainContent already scopes to main content,
//       so the first fragment IS the first event on an overview page.
function condensePipelineText(text, limit) {
  // Split into rough phrases at double-space boundaries or after sentence punctuation.
  // Using \n as separator preserves block structure (event cards, sections).
  const fragments = text.split(/\s{2,}|(?<=[.!?])\s+/);

  // Count occurrences of each short fragment (case-insensitive key).
  const counts = new Map();
  for (const f of fragments) {
    const key = f.trim().toLowerCase();
    if (key.length > 0 && key.length <= 60) counts.set(key, (counts.get(key) || 0) + 1);
  }

  // Keep a fragment if:
  //   - it is long (> 60 chars) — almost certainly real content
  //   - it appears at most 3 times — allows repeated dates/locations across a few events
  //     without keeping global nav items that repeat dozens of times
  const t = fragments
    .filter(f => {
      const trimmed = f.trim();
      if (trimmed.length === 0) return false;
      if (trimmed.length > 60) return true;
      return (counts.get(trimmed.toLowerCase()) || 0) <= 3;
    })
    .join('\n');

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
    const rawHtml = chunks.map(c => decoder.decode(c, { stream: true })).join('') + decoder.decode();

    // Extract structured data from rawHtml BEFORE stripping removes <script> blocks
    const jsonLdItems       = extractJsonLd(rawHtml);
    const jsonLdEvents      = filterJsonLdEvents(jsonLdItems);
    const embeddedScriptData = extractEmbeddedScriptData(rawHtml);

    // HTML structure diagnostics (lightweight, no side effects)
    const htmlDiagnostics = analyzeHtmlStructure(rawHtml);

    // Prefer semantic main content area over full document when available
    const { html: mainHtml, selectedBy: contentSelectedBy } = selectMainContent(rawHtml);
    const text = stripHtml(mainHtml);
    const signals = detectSignals(text);
    const detectedCount = Object.values(signals).filter(s => s.detected).length;
    const contentQuality = assessContentQuality(text, jsonLdEvents.length);
    // Preview of what would be sent to the LLM — available in both dry-run and live mode
    const condensedPreview = condensePipelineText(text, LLM_TEXT_LIMIT).slice(0, 800);

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
      jsonLdItems,             // all JSON-LD items (for LLM); stripped before report storage
      jsonLdEvents,            // schema.org Event items only; stripped before report storage
      embeddedScriptData,      // event arrays from __NEXT_DATA__ etc.; stripped before storage
      embeddedScriptEventCount: embeddedScriptData.reduce((n, g) => n + g.events.length, 0),
      embeddedScriptSources: embeddedScriptData.map(g => g.source),
      condensedPreview,        // first 800 chars of condensed text — kept in report for diagnostics
      jsonLdItemCount: jsonLdItems.length,
      jsonLdEventCount: jsonLdEvents.length,
      // First 3 events as a diagnostic sample (names only, no personal data)
      jsonLdEventSample: jsonLdEvents.slice(0, 3).map(e => ({
        name: e.name || null,
        startDate: e.startDate || null,
        endDate: e.endDate || null,
      })),
      contentQuality,          // { skip, issues, hasEventKeywords }
      htmlDiagnostics,         // structural analysis: step sizes, tag inventory, semantic elements
      contentSelectedBy,       // which selector chose the extraction scope
      // Truncation and content-reach summary for dry-run visibility
      truncationDiag: {
        wasTruncated:    truncated,
        limitKB:         Math.round(MAX_BODY_BYTES / 1000),
        fetchedKB:       Math.round(totalBytes / 1000),
        headComplete:    htmlDiagnostics.headComplete,
        bodyFound:       htmlDiagnostics.hasBody,
        bodyPositionPct: htmlDiagnostics.bodyPositionPercent,
        hasNextData:     htmlDiagnostics.hasNextData,
        hasNuxtData:     htmlDiagnostics.hasNuxtData,
        hasJsonScript:   htmlDiagnostics.hasJsonScript,
        jsonLdEvents:    jsonLdEvents.length,
        embeddedEvents:  embeddedScriptData.reduce((n, g) => n + g.events.length, 0),
      },
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

// ── Few-shot example loading and similarity scoring ────────────────────────────
const FEW_SHOT_MAX       = 5;    // max reference examples per LLM call
const FEW_SHOT_MIN_SCORE = 2;    // min relevance score; 0 = not included
const FEW_SHOT_MAX_LOAD  = 100;  // max published activities to load per run

/**
 * Load published activities as potential few-shot reference examples.
 * Only `status === 'published'` entries are used — the only reliable editorial
 * confirmation signal in the current data model (suggestions stay 'draft').
 * Returns lightweight objects: { id, title, category, additionalCategories, tags }.
 */
async function loadPublishedExamples(db, city) {
  const snap = await db.ref('activities').once('value');
  const examples = [];
  snap.forEach(child => {
    if (examples.length >= FEW_SHOT_MAX_LOAD) return;
    const a = child.val();
    if (!a || a.status !== 'published') return;
    if (a.city !== city) return;
    if (!a.category) return;
    examples.push({
      id: child.key,
      title: a.title || '',
      category: a.category,
      additionalCategories: Array.isArray(a.additionalCategories) && a.additionalCategories.length > 0
        ? a.additionalCategories : null,
      tags: Array.isArray(a.tags) && a.tags.length > 0 ? a.tags : null,
    });
  });
  return examples;
}

/**
 * Extract a normalised set of hint words from a source's name and condensed text.
 * Returns a Set of lowercase tokens (3+ chars) augmented with any matching tag IDs.
 * Tag IDs are added when all their parts appear in the text (e.g. 'weihnachtsmarkt').
 */
function extractSourceHintWords(sourceName, condensedText) {
  const combined = ((sourceName || '') + ' ' + (condensedText || '')).toLowerCase();
  const words = new Set((combined.match(/\b[a-zäöüß]{3,}\b/g) || []));
  // Add matching tag IDs as synthetic tokens so score() can match them directly
  for (const tag of ALL_TAGS_FLAT) {
    const parts = tag.split('_').filter(p => p.length >= 3);
    if (parts.length > 0 && parts.every(p => words.has(p) || combined.includes(p))) {
      words.add(tag);
    }
  }
  return words;
}

/**
 * Score how relevant a published example is to a source's hint word set.
 * Scoring (higher = more relevant):
 *   +3  exact tag ID match in hintWords
 *   +1  per 3+ char tag-part match in hintWords
 *   +2  per 4+ char title-word overlap
 */
function scoreExampleRelevance(example, hintWords) {
  let score = 0;
  if (example.tags) {
    for (const tag of example.tags) {
      if (hintWords.has(tag)) {
        score += 3;
      } else {
        for (const part of tag.split('_')) {
          if (part.length >= 3 && hintWords.has(part)) score += 1;
        }
      }
    }
  }
  const titleWords = (example.title || '').toLowerCase().match(/\b[a-zäöüß]{4,}\b/g) || [];
  for (const w of titleWords) {
    if (hintWords.has(w)) score += 2;
  }
  return score;
}

/**
 * Select the most relevant few-shot examples for one source.
 * Returns up to FEW_SHOT_MAX examples scoring >= FEW_SHOT_MIN_SCORE.
 * Returns empty array when no examples are relevant enough (pipeline runs without them).
 */
function selectFewShotExamples(allExamples, hintWords) {
  if (!allExamples || allExamples.length === 0) return [];
  return allExamples
    .map(ex => ({ ex, score: scoreExampleRelevance(ex, hintWords) }))
    .filter(({ score }) => score >= FEW_SHOT_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, FEW_SHOT_MAX)
    .map(({ ex }) => ex);
}

/**
 * Format few-shot examples as a prompt section (appended to the system prompt).
 * Deliberately excludes price, dates, location, coordinates.
 */
function formatFewShotSection(examples) {
  if (!examples || examples.length === 0) return '';
  const lines = examples.map(ex => {
    const parts = [`"${ex.title}"`];
    parts.push(`category: ${ex.category}`);
    if (ex.additionalCategories) parts.push(`additionalCategories: [${ex.additionalCategories.join(', ')}]`);
    if (ex.tags) parts.push(`tags: [${ex.tags.join(', ')}]`);
    return '• ' + parts.join(' → ');
  });
  return `

--- EDITORIALLY CONFIRMED REFERENCE EXAMPLES ---
The following activities were reviewed and categorised by editors. Use them as guidance
for category and tag selection for the activities you extract from the page below.
IMPORTANT: Do NOT copy prices, dates, opening hours, addresses or coordinates from these examples.
Decide independently based on the actual source text — treat these as style guidance, not templates.

${lines.join('\n')}
--- END REFERENCE EXAMPLES ---`;
}

// ── LLM extraction prompt ─────────────────────────────────────────────────────
function buildExtractionPrompt(text, city, jsonLdEvents, embeddedScriptData, fewShotExamples) {
  const condensed = condensePipelineText(text, LLM_TEXT_LIMIT);
  const system = `You extract individual activity and event listings from website content for the city of ${city}.

This is typically an overview page listing MULTIPLE distinct events. Extract every individual event you can identify.

Rules:
- Extract EACH distinct activity as a SEPARATE entry in the activities array. Do not combine multiple events.
- Each entry must be SELF-CONTAINED: only fill a field from data explicitly stated for that specific activity. Never copy data between entries, even if the data looks similar.
- Only include activities clearly located in or associated with ${city}.
- NEVER invent, guess or infer data. Use null for unknown fields.
- Do not include lat/lng coordinates.
- Dates must be ISO-8601 (YYYY-MM-DD). For month+year only, use the first day of the from-month and last day of the to-month.
- Ignore navigation menus, cookie notices, breadcrumbs and footer content.
- Maximum ${MAX_SUGGESTIONS} activities.

location field — fill only when a specific location is mentioned beyond the city:
- location.address: the most specific address available — street address (Straße + Hausnummer), named square (Platz), or venue name. NEVER set to just the city ("Köln") — leave location null if only the city is known.
- location.venueName: named venue separate from the street address, e.g. "Kölner Dom", "Rheinauhafen", "MediaPark", "Friesenplatz". Null if not mentioned or already in address.
- Examples: {"address": "Hansaring 97, 50670 Köln", "venueName": "Alte Kantine"}, {"address": "Friesenplatz, Köln", "venueName": null}, {"address": "Domkloster 4", "venueName": "Kölner Dom"}.
- If no specific location is stated beyond the city, set location to null.

schedule field — populate when temporal data is explicitly stated for the specific activity:
- dates: one or more concrete dates (ISO-8601), with optional HH:MM start/end times.
- period: a continuous date range (festival, exhibition running from–to).
- regularHours: recurring weekly opening hours per day group (days as ['mo','di',…], open/close as HH:MM).
- exceptions: specific dates with deviating hours or closure (e.g. closed on 25.12.).
- recurrence: a repeating event pattern (weekly/biweekly/monthly/daily/other) with optional days and time.
- timezone: IANA name (e.g. "Europe/Berlin") — use only when explicitly stated, otherwise null.
All schedule sub-fields are optional and default to null. Leave schedule null when no temporal data is available for an activity.` + formatFewShotSection(fewShotExamples);

  // Prioritise structured data sections — include both JSON-LD and embedded JS data
  const jsonLdSection = (jsonLdEvents && jsonLdEvents.length > 0)
    ? `\n\n--- STRUCTURED EVENT DATA (JSON-LD schema.org, high confidence) ---\n${formatJsonLdEventsForPrompt(jsonLdEvents)}\n--- END JSON-LD ---`
    : '';

  const embeddedText = embeddedScriptData && embeddedScriptData.length > 0
    ? formatEmbeddedEventsForPrompt(embeddedScriptData)
    : '';
  const embeddedSection = embeddedText
    ? `\n\n--- EMBEDDED PAGE DATA (JavaScript data layer, high confidence) ---\n${embeddedText}\n--- END EMBEDDED DATA ---`
    : '';

  const structuredSections = jsonLdSection + embeddedSection;
  const user = `Extract all individual activities from the following website content.${structuredSections}\n\nWebsite text:\n\n${condensed}`;

  const condensedPreview = condensed.slice(0, 800);
  return { system, user, condensedPreview };
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
async function callAnthropicAPI(text, city, apiKey, jsonLdEvents, embeddedScriptData, fewShotExamples) {
  const { system, user, condensedPreview } = buildExtractionPrompt(text, city, jsonLdEvents, embeddedScriptData, fewShotExamples);
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
        max_tokens: 4096,
        tools: [EXTRACTION_TOOL],
        tool_choice: { type: 'tool', name: 'extract_activities' },
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return { activities: [], inputTokens: 0, outputTokens: 0, condensedPreview, error: `Anthropic HTTP ${res.status}: ${errBody.slice(0, 200)}` };
    }

    const data = await res.json();
    const inputTokens  = data.usage?.input_tokens  || 0;
    const outputTokens = data.usage?.output_tokens || 0;

    // Truncation check — must be before content inspection
    if (data.stop_reason === 'max_tokens') {
      return { activities: [], inputTokens, outputTokens, condensedPreview, error: 'Response truncated (stop_reason: max_tokens). Raise max_tokens or reduce LLM_TEXT_LIMIT.' };
    }

    // Tool use response: the Anthropic API guarantees valid JSON in toolBlock.input
    const toolBlock = data.content?.find(b => b.type === 'tool_use' && b.name === 'extract_activities');
    if (!toolBlock) {
      const stopInfo = data.stop_reason ? ` stop_reason: ${data.stop_reason}` : '';
      return { activities: [], inputTokens, outputTokens, condensedPreview, error: `No extract_activities tool_use block in response.${stopInfo}` };
    }

    const activities = toolBlock.input?.activities;
    if (!Array.isArray(activities)) {
      return { activities: [], inputTokens, outputTokens, condensedPreview, error: 'Tool response missing activities array' };
    }

    return { activities, inputTokens, outputTokens, condensedPreview, error: null };
  } catch (err) {
    clearTimeout(timer);
    const msg = err.name === 'AbortError' ? `LLM timeout after ${LLM_TIMEOUT_MS}ms` : String(err.message || err);
    return { activities: [], inputTokens: 0, outputTokens: 0, condensedPreview, error: msg };
  }
}

// ── Schedule validation ───────────────────────────────────────────────────────
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE     = /^\d{2}:\d{2}$/;
const VALID_DAYS  = new Set(['mo','di','mi','do','fr','sa','so']);
const VALID_RECURRENCE_PATTERNS = new Set(['weekly','biweekly','monthly','daily','other']);

function isIsoDate(v)  { return typeof v === 'string' && ISO_DATE_RE.test(v); }
function isHhmm(v)     { return typeof v === 'string' && TIME_RE.test(v); }
function strOrNull(v, max) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, max);
  return s.length > 0 ? s : null;
}

function validateSchedule(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const result = {};

  // timezone
  const tz = strOrNull(raw.timezone, 60);
  if (tz) result.timezone = tz;

  // dates — array of { date, startTime?, endTime?, note? }
  if (Array.isArray(raw.dates)) {
    const dates = raw.dates
      .filter(d => d && typeof d === 'object' && isIsoDate(d.date))
      .map(d => {
        const entry = { date: d.date };
        if (isHhmm(d.startTime)) entry.startTime = d.startTime;
        if (isHhmm(d.endTime))   entry.endTime   = d.endTime;
        const note = strOrNull(d.note, 200);
        if (note) entry.note = note;
        return entry;
      });
    if (dates.length > 0) result.dates = dates.slice(0, 50);
  }

  // period — { from: YYYY-MM-DD, to: YYYY-MM-DD }
  if (raw.period && typeof raw.period === 'object' && isIsoDate(raw.period.from) && isIsoDate(raw.period.to)) {
    result.period = { from: raw.period.from, to: raw.period.to };
  }

  // regularHours — array of { days: string[], open?, close?, note? }
  if (Array.isArray(raw.regularHours)) {
    const hours = raw.regularHours
      .filter(h => h && typeof h === 'object' && Array.isArray(h.days) && h.days.length > 0)
      .map(h => {
        const days = h.days.filter(d => VALID_DAYS.has(d));
        if (days.length === 0) return null;
        const entry = { days };
        if (isHhmm(h.open))  entry.open  = h.open;
        if (isHhmm(h.close)) entry.close = h.close;
        const note = strOrNull(h.note, 200);
        if (note) entry.note = note;
        return entry;
      })
      .filter(Boolean);
    if (hours.length > 0) result.regularHours = hours.slice(0, 20);
  }

  // exceptions — array of { date, closed?, open?, close?, note? }
  if (Array.isArray(raw.exceptions)) {
    const excs = raw.exceptions
      .filter(e => e && typeof e === 'object' && isIsoDate(e.date))
      .map(e => {
        const entry = { date: e.date };
        if (typeof e.closed === 'boolean') entry.closed = e.closed;
        if (isHhmm(e.open))  entry.open  = e.open;
        if (isHhmm(e.close)) entry.close = e.close;
        const note = strOrNull(e.note, 200);
        if (note) entry.note = note;
        return entry;
      });
    if (excs.length > 0) result.exceptions = excs.slice(0, 30);
  }

  // recurrence — { pattern, days?, startTime?, endTime?, note? }
  if (raw.recurrence && typeof raw.recurrence === 'object' && VALID_RECURRENCE_PATTERNS.has(raw.recurrence.pattern)) {
    const rec = { pattern: raw.recurrence.pattern };
    if (Array.isArray(raw.recurrence.days)) {
      const days = raw.recurrence.days.filter(d => VALID_DAYS.has(d));
      if (days.length > 0) rec.days = days;
    }
    if (isHhmm(raw.recurrence.startTime)) rec.startTime = raw.recurrence.startTime;
    if (isHhmm(raw.recurrence.endTime))   rec.endTime   = raw.recurrence.endTime;
    const note = strOrNull(raw.recurrence.note, 200);
    if (note) rec.note = note;
    result.recurrence = rec;
  }

  // Return null when nothing meaningful was extracted
  return Object.keys(result).length > 0 ? result : null;
}

// ── Activity validation ───────────────────────────────────────────────────────
function validateActivity(raw, sourceUrl, sourceName) {
  const errors = [];

  if (!raw || typeof raw !== 'object') return { valid: false, errors: ['not an object'] };

  // Required fields
  if (!raw.title || typeof raw.title !== 'string' || raw.title.trim().length === 0) errors.push('title missing');
  if (!raw.description || typeof raw.description !== 'string' || raw.description.trim().length === 0) errors.push('description missing');
  if (!raw.category || (!CATEGORY_IDS.has(raw.category) && !LEGACY_CATEGORY_IDS.has(raw.category))) errors.push(`invalid category: ${raw.category}`);

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
    if (typeof raw.location.venueName === 'string' && raw.location.venueName.trim()) {
      location.venueName = raw.location.venueName.trim().slice(0, 200);
    }
  }

  // operatingPeriod: { from: YYYY-MM-DD, to: YYYY-MM-DD } or null
  let operatingPeriod = null;
  if (raw.operatingPeriod && typeof raw.operatingPeriod === 'object') {
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    if (ISO_DATE.test(raw.operatingPeriod.from) && ISO_DATE.test(raw.operatingPeriod.to)) {
      operatingPeriod = { from: raw.operatingPeriod.from, to: raw.operatingPeriod.to };
    }
  }

  // schedule: structured temporal data
  const schedule = validateSchedule(raw.schedule);

  // Backward-compat: derive operatingPeriod from schedule.period when not already set
  if (!operatingPeriod && schedule?.period) {
    operatingPeriod = { from: schedule.period.from, to: schedule.period.to };
  }

  // Track what the LLM could not determine
  const missingFields = [];
  if (!location) missingFields.push('location');
  if (!operatingPeriod) missingFields.push('operatingPeriod');
  if (!price) missingFields.push('price');
  if (!website) missingFields.push('website');
  if (!providerName) missingFields.push('providerName');

  const tagSplit = splitTags(raw.tags || []);
  const additionalCategories = validateAdditionalCategories(raw.additionalCategories || [], category);

  const activity = {
    title,
    tagline,
    description,
    category,
    tags: tagSplit.valid.length > 0 ? tagSplit.valid : null,
    unknownTagSuggestions: tagSplit.unknown.length > 0 ? tagSplit.unknown : null,
    additionalCategories: additionalCategories.length > 0 ? additionalCategories : null,
    eyebrow,
    location,
    lat: null,
    lng: null,
    geoQuality: 'missing',
    providerName,
    website,
    instagram: null,
    price,
    schedule,
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
    let sourcesSkippedInactive     = 0;
    let sourcesSkippedCityMismatch = 0;
    let sourcesSkippedDuplicateUrl = 0;
    const seenUrls = new Set();
    sourcesSnap.forEach(child => {
      const s = child.val();
      if (!s.active) { sourcesSkippedInactive++; return; }
      if (s.city?.trim() !== city) { sourcesSkippedCityMismatch++; return; }
      if (seenUrls.has(s.url)) { sourcesSkippedDuplicateUrl++; return; }
      seenUrls.add(s.url);
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

    // Load published activities once for few-shot reference selection (non-fatal)
    let publishedExamples = [];
    if (mode === 'live') {
      try {
        publishedExamples = await loadPublishedExamples(db, city);
      } catch (err) {
        // Non-fatal: pipeline continues without few-shot examples
        llmErrors.push({ phase: 'few-shot-load', error: String(err.message || err) });
      }
    }

    if (mode === 'live') {
      for (const result of fetchResults) {
        if (!result.ok || !result.text) continue;
        if (llmCallsUsed >= MAX_LLM_CALLS) break;
        if (suggestionsSaved >= MAX_SUGGESTIONS) break;

        // Skip LLM if content quality is poor and there are no JSON-LD events
        if (result.contentQuality?.skip) {
          result.llmSkipped = true;
          result.llmSkipReason = result.contentQuality.issues.join('; ');
          continue;
        }

        // Select relevant few-shot examples for this source
        const hintWords = extractSourceHintWords(result.name, result.condensedPreview);
        const fewShotExamples = selectFewShotExamples(publishedExamples, hintWords);
        result.fewShotExampleIds    = fewShotExamples.map(e => e.id);
        result.fewShotExampleCount  = fewShotExamples.length;

        llmCallsUsed++;
        const { activities, inputTokens, outputTokens, condensedPreview, error } = await callAnthropicAPI(result.text, city, apiKey, result.jsonLdEvents, result.embeddedScriptData, fewShotExamples);
        totalInputTokens  += inputTokens;
        totalOutputTokens += outputTokens;

        // Per-source diagnostic stats (stored in result, stripped of 'text' before saving)
        result.llmActivitiesFound     = activities.length;
        result.llmActivitiesRejected  = 0;
        result.llmActivitiesDeduplicated = 0;
        result.llmActivitiesSaved     = 0;
        result.llmError               = error || null;
        result.condensedPreview       = condensedPreview || null;

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
            result.llmActivitiesRejected++;
            continue;
          }

          // Dedup check
          const hash = duplicateHash(city, activity.category, activity.title);
          const safeHash = hash.replace(/[.#$[\]]/g, '_');
          const hashSnap = await db.ref(`suggestionHashes/${safeHash}`).once('value');
          if (hashSnap.exists()) {
            suggestionsDeduplicated++;
            result.llmActivitiesDeduplicated++;
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
            fewShotExampleIds: fewShotExamples.length > 0 ? fewShotExamples.map(e => e.id) : null,
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
          result.llmActivitiesSaved++;
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

    // Strip raw data arrays from results before storing (counts/samples are kept)
    const sourceResults = fetchResults.map(({ text: _t, jsonLdItems: _i, jsonLdEvents: _e, embeddedScriptData: _s, ...rest }) => rest);

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
      sourcesSkippedDuplicateUrl,
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
      fewShotExamplesLoaded: publishedExamples.length,
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
exports._selectMainContent      = selectMainContent;
exports._analyzeHtmlStructure   = analyzeHtmlStructure;
exports._condensePipelineText   = condensePipelineText;
exports._detectSignals          = detectSignals;
exports._extractJsonLd               = extractJsonLd;
exports._filterJsonLdEvents          = filterJsonLdEvents;
exports._formatJsonLdEventsForPrompt = formatJsonLdEventsForPrompt;
exports._assessContentQuality        = assessContentQuality;
exports._looksLikeEventObject        = looksLikeEventObject;
exports._findEventArraysInData       = findEventArraysInData;
exports._extractEmbeddedScriptData   = extractEmbeddedScriptData;
exports._formatEmbeddedEventsForPrompt = formatEmbeddedEventsForPrompt;
exports._fetchSource            = fetchSource;
exports._buildExtractionPrompt  = buildExtractionPrompt;
exports._extractJsonFromLLMResponse = extractJsonFromLLMResponse;
exports._callAnthropicAPI       = callAnthropicAPI;
exports._validateActivity       = validateActivity;
exports._validateSchedule       = validateSchedule;
exports._loadPublishedExamples      = loadPublishedExamples;
exports._extractSourceHintWords     = extractSourceHintWords;
exports._scoreExampleRelevance      = scoreExampleRelevance;
exports._selectFewShotExamples      = selectFewShotExamples;
exports._formatFewShotSection       = formatFewShotSection;
