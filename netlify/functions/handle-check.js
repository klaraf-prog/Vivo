'use strict';
// GET ?handle={value} — returns { available: boolean }.
// No auth required: handle availability is not sensitive.
// Called client-side during registration for real-time feedback.
const { initAdmin, json } = require('./_studio-shared');

const HANDLE_RE = /^[a-z0-9_]{2,30}$/;

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const raw = ((event.queryStringParameters || {}).handle || '').trim();
  const normalized = raw.toLowerCase();

  if (!HANDLE_RE.test(normalized)) {
    return json(200, { available: false, reason: 'invalid-format' });
  }

  try {
    const db = initAdmin().database();
    const snap = await db.ref(`handles/${normalized}`).once('value');
    return json(200, { available: !snap.exists() });
  } catch (e) {
    console.error('[someday:handle-check] error:', e.message);
    return json(500, { error: 'Check failed' });
  }
};
