// seed-display.js — create (or repair) the wall display's account.
//
//   npm install firebase-admin        # already in package.json
//   DISPLAY_EMAIL=aatc.display@example.com DISPLAY_PASSWORD='<long password>' \
//     node seed-display.js
//
// Needs a service account key: Firebase console -> Project settings ->
// Service accounts -> Generate new private key -> save as serviceAccount.json
// here. DELETE IT AFTERWARDS. It bypasses every security rule; it is the one
// credential in this project that genuinely must not be committed or kept.
//
// Everything this script does can equally be done by hand in the console. It
// exists so the display account is created the same way twice, not guessed at
// under time pressure.

const { cert, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const fs = require("fs");
const path = require("path");

const serviceAccountPath = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT || "serviceAccount.json");
if (!fs.existsSync(serviceAccountPath)) {
  console.error(`Service account file not found: ${serviceAccountPath}`);
  console.error("Firebase console -> Project settings -> Service accounts -> Generate new private key.");
  process.exit(1);
}

const email = process.env.DISPLAY_EMAIL;
const password = process.env.DISPLAY_PASSWORD;
if (!email || !password) {
  console.error("Set DISPLAY_EMAIL and DISPLAY_PASSWORD before running.");
  process.exit(1);
}
if (password.length < 16) {
  // This account sits signed in on an unattended machine for the whole mission.
  console.error("Use a password of at least 16 characters for the display account.");
  process.exit(1);
}

initializeApp({ credential: cert(require(serviceAccountPath)) });

const auth = getAuth();
const db = getFirestore();

async function findOrCreate() {
  try {
    const existing = await auth.getUserByEmail(email);
    await auth.updateUser(existing.uid, { password });
    console.log(`Auth account already existed; password reset (${existing.uid})`);
    return existing;
  } catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
    const created = await auth.createUser({ email, password, displayName: "DISPLAY" });
    console.log(`Auth account created (${created.uid})`);
    return created;
  }
}

async function run() {
  const user = await findOrCreate();

  await db.collection("users").doc(user.uid).set({
    email,
    crewCode: "DISPLAY",
    displayName: "DISPLAY",
    role: "display",
  });

  console.log("users/%s written: crewCode=DISPLAY, role=display", user.uid);
  console.log("\nNow open display.html on the Pi and sign in once with this account.");
  console.log("Then delete serviceAccount.json.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
