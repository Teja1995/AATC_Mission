# Mission Data Tracker

Static Firebase app for the AATC analog astronaut mission. It provides email/password login, UTC and mission-time clocks, session-specific test checklists, live crew completion status, and commander controls.

## Configure Firebase

1. Create a Firebase project and enable Email/Password Authentication and Firestore.
2. Copy the web app configuration into `firebase-config.js`.
3. **Publish `firestore.rules`** in the Firebase console (Firestore Database → Rules → paste → Publish), or run `firebase deploy --only firestore:rules`.
4. Create the crew accounts and matching `users/{uid}` documents with `node seed.js` (see `claude.md`).
5. Serve this directory over HTTP for local testing, or publish it with GitHub Pages. Firebase web modules are loaded from Google's CDN.

The config file contains public project identifiers. Firestore rules and Authentication protect the data; never place an Admin SDK service-account key in this directory.

## GitHub Pages

Set the repository Pages source to the branch and folder containing `index.html`. Add the final Pages origin to Firebase Authentication's authorized domains before logging in.

## Mission time and mission days

- The Commander anchors a day by entering the mission time that is running right now, or by pressing **Reset to T+00:00:00**. The app stores `wakeUpTime = now_utc − entered` in `missionDay/{dayNumber}`; every client derives the clock from that anchor, so all screens agree.
- A mission day is 24 hours long. When the clock passes **T+23:59:59 it wraps to T+00:00:00 and the mission day advances by one** — Day 3 becomes Day 4, Session 4 becomes Session 1, and the day-conditional tests change with it. The Commander does not have to be awake at the rollover.
- Day numbers stop advancing at Day 7; the clock keeps wrapping.
- `missionDay/active` records which day the Commander last selected. It lives in the same collection as the anchors so a single security rule covers both.

## Troubleshooting

**"Missing or insufficient permissions" when the Commander changes the day or resets a day.**
The rules in the Firebase console are older than the ones in this repo. Publish `firestore.rules` from this repo — it grants commanders write access to the whole `missionDay` collection (anchors *and* the `active` pointer) and delete access to `completions`, which the in-app **Reset day** needs. Earlier rule sets denied both.

Also check that the account really is a commander: `users/{uid}.role` must read exactly `commander` (FE04). The rules resolve the role by reading that document, so a missing or misspelled field denies the write.

## Firestore reset note

`firestore.rules` allows only commanders to delete completion documents, which is required by the in-app Reset day action. Astronauts can create only their own completion documents and cannot update or delete them.

## Urine volume logging ("Log Void")

A floating **Log Void** button sits on every screen once logged in. It asks for two
things only — volume in millilitres, and the Armstrong colour, chosen by tapping one
of eight swatches printed in the actual scale colours rather than typing a number.
Crew code, mission day, mission time and UTC are filled in from the live session and
shown above the form so the astronaut can see what is being recorded.

Entries are stored in Firestore under `/voids`, and **FE01 and FE07 see a Void log
panel with "Download void log (CSV)"** — one UTF-8 file, all seven days, columns
`Crew Code, Mission Day, Mission Time, UTC Date & Time, Volume (mL), Colour (1-8)`,
sorted by crew code then time. Nobody else can read the collection back; a crew
member can only add their own entries. Nothing is ever updated or deleted.

The document id is the crew code plus the moment of the void, so a retry after a
lost response overwrites the same document rather than adding a second row.

### Nothing is lost if the network is

A void cannot be measured twice, so an entry is written to the device before the
network is touched and stays there until Firestore confirms it. The count of
unsent entries rides on the Log Void button; queued entries retry every minute,
when the browser comes back online, and on the next submit.

## Commander-added tasks

The Commander's **Add a task** panel puts an ad-hoc job into any session of the
current mission day, assigned to one crew member or to everyone. The task shows
up in that session for the whole crew and in the dashboard, tagged with who owes
it; only the assignee gets a **Mark done** button, and everyone else sees `with
FE03` until it is done. Tasks are scoped to the day they were added on and clear
at the rollover. The Commander can remove one at any time.

This needs the `/tasks` rule from `firestore.rules` — publish the file again if
the console copy predates it, or added tasks will fail to save and to load.
