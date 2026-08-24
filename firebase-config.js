// firebase-config.js
//
// Paste the config object from:
//   Firebase console -> Project settings -> General -> Your apps -> Web app -> SDK setup
//
// These values are PUBLIC by design. They identify the project, they do not grant
// access to it. Access is enforced by the Firestore security rules in
// firestore.rules — keep those tight and this file is safe to commit.

export const firebaseConfig = {
  apiKey: "AIzaSyBSlR9HOtoJ2Ivd99CLwIFhXz0EYUxvAXM",
  authDomain: "aatc-mission.firebaseapp.com",
  projectId: "aatc-mission",
  storageBucket: "aatc-mission.firebasestorage.app",
  messagingSenderId: "202616289745",
  appId: "1:202616289745:web:a8a9783a71c5091481c8f0",
  measurementId: "G-DDG08W3H37",
};

// Google Apps Script web app that appends void logs to the AATC_UrineVolume
// sheet. Deploy the script in apps-script/Code.gs as a web app (Execute as: Me,
// Access: Anyone) and paste the /exec URL here.
//
// Unlike the Firebase keys above, this URL is a write capability: anyone who
// reads the page source can append rows to the sheet. It cannot read the sheet
// back. That is the cost of having no backend — see README.
export const APPS_SCRIPT_URL = "PASTE_APPS_SCRIPT_URL";