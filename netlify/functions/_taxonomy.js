'use strict';
// Controlled vocabulary for categories and tags.
// Stable internal IDs, independent of display labels.

const CATEGORIES = [
  { id: 'food_drinks',           label: 'Food & Drinks' },
  { id: 'kultur_entertainment',  label: 'Kultur & Entertainment' },
  { id: 'sport_bewegung',        label: 'Sport & Bewegung' },
  { id: 'kreativitaet_workshops',label: 'Kreativität & Workshops' },
  { id: 'outdoor_natur',         label: 'Outdoor & Natur' },
  { id: 'wellness_entspannung',  label: 'Wellness & Entspannung' },
  { id: 'events_nightlife',      label: 'Events & Nightlife' },
  { id: 'community_social',      label: 'Community & Social' },
];

const CATEGORY_IDS = new Set(CATEGORIES.map(c => c.id));

// Legacy category IDs from discovery pipeline v1 — kept valid for existing drafts/activities
const LEGACY_CATEGORY_IDS = new Set([
  'market','festival','concert','exhibition','sport',
  'outdoor','food','culture','family','nightlife','other',
]);

const TAGS_BY_CATEGORY = {
  food_drinks:            ['restaurant','cafe','brunch','tasting','street_food','kochkurs'],
  kultur_entertainment:   ['konzert','theater','musical','comedy','kino','ausstellung','museum'],
  sport_bewegung:         ['fitness','tanzen','bouldern','ballsport','laufen','wassersport'],
  kreativitaet_workshops: ['toepfern','malen','diy','fotografie','handwerk','workshop'],
  outdoor_natur:          ['wandern','radfahren','picknick','naturerlebnis','ausflug','spaziergang'],
  wellness_entspannung:   ['spa','sauna','massage','meditation','yoga','achtsamkeit'],
  events_nightlife:       ['festival_tag','party','weihnachtsmarkt','stadtfest','flohmarkt','club'],
  community_social:       ['meetup','spieleabend','stammtisch','networking','ehrenamt','sprachaustausch'],
};

// Note: 'festival_tag' (not 'festival') avoids collision with legacy category ID 'festival'

const TAG_LABELS = {
  restaurant:'Restaurant', cafe:'Café', brunch:'Brunch', tasting:'Tasting',
  street_food:'Street Food', kochkurs:'Kochkurs',
  konzert:'Konzert', theater:'Theater', musical:'Musical', comedy:'Comedy',
  kino:'Kino', ausstellung:'Ausstellung', museum:'Museum',
  fitness:'Fitness', tanzen:'Tanzen', bouldern:'Bouldern', ballsport:'Ballsport',
  laufen:'Laufen', wassersport:'Wassersport',
  toepfern:'Töpfern', malen:'Malen', diy:'DIY', fotografie:'Fotografie',
  handwerk:'Handwerk', workshop:'Workshop',
  wandern:'Wandern', radfahren:'Radfahren', picknick:'Picknick',
  naturerlebnis:'Naturerlebnis', ausflug:'Ausflug', spaziergang:'Spaziergang',
  spa:'Spa', sauna:'Sauna', massage:'Massage', meditation:'Meditation',
  yoga:'Yoga', achtsamkeit:'Achtsamkeit',
  festival_tag:'Festival', party:'Party', weihnachtsmarkt:'Weihnachtsmarkt',
  stadtfest:'Stadtfest', flohmarkt:'Flohmarkt', club:'Club',
  meetup:'Meetup', spieleabend:'Spieleabend', stammtisch:'Stammtisch',
  networking:'Networking', ehrenamt:'Ehrenamt', sprachaustausch:'Sprachaustausch',
};

const ALL_TAGS_FLAT = Object.values(TAGS_BY_CATEGORY).flat();
const ALL_TAG_IDS = new Set(ALL_TAGS_FLAT);

/** Returns true if id is a current or legacy category id. */
function validateCategory(id) {
  if (!id || typeof id !== 'string') return false;
  return CATEGORY_IDS.has(id) || LEGACY_CATEGORY_IDS.has(id);
}

/** Returns filtered array: only known tag IDs, max 5, no duplicates. */
function validateTags(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  return arr.filter(t => {
    if (typeof t !== 'string' || !ALL_TAG_IDS.has(t) || seen.has(t)) return false;
    seen.add(t);
    return true;
  }).slice(0, 5);
}

module.exports = {
  CATEGORIES, CATEGORY_IDS, LEGACY_CATEGORY_IDS,
  TAGS_BY_CATEGORY, TAG_LABELS, ALL_TAGS_FLAT, ALL_TAG_IDS,
  validateCategory, validateTags,
};
