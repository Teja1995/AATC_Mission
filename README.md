# Mission Data Tracker

Static Firebase app for the AATC analog astronaut mission. It provides email/password login, UTC and mission-time clocks, session-specific test checklists, live crew completion status, and commander controls.

## Configure Firebase

1. Create a Firebase project and enable Email/Password Authentication and Firestore.
2. Copy the web app configuration into `firebase-config.js`.
3. Publish `firestore.rules` in the Firebase console or with the Firebase CLI.
4. Create the crew accounts and matching `users/{uid}` documents from the seed script in `claude.md`.
5. Serve this directory over HTTP for local testing, or publish it with GitHub Pages. Firebase web modules are loaded from Google's CDN.

The config file contains public project identifiers. Firestore rules and Authentication protect the data; never place an Admin SDK service-account key in this directory.

## GitHub Pages

Set the repository Pages source to the branch and folder containing `index.html`. Add the final Pages origin to Firebase Authentication's authorized domains before logging in.

## Firestore reset note

`firestore.rules` allows only commanders to delete completion documents, which is required by the in-app Reset day action. Astronauts can create only their own completion documents and cannot update or delete them.
