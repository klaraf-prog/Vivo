# Someday PWA — End-to-End Test Plan

All tests run against the Firebase Local Emulator Suite (Auth 9099, RTDB 9000)
with Netlify Dev (`netlify dev`) on port 8888.  
No production data is read or written at any point.

---

## Prerequisites

```bash
firebase emulators:start --only auth,database
netlify dev
```

Import seed data before each run:
```bash
firebase emulators:export ./tests/emulator-seed --force   # once, to create it
firebase emulators:exec --only auth,database \
  'firebase emulators:import ./tests/emulator-seed'       # before each suite
```

---

## Test Suite A — Registration

| ID | Step | Expected |
|----|------|----------|
| A1 | Open `http://localhost:8888`, navigate to Profile tab | Sign-in / Create account tabs visible |
| A2 | Click "Create account", fill name "Tester", email `tester@test.local`, password `pass123` | `createUserWithEmailAndPassword` succeeds; avatar letter "T" appears in header |
| A3 | Reload page | User remains signed in (Firebase LOCAL persistence) |
| A4 | Check RTDB emulator: `users/$uid.displayName` | Value is "Tester" |
| A5 | Try to create a second account with the same email | Auth error displayed: "email already in use" |

---

## Test Suite B — Sign-In / Sign-Out

| ID | Step | Expected |
|----|------|----------|
| B1 | Sign out from Profile → Settings | Profile tab shows sign-in form |
| B2 | Sign in with `tester@test.local` / `pass123` | Profile tab shows name "Tester"; Calendar/Spaces show real data |
| B3 | Sign in with wrong password | Error message shown; user remains unauthenticated |

---

## Test Suite C — Calendar (dynamic week)

| ID | Step | Expected |
|----|------|----------|
| C1 | Open Calendar tab when signed in | Displayed week header matches the current ISO week (Mon–Sun) |
| C2 | Click "←" once | Previous week shown; "Today" button visible |
| C3 | Click "Today" | Returns to the current week (offset 0) |
| C4 | RSVP to an invited event with "✓ Going" | RSVP button highlighted; event appears in calendar grid |
| C5 | Reload page | RSVP persists (data stored in RTDB) |

---

## Test Suite D — Friend Requests

| ID | Step | Expected |
|----|------|----------|
| D1 | In Profile → Friends, type "Tester2" in search box, click Search | Results list shows "Tester2" with "Add friend" button |
| D2 | Click "Add friend" | Button changes to "Sent ✓" |
| D3 | Sign in as Tester2, open Friends tab | Friend request from Tester visible with Accept/Decline buttons |
| D4 | Click "Accept" | Tester2's friends list now shows Tester; Tester's list shows Tester2 |
| D5 | As Tester, click "Remove" next to Tester2 | Removed from both users' friends lists |
| D6 | As Tester2, decline a new request | Request disappears; no friendship created |

---

## Test Suite E — Space Creation

| ID | Step | Expected |
|----|------|----------|
| E1 | Open Spaces tab, click "+" float button | Space creation sheet opens |
| E2 | Enter "Run Club", leave members empty, submit | New space appears in Spaces list |
| E3 | Click space → Members tab | Shows current user as only member |
| E4 | Create space "Weekend Crew" with Tester2's UID in members | Both users see "Weekend Crew" in their Spaces list |
| E5 | Create space with empty name | Error "Please enter a group name." shown; no RTDB write |

---

## Test Suite F — Event Creation in a Space

| ID | Step | Expected |
|----|------|----------|
| F1 | Inside "Run Club", click "+ Create group event" | Creates event linked to space |
| F2 | Reload Calendar tab | New event appears in the calendar grid under "Run Club" colour |
| F3 | RSVP "✗ No" to the event | `userEvents/$uid/$eventId` = `'nein'` in RTDB |

---

## Test Suite G — Image Fallbacks

| ID | Step | Expected |
|----|------|----------|
| G1 | Open Discover tab with network throttled so images fail | Activity cards show category-colour gradient backgrounds instead of broken images |
| G2 | Re-enable network | Images load normally; fallback gradient replaced by real image |

---

## Test Suite H — Demo Data Separation

| ID | Step | Expected |
|----|------|----------|
| H1 | Signed-out: open Calendar | Demo events (Dentist, Dinner with Leo, Social run) visible |
| H2 | Sign in as Tester | Demo events hidden; only real Firebase events shown |
| H3 | Open browser console | Log message `[someday] Showing demo activities` NOT present when real activities exist |

---

## Test Suite I — Admin Panel (Studio)

| ID | Step | Expected |
|----|------|----------|
| I1 | Open `http://localhost:8888/admin` | Sign-in form shown |
| I2 | Sign in with a user that has `studioRole: editor` custom claim | Dashboard tab shown with audit log and stats |
| I3 | Edit a suggestion's title | Success toast; change reflected in RTDB emulator |
| I4 | Sign in as a user without studioRole | 403 / "Access denied" shown; no data tab visible |

---

## Test Suite J — Security (server-side)

| ID | Step | Expected |
|----|------|----------|
| J1 | Call `POST /.netlify/functions/friends` with no token | HTTP 401 |
| J2 | Call with a valid token but `action: 'follow'` | HTTP 400 |
| J3 | Call `POST /.netlify/functions/space-create` with name `` (empty) | HTTP 400 |
| J4 | Call `GET /.netlify/functions/user-search?q=a` (one char) | HTTP 400 |
| J5 | Call `POST /.netlify/functions/user-profile` with `username: 'AB'` (uppercase) | HTTP 400 (username regex) |
| J6 | Try to accept a friend request that does not exist | HTTP 404 |

---

## Automated regression

```bash
npm test   # runs tests/studio.test.js — 94 unit tests
```

All 94 tests must pass before any push to the feature branch.
