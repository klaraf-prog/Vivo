// Netlify Function: POST /.netlify/functions/send-email
// Required env vars:
//   RESEND_API_KEY       — from Resend dashboard
//   RESEND_FROM          — verified sender, e.g. "vivo <hi@yourdomain.com>"
//   FIREBASE_API_KEY     — Firebase Web API key (public, used for token verification)
//   FIREBASE_RTDB_URL    — e.g. https://vivo-mvp-default-rtdb.europe-west1.firebasedatabase.app

const { Resend } = require('resend');

const resend       = new Resend(process.env.RESEND_API_KEY);
const FROM         = process.env.RESEND_FROM || 'vivo <onboarding@resend.dev>';
const FIREBASE_KEY = process.env.FIREBASE_API_KEY;
const RTDB_URL     = (process.env.FIREBASE_RTDB_URL || '').replace(/\/$/, '');

// Production URL fallback (DEPLOY_PRIME_URL is set by Netlify to the branch's stable URL)
const DEFAULT_APP_URL = process.env.DEPLOY_PRIME_URL || process.env.URL || 'https://vivo-app.netlify.app';

// Only allow origins that are Netlify deploy URLs or the configured production URL.
// This prevents a compromised token from injecting arbitrary URLs into emails.
function sanitiseOrigin(origin) {
  if (!origin) return DEFAULT_APP_URL;
  if (/^https:\/\/[a-z0-9-]+\.netlify\.app$/.test(origin)) return origin;
  if (origin === (process.env.URL || '').replace(/\/$/, '')) return origin;
  return DEFAULT_APP_URL;
}

// ── Firebase helpers ──────────────────────────────────────────────────────────

async function verifyIdToken(idToken) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
  );
  if (!res.ok) return null;
  const d = await res.json();
  return d.users?.[0] ?? null;
}

async function getRecipientSettings(recipientUid, idToken) {
  const res = await fetch(`${RTDB_URL}/users/${recipientUid}/settings.json?auth=${idToken}`);
  if (!res.ok) return null;
  return res.json();
}

// ── Email templates ───────────────────────────────────────────────────────────

const TYPE_META = {
  invite:       { subject: n => `${n} hat dich zu einem Event eingeladen`,  cta: 'Event ansehen →' },
  rsvp:         { subject: n => `${n} hat auf dein Event reagiert`,          cta: 'Event ansehen →' },
  event_edited: { subject: n => `Ein Event wurde aktualisiert`,              cta: 'Änderungen ansehen →' },
  friend:       { subject: n => `${n} hat dich als Freund hinzugefügt`,      cta: 'Profil ansehen →' },
  event_start:  { subject: () => `Dein Event startet in 2 Stunden`,          cta: 'Event ansehen →' },
  nudge:        { subject: n => `${n} erinnert dich an ein Event`,            cta: 'Event ansehen →' },
};

function buildEmail({ type, title, body, url, senderName, appUrl }) {
  const fullUrl  = url ? appUrl.replace(/\/$/, '') + url : appUrl;
  const meta     = TYPE_META[type] || { subject: () => title, cta: 'Ansehen →' };
  const subject  = meta.subject(senderName || 'Jemand');

  const html = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#F5F0E8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:40px 16px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px">

        <!-- Header -->
        <tr><td style="padding-bottom:20px">
          <span style="font-size:1.5rem;font-weight:800;color:#1A1714;letter-spacing:-.02em">vivo</span>
        </td></tr>

        <!-- Card -->
        <tr><td style="background:#fff;border-radius:16px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,.07)">

          <!-- Title -->
          <p style="margin:0 0 8px;font-size:1.125rem;font-weight:700;color:#1A1714;line-height:1.3">
            ${title}
          </p>

          <!-- Body -->
          <p style="margin:0 0 28px;font-size:.9375rem;color:#555048;line-height:1.55">
            ${body}
          </p>

          <!-- CTA -->
          <a href="${fullUrl}"
            style="display:inline-block;background:#F5A623;color:#1A1714;text-decoration:none;
                   padding:13px 26px;border-radius:10px;font-weight:600;font-size:.9375rem">
            ${meta.cta}
          </a>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 0 0;font-size:.8125rem;color:#8A847D;line-height:1.5;text-align:center">
          Du erhältst diese E-Mail, weil du E-Mail-Benachrichtigungen auf vivo aktiviert hast.<br>
          <a href="${appUrl}" style="color:#8A847D;text-decoration:underline">Einstellungen ändern</a>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html };
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // Auth
  const authHeader = event.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Missing token' }) };
  }
  const idToken = authHeader.slice(7);

  const sender = await verifyIdToken(idToken);
  if (!sender) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) };
  }

  // Parse body
  let payload;
  try { payload = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { recipientUid, type, title, body: msgBody, url, senderName, appOrigin } = payload;
  if (!recipientUid || !type || !title) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  // Resolve the app URL: trust the client's origin if it's a known Netlify domain,
  // otherwise fall back to the server-side DEPLOY_PRIME_URL / URL env var.
  const appUrl = sanitiseOrigin(appOrigin);

  // Read recipient settings — function independently validates, never trusts client
  const settings = await getRecipientSettings(recipientUid, idToken);
  if (!settings?.emailEnabled || !settings?.emailAddress) {
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: 'email not enabled' }) };
  }

  const typeMap = { invite: 'invites', rsvp: 'rsvps', event_edited: 'eventChanges', friend: 'newFriends' };
  const typeKey = typeMap[type];
  if (typeKey && settings.types?.[typeKey] === false) {
    return { statusCode: 200, headers, body: JSON.stringify({ skipped: 'type disabled' }) };
  }

  // Build and send
  const { subject, html } = buildEmail({ type, title, body: msgBody, url, senderName, appUrl });

  try {
    const result = await resend.emails.send({
      from:    FROM,
      to:      [settings.emailAddress],
      subject,
      html,
    });
    console.log('Email sent:', result.data?.id, '→', settings.emailAddress, '(origin:', appUrl, ')');
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id: result.data?.id }) };
  } catch (err) {
    console.error('Resend error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
