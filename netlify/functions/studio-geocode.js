'use strict';
// Manual geocoding via Nominatim (OpenStreetMap) for a single address query.
// Only for occasional manual use in Studio — not for automated mass geocoding.
//
// Nominatim usage policy (https://operations.osmfoundation.org/policies/nominatim/):
//   - Maximum 1 request/second (naturally satisfied by manual button clicks)
//   - Must send a descriptive User-Agent with contact email
//   - Bulk geocoding and automated crawling are not permitted
//   - Attribution already present via Leaflet/OpenStreetMap tiles
const { verifyStudioToken, json } = require('./_studio-shared');

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
// Identifies the app and provides a contact address as required by OSM policy
const USER_AGENT = 'SomedayApp/1.0 (mailto:klara.faiss@gmail.com)';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const actor = await verifyStudioToken(event.headers['authorization'], ['editor', 'superadmin']);
  if (!actor) return json(403, { error: 'Forbidden' });

  let payload;
  try { payload = JSON.parse(event.body); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { query } = payload;
  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return json(400, { error: 'query muss mindestens 2 Zeichen enthalten' });
  }

  const q = query.trim();
  // countrycodes=de keeps results focused on Germany; addressdetails=0 reduces payload
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(q)}&format=jsonv2&limit=5&addressdetails=0&countrycodes=de`;

  let raw;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'de',
        'Accept': 'application/json',
      },
    });
    if (!res.ok) return json(502, { error: `Nominatim HTTP ${res.status}` });
    raw = await res.json();
  } catch (err) {
    return json(502, { error: 'Nominatim nicht erreichbar: ' + err.message });
  }

  const candidates = (Array.isArray(raw) ? raw : [])
    .map(r => ({
      displayName: r.display_name || '',
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      type: r.type || r.class || '',
    }))
    .filter(c => isFinite(c.lat) && isFinite(c.lng));

  return json(200, { candidates });
};
