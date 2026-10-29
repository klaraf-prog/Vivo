'use strict';

const {
  CATEGORIES,
  CATEGORY_IDS,
  LEGACY_CATEGORY_IDS,
  TAGS_BY_CATEGORY,
  TAG_LABELS,
  ALL_TAGS_FLAT,
  ALL_TAG_IDS,
  validateCategory,
  validateTags,
  splitTags,
  validateAdditionalCategories,
} = require('../netlify/functions/_taxonomy');

describe('CATEGORIES', () => {
  test('has exactly 8 entries', () => {
    expect(CATEGORIES).toHaveLength(8);
  });

  test('all expected IDs are present', () => {
    const ids = CATEGORIES.map(c => c.id);
    expect(ids).toContain('food_drinks');
    expect(ids).toContain('kultur_entertainment');
    expect(ids).toContain('sport_bewegung');
    expect(ids).toContain('kreativitaet_workshops');
    expect(ids).toContain('outdoor_natur');
    expect(ids).toContain('wellness_entspannung');
    expect(ids).toContain('events_nightlife');
    expect(ids).toContain('community_social');
  });

  test('every entry has id and label', () => {
    for (const c of CATEGORIES) {
      expect(typeof c.id).toBe('string');
      expect(c.id.length).toBeGreaterThan(0);
      expect(typeof c.label).toBe('string');
      expect(c.label.length).toBeGreaterThan(0);
    }
  });
});

describe('validateCategory', () => {
  test('accepts new category IDs', () => {
    expect(validateCategory('food_drinks')).toBe(true);
    expect(validateCategory('outdoor_natur')).toBe(true);
    expect(validateCategory('community_social')).toBe(true);
  });

  test('accepts legacy category IDs', () => {
    expect(validateCategory('market')).toBe(true);
    expect(validateCategory('festival')).toBe(true);
    expect(validateCategory('concert')).toBe(true);
    expect(validateCategory('nightlife')).toBe(true);
    expect(validateCategory('other')).toBe(true);
  });

  test('rejects unknown category', () => {
    expect(validateCategory('unknown')).toBe(false);
    expect(validateCategory('Food')).toBe(false);
    expect(validateCategory('food_drinks_extra')).toBe(false);
  });

  test('rejects null, undefined, empty string', () => {
    expect(validateCategory(null)).toBe(false);
    expect(validateCategory(undefined)).toBe(false);
    expect(validateCategory('')).toBe(false);
  });

  test('rejects non-string types', () => {
    expect(validateCategory(123)).toBe(false);
    expect(validateCategory({})).toBe(false);
  });
});

