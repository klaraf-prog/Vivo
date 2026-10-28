'use strict';
const admin = require('firebase-admin');

let _app       = null;
let _initError = null;

function initAdmin() {
  if (_app)       return _app;
  if (_initError) throw _initError;
  if (admin.apps.length > 0) { _app = admin.apps[0]; return _app; }

  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!saJson) {
    _initError = Object.assign(
      new Error('FIREBASE_SERVICE_ACCOUNT_JSON environment variable is not set'),
      { code: 'missing-env' }
    );
    throw _initError;
  }
  const dbUrl = process.env.FIREBASE_RTDB_URL;
  if (!dbUrl) {
    _initError = Object.assign(
      new Error('FIREBASE_RTDB_URL environment variable is not set'),
      { code: 'missing-env' }
    );
    throw _initError;
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(saJson);
  } catch {
    _initError = Object.assign(
      new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON'),
      { code: 'invalid-config' }
    );
    throw _initError;
  }
  try {
    _app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: dbUrl,
    });
    return _app;
  } catch (e) {
    _initError = e;
    throw _initError;
  }
}

async function verifyUserToken(authHeader) {
  if (!authHeader || !/^Bearer\s+\S/i.test(authHeader)) {
    return { decoded: null, errorStatus: 401, errorCode: 'missing-token' };
  }
  const token = authHeader.replace(/^Bearer\s+/i, '');
  let app;
  try {
    app = initAdmin();
  } catch (e) {
    console.error('[someday:auth] Firebase Admin SDK initialisation failed:', e.message);
    console.error('[someday:auth] Check that FIREBASE_SERVICE_ACCOUNT_JSON and FIREBASE_RTDB_URL are set correctly in Netlify environment variables.');
    return { decoded: null, errorStatus: 503, errorCode: e.code || 'init-error' };
  }
  try {
    const decoded = await app.auth().verifyIdToken(token);
    return { decoded, errorStatus: null, errorCode: null };
  } catch (e) {
    const code = (e.errorInfo && e.errorInfo.code) || e.code || 'unknown';
    console.warn('[someday:auth] Token verification failed:', code);
    return { decoded: null, errorStatus: 401, errorCode: code };
  }
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
  _app       = null;
  _initError = null;
}

module.exports = { initAdmin, verifyUserToken, verifyStudioToken, json, makeId, duplicateHash, _resetForTesting };
