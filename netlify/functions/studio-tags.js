'use strict';
// Tag catalog management: GET returns merged baseline+Firebase catalog,
// POST (superadmin only) creates/updates/deactivates/reactivates tags.
const { initAdmin, verifyStudioToken, json } = require('./_studio-shared');
const { TAG_LABELS } = require('./_taxonomy');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const db = initAdmin().database();

  // ── GET: public read of merged tag catalog ───────────────────────
  if (event.httpMethod === 'GET') {
    const snap = await db.ref('/config/tagCatalog').once('value');
    const overrides = snap.val() || {};
    const catalog = {};
    for (const [id, label] of Object.entries(TAG_LABELS)) {
      catalog[id] = { id, label, synonyms: [], active: true, baseline: true, ...(overrides[id] || {}) };
    }
    for (const [id, entry] of Object.entries(overrides)) {
      if (!catalog[id]) catalog[id] = { id, baseline: false, ...entry };
    }
    const tags = Object.values(catalog).sort((a, b) => a.label.localeCompare(b.label, 'de'));
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ tags }) };
  }

  // ── POST: superadmin-only mutations ─────────────────────────────
  if (event.httpMethod === 'POST') {
    const actor = await verifyStudioToken(event.headers['authorization'], ['superadmin']);
    if (!actor) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'superadmin_required' }) };

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid_json' }); }

    const { action, id, label, synonyms } = body;

    if (!action || !id || typeof id !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(id)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_id' }) };
    }

    const now = new Date().toISOString();

    if (action === 'upsert') {
      if (typeof label !== 'string' || label.trim().length < 1) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'label_required' }) };
      }
      const existSnap = await db.ref(`/config/tagCatalog/${id}`).once('value');
      const existing = existSnap.val() || {};
      const entry = {
        ...existing,
        label: label.trim(),
        synonyms: Array.isArray(synonyms) ? synonyms.filter(s => typeof s === 'string').slice(0, 10) : (existing.synonyms || []),
        active: existing.active !== false,
        updatedAt: now,
        updatedBy: actor.uid,
      };
      if (!existing.createdAt) { entry.createdAt = now; entry.createdBy = actor.uid; }
      await db.ref(`/config/tagCatalog/${id}`).set(entry);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, id, entry }) };
    }

    if (action === 'deactivate' || action === 'reactivate') {
      await db.ref(`/config/tagCatalog/${id}`).update({ active: action === 'reactivate', updatedAt: now, updatedBy: actor.uid });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'unknown_action' }) };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method_not_allowed' }) };
};
