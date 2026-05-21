// Netlify Scheduled Function: sends motivational push notifications.
// Schedule defined in netlify.toml: runs every hour UTC 15–18 (= 17–20 CET/CEST).
//
// Required env vars (add in Netlify dashboard → Site config → Environment variables):
//   VAPID_PUBLIC_KEY   — from VAPID key pair (see README or generate with web-push)
//   VAPID_PRIVATE_KEY  — private half of VAPID key pair  (keep secret)
//   VAPID_CONTACT      — mailto: or https: contact for push service, e.g. mailto:admin@example.com
//   FIREBASE_API_KEY   — Firebase Web API key (used to get an anonymous auth token)
//   FIREBASE_RTDB_URL  — e.g. https://vivo-mvp-default-rtdb.europe-west1.firebasedatabase.app

const webpush = require('web-push');

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_CONTACT = process.env.VAPID_CONTACT || 'mailto:admin@vivo-app.netlify.app';
const RTDB_URL      = (process.env.FIREBASE_RTDB_URL || '').replace(/\/$/, '');
const FIREBASE_KEY  = process.env.FIREBASE_API_KEY;

const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
const TWO_DAYS_MS  = 2 * 24 * 60 * 60 * 1000;
const ONE_WEEK_MS  = 7 * 24 * 60 * 60 * 1000;

const MOTIVATE_MESSAGES = [
  'Du hast deine Freunde schon eine Weile nicht gesehen — wie wäre es mit einem Event? 🎉',
  'Es ist Zeit für etwas Gemeinsames — plan ein Event mit deinen Freunden! 🗓️',
  'Wann habt ihr euch zuletzt getroffen? Zeit, etwas zu organisieren! 👋',
];

// ── Firebase helpers ──────────────────────────────────────────────────────────

async function getAnonToken() {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }),
    }
  );
  if (!res.ok) throw new Error('Firebase anon sign-up failed: ' + res.status);
  const d = await res.json();
  return d.idToken;
}

async function rtdbGet(path, token) {
  const res = await fetch(`${RTDB_URL}/${path}.json?auth=${token}`);
  if (!res.ok) return null;
  const text = await res.text();
  return text === 'null' ? null : JSON.parse(text);
}

async function rtdbSet(path, value, token) {
  await fetch(`${RTDB_URL}/${path}.json?auth=${token}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

exports.handler = async () => {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.error('motivate: VAPID keys not configured');
    return { statusCode: 200 };
  }

  webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);

  // Double-check the hour window in case cron fires slightly early/late.
  // Compare against Berlin time (UTC+1 winter / UTC+2 summer).
  const now   = new Date();
  const month = now.getUTCMonth(); // 0-based
  const offset = (month >= 2 && month <= 9) ? 2 : 1; // CEST vs CET
  const berlinHour = (now.getUTCHours() + offset) % 24;
  if (berlinHour < 17 || berlinHour >= 20) {
    console.log('motivate: outside 17–20h window, skipping');
    return { statusCode: 200 };
  }

  let token;
  try {
    token = await getAnonToken();
  } catch(e) {
    console.error('motivate: could not get Firebase token:', e.message);
    return { statusCode: 200 };
  }

  const users = await rtdbGet('users', token);
  if (!users) { console.log('motivate: no users found'); return { statusCode: 200 }; }

  const nowTs = Date.now();
  let sent = 0;

  for (const [uid, user] of Object.entries(users)) {
    try {
      const s = user.settings || {};

      // Skip: motivation notifs explicitly disabled or push disabled.
      if (s.motivationNotifs === false) continue;
      if (s.pushEnabled === false) continue;

      // Skip: no push subscription stored.
      if (!user.pushSub || !user.pushSub.endpoint) continue;

      // Skip: already sent within the past week.
      if (user.lastMotivationTs && nowTs - user.lastMotivationTs < ONE_WEEK_MS) continue;

      // Skip: user was active in the last 5 days.
      if (user.lastActivityTs && nowTs - user.lastActivityTs < FIVE_DAYS_MS) continue;

      // Skip: user has an event coming up in the next 2 days.
      const userEvents = await rtdbGet('userEvents/' + uid, token);
      if (userEvents) {
        const eventIds = Object.keys(userEvents).filter(k => userEvents[k] !== 'nein');
        const dateReads = await Promise.all(
          eventIds.map(id => rtdbGet('events/' + id + '/date', token))
        );
        const hasUpcoming = dateReads.some(dateStr => {
          if (!dateStr) return false;
          const evTs = new Date(dateStr + 'T12:00:00').getTime();
          return evTs >= nowTs && evTs <= nowTs + TWO_DAYS_MS;
        });
        if (hasUpcoming) continue;
      }

      // All conditions met — send push.
      const body = MOTIVATE_MESSAGES[Math.floor(Math.random() * MOTIVATE_MESSAGES.length)];
      const payload = JSON.stringify({ title: 'vivo', body, type: 'motivate', url: '/' });

      await webpush.sendNotification(user.pushSub, payload);
      await rtdbSet('users/' + uid + '/lastMotivationTs', nowTs, token);
      sent++;
      console.log('motivate: sent to', uid);
    } catch(err) {
      // 410 = subscription expired/invalid — clean it up
      if (err.statusCode === 410) {
        await rtdbSet('users/' + uid + '/pushSub', null, token).catch(() => {});
      }
      console.warn('motivate: error for', uid, err.statusCode || err.message);
    }
  }

  console.log(`motivate: done. sent=${sent}`);
  return { statusCode: 200 };
};
