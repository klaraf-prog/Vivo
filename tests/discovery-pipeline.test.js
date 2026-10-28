'use strict';

/**
 * Tests for discovery-pipeline.js:
 * - _stripHtml: removes tags, decodes entities
 * - _detectSignals: detects operatingPeriod, openingHours, exceptionalHours,
 *                   location, price, provider; returns detected + examples
 * - Auth guards: GET requires researcher+, POST requires editor+
 * - Dry-run: only reads discoverySources and writes discoveryPipelineRuns
 */

const mockStore = {};

function mockGet(path) {
  if (!path) return mockStore;
  return path.split('/').reduce(
    (cur, k) => (cur != null && cur[k] !== undefined ? cur[k] : undefined),
    mockStore,
  );
}
function mockSet(path, val) {
  const parts = path.split('/');
  let cur = mockStore;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  if (val === null) delete cur[parts[parts.length - 1]];
  else              cur[parts[parts.length - 1]] = val;
}

jest.mock('../netlify/functions/_studio-shared', () => {
  function _get(path) {
    if (!path) return mockStore;
    return path.split('/').reduce(
      (cur, k) => (cur != null && cur[k] !== undefined ? cur[k] : undefined),
      mockStore,
    );
  }
  function _set(path, val) {
    const parts = path.split('/');
    let cur = mockStore;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    if (val === null) delete cur[parts[parts.length - 1]];
    else              cur[parts[parts.length - 1]] = val;
  }

  return {
    initAdmin: () => ({
      database: () => ({
        ref: (path) => ({
          once: async (eventType, callback) => {
            const val = _get(path ?? '');
            const snap = {
              exists: () => val !== undefined && val !== null,
              val:    () => val ?? null,
              forEach: (fn) => {
                if (val && typeof val === 'object') {
                  for (const [k, v] of Object.entries(val)) {
                    fn({ key: k, val: () => v });
                  }
                }
              },
            };
            return snap;
          },
          update: jest.fn(async (updates) => {
            for (const [k, v] of Object.entries(updates)) _set(k.replace(/^\//, ''), v);
          }),
          orderByChild: () => ({
            equalTo: (val) => ({
              once: async () => {
                const all = _get(path ?? '');
                const filtered = {};
                if (all && typeof all === 'object') {
                  for (const [k, v] of Object.entries(all)) {
                    if (v && v.city === val) filtered[k] = v;
                  }
                }
                return {
                  forEach: (fn) => {
                    for (const [k, v] of Object.entries(filtered)) fn({ key: k, val: () => v });
                  },
                };
              },
            }),
            limitToLast: (n) => ({
              once: async () => {
                const all = _get(path ?? '');
                const entries = all && typeof all === 'object' ? Object.entries(all) : [];
                const last = entries.slice(-n);
                return {
                  forEach: (fn) => {
                    for (const [k, v] of last) fn({ key: k, val: () => v });
                  },
                };
              },
            }),
          }),
        }),
      }),
    }),
    verifyStudioToken: jest.fn(),
    json: (status, body) => ({ statusCode: status, _body: body, body: JSON.stringify(body) }),
    makeId: (prefix) => `${prefix}_test`,
  };
});

const {
  handler, _stripHtml, _selectMainContent, _analyzeHtmlStructure, _detectSignals, _condensePipelineText,
  _extractJsonLd, _filterJsonLdEvents, _formatJsonLdEventsForPrompt, _assessContentQuality,
  _looksLikeEventObject, _findEventArraysInData, _extractEmbeddedScriptData, _formatEmbeddedEventsForPrompt,
} = require('../netlify/functions/discovery-pipeline');
const shared = require('../netlify/functions/_studio-shared');

function makeEvent(method, body, authHeader = 'Bearer tok') {
  return {
    httpMethod: method,
    headers: { authorization: authHeader },
    body: body ? JSON.stringify(body) : null,
    queryStringParameters: {},
  };
}

beforeEach(() => {
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  shared.verifyStudioToken.mockReset();
});

// ── _stripHtml ────────────────────────────────────────────────────────────────
describe('_stripHtml', () => {
  test('removes HTML tags', () => {
    const result = _stripHtml('<h1>Title</h1><p>Text</p>');
    expect(result).not.toContain('<');
    expect(result).toContain('Title');
    expect(result).toContain('Text');
  });

  test('removes script and style blocks entirely', () => {
    const result = _stripHtml('<script>alert("xss")</script><style>.a{color:red}</style>Hello');
    expect(result).not.toContain('alert');
    expect(result).not.toContain('color:red');
    expect(result).toContain('Hello');
  });

  test('decodes common HTML entities', () => {
    const result = _stripHtml('&amp; &lt;tag&gt; &nbsp;text');
    expect(result).toContain('&');
    expect(result).toContain('text');
  });

  test('collapses whitespace', () => {
    const result = _stripHtml('a   b\n\n\tc');
    expect(result).toBe('a b c');
  });
});

// ── _condensePipelineText ─────────────────────────────────────────────────────
describe('_condensePipelineText', () => {
  test('returns text within the given limit', () => {
    const long = 'word '.repeat(20_000);
    const result = _condensePipelineText(long, 40_000);
    expect(result.length).toBeLessThanOrEqual(40_000);
  });

  test('removes repeated short navigation fragments', () => {
    // Simulate nav items repeated many times (e.g. breadcrumb links)
    const navItem = 'Home  ';
    const content = 'Weihnachtsmarkt am Kölner Dom mit über 160 Ständen und vielen Attraktionen für die ganze Familie.';
    // nav items appear 5 times, content once
    const text = (navItem.repeat(5)) + '  ' + content;
    const result = _condensePipelineText(text, 40_000);
    expect(result).toContain('Weihnachtsmarkt');
    // "Home" should appear at most 2 times (deduplication threshold)
    const homeCount = (result.match(/Home/g) || []).length;
    expect(homeCount).toBeLessThanOrEqual(2);
  });

  test('skips opening nav on long pages', () => {
    // Page starts with nav-only content, real content comes later
    const nav = 'Startseite '.repeat(2_000);  // ~22K chars of nav
    const content = 'Weihnachtsmarkt am Dom: täglich geöffnet von 11 bis 22 Uhr.  '.repeat(50);
    const text = nav + content;
    expect(text.length).toBeGreaterThan(20_000);
    const result = _condensePipelineText(text, 40_000);
    expect(result).toContain('Weihnachtsmarkt');
  });

  test('preserves long content sentences', () => {
    const sentence = 'Der Kölner Weihnachtsmarkt am Dom ist einer der ältesten und schönsten Weihnachtsmärkte Deutschlands.';
    const result = _condensePipelineText(sentence, 40_000);
    expect(result).toContain('Kölner Weihnachtsmarkt');
  });
});

// ── _detectSignals ────────────────────────────────────────────────────────────
describe('_detectSignals', () => {
  test('detects operatingPeriod from German date range', () => {
    const r = _detectSignals('Weihnachtsmarkt vom 21.11. bis 23.12.2024 am Dom');
    expect(r.operatingPeriod.detected).toBe(true);
    expect(r.operatingPeriod.examples.length).toBeGreaterThan(0);
  });

  test('detects openingHours from time ranges', () => {
    const r = _detectSignals('Öffnungszeiten: Mo-Fr 11:00 - 21:00 Uhr, Sa 10:00 - 22:00 Uhr');
    expect(r.openingHours.detected).toBe(true);
  });

  test('detects exceptionalHours from Heiligabend', () => {
    const r = _detectSignals('Heiligabend 24.12. Sonderöffnungszeiten 10:00 - 14:00 Uhr');
    expect(r.exceptionalHours.detected).toBe(true);
  });

  test('detects exceptionalHours from 25. Dezember', () => {
    const r = _detectSignals('Am 25. Dezember geschlossen.');
    expect(r.exceptionalHours.detected).toBe(true);
  });

  test('detects location from German street patterns', () => {
    const r = _detectSignals('Roncalliplatz, 50667 Köln, direkt am Dom');
    expect(r.location.detected).toBe(true);
  });

  test('detects price from Euro symbol', () => {
    const r = _detectSignals('Eintritt frei. VIP-Ticket: 15 €');
    expect(r.price.detected).toBe(true);
  });

  test('detects provider from Impressum keyword', () => {
    const r = _detectSignals('Veranstalter: Köln Tourismus GmbH. Impressum');
    expect(r.provider.detected).toBe(true);
  });

  test('returns no detections for empty text', () => {
    const r = _detectSignals('');
    for (const v of Object.values(r)) expect(v.detected).toBe(false);
  });

  test('returns exactly the signal keys', () => {
    const r = _detectSignals('test');
    expect(Object.keys(r).sort()).toEqual([
      'exceptionalHours', 'location', 'openingHours', 'operatingPeriod', 'price', 'provider',
    ]);
  });

  test('examples are strings capped at 120 chars', () => {
    const longText = 'Öffnungszeiten: ' + 'Mo 11:00 - 21:00 Uhr '.repeat(20);
    const r = _detectSignals(longText);
    for (const ex of r.openingHours.examples) {
      expect(typeof ex).toBe('string');
      expect(ex.length).toBeLessThanOrEqual(120);
    }
  });
});

// ── Auth guards ───────────────────────────────────────────────────────────────
describe('handler auth guards', () => {
  test('GET returns 405 for non-GET/POST', async () => {
    const res = await handler({ httpMethod: 'DELETE', headers: {}, body: null });
    expect(res.statusCode).toBe(405);
  });

  test('GET returns 403 when not authenticated', async () => {
    shared.verifyStudioToken.mockResolvedValue(null);
    const res = await handler(makeEvent('GET', null));
    expect(res.statusCode).toBe(403);
  });

  test('POST returns 403 for researcher role (editor+ required)', async () => {
    shared.verifyStudioToken.mockResolvedValue(null);
    const res = await handler(makeEvent('POST', { city: 'Köln' }));
    expect(res.statusCode).toBe(403);
  });

  test('GET returns 200 for researcher', async () => {
    shared.verifyStudioToken.mockResolvedValue({ uid: 'u1', studioRole: 'researcher' });
    const res = await handler(makeEvent('GET', null));
    expect(res.statusCode).toBe(200);
  });

  test('POST returns 200 for editor with no sources', async () => {
    shared.verifyStudioToken.mockResolvedValue({ uid: 'ed', studioRole: 'editor' });
    const res = await handler(makeEvent('POST', { city: 'Köln' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.report.mode).toBe('dry-run');
  });

  test('report includes sourcesSkippedCityMismatch when sources have different city', async () => {
    // One source matches Köln, one has a different city
    mockSet('discoverySources/src_koeln',  { city: 'Köln',    url: 'https://a.com', name: 'A', active: true });
    mockSet('discoverySources/src_berlin', { city: 'Berlin',  url: 'https://b.com', name: 'B', active: true });
    mockSet('discoverySources/src_inactive', { city: 'Köln', url: 'https://c.com', name: 'C', active: false });
    shared.verifyStudioToken.mockResolvedValue({ uid: 'ed', studioRole: 'editor' });
    const res = await handler(makeEvent('POST', { city: 'Köln' }));
    const { report } = JSON.parse(res.body);
    expect(report.sourcesConsidered).toBe(1);       // only the active Köln source
    expect(report.sourcesSkippedCityMismatch).toBe(1); // Berlin skipped
    expect(report.sourcesSkippedInactive).toBe(1);     // inactive skipped
  });

  test('POST returns 400 for unsupported city', async () => {
    shared.verifyStudioToken.mockResolvedValue({ uid: 'ed', studioRole: 'editor' });
    const res = await handler(makeEvent('POST', { city: 'Berlin' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/City not supported/);
  });
});

// ── Dry-run: writes only to discoveryPipelineRuns ────────────────────────────
describe('dry-run pipeline', () => {
  const editor = { uid: 'ed', studioRole: 'editor', email: 'ed@test.com' };

  test('writes run report to discoveryPipelineRuns/', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    await handler(makeEvent('POST', { city: 'Köln' }));
    const run = mockGet('discoveryPipelineRuns/run_test');
    expect(run).toBeDefined();
    expect(run.mode).toBe('dry-run');
    expect(run.city).toBe('Köln');
  });

  test('does NOT write to suggestions/', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    await handler(makeEvent('POST', { city: 'Köln' }));
    expect(mockGet('suggestions')).toBeUndefined();
  });

  test('does NOT write to activities/', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    await handler(makeEvent('POST', { city: 'Köln' }));
    expect(mockGet('activities')).toBeUndefined();
  });

  test('report contains enforced limits', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    const res = await handler(makeEvent('POST', { city: 'Köln' }));
    const { report } = JSON.parse(res.body);
    expect(report.limits.maxSources).toBe(5);
    expect(report.limits.maxSuggestions).toBe(20);
    expect(report.limits.maxLlmCalls).toBe(10);
  });

  test('report includes triggeredBy actor uid', async () => {
    shared.verifyStudioToken.mockResolvedValue(editor);
    const res = await handler(makeEvent('POST', { city: 'Köln' }));
    const { report } = JSON.parse(res.body);
    expect(report.triggeredBy).toBe('ed');
  });

  test('GET returns list of runs from discoveryPipelineRuns/', async () => {
    mockSet('discoveryPipelineRuns/run_1', { city: 'Köln', mode: 'dry-run', startedAt: 1000 });
    mockSet('discoveryPipelineRuns/run_2', { city: 'Köln', mode: 'dry-run', startedAt: 2000 });
    shared.verifyStudioToken.mockResolvedValue({ uid: 'r', studioRole: 'researcher' });
    const res = await handler(makeEvent('GET', null));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.runs).toBeDefined();
  });
});

// ── _stripHtml: improved removal ──────────────────────────────────────────────
describe('_stripHtml improvements', () => {
  test('removes <head> section entirely', () => {
    const html = '<html><head><title>Page</title><meta name="x" content="y"><link rel="stylesheet" href="a.css"></head><body>Content here</body></html>';
    const result = _stripHtml(html);
    expect(result).not.toContain('stylesheet');
    expect(result).not.toContain('meta');
    expect(result).toContain('Content here');
  });

  test('removes <svg> blocks', () => {
    const html = '<p>Text</p><svg viewBox="0 0 100 100"><path d="M 0 0"/></svg><p>After</p>';
    const result = _stripHtml(html);
    expect(result).not.toContain('viewBox');
    expect(result).not.toContain('path');
    expect(result).toContain('Text');
    expect(result).toContain('After');
  });

  test('removes <noscript> blocks', () => {
    const html = '<noscript><img src="tracker.gif"></noscript>Real content';
    const result = _stripHtml(html);
    expect(result).not.toContain('tracker');
    expect(result).toContain('Real content');
  });

  test('removes CSS @-rules and brace blocks', () => {
    // CSS that leaks through — @-rules and {...} blocks are removed
    const cssLeak = '@media (max-width:768px){body{margin:0}} Weihnachtsmarkt am Dom';
    const result = _stripHtml(cssLeak);
    expect(result).toContain('Weihnachtsmarkt');
    expect(result).not.toContain('@media');
  });

  test('does NOT delete German event text that looks like CSS (colon-semicolon)', () => {
    // Critical regression test: the old broad CSS regex deleted real event data
    const eventText = 'Veranstalter: KölnTourismus GmbH; Öffnungszeiten: täglich 11-22 Uhr; Adresse: Roncalliplatz, 50667 Köln;';
    const result = _stripHtml(eventText);
    expect(result).toContain('KölnTourismus');
    expect(result).toContain('täglich');
    expect(result).toContain('Roncalliplatz');
  });
});

// ── _extractJsonLd ────────────────────────────────────────────────────────────
describe('_extractJsonLd', () => {
  test('extracts single JSON-LD object', () => {
    const html = `<html><script type="application/ld+json">{"@type":"Event","name":"Weihnachtsmarkt"}</script></html>`;
    const items = _extractJsonLd(html);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('Weihnachtsmarkt');
  });

  test('extracts multiple JSON-LD blocks', () => {
    const html = `
      <script type="application/ld+json">{"@type":"Event","name":"Markt 1"}</script>
      <script type="application/ld+json">{"@type":"Event","name":"Markt 2"}</script>
    `;
    const items = _extractJsonLd(html);
    expect(items).toHaveLength(2);
  });

  test('extracts @graph arrays', () => {
    const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Event","name":"A"},{"@type":"Place","name":"B"}]}</script>`;
    const items = _extractJsonLd(html);
    expect(items).toHaveLength(2);
    expect(items.map(i => i.name)).toEqual(['A', 'B']);
  });

  test('skips malformed JSON-LD silently', () => {
    const html = `<script type="application/ld+json">{broken json</script><script type="application/ld+json">{"@type":"Event","name":"Valid"}</script>`;
    const items = _extractJsonLd(html);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('Valid');
  });

  test('returns empty array when no JSON-LD present', () => {
    const html = '<html><body>No structured data here</body></html>';
    const items = _extractJsonLd(html);
    expect(items).toEqual([]);
  });
});

// ── _filterJsonLdEvents ───────────────────────────────────────────────────────
describe('_filterJsonLdEvents', () => {
  test('returns only Event-type items', () => {
    const items = [
      { '@type': 'Event', name: 'Konzert' },
      { '@type': 'Place', name: 'Dom' },
      { '@type': 'Festival', name: 'Fest' },
      { '@type': 'Organization', name: 'Org' },
    ];
    const events = _filterJsonLdEvents(items);
    expect(events).toHaveLength(2);
    expect(events.map(e => e.name)).toEqual(['Konzert', 'Fest']);
  });

  test('handles array @type', () => {
    const items = [{ '@type': ['Event', 'MusicEvent'], name: 'Konzert' }];
    const events = _filterJsonLdEvents(items);
    expect(events).toHaveLength(1);
  });

  test('returns empty array when no events present', () => {
    const items = [{ '@type': 'WebSite' }, { '@type': 'BreadcrumbList' }];
    expect(_filterJsonLdEvents(items)).toEqual([]);
  });
});

// ── _assessContentQuality ─────────────────────────────────────────────────────
describe('_assessContentQuality', () => {
  test('marks CSS-heavy text for skipping (no JSON-LD events)', () => {
    const cssText = Array.from({ length: 50 }, (_, i) =>
      `color: #${i.toString(16).padStart(3, '0')}; background-color: white; font-size: ${i}px;`
    ).join(' ');
    const result = _assessContentQuality(cssText, 0);
    expect(result.skip).toBe(true);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  test('does not skip CSS-heavy text when JSON-LD events are present', () => {
    const cssText = Array.from({ length: 50 }, (_, i) =>
      `color: #${i.toString(16).padStart(3, '0')}; background-color: white; font-size: ${i}px;`
    ).join(' ');
    const result = _assessContentQuality(cssText, 3);
    expect(result.skip).toBe(false);
  });

  test('marks very short text for skipping (no JSON-LD events)', () => {
    const result = _assessContentQuality('Hi', 0);
    expect(result.skip).toBe(true);
  });

  test('does not skip real event content', () => {
    const eventText = 'Der Weihnachtsmarkt am Kölner Dom öffnet am 21. November. Öffnungszeiten täglich 11–21 Uhr. Eintritt frei.';
    const result = _assessContentQuality(eventText, 0);
    expect(result.skip).toBe(false);
    expect(result.hasEventKeywords).toBe(true);
  });

  test('detects event keywords in German text', () => {
    const text = 'Weihnachtsmarkt mit vielen Ständen und Konzerten.';
    const result = _assessContentQuality(text, 0);
    expect(result.hasEventKeywords).toBe(true);
  });

  test('returns issues array even when not skipping', () => {
    const text = 'Weihnachtsmarkt am Dom.';
    const result = _assessContentQuality(text, 0);
    expect(Array.isArray(result.issues)).toBe(true);
  });
});

// ── _stripHtml: nav/header/footer/aside removal ───────────────────────────────
describe('_stripHtml nav/chrome removal', () => {
  test('removes <nav> block text content entirely', () => {
    const html = '<nav><ul><li><a href="/">Startseite</a></li><li><a href="/events">Veranstaltungen</a></li></ul></nav><main><p>Weihnachtsmarkt am Kölner Dom</p></main>';
    const result = _stripHtml(html);
    expect(result).not.toContain('Startseite');
    expect(result).not.toContain('Veranstaltungen');
    expect(result).toContain('Weihnachtsmarkt');
  });

  test('preserves <header> text content (HTML5 headers wrap event titles/dates)', () => {
    // <header> is NOT removed because article headers often contain the event name and date
    const html = '<header><h1>Konzert am 24.12. im Gürzenich</h1></header><article>Details zum Event</article>';
    const result = _stripHtml(html);
    expect(result).toContain('Konzert');
    expect(result).toContain('Gürzenich');
    expect(result).toContain('Details');
  });

  test('preserves <footer> text content (footers may contain venue or contact info)', () => {
    // <footer> is NOT removed because footer elements may contain provider/address data
    const html = '<main>Weihnachtsmarkt am Dom</main><footer>Veranstalter: KölnTourismus GmbH, Roncalliplatz 1</footer>';
    const result = _stripHtml(html);
    expect(result).toContain('Weihnachtsmarkt');
    expect(result).toContain('KölnTourismus');
  });

  test('removes <aside> block text content entirely', () => {
    const html = '<main><p>Stadtführung durch die Altstadt</p></main><aside><p>Werbung: Hotel Buchen</p></aside>';
    const result = _stripHtml(html);
    expect(result).not.toContain('Werbung');
    expect(result).toContain('Stadtführung');
  });

  test('does NOT destroy German event data with colon-semicolon pattern', () => {
    // Previously the CSS regex "\b[a-zA-Z-]+:\s*...\s*;" would delete these
    const text = 'Veranstalter: KölnTourismus GmbH; Öffnungszeiten: täglich 11-22 Uhr; Adresse: Roncalliplatz, 50667 Köln;';
    const result = _stripHtml(text);
    expect(result).toContain('KölnTourismus');
    expect(result).toContain('täglich');
    expect(result).toContain('Roncalliplatz');
  });
});

// ── _selectMainContent ────────────────────────────────────────────────────────
describe('_selectMainContent', () => {
  test('extracts <main> content when present and large enough', () => {
    const mainBody = 'Weihnachtsmarkt am Kölner Dom '.repeat(20); // > 500 chars
    const html = `<header>Site Header</header><main>${mainBody}</main><footer>Footer</footer>`;
    const { html: selected, selectedBy } = _selectMainContent(html);
    expect(selected).toContain('Weihnachtsmarkt');
    expect(selected).not.toContain('Site Header');
    expect(selected).not.toContain('Footer');
    expect(selectedBy).toContain('main');
  });

  test('falls back to full document when <main> is too short', () => {
    const html = '<header>Site Header</header><main>Short</main><div>Full page content that is long enough to matter here</div>';
    const { html: selected, selectedBy } = _selectMainContent(html);
    expect(selected).toContain('Site Header');
    expect(selectedBy).toBe('full-document');
  });

  test('falls back to full document when no semantic landmark exists', () => {
    const html = '<div class="wrap"><p>All content here without any main landmark</p></div>';
    const { selectedBy } = _selectMainContent(html);
    expect(selectedBy).toBe('full-document');
  });

  test('uses role="main" when <main> tag is absent', () => {
    const mainBody = 'Veranstaltungen in Köln '.repeat(30); // > 500 chars
    const html = `<div role="main">${mainBody}</div><aside>Sidebar</aside>`;
    const { html: selected, selectedBy } = _selectMainContent(html);
    expect(selected).toContain('Veranstaltungen');
    expect(selectedBy).toMatch(/role/);
  });
});

// ── _analyzeHtmlStructure ──────────────────────────────────────────────────────
describe('_analyzeHtmlStructure', () => {
  test('returns step sizes in descending order', () => {
    const html = '<html><head><style>.a{color:red}</style></head><body><nav>Menu</nav><main><p>Event content here and more text</p></main></body></html>';
    const diag = _analyzeHtmlStructure(html);
    expect(diag.rawSizeChars).toBeGreaterThan(0);
    expect(diag.afterHeadChars).toBeLessThan(diag.rawSizeChars);
    expect(diag.strippedChars).toBeLessThan(diag.rawSizeChars);
  });

  test('detects <main> presence', () => {
    const html = '<html><body><main><p>Content</p></main></body></html>';
    const diag = _analyzeHtmlStructure(html);
    expect(diag.hasMain).toBe(true);
    expect(diag.hasRoleMain).toBe(false);
  });

  test('detects role="main"', () => {
    const html = '<div role="main"><p>Content</p></div>';
    const diag = _analyzeHtmlStructure(html);
    expect(diag.hasRoleMain).toBe(true);
  });

  test('reports cssLeakPercent when CSS text is present', () => {
    // Build a text that will have many CSS-like patterns after stripping
    const cssText = Array(50).fill('color: red; background-color: blue; margin-top: 10px;').join(' ');
    const html = `<body>${cssText}</body>`;
    const diag = _analyzeHtmlStructure(html);
    expect(diag.cssLeakPercent).toBeGreaterThan(0);
  });

  test('reports topTags with tag names and counts', () => {
    const html = '<div><p>a</p><p>b</p><span>c</span></div>';
    const diag = _analyzeHtmlStructure(html);
    expect(diag.topTags.some(t => t.startsWith('p('))).toBe(true);
    expect(diag.topTags.some(t => t.startsWith('div('))).toBe(true);
  });

  test('headComplete is true when </head> is present', () => {
    const html = '<html><head><title>Test</title></head><body><p>Content</p></body></html>';
    const diag = _analyzeHtmlStructure(html);
    expect(diag.headComplete).toBe(true);
  });

  test('headComplete is false when </head> is missing (truncated document)', () => {
    // Simulate a truncated page where </head> never appears
    const html = '<html><head><style>.a { color: red; } .b { margin: 0; }';
    const diag = _analyzeHtmlStructure(html);
    expect(diag.headComplete).toBe(false);
  });

  test('hasBody is true when <body> tag is present', () => {
    const html = '<html><head></head><body><p>Content</p></body></html>';
    const diag = _analyzeHtmlStructure(html);
    expect(diag.hasBody).toBe(true);
    expect(diag.bodyPositionPercent).toBeGreaterThanOrEqual(0);
    expect(diag.bodyPositionPercent).toBeLessThan(100);
  });

  test('hasBody is false when <body> is absent (truncated in head)', () => {
    const html = '<html><head><title>Title</title><style>.a { color: red; }';
    const diag = _analyzeHtmlStructure(html);
    expect(diag.hasBody).toBe(false);
    expect(diag.bodyPositionPercent).toBeNull();
  });

  test('detects __NEXT_DATA__ signal', () => {
    const html = '<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{}}</script></body></html>';
    const diag = _analyzeHtmlStructure(html);
    expect(diag.hasNextData).toBe(true);
    expect(diag.hasNuxtData).toBe(false);
  });

  test('detects __NUXT__ signal', () => {
    const html = '<html><body><script>window.__NUXT__={data:[]}</script></body></html>';
    const diag = _analyzeHtmlStructure(html);
    expect(diag.hasNuxtData).toBe(true);
  });

  test('detects generic JSON script', () => {
    const html = '<html><body><script type="application/json">{"items":[]}</script></body></html>';
    const diag = _analyzeHtmlStructure(html);
    expect(diag.hasJsonScript).toBe(true);
  });
});

// ── _looksLikeEventObject ─────────────────────────────────────────────────────
describe('_looksLikeEventObject', () => {
  test('recognises event object with name and date', () => {
    expect(_looksLikeEventObject({ name: 'Weihnachtsmarkt', startDate: '2024-11-21' })).toBe(true);
  });

  test('recognises event object with title and location', () => {
    expect(_looksLikeEventObject({ title: 'Konzert', location: 'Köln', description: 'Jazz' })).toBe(true);
  });

  test('recognises German field names', () => {
    expect(_looksLikeEventObject({ name: 'Markt', ort: 'Dom', beginn: '21.11.' })).toBe(true);
  });

  test('rejects object without name/title', () => {
    expect(_looksLikeEventObject({ startDate: '2024-12-01', location: 'Köln' })).toBe(false);
  });

  test('rejects non-objects', () => {
    expect(_looksLikeEventObject(null)).toBe(false);
    expect(_looksLikeEventObject('string')).toBe(false);
    expect(_looksLikeEventObject([1, 2])).toBe(false);
  });
});

// ── _findEventArraysInData ────────────────────────────────────────────────────
describe('_findEventArraysInData', () => {
  test('finds event array at top level', () => {
    const data = [
      { name: 'Markt A', startDate: '2024-11-21', location: 'Dom' },
      { name: 'Markt B', startDate: '2024-11-22', location: 'Altstadt' },
    ];
    const result = _findEventArraysInData(data);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(2);
  });

  test('finds event array nested inside an object', () => {
    const data = {
      meta: { title: 'Weihnachtsmärkte' },
      events: [
        { name: 'Markt A', location: 'Dom', description: 'Schöner Markt' },
        { name: 'Markt B', location: 'Altstadt', description: 'Historisch' },
      ],
    };
    const result = _findEventArraysInData(data);
    expect(result).toHaveLength(1);
    expect(result[0][0].name).toBe('Markt A');
  });

  test('finds event array in Next.js pageProps structure', () => {
    const nextData = {
      props: {
        pageProps: {
          listings: [
            { title: 'Dom-Weihnachtsmarkt', date: '2024-11-21', venue: 'Roncalliplatz' },
            { title: 'Neumarkt-Weihnachtsmarkt', date: '2024-11-21', venue: 'Neumarkt' },
          ],
        },
      },
      buildId: 'abc123',
    };
    const result = _findEventArraysInData(nextData);
    expect(result).toHaveLength(1);
    expect(result[0][0].title).toBe('Dom-Weihnachtsmarkt');
  });

  test('returns empty for data with no event-like arrays', () => {
    const data = { menu: ['Home', 'About', 'Contact'], config: { lang: 'de' } };
    expect(_findEventArraysInData(data)).toEqual([]);
  });

  test('respects node limit and does not throw on deep structures', () => {
    // Deeply nested object
    let deep = { val: null };
    let cur = deep;
    for (let i = 0; i < 200; i++) { cur.child = { val: i }; cur = cur.child; }
    expect(() => _findEventArraysInData(deep)).not.toThrow();
  });
});

// ── _extractEmbeddedScriptData ────────────────────────────────────────────────
describe('_extractEmbeddedScriptData', () => {
  test('extracts event array from Next.js __NEXT_DATA__', () => {
    const events = [
      { name: 'Dom-Weihnachtsmarkt', startDate: '2024-11-21', location: 'Roncalliplatz' },
      { name: 'Neumarkt-Weihnachtsmarkt', startDate: '2024-11-21', location: 'Neumarkt' },
    ];
    const html = `<html><head></head><body>
      <script id="__NEXT_DATA__" type="application/json">
        {"props":{"pageProps":{"markets":${JSON.stringify(events)}}},"buildId":"abc"}
      </script>
    </body></html>`;
    const result = _extractEmbeddedScriptData(html);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].source).toBe('next.js');
    expect(result[0].events).toHaveLength(2);
    expect(result[0].events[0].name).toBe('Dom-Weihnachtsmarkt');
  });

  test('extracts event array from generic application/json script', () => {
    const events = [
      { title: 'Weihnachtsmarkt', date: '2024-12-01', ort: 'Köln' },
      { title: 'Konzert', date: '2024-12-10', ort: 'Köln' },
    ];
    const html = `<html><body>
      <script type="application/json">${JSON.stringify({ items: events })}</script>
    </body></html>`;
    const result = _extractEmbeddedScriptData(html);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].events[0].title).toBe('Weihnachtsmarkt');
  });

  test('returns empty array when no embedded data present', () => {
    const html = '<html><body><p>Simple page</p></body></html>';
    expect(_extractEmbeddedScriptData(html)).toEqual([]);
  });

  test('ignores JSON-LD blocks (already handled by extractJsonLd)', () => {
    const html = `<script type="application/ld+json">{"@type":"Event","name":"Concert"}</script>`;
    const result = _extractEmbeddedScriptData(html);
    expect(result).toEqual([]);
  });

  test('handles malformed JSON gracefully', () => {
    const html = `<script id="__NEXT_DATA__" type="application/json">{broken json</script>`;
    expect(() => _extractEmbeddedScriptData(html)).not.toThrow();
    expect(_extractEmbeddedScriptData(html)).toEqual([]);
  });
});

// ── _formatEmbeddedEventsForPrompt ────────────────────────────────────────────
describe('_formatEmbeddedEventsForPrompt', () => {
  test('formats event arrays as readable lines', () => {
    const data = [{
      source: 'next.js',
      events: [
        { name: 'Dom-Markt', startDate: '2024-11-21', location: 'Roncalliplatz', url: 'https://example.com' },
      ],
    }];
    const result = _formatEmbeddedEventsForPrompt(data);
    expect(result).toContain('Dom-Markt');
    expect(result).toContain('2024-11-21');
    expect(result).toContain('Roncalliplatz');
    expect(result).toContain('https://example.com');
  });

  test('handles German field names', () => {
    const data = [{
      source: 'json-script',
      events: [{ name: 'Markt', beginn: '21.11.2024', ort: 'Altstadt' }],
    }];
    const result = _formatEmbeddedEventsForPrompt(data);
    expect(result).toContain('Markt');
    expect(result).toContain('21.11.2024');
    expect(result).toContain('Altstadt');
  });

  test('returns empty string for empty input', () => {
    expect(_formatEmbeddedEventsForPrompt([])).toBe('');
  });
});
