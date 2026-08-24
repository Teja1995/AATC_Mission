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
`circadian_midday`, `hof`,
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

Live copy: [`firestore.rules`](firestore.rules). Publish it after any change --
the console copy is what actually runs.

Two things the first draft of these rules got wrong, both found by probing the
live project:

- **Signed in is not the same as crew.** Email/password sign-up is open by
  default and the web API key is published in the page, so anyone on the
  internet can hold a valid session. Rules that said `request.auth != null`
  handed that outsider every completion and every mission-day anchor. They now
  require a `users/{uid}` document, which only the seed script creates.
- **A filed document must not claim someone else's crew code.** `uid ==
  request.auth.uid` alone let a caller write a completion or a void under any
  `crewCode` they liked -- and the crew code is what the dashboard and the
  exported CSV read. Creates now check the crew code against the caller's own
  profile.

Sign-up should also be switched off in the console: Authentication -> Settings
-> User actions -> uncheck "Enable create (sign-up)". The crew accounts already
exist; nobody needs to make another.

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn() {
      return request.auth != null;
    }

    // Being signed in is not the same as being crew. Email/password sign-up is
    // open by default and the project's API key is published in the page, so an
    // outsider can hold a valid session. Only an account with a users/{uid}
    // document -- one the seed script created -- counts as crew.
    function isCrew() {
      return signedIn()
        && exists(/databases/$(database)/documents/users/$(request.auth.uid));
    }

    function profile() {
      return get(/databases/$(database)/documents/users/$(request.auth.uid)).data;
    }

    function isCommander() {
      return isCrew() && profile().role == 'commander';
    }

    function isDataOfficer() {
      return isCrew() && profile().crewCode in ['FE01', 'FE07'];
    }

    // A document filed by one crew member must not be able to claim another's
    // crew code -- that is what the dashboard and the exported CSV read.
    function filedBySelf() {
      return isCrew()
        && request.resource.data.uid == request.auth.uid
        && request.resource.data.crewCode == profile().crewCode;
    }

    match /users/{uid} {
      allow read: if isCrew() && (request.auth.uid == uid || isCommander());
      allow write: if false; // managed by the seed script only
    }

    // Holds the per-day anchors under ids "1".."7", plus the commander-selected
    // active day under the reserved id "active".
    match /missionDay/{day} {
      allow read: if isCrew();
      allow write: if isCommander();
    }

    // Tasks the commander adds to a session. Every crew member reads them --
    // the crew can see what is outstanding and with whom -- only the commander
    // writes. Titles are free text, so they stay inside the crew.
    match /tasks/{taskId} {
      allow read: if isCrew();
      allow write: if isCommander();
    }

    // Void logs are health data. A crew member files their own and can read
    // their own back; only the two data officers can read the whole set, which
    // is what the CSV export needs. Nothing is ever updated or deleted -- a
    // measurement that has been taken is a fact.
    match /voids/{voidId} {
      allow create: if filedBySelf();
      // get and list are split deliberately. A list rule that inspects
      // resource.data can only be satisfied by a query the engine can prove
      // matches it; the export lists the whole collection, so its rule must
      // stand on the caller alone.
      allow get: if isDataOfficer()
        || (isCrew() && resource.data.uid == request.auth.uid);
      allow list: if isDataOfficer();
      allow update, delete: if false;
    }

    match /completions/{docId} {
      allow read: if isCrew();
      allow create: if filedBySelf();
      allow update: if false; // no undoing from the app
      allow delete: if isCommander(); // the Reset day action
    }
  }
}
```

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

## Commander-added tasks

Beyond the fixed battery, the Commander can add an ad-hoc task to any session of
the current mission day and assign it either to one crew member or to everyone.

- Added from the Commander's "Add a task" panel: title, session (1-4), assignee
  (Everyone, or a single crew code).
- The task appears in its session for the **whole crew**, tagged with who owes
  it, so the dashboard shows what is outstanding and with whom.
- Only the assignee sees a **Mark done** button. Everyone else sees the row with
  `with FE03`, or a tick and `done by FE03` once it is finished. A task assigned
  to Everyone behaves like a protocol test: each crew member ticks their own.
