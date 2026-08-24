# Mission Data Tracker — Build Specification

## What this is

A web app for an analog astronaut mission (AATC habitat, near Kraków).
Every mission day lasts 16 hours, split into four 4-hour sessions.
Astronauts must log in, see which data-collection tests are due in the current session,
and mark each one done. A live dashboard shows who has completed each test and who hasn't.
Only the Commander can set the mission day start time.

---

## Hosting constraints

- Hosted entirely on **GitHub Pages** (static files only — no server, no paid services).
- All persistent state is stored in **Firebase Firestore** (free Spark tier — no billing required).
- Authentication via **Firebase Authentication** (free tier, email/password).
- No backend code, no serverless functions, no databases other than Firestore.
- Single-page app: one `index.html` + vanilla JS (or a bundled React/Vue app committed to `docs/` or `gh-pages` branch).

---

## User roles

| Role | How identified | Privileges |
|---|---|---|
| Commander | Firestore `users/{uid}.role == "commander"` | Set mission day number + wake-up time; reset a day |
| Astronaut | Firestore `users/{uid}.role == "astronaut"` | Mark own tests as done; view dashboard |

There is no self-registration — accounts are created by running the seed script (see below)
before Day 1. Each crew member receives their email + temporary password from the Data Officer.

### Crew roster

| Code | Email | Role in app |
|---|---|---|
| FE01 | alinahalchak@gmail.com | astronaut |
| FE02 | andriana2081@gmail.com | astronaut |
| FE03 | upadhyay.arin@gmail.com | astronaut |
| FE04 | emericduval2004@gmail.com | **commander** |
| FE05 | mahmed@agh.edu.pl | astronaut |
| FE06 | romamalenko241@gmail.com | astronaut |
| FE07 | pedapudisrteja@gmail.com | astronaut |

FE04 (Commanding Officer) is the only user with `role == "commander"`.
All others have `role == "astronaut"`.

**Display name rule**: every user is displayed by their crew code only (FE01, FE02 … FE07).
Real names are never shown anywhere in the UI or stored in Firestore.

---

## Authentication flow

1. Landing page shows a simple login form (email + password).
2. On success, app reads `users/{uid}` from Firestore to get `role` and `crewCode`.
3. Commander sees an extra "Mission Control" panel; astronauts do not.
4. "Log out" button always visible in the header.

---

## Time system

### Two clocks only — no local time anywhere in the app

| Clock | Format | Where shown |
|---|---|---|
| UTC | `YYYY-MM-DD  HH:MM:SS UTC` | Header, always visible |
| Mission Time | `T+HH:MM:SS` | Header, always visible |

Local time (browser timezone) is **never displayed or used** for any calculation.
All timestamps stored in Firestore are **UTC ISO strings**.

### Mission Time definition

Mission Time starts at exactly **T+00:00:00** the moment the Commander presses
**"Start Day"**. It counts up continuously from zero:

```
MissionTime = now_utc() − wakeUpTime_utc
```

- Clamped to `T+00:00:00` if negative (Commander set a future anchor).
- Displayed as `T+HH:MM:SS`, counting up every second via `setInterval`.
- Counts up to `T+24:00:00` with no automatic stop or cap.

### What the Commander sets

The Commander enters the **current Mission Time** — what T+ reads right now — and the app
back-calculates the UTC anchor automatically:

```
wakeUpTime_utc = now_utc() − entered_mission_time
```

UTC is a fixed standard and is never edited directly.

```
+------------------------------------------------------+
|  Mission Control                      Day: [3 v]    |
|                                                      |
|  Current UTC:  2026-08-25  06:42:17 UTC  (read-only)  |
|                                                      |
|  Current Mission Time:  T+ [02] : [12] : [17]       |
|                         HH    MM     SS              |
|                                                      |
|  [Set Mission Time]     [Reset to T+00:00:00]        |
|                                                      |
|  Anchor UTC will be:  04:30:00 UTC  (calculated)     |
|  Last saved:  Day 3 anchor = 04:30:00 UTC            |
+------------------------------------------------------+
```

#### Setting a Mission Time
- Commander types the three fields: `HH`, `MM`, `SS` for the Mission Time that is
  currently running (e.g. T+02:12:17 if the day started 2 hours 12 minutes ago).
- As they type, the **"Anchor UTC will be"** line updates live:
  `anchor = now_utc() − entered_mission_time`.
- **[Set Mission Time]** writes `wakeUpTime = anchor` to Firestore. Mission Time on all
  clients immediately reads the entered value and continues counting up from there.

#### Reset to zero
- **[Reset to T+00:00:00]** sets `wakeUpTime = now_utc()`, making Mission Time restart
  from T+00:00:00 on all clients.

#### Count duration
- Mission Time counts up from T+00:00:00 continuously for **24 hours** (T+24:00:00).
- Display format: `T+HH:MM:SS`, updating every second.
- No automatic stop or reset — the Commander must press Reset to start a new day.
- Session boundaries are based on Mission Time hours (see table below).

