'use strict';
const { initAdmin, verifyStudioToken, json, makeId } = require('./_studio-shared');

const ALLOWED_TYPES = ['website', 'open-data', 'api', 'social', 'other'];

// Normalise a URL for duplicate detection: lowercase, strip trailing slash and fragment.
function normaliseUrl(raw) {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    return u.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return raw.trim().toLowerCase().replace(/\/$/, '');
  }
}

function safeKey(normUrl) {
  return normUrl.replace(/[.#$[\]/]/g, '_').slice(0, 768);
}

exports.handler = async (event) => {
  const method = event.httpMethod;

  // ── GET — list all sources (researcher/editor/superadmin) ─────────
  if (method === 'GET') {
    const actor = await verifyStudioToken(
      event.headers['authorization'],
      ['researcher', 'editor', 'superadmin'],
    );
    if (!actor) return json(403, { error: 'forbidden' });

    const db   = initAdmin().database();
    const snap = await db.ref('discoverySources').once('value');
    return json(200, { sources: snap.val() || {} });
  }

  // ── POST — add a new source (editor/superadmin) ───────────────────
  if (method === 'POST') {
    const actor = await verifyStudioToken(
      event.headers['authorization'],
      ['editor', 'superadmin'],
    );
    if (!actor) return json(403, { error: 'forbidden' });

    let payload;
    try { payload = JSON.parse(event.body); }
    catch { return json(400, { error: 'invalid-json' }); }

    const { url, name, city, sourceType, notes } = payload;
    if (!url)        return json(400, { error: 'url required' });
    if (!name)       return json(400, { error: 'name required' });
    if (!city)       return json(400, { error: 'city required' });
    if (!sourceType) return json(400, { error: 'sourceType required' });
    if (!ALLOWED_TYPES.includes(sourceType)) {
      return json(400, { error: `sourceType must be one of: ${ALLOWED_TYPES.join(', ')}` });
    }

    // Basic URL validation
    try { new URL(url.trim()); }
    catch { return json(400, { error: 'url is not a valid URL' }); }

    const normUrl = normaliseUrl(url);
    const hashKey = safeKey(normUrl);

    const db       = initAdmin().database();
    const hashSnap = await db.ref(`discoverySourceUrls/${hashKey}`).once('value');
    if (hashSnap.exists()) {
      return json(409, { error: 'duplicate-url', existingId: hashSnap.val() });
    }

    const now      = Date.now();
    const sourceId = makeId('src');
    const logId    = makeId('log');

    const source = {
      url:        url.trim(),
      normUrl,
      name:       name.trim(),
      city:       city.trim(),
      sourceType,
      active:     true,
      notes:      notes ? notes.trim() : null,
      addedAt:    now,
      addedBy:    actor.uid,
      updatedAt:  now,
    };

    await db.ref().update({
      [`discoverySources/${sourceId}`]:     source,
      [`discoverySourceUrls/${hashKey}`]:   sourceId,
      [`studioAuditLog/${logId}`]: {
        action:     'source-add',
        actorUid:   actor.uid,
        actorEmail: actor.email || null,
        actorRole:  actor.studioRole,
        sourceId,
        details:    `Added source: ${name} (${url.trim()})`,
        timestamp:  now,
      },
    });

    return json(201, { sourceId });
  }

  // ── PATCH — toggle active / update name/notes (editor/superadmin) ─
  if (method === 'PATCH') {
    const actor = await verifyStudioToken(
      event.headers['authorization'],
      ['editor', 'superadmin'],
    );
    if (!actor) return json(403, { error: 'forbidden' });

    let payload;
    try { payload = JSON.parse(event.body); }
    catch { return json(400, { error: 'invalid-json' }); }

    const { sourceId, ...fields } = payload;
    if (!sourceId) return json(400, { error: 'sourceId required' });

    const db   = initAdmin().database();
    const snap = await db.ref(`discoverySources/${sourceId}`).once('value');
    if (!snap.exists()) return json(404, { error: 'source not found' });

    const updates = { [`discoverySources/${sourceId}/updatedAt`]: Date.now() };
    if (typeof fields.active === 'boolean') {
      updates[`discoverySources/${sourceId}/active`] = fields.active;
    }
    if (typeof fields.name === 'string' && fields.name.trim()) {
      updates[`discoverySources/${sourceId}/name`] = fields.name.trim();
    }
    if (typeof fields.notes === 'string') {
      updates[`discoverySources/${sourceId}/notes`] = fields.notes.trim() || null;
    }

    await db.ref().update(updates);
    return json(200, { ok: true });
  }

  // ── DELETE — remove a source (editor/superadmin) ──────────────────
  if (method === 'DELETE') {
    const actor = await verifyStudioToken(
      event.headers['authorization'],
      ['editor', 'superadmin'],
    );
    if (!actor) return json(403, { error: 'forbidden' });

    let payload;
    try { payload = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'invalid-json' }); }

    const { sourceId } = payload;
    if (!sourceId) return json(400, { error: 'sourceId required' });

    const db   = initAdmin().database();
    const snap = await db.ref(`discoverySources/${sourceId}`).once('value');
    if (!snap.exists()) return json(404, { error: 'source not found' });

    const source  = snap.val();
    const hashKey = safeKey(source.normUrl || normaliseUrl(source.url));
    const logId   = makeId('log');
    const now     = Date.now();

    await db.ref().update({
      [`discoverySources/${sourceId}`]:   null,
      [`discoverySourceUrls/${hashKey}`]: null,
      [`studioAuditLog/${logId}`]: {
        action:     'source-delete',
        actorUid:   actor.uid,
        actorEmail: actor.email || null,
        actorRole:  actor.studioRole,
        sourceId,
        details:    `Deleted source: ${source.name} (${source.url})`,
        timestamp:  now,
      },
    });

    return json(200, { ok: true });
  }

  return json(405, { error: 'method-not-allowed' });
};
