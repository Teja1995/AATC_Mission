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
const astronauts = [
  { crewCode: "FE01", email: "alinahalchak@gmail.com" },
  { crewCode: "FE02", email: "andriana2081@gmail.com" },
  { crewCode: "FE03", email: "upadhyay.arin@gmail.com" },
  { crewCode: "FE05", email: "mahmed@agh.edu.pl" },
  { crewCode: "FE06", email: "romamalenko241@gmail.com" },
  { crewCode: "FE07", email: "pedapudisrteja@gmail.com" },
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
  for (const member of astronauts) {
    const user = await findOrCreateUser(member);
    await db.collection("users").doc(user.uid).set({
      email: member.email,
      crewCode: member.crewCode,
      displayName: member.crewCode,
      role: "astronaut",
    });
    console.log(`${member.crewCode}: ready (${user.uid})`);
  }
  console.log("All astronaut accounts are ready.");
}

seed().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
