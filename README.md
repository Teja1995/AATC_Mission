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

## Urine volume logging ("Log Urine")

A floating **Log Urine** button sits on every screen once logged in. It asks for two
things only — volume in millilitres, and the Armstrong colour, chosen by tapping one
of eight swatches printed in the actual scale colours rather than typing a number.
Crew code, mission day, mission time and UTC are filled in from the live session and
shown above the form so the astronaut can see what is being recorded.

Entries are stored in Firestore under `/voids`, and **FE07 (admin) sees a Urine log
panel with "Download urine log (CSV)"** — one UTF-8 file, all seven days, columns
`Crew Code, Mission Day, Mission Time, UTC Date & Time, Volume (mL), Colour (1-8)`,
sorted by crew code then time. Nobody else can read the collection back; a crew
member can only add their own entries. Nothing is ever updated or deleted.

The document id is the crew code plus the moment of the void, so a retry after a
lost response overwrites the same document rather than adding a second row.

### Seeing and correcting your own entries

A **My urine log** tab beside Sessions and Crew dashboard shows each crew member
their own entries, newest first, and nobody else's. **Edit** reopens the form on
that entry; only volume and colour can change, while crew code, mission day,
mission time and UTC stay pinned to what was filed. A corrected row is labelled
`corrected` and carries a `Corrected (UTC)` column into the CSV.

**Delete** removes an entry permanently, after a confirmation naming it. A crew
member can delete their own; **FE07 (admin) sees every entry in the Urine log
panel and can delete anyone's** — test values typed by someone else cannot be
corrected by anybody but their author, and they should not be in the dataset at
all. The display account can delete nothing. There is no undo: a deleted row is
gone from Firestore and from every later export.

### Nothing is lost if the network is

A void cannot be measured twice, so an entry is written to the device before the
network is touched and stays there until Firestore confirms it. The count of
unsent entries rides on the Log Urine button; queued entries retry every minute,
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

## Account and rule hardening

Two exposures were found by probing the live project and are closed in
`firestore.rules`:

- **A signed-in account is not necessarily crew.** Firebase email/password
  sign-up is open by default, and the web API key is public in the page source,
  so an outsider can register and hold a valid session. Rules keyed on
  `request.auth != null` gave that account read access to every completion and
  mission-day anchor. Every rule now requires a `users/{uid}` document, which
  only the seed script creates.
- **A create could claim another crew member's code.** Checking only
  `uid == request.auth.uid` allowed a completion or void to be filed under any
  `crewCode` — the field the dashboard and the CSV export read. Creates now
  check it against the caller's own profile.

Also switch sign-up off in the console: **Authentication → Settings → User
actions → uncheck "Enable create (sign-up)"**. All seven crew accounts already
exist; nothing in the app ever needs to create another.

Republish `firestore.rules` after pulling this change.

## Roles

| Crew code | `users/{uid}.role` | Can do |
|---|---|---|
| FE04 | `commander` | Mission Control: set the day and its anchor, add and remove tasks, reset a day |
| FE07 | `admin` | Everything the commander can, plus reading and exporting the void log |
| all others | `astronaut` | Mark their own tests done, view the dashboard |

The role lives in the user's Firestore document and is the only thing the rules
consult — no crew code is hardcoded anywhere. `seed.js` carries each role with
the roster, so re-running it cannot silently demote anyone.

