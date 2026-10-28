'use strict';
// GET /.netlify/functions/health — diagnostics for server config, no auth required, no secrets exposed
const { initAdmin, json } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const checks = {
    timestamp: new Date().toISOString(),
    serviceAccountJsonSet: !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    rtdbUrlSet: !!process.env.FIREBASE_RTDB_URL,
    adminSdkInitialised: false,
    projectId: null,
    adminSdkError: null,
  };

  try {
    initAdmin();
    checks.adminSdkInitialised = true;
    try {
      checks.projectId = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}').project_id || null;
    } catch {
      // not exposed
    }
  } catch (e) {
    checks.adminSdkError = e.message;
  }

  const ok = checks.adminSdkInitialised;
  return json(ok ? 200 : 503, checks);
};