- The Commander can remove a task; completions already filed against it are left
  in place and simply stop being displayed.
- Tasks belong to the mission day they were added on and disappear at the
  rollover, like the day's completions.

```
/tasks/{taskId}              // taskId: "task_<base36 timestamp><random>"
  dayNumber: number
  sessionNumber: number      // 1-4
  title: string
  assignedTo: string         // "ALL" or a crew code, e.g. "FE03"
  createdBy: uid
  createdAt: string          // UTC ISO
```

Completions for an added task use the task id as the `testKey`, so the document
id keeps the same shape: `{dayNumber}_{sessionNumber}_{taskId}_{uid}`.

Firestore rules: anyone signed in reads `/tasks`; only a commander writes. The
assignee rule is enforced in the UI, on the same footing as every other test —
the rules stop a crew member writing a completion under anyone else's uid.

## Out of scope (do not build)

- Self-registration
- Password reset flow (handle in Firebase console)
- Push / SMS notifications
- Offline mode / service worker
- Excel sheet integration
- Any backend, API, or paid service

## Urine Volume Logging

### Overview
Astronauts log urine volume via a 2-field form in the app. All other fields are
auto-populated from the live mission clock and the logged-in user. Entries are
stored in Firestore and exported as a single CSV at the end of the mission by
FE01 or FE07, who are the only people able to read the collection back.

*(This originally posted to a private Google Sheet through an Apps Script web
app. That path needed a publicly callable URL embedded in the page -- a write
capability anyone reading the source could use -- and the deployment would not
serve anonymous callers. Firestore already carries every other piece of mission
state, so the void log goes there too and leaves as a CSV at the end.)*

### What the astronaut sees
A "Log Void" button fixed to every screen, available at any mission time. It
opens a form with exactly two inputs:

- **Volume (mL)** -- a number.
- **Colour (1-8)** -- eight swatches painted in the Armstrong scale's own
  colours, so the crew matches a colour to a colour rather than translating one
  into a number. The selected score shows its status text, and 7-8 reads
  "Flag to FE01".

### What the app records automatically (no astronaut input)
- `crewCode` -- from the logged-in user's Firestore document
- `missionDay` -- the current derived mission day
- `missionTime` -- computed live: `T+HH:MM:SS` (empty if no day is anchored yet;
  `utcDateTime` always allows it to be reconstructed afterwards)
- `utcDateTime` -- `new Date().toISOString()` at the moment of submit
- `uid` -- so the security rules can pin the entry to its author

All of these are shown above the form, ticking live, so the astronaut can see
what is being filed.

### Storage

```
/voids/{crewCode}_{utcDateTime}      // colons and dots replaced with hyphens
  uid: string
  crewCode: string
  missionDay: number
  missionTime: string
  utcDateTime: string
  volumeMl: number
  colourScore: number
```

The document id is the crew code and the moment of the void, so a retry after a
lost response overwrites the same document instead of creating a second one.
A void cannot be duplicated.

### Nothing is lost if the network is

A void cannot be measured twice. Each entry is written to the device before
Firestore is touched and stays there until the write is confirmed. The count of
unsent entries shows on the Log Void button; the queue is retried every minute,
when the browser comes back online, and on the next submit.

### Export

FE01 and FE07 see a **Void log** panel with **Download void log (CSV)**. It
reads the whole collection and writes one UTF-8 file:

| A | B | C | D | E | F |
|---|---|---|---|---|---|
| Crew Code | Mission Day | Mission Time | UTC Date & Time | Volume (mL) | Colour (1-8) |

Sorted by crew code, then by time. Rows are never updated or deleted from the
app -- a measurement that has been taken is a fact.

### Colour reference (Armstrong scale -- print and post near the toilet)
| Score | Colour | Status |
|---|---|---|
| 1-2 | Pale straw | Well hydrated |
| 3-4 | Yellow | Adequate |
| 5-6 | Dark / amber | Mild dehydration |
| 7-8 | Dark amber / brown | Flag to FE01 |