#### Behaviour after setting
- `wakeUpTime` is stored in Firestore `missionDay/{dayNumber}` as a UTC ISO string.
- Every client computes Mission Time as `now_utc() − wakeUpTime` in real time.
- The Commander can update at any point — all clients resync instantly via `onSnapshot`.
- Non-commanders cannot write to this document (Firestore rules enforce this).

### Session boundaries (Mission Time)

| Mission Time | Session |
|---|---|
| T+00:00:00 – T+03:59:59 | Session 1 |
| T+04:00:00 – T+07:59:59 | Session 2 |
| T+08:00:00 – T+11:59:59 | Session 3 |
| T+12:00:00 – T+23:59:59 | Session 4 |

Mission Time runs to T+24:00:00 (full 24-hour count). Session 4 covers T+12:00:00 onward
for the remainder of the day. The 16-hour experiment window is the active data-collection
period; the clock itself does not stop at T+16:00:00.

---

## Tests per session

These are fixed — they do not change day to day except where noted.

### Session 1 (T+00:00)
| Test | Sheet | Notes |
|---|---|---|
| Sleep | Sleep | |
| Circadian (morning) | Circadian | |
| Bioimpedance (morning) | Bioimpedance | |
| Saturation, Temp, Resp. Rate, BP | Bioimpedance | |
| Chimp (morning) | Chimp | |
| Urine analysis | Urine | **Day 1 only** |

### Session 2 (T+04:00)
| Test | Sheet | Notes |
|---|---|---|
| Circadian (midday) | Circadian | |
| Heart Time | Heart Time | **Days 2–5 only** |
| Hof Protocol | Hof | |

### Session 3 (T+08:00)
| Test | Sheet | Notes |
|---|---|---|
| Circadian (evening) | Circadian | |
| PR Presentation | — | **Day 7 only** |
| Summary Report | — | **Day 7 only** |

### Session 4 (T+12:00)
| Test | Sheet | Notes |
|---|---|---|
| Circadian (midnight) | Circadian | |
| Water intake | Water | |
| Daily Report | Report | |
| Bioimpedance (evening) | Bioimpedance | |
| Chimp (evening) | Chimp | |
| Space Dragon Test A4 | — | **Days 4 and 6 only** |

Day-conditional tests must be hidden entirely on days when they do not apply —
do not show them greyed out.

---

## Firestore data model

```
/users/{uid}
  email: string
  crewCode: string          // "FE01" … "FE18"
  displayName: string       // e.g. "Ravi"
  role: "commander" | "astronaut"

/missionDay/{dayNumber}     // dayNumber: "1" … "7"
  wakeUpTime: timestamp     // set by Commander
  setBy: uid

/completions/{dayNumber}_{sessionNumber}_{testKey}_{uid}
  crewCode: string
  displayName: string
  completedAt: timestamp
  dayNumber: number
  sessionNumber: number
  testKey: string           // slugified test name, e.g. "sleep", "bioimpedance_morning"
```

`testKey` values (use these exactly as document ID components):
`sleep`, `circadian_morning`, `bioimpedance_morning`, `vitals_morning`,
`chimp_morning`, `urine`,
`circadian_midday`, `heart_time`, `hof`,
`circadian_evening`, `pr_presentation`, `summary_report`,
`circadian_midnight`, `water`, `daily_report`,
`bioimpedance_evening`, `chimp_evening`, `space_dragon`

---

## UI — main screen (astronaut view)

```
┌────────────────────────────────────────────────────────┐
│  DAILY SESSION PROTOCOL              [FE07] [logout]   │
│  2026-08-25  06:42:17 UTC     T+02:14:33              │
├────────────────────────────────────────────────────────┤
│  Mission Day 3   ●●●○○○○                               │
│  Session 1  T+00:00:00 – T+03:59:59    [active]       │
├──────────────────────────────────────────────────┤
│  ✓ Sleep                         Sheet: Sleep    │
│    Circadian (morning)           Sheet: Circadian│  ← due now, highlighted
│    Bioimpedance (morning)        Sheet: Bioimp.  │
│    ...                                           │
├──────────────────────────────────────────────────┤
│  Session 2  T+04:00 – T+07:59   [upcoming]       │
│  ...                                             │
└──────────────────────────────────────────────────┘
```

- All four sessions visible at all times — scroll down to see future sessions.
- Current session is visually prominent (bright border, expanded). Future sessions are dimmed.
- Each test row has a **"Mark done"** button (only for the astronaut's own tests).
  Once marked, the button becomes a green checkmark and cannot be undone by the astronaut.
- When T reaches a session's start time, a **chime sound** plays once (Web Audio API, short beep —
  no audio file dependency) and the new session's tests are highlighted.

---

## UI — dashboard panel (visible to all, updates in real time)

Below the session list, or accessible via a tab:

```
Test                    | Done | Pending
------------------------|------|--------
Sleep                   | FE01 FE03 FE05 | FE02 FE04 FE06 …
Circadian (morning)     | FE01           | FE02 FE03 …
...
```

- Updates live via Firestore `onSnapshot`.
- Crew codes of completers shown in teal; pending in muted text.
- Commander sees a **"Reset day"** button that deletes all completions for the current day
  (with a confirmation dialog).