**FE07's document must read `role: "admin"`.** Set it in the Firebase console
(Firestore → `users` → FE07's document → `role` → `admin`) or re-run `seed.js`.
Until then FE07 is an ordinary astronaut and the Void log panel will not appear.

## Wall display (Raspberry Pi)

`display.html` is a separate, read-only page for a screen left running in the
habitat: mission clock, mission day, the session due now, what is next, and the
crew dashboard. It has no Mission Control, no Add task, no urine log and no Log
Urine button, and it can write nothing at all.

    https://teja1995.github.io/AATC_Mission/display.html

**Never sign the Pi in as a crew member.** A crew login puts that person's
private urine log and every admin control on a wall in a shared space. Create a
dedicated account instead:

**By hand, in the console:**

1. Firebase console → Authentication → Users → **Add user**, e.g.
   `aatc.display@yourdomain` with a long password. (Sign-up is closed to the
   public, so it has to be added here.)
2. Copy the new user's UID.
3. Firestore → `users` → **Add document**, ID = that UID, fields:
   `crewCode: "DISPLAY"`, `displayName: "DISPLAY"`, `role: "display"`,
   `email: "<the address>"`.
4. Open `display.html` on the Pi and sign in once. Firebase keeps the session,
   so the display comes back by itself after a reboot.

**Or scripted**, if you would rather not hand-type a UID:

    # serviceAccount.json in this folder, from
    # Project settings -> Service accounts -> Generate new private key
    DISPLAY_EMAIL=aatc.display@example.com     DISPLAY_PASSWORD='a-long-password-here'       node seed-display.js
    rm serviceAccount.json

Nothing else can do it: `users` is `allow write: if false` for every client, so
the console and the Admin SDK are the only two paths. Delete the key when the
script finishes — it bypasses every rule in the project.

The rules give `role: "display"` read access to the mission day, tasks and
completions, and refuse it every write — `filedBySelf()` and the urine-log
update rule both exclude it. Someone walking past the screen cannot mark a test
done or file a measurement.

`DISPLAY` is not in `CREW_CODES`, so it never appears on the dashboard as a
person who owes anything.

The page reloads itself every 12 hours, so a browser that has quietly lost its
Firestore stream recovers on its own instead of showing a frozen clock.

### Kiosk mode on the Pi

    chromium-browser --kiosk --noerrdialogs --disable-infobars \
      --incognito=false \
      https://teja1995.github.io/AATC_Mission/display.html

Leave incognito off, or the sign-in is lost at every reboot.

## Shared mission module

`mission.js` holds the task battery, the session windows, the clock arithmetic
and the item model. Both `app.js` and `display.js` import it, so the screen on
the wall cannot disagree with the phone in someone's hand about what is due or
what day it is. Run its checks with `node tests/mission.test.mjs`.

## Food logging

The floating **+** button opens a menu — **Log Urine**, **Log Food** — with room
for whatever gets added next. A count of unsent entries rides on the + itself,
since the menu is shut most of the time.

**Log Food** takes a barcode, then how much was eaten:

- **Scan** uses the browser's own `BarcodeDetector`. It exists in Chrome and on
  Android; **Safari has no such API**, so the barcode field is always typeable
  and the Look up button works either way. A USB barcode gun works too — those
  type the digits and press Enter, which the field handles.
- The barcode is looked up **in the crew's own list first**, then in
  **Open Food Facts** (free, no key, permissive CORS), filling in the product
  name and kcal per 100 g. Where a product carries only kilojoules, the figure
  is converted and the hint says so.
- Enter the grams eaten and the **total kcal** is computed. That total is the
  measure; it stays editable, and every field the lookup filled can be
  overwritten.
- **A barcode is never required.** An analog habitat repacks most of its food,
  so naming the food and typing the kcal is a first-class path, recorded as
  `source: "manual"` rather than `"barcode"`.

### The crew's own food list

There is no Polish barcode database worth linking to. Checked:

| Source | Result |
|---|---|
| `pl.openfoodfacts.org` | The same database as `world.` — identical 404s |
| Polish barcodes sampled in Open Food Facts | **0 of 6** found, plus 3 of 5 missing in an earlier sample |
| GS1 Poland eProdukty | No public API |
| Nutritionix / Edamam and similar | Need an API key, which would sit in this page's public source, and are weak on Polish retail |

So the app keeps its own list in `/foodItems`, and the point is that **each food
is typed once by one person**, not by every crew member every time:

- **FE07 prepares it up front.** The Urine log panel has a *Crew food list* box
  that takes lines of `barcode,name,kcal per 100 g` pasted in bulk, straight off
  the packets. Leave the barcode empty for anything unpackaged:
  `,Chleb żytni,247`.
- **Crew pick from it.** The food form starts with a *Known food* box that
  autocompletes against that list and fills in the energy — no barcode, no
  camera, no internet.
- **Anything logged by hand joins the list.** Log a food with a name and an
  energy figure and it is saved for everyone, credited to whoever added it.

The list is consulted **before** Open Food Facts, so anything the crew has
already identified resolves instantly even when that service is slow or
unreachable. The display account cannot write to it.

**My food log** is a tab beside My urine log: your own entries, newest first,
with the day's running kcal total in the header. Edit corrects an entry; Delete
removes it. Same rules as urine — your own to see, correct and remove; the admin
holds the whole set, can delete anyone's, and exports it as
`aatc_food_log_<date>.csv`.

Entries queue on the device before they touch the network, exactly like urine
entries, and flush when the connection returns.
