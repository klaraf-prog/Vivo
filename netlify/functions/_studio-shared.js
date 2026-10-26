const admin = require('firebase-admin');

let _app = null;

function initAdmin() {
  if (_app) return _app;
  if (admin.apps.length > 0) {
    _app = admin.apps[0];
    return _app;
  }
  _app = admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    ),
    databaseURL: process.env.FIREBASE_RTDB_URL,
  });
  return _app;
}

async function verifyStudioToken(authHeader, allowedRoles) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  try {
    const decoded = await initAdmin().auth().verifyIdToken(token);
    if (!decoded.studioRole) return null;
    if (allowedRoles && !allowedRoles.includes(decoded.studioRole)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function slugify(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function duplicateHash(city, category, title) {
  return `${(city || '').toLowerCase()}:${(category || '').toLowerCase()}:${slugify(title)}`;
}

function _resetForTesting() {
  _app = null;
}

module.exports = { initAdmin, verifyStudioToken, json, makeId, duplicateHash, _resetForTesting };
