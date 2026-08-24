const { cert, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const fs = require("fs");
const path = require("path");

const serviceAccountPath = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT || "serviceAccount.json");
if (!fs.existsSync(serviceAccountPath)) {
  console.error(`Service account file not found: ${serviceAccountPath}`);
  process.exit(1);
}

const temporaryPassword = process.env.TEMP_PASSWORD;
if (!temporaryPassword) {
  console.error("Set TEMP_PASSWORD before running the script.");
  process.exit(1);
}

initializeApp({
  credential: cert(require(serviceAccountPath)),
});

const auth = getAuth();
const db = getFirestore();
// Three roles: "astronaut" is crew, "commander" runs the mission day, "admin"
// runs the application and is the only reader of the void log. The role travels
// with the roster so re-running this script cannot quietly demote anybody.
const crew = [
  { crewCode: "FE01", email: "alinahalchak@gmail.com", role: "astronaut" },
  { crewCode: "FE02", email: "andriana2081@gmail.com", role: "astronaut" },
  { crewCode: "FE03", email: "upadhyay.arin@gmail.com", role: "astronaut" },
  { crewCode: "FE04", email: "emericduval2004@gmail.com", role: "commander" },
  { crewCode: "FE05", email: "mahmed@agh.edu.pl", role: "astronaut" },
  { crewCode: "FE06", email: "romamalenko241@gmail.com", role: "astronaut" },
  { crewCode: "FE07", email: "pedapudisrteja@gmail.com", role: "admin" },
];

async function findOrCreateUser(member) {
  try {
    return await auth.getUserByEmail(member.email);
  } catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
    return auth.createUser({
      email: member.email,
      password: temporaryPassword,
      displayName: member.crewCode,
    });
  }
}

async function seed() {
  for (const member of crew) {
    const user = await findOrCreateUser(member);
    await db.collection("users").doc(user.uid).set({
      email: member.email,
      crewCode: member.crewCode,
      displayName: member.crewCode,
      role: member.role,
    });
    console.log(`${member.crewCode}: ready as ${member.role} (${user.uid})`);
  }
  console.log("All crew accounts are ready.");
}

seed().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
