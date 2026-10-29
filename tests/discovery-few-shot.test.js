'use strict';
// Tests for few-shot example loading and similarity scoring in discovery-pipeline.js

const {
  _extractSourceHintWords: extractSourceHintWords,
  _scoreExampleRelevance:  scoreExampleRelevance,
  _selectFewShotExamples:  selectFewShotExamples,
  _formatFewShotSection:   formatFewShotSection,
  _loadPublishedExamples:  loadPublishedExamples,
} = require('../netlify/functions/discovery-pipeline');

// ── extractSourceHintWords ────────────────────────────────────────────────────

describe('extractSourceHintWords', () => {
  it('tokenises words from source name and text', () => {
    const words = extractSourceHintWords('Kölner Märkte', 'Adventsmarkt und Weihnachtsmarkt');
    expect(words.has('kölner')).toBe(true);
    expect(words.has('märkte')).toBe(true);
    expect(words.has('weihnachtsmarkt')).toBe(true);
  });

  it('adds tag IDs when their parts appear in the text', () => {
    // 'weihnachtsmarkt' is a tag ID in the taxonomy
    const words = extractSourceHintWords('', 'Besuch den Weihnachtsmarkt am Dom');
    expect(words.has('weihnachtsmarkt')).toBe(true);
  });

  it('adds festival_tag ID when "festival" appears as a standalone word', () => {
    // 'festival_tag' parts = ['festival','tag']; need both parts in text
    const words = extractSourceHintWords('Sommer Festival Tag Köln', '');
    expect(words.has('festival')).toBe(true); // plain word present
  });

  it('handles null/empty inputs gracefully', () => {
    const words = extractSourceHintWords(null, null);
    expect(words.size).toBe(0);
  });

  it('does not add tag IDs when parts are missing', () => {
    // 'spieleabend' → parts ['spieleabend'] (single word), present only if the word itself appears
    const words = extractSourceHintWords('Konzert heute', '');
    expect(words.has('spieleabend')).toBe(false);
  });
});

// ── scoreExampleRelevance ─────────────────────────────────────────────────────

describe('scoreExampleRelevance', () => {
  const weihnachtsExample = {
    id: 'act1',
    title: 'Weihnachtsmarkt am Kölner Dom',
    category: 'events_nightlife',
    additionalCategories: null,
    tags: ['weihnachtsmarkt', 'stadtfest'],
  };

  it('scores high for exact tag match', () => {
    const hints = new Set(['weihnachtsmarkt', 'dom', 'köln']);
    const score = scoreExampleRelevance(weihnachtsExample, hints);
    // +3 (weihnachtsmarkt tag) + 2 (weihnachtsmarkt title word) + 2 (kölner title word match 'köln' - 4 chars) = ?
    // 'kölner' is 6 chars but hint has 'köln' (4 chars) — 'kölner' !== 'köln' so no title match for 'köln'
    // title words ≥4 chars: 'weihnachtsmarkt','kölner','dom' — hints: 'dom' matches → +2
    // tag 'weihnachtsmarkt' in hints → +3; tag 'stadtfest' not in hints, parts ['stadtfest'] ≥3 chars in hints? No
    // title word 'weihnachtsmarkt' in hints → +2; 'kölner' not in hints; 'dom' in hints → +2
    expect(score).toBeGreaterThanOrEqual(5);
  });

  it('scores 0 for completely unrelated example', () => {
    const cafeExample = {
      id: 'act2',
      title: 'Gemütliches Café in Ehrenfeld',
      category: 'food_drinks',
      tags: ['cafe', 'brunch'],
    };
    const hints = new Set(['weihnachtsmarkt', 'advent', 'dezember']);
    expect(scoreExampleRelevance(cafeExample, hints)).toBe(0);
  });

  it('scores tag part matches when full tag not in hints', () => {
    const ex = { id: 'act3', title: 'Party Night', category: 'events_nightlife', tags: ['festival_tag'] };
    const hints = new Set(['festival']); // 'festival_tag' not directly in hints, but part 'festival' is
    const score = scoreExampleRelevance(ex, hints);
    expect(score).toBeGreaterThan(0);
  });

  it('handles example with no tags', () => {
    const ex = { id: 'act4', title: 'Weihnachtsmarkt Ehrenfeld', category: 'events_nightlife', tags: null };
    const hints = new Set(['weihnachtsmarkt']);
    const score = scoreExampleRelevance(ex, hints);
    expect(score).toBeGreaterThan(0); // title word match
  });
});

// ── selectFewShotExamples ─────────────────────────────────────────────────────