---

## UI — Commander panel

Appears only when `role == "commander"`. Rendered above the session list.

```
┌─────────────────────────────────────────┐
│  Mission Control          Day: [3 ▾]   │
│                                         │
│  Current UTC: 06:42:17 UTC              │
│                                         │
│  [▶ Start Day 3 — set T+00:00:00 now]  │
│                                         │
│  Last set: Day 3 started at 06:42:17 UTC│
└─────────────────────────────────────────┘
```

- Day selector: 1–7.
- No time input — Mission Time always starts from the moment the button is pressed.
- Button label updates to reflect the selected day number.
- "Last set" line reads from Firestore and shows the UTC timestamp of the last start.
- On press: write `{ wakeUpTime: new Date().toISOString(), setBy: uid }` to
  `missionDay/{dayNumber}`. All clients update instantly via `onSnapshot`.

---

## Notifications / alerts

- **Session start chime**: Web Audio API short sine-wave beep (440 Hz, 200 ms, gain 0.3).
  Triggered once when T crosses a session boundary. Store the last-triggered session in
  `localStorage` so a page refresh does not re-trigger.
- **Visual highlight**: when a new session becomes active, its header pulses once with a
  CSS keyframe animation (no looping).
- No push notifications, no service workers required.

---

## Firestore security rules

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Users can read their own doc; commanders can read all
    match /users/{uid} {
      allow read: if request.auth.uid == uid
                  || get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'commander';
      allow write: if false; // managed via Firebase console only
    }

    // Anyone authenticated can read mission day config
    match /missionDay/{day} {
      allow read: if request.auth != null;
      allow write: if get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'commander';
    }

    // Astronauts write only their own completions; everyone can read
    match /completions/{docId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
                    && request.resource.data.uid == request.auth.uid;
      allow update, delete: if false; // no undoing from the app
    }
  }
}
```

---

## Visual style

Match the PDF reference design:
- Background: near-black (`#0d1117`)
- Card background: dark navy (`#161b27`)
- Session accent colours: teal (S1), green (S2), amber (S3), pink/magenta (S4)
- Countdown text: bold teal (`#00e5cc`)
- Body text: off-white (`#e6edf3`)
- Completed rows: green checkmark + muted text
- Font: system monospace for the timer; sans-serif for everything else
- Responsive — works on 375 px wide phone screen and 1280 px laptop

---

## File structure

```
/
├── index.html
├── app.js
├── style.css
├── firebase-config.js    // Firebase project credentials (public — Firestore rules enforce security)
└── README.md
```

All files in the repo root (or `docs/` if using that for GitHub Pages).

---

## Seed script — create all Firebase accounts

Run this **once** from a local machine before Day 1 using the Firebase Admin SDK.
It creates Firebase Auth accounts and the matching Firestore `/users/{uid}` documents.

```js
// seed.js  —  run with: node seed.js
// Requires: npm install firebase-admin
// Place your Firebase service account JSON at ./serviceAccount.json

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccount.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const auth = admin.auth();
const db = admin.firestore();

const TEMP_PASSWORD = 'SpaceReady4!'; // crew members change this on first login

const crew = [
  { code: 'FE01', email: 'alinahalchak@gmail.com',    role: 'astronaut'  },
  { code: 'FE02', email: 'andriana2081@gmail.com',    role: 'astronaut'  },
  { code: 'FE03', email: 'upadhyay.arin@gmail.com',   role: 'astronaut'  },
  { code: 'FE04', email: 'emericduval2004@gmail.com', role: 'commander'  },
  { code: 'FE05', email: 'mahmed@agh.edu.pl',         role: 'astronaut'  },
  { code: 'FE06', email: 'romamalenko241@gmail.com',  role: 'astronaut'  },
  { code: 'FE07', email: 'pedapudisrteja@gmail.com',  role: 'astronaut'  },
];

async function seed() {
  for (const member of crew) {
    // Create Firebase Auth account
    const user = await auth.createUser({
      email: member.email,
      password: TEMP_PASSWORD,
      displayName: member.code,   // crew code only — no real name
    });

    // Write Firestore user document
    await db.collection('users').doc(user.uid).set({
      email: member.email,
      crewCode: member.code,
      displayName: member.code,   // crew code only
      role: member.role,
    });

    console.log(`✓ ${member.code}  ${member.email}  [${member.role}]  uid: ${user.uid}`);
  }
  console.log('\nAll crew accounts created.');
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
```

**Steps to run:**
1. In the Firebase console → Project settings → Service accounts → Generate new private key → save as `serviceAccount.json` in the same folder as `seed.js`.
2. `npm install firebase-admin`
3. `node seed.js`
4. Delete `serviceAccount.json` immediately after — never commit it to the repo.
5. Share `SpaceReady4!` with each crew member privately; they can change their password via Firebase console if needed.

---

## Out of scope (do not build)

- Self-registration
- Password reset flow (handle in Firebase console)
- Push / SMS notifications
- Offline mode / service worker
- Excel sheet integration
- Any backend, API, or paid service