describe('validateTags', () => {
  test('returns empty array for non-array input', () => {
    expect(validateTags(null)).toEqual([]);
    expect(validateTags(undefined)).toEqual([]);
    expect(validateTags('konzert')).toEqual([]);
    expect(validateTags({})).toEqual([]);
  });

  test('returns empty array for empty array', () => {
    expect(validateTags([])).toEqual([]);
  });

  test('accepts valid tags', () => {
    const result = validateTags(['konzert', 'yoga']);
    expect(result).toContain('konzert');
    expect(result).toContain('yoga');
  });

  test('strips unknown tags', () => {
    const result = validateTags(['konzert', 'notavalidtag', 'yoga']);
    expect(result).toContain('konzert');
    expect(result).toContain('yoga');
    expect(result).not.toContain('notavalidtag');
  });

  test('deduplicates tags', () => {
    const result = validateTags(['konzert', 'konzert', 'yoga']);
    expect(result.filter(t => t === 'konzert')).toHaveLength(1);
  });

  test('enforces max 5 tags', () => {
    const input = ['restaurant', 'cafe', 'brunch', 'konzert', 'theater', 'yoga', 'spa'];
    const result = validateTags(input);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  test('accepts tags from different categories', () => {
    const input = ['konzert', 'wandern', 'yoga', 'party', 'meetup'];
    const result = validateTags(input);
    expect(result).toHaveLength(5);
  });

  test('festival_tag is valid (not festival)', () => {
    expect(validateTags(['festival_tag'])).toContain('festival_tag');
    expect(validateTags(['festival'])).not.toContain('festival');
  });
});

describe('TAG_LABELS', () => {
  test('every tag ID in ALL_TAGS_FLAT has a label', () => {
    for (const tag of ALL_TAGS_FLAT) {
      expect(TAG_LABELS[tag]).toBeDefined();
      expect(typeof TAG_LABELS[tag]).toBe('string');
      expect(TAG_LABELS[tag].length).toBeGreaterThan(0);
    }
  });

  test('no extra labels beyond known tags', () => {
    for (const key of Object.keys(TAG_LABELS)) {
      expect(ALL_TAG_IDS.has(key)).toBe(true);
    }
  });
});

describe('TAGS_BY_CATEGORY', () => {
  test('every new category has tags', () => {
    for (const { id } of CATEGORIES) {
      expect(Array.isArray(TAGS_BY_CATEGORY[id])).toBe(true);
      expect(TAGS_BY_CATEGORY[id].length).toBeGreaterThan(0);
    }
  });

  test('ALL_TAGS_FLAT contains all tags', () => {
    const manual = Object.values(TAGS_BY_CATEGORY).flat();
    expect(ALL_TAGS_FLAT).toEqual(manual);
  });

  test('ALL_TAG_IDS contains all tag IDs', () => {
    for (const tag of ALL_TAGS_FLAT) {
      expect(ALL_TAG_IDS.has(tag)).toBe(true);
    }
  });
});

describe('splitTags', () => {
  test('returns empty valid and unknown for non-array input', () => {
    expect(splitTags(null)).toEqual({ valid: [], unknown: [] });
    expect(splitTags('konzert')).toEqual({ valid: [], unknown: [] });
    expect(splitTags({})).toEqual({ valid: [], unknown: [] });
  });

  test('separates known from unknown tags', () => {
    const result = splitTags(['konzert', 'notavalidtag', 'yoga']);
    expect(result.valid).toContain('konzert');
    expect(result.valid).toContain('yoga');
    expect(result.unknown).toContain('notavalidtag');
  });

  test('caps valid at 5, collects all unknown', () => {
    const input = ['restaurant', 'cafe', 'brunch', 'konzert', 'theater', 'yoga', 'badtag1', 'badtag2'];
    const result = splitTags(input);
    expect(result.valid.length).toBeLessThanOrEqual(5);
    expect(result.unknown).toContain('badtag1');
    expect(result.unknown).toContain('badtag2');
  });

  test('deduplicates tags', () => {
    const result = splitTags(['konzert', 'konzert', 'yoga', 'unknowntag', 'unknowntag']);
    expect(result.valid.filter(t => t === 'konzert')).toHaveLength(1);
    expect(result.unknown.filter(t => t === 'unknowntag')).toHaveLength(1);
  });

  test('returns empty unknown when all tags are known', () => {
    const result = splitTags(['konzert', 'yoga']);
    expect(result.unknown).toHaveLength(0);
  });

  test('returns empty valid when all tags are unknown', () => {
    const result = splitTags(['badtag1', 'badtag2']);
    expect(result.valid).toHaveLength(0);
    expect(result.unknown).toContain('badtag1');
  });
});

describe('validateAdditionalCategories', () => {
  test('accepts valid new category IDs', () => {
    const result = validateAdditionalCategories(['kultur_entertainment', 'sport_bewegung'], 'food_drinks');
    expect(result).toContain('kultur_entertainment');
    expect(result).toContain('sport_bewegung');
  });

  test('rejects legacy category IDs', () => {
    const result = validateAdditionalCategories(['market', 'festival', 'food_drinks'], null);
    expect(result).not.toContain('market');
    expect(result).not.toContain('festival');
    expect(result).toContain('food_drinks');
  });

  test('rejects the primary category ID', () => {
    const result = validateAdditionalCategories(['food_drinks', 'sport_bewegung'], 'food_drinks');
    expect(result).not.toContain('food_drinks');
    expect(result).toContain('sport_bewegung');
  });

  test('deduplicates entries', () => {
    const result = validateAdditionalCategories(['sport_bewegung', 'sport_bewegung', 'yoga_extra'], null);
    expect(result.filter(id => id === 'sport_bewegung')).toHaveLength(1);
  });

  test('returns empty array for non-array input', () => {
    expect(validateAdditionalCategories(null, null)).toEqual([]);
    expect(validateAdditionalCategories('food_drinks', null)).toEqual([]);
  });

  test('returns empty array when all are rejected', () => {
    const result = validateAdditionalCategories(['market', 'festival'], null);
    expect(result).toHaveLength(0);
  });

  test('works with no primary ID', () => {
    const result = validateAdditionalCategories(['food_drinks', 'sport_bewegung'], null);
    expect(result).toContain('food_drinks');
    expect(result).toContain('sport_bewegung');
  });
});