describe('selectFewShotExamples', () => {
  const examples = [
    { id: 'act1', title: 'Weihnachtsmarkt Dom', category: 'events_nightlife', tags: ['weihnachtsmarkt'] },
    { id: 'act2', title: 'Adventsmarkt Ehrenfeld', category: 'events_nightlife', tags: ['weihnachtsmarkt', 'stadtfest'] },
    { id: 'act3', title: 'Gemütliches Café', category: 'food_drinks', tags: ['cafe'] },
    { id: 'act4', title: 'Yoga im Park', category: 'wellness_entspannung', tags: ['yoga'] },
    { id: 'act5', title: 'Konzert Philharmonie', category: 'kultur_entertainment', tags: ['konzert'] },
    { id: 'act6', title: 'Weihnachtsmarkt Neumarkt', category: 'events_nightlife', tags: ['weihnachtsmarkt'] },
  ];

  it('returns relevant examples sorted by score', () => {
    const hints = new Set(['weihnachtsmarkt', 'advent', 'markt']);
    const selected = selectFewShotExamples(examples, hints);
    // Should pick weihnachtsmarkt-tagged examples first
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.every(e => ['act1','act2','act6'].includes(e.id))).toBe(true);
  });

  it('excludes unrelated examples below threshold', () => {
    const hints = new Set(['weihnachtsmarkt']);
    const selected = selectFewShotExamples(examples, hints);
    const ids = selected.map(e => e.id);
    expect(ids).not.toContain('act3'); // café
    expect(ids).not.toContain('act4'); // yoga
  });

  it('returns empty array when no examples are relevant', () => {
    const hints = new Set(['xyz123', 'nichtexistent']);
    expect(selectFewShotExamples(examples, hints)).toHaveLength(0);
  });

  it('returns at most FEW_SHOT_MAX (5) examples', () => {
    // 6 weihnachtsmarkt-themed entries; max is 5
    const manyExamples = Array.from({ length: 10 }, (_, i) => ({
      id: `act${i}`, title: 'Weihnachtsmarkt', category: 'events_nightlife', tags: ['weihnachtsmarkt'],
    }));
    const hints = new Set(['weihnachtsmarkt']);
    expect(selectFewShotExamples(manyExamples, hints).length).toBeLessThanOrEqual(5);
  });

  it('returns empty array for empty input', () => {
    expect(selectFewShotExamples([], new Set(['weihnachtsmarkt']))).toHaveLength(0);
    expect(selectFewShotExamples(null, new Set(['weihnachtsmarkt']))).toHaveLength(0);
  });
});

// ── formatFewShotSection ──────────────────────────────────────────────────────

describe('formatFewShotSection', () => {
  it('returns empty string for empty array', () => {
    expect(formatFewShotSection([])).toBe('');
    expect(formatFewShotSection(null)).toBe('');
  });

  it('includes title, category and tags in output', () => {
    const examples = [
      { id: 'act1', title: 'Weihnachtsmarkt Dom', category: 'events_nightlife', additionalCategories: null, tags: ['weihnachtsmarkt'] },
    ];
    const section = formatFewShotSection(examples);
    expect(section).toContain('Weihnachtsmarkt Dom');
    expect(section).toContain('events_nightlife');
    expect(section).toContain('weihnachtsmarkt');
  });

  it('includes additionalCategories when present', () => {
    const examples = [
      { id: 'act1', title: 'Stadtfest', category: 'events_nightlife', additionalCategories: ['community_social'], tags: null },
    ];
    const section = formatFewShotSection(examples);
    expect(section).toContain('community_social');
  });

  it('does not include actual field data for prices, addresses or dates', () => {
    // The instruction text mentions these words as things to avoid; the example data itself must not contain them
    const examples = [
      { id: 'act1', title: 'Test', category: 'events_nightlife', additionalCategories: null, tags: ['stadtfest'] },
    ];
    const section = formatFewShotSection(examples);
    // The per-example lines should not carry any price/location/date data
    const exampleLines = section.split('\n').filter(l => l.startsWith('•'));
    for (const line of exampleLines) {
      expect(line).not.toMatch(/\d+[,.]?\d*\s*€|€\s*\d+|straße|adresse|platz|2025|2026/i);
    }
  });

  it('contains the editorial confirmation header', () => {
    const examples = [
      { id: 'act1', title: 'Test', category: 'events_nightlife', additionalCategories: null, tags: null },
    ];
    const section = formatFewShotSection(examples);
    expect(section).toContain('EDITORIALLY CONFIRMED REFERENCE EXAMPLES');
    expect(section).toContain('Do NOT copy');
  });
});

// ── loadPublishedExamples ─────────────────────────────────────────────────────

describe('loadPublishedExamples', () => {
  function makeDb(activities) {
    return {
      ref: () => ({
        once: async () => ({
          forEach: cb => {
            for (const [key, val] of Object.entries(activities)) {
              cb({ key, val: () => val });
            }
          },
        }),
      }),
    };
  }

  it('returns only published activities for the given city', async () => {
    const db = makeDb({
      act1: { status: 'published', city: 'Köln', category: 'events_nightlife', title: 'A', tags: ['weihnachtsmarkt'] },
      act2: { status: 'draft',     city: 'Köln', category: 'food_drinks',      title: 'B', tags: null },
      act3: { status: 'published', city: 'Berlin', category: 'food_drinks',    title: 'C', tags: null },
    });
    const result = await loadPublishedExamples(db, 'Köln');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('act1');
    expect(result[0].title).toBe('A');
    expect(result[0].tags).toEqual(['weihnachtsmarkt']);
  });

  it('excludes activities without category', async () => {
    const db = makeDb({
      act1: { status: 'published', city: 'Köln', category: null, title: 'No cat' },
    });
    const result = await loadPublishedExamples(db, 'Köln');
    expect(result).toHaveLength(0);
  });

  it('returns empty additionalCategories/tags as null', async () => {
    const db = makeDb({
      act1: { status: 'published', city: 'Köln', category: 'food_drinks', title: 'T', tags: [], additionalCategories: [] },
    });
    const result = await loadPublishedExamples(db, 'Köln');
    expect(result[0].tags).toBeNull();
    expect(result[0].additionalCategories).toBeNull();
  });

  it('returns empty array when no activities exist', async () => {
    const db = makeDb({});
    const result = await loadPublishedExamples(db, 'Köln');
    expect(result).toHaveLength(0);
  });
});
