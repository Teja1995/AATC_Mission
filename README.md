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
