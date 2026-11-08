'use strict';
// One-time setup: deploy database.rules.json to the production Firebase RTDB.
//
// Protection: requires the header  X-Deploy-Secret: <DEPLOY_RULES_SECRET>
// Set DEPLOY_RULES_SECRET in Netlify → Site configuration → Environment variables.
//
// Usage (curl):
//   curl -X POST https://<your-site>.netlify.app/.netlify/functions/deploy-database-rules \
//        -H "X-Deploy-Secret: <your-secret>"
//
// Or open in a browser with:
//   https://<your-site>.netlify.app/.netlify/functions/deploy-database-rules?secret=<your-secret>
//
// After rules are deployed, this function is no longer needed.
// For security, delete or disable it once the rules are live.

const path = require('path');
const fs   = require('fs');
const { initAdmin, json } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  // Verify secret
  const secret   = process.env.DEPLOY_RULES_SECRET;
  const provided = (event.headers || {})['x-deploy-secret']
                 || (event.queryStringParameters || {}).secret
                 || '';

  if (!secret) {
    return json(500, { error: 'DEPLOY_RULES_SECRET env var is not set in Netlify' });
  }
  if (provided !== secret) {
    return json(401, { error: 'Unauthorized — provide the correct X-Deploy-Secret header or ?secret= query param' });
  }

  // Read and validate the rules file
  const rulesPath = path.join(__dirname, '../../database.rules.json');
  let rulesText;
  try {
    rulesText = fs.readFileSync(rulesPath, 'utf8');
    JSON.parse(rulesText); // validate JSON
  } catch (e) {
    return json(500, { error: 'Failed to read database.rules.json: ' + e.message });
  }

  // Get an OAuth2 access token from the Firebase service account
  let accessToken;
  try {
    const app      = initAdmin();
    const tokenRes = await app.options.credential.getAccessToken();
    accessToken    = tokenRes.access_token;
  } catch (e) {
    return json(500, { error: 'Failed to get service account token: ' + e.message });
  }

  const dbUrl = (process.env.FIREBASE_RTDB_URL || '').replace(/\/$/, '');
  if (!dbUrl) return json(500, { error: 'FIREBASE_RTDB_URL not set' });

  // Deploy rules via Firebase RTDB REST API
  try {
    const res = await fetch(`${dbUrl}/.settings/rules.json`, {
      method:  'PUT',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: rulesText,
    });

    const responseText = await res.text();
    if (!res.ok) {
      return json(500, {
        error:  'Firebase rejected the rules deployment',
        status: res.status,
        detail: responseText,
      });
    }

    return json(200, {
      ok:      true,
      message: 'RTDB security rules deployed successfully to ' + dbUrl,
      status:  res.status,
    });
  } catch (e) {
    return json(500, { error: 'HTTP request to Firebase failed: ' + e.message });
  }
};
