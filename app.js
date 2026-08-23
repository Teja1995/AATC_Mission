import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  setDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js?v=2";

const CREW_CODES = ["FE01", "FE02", "FE03", "FE04", "FE05", "FE06", "FE07"];
const SESSION_ACCENTS = ["s1", "s2", "s3", "s4"];
const SESSIONS = [
  {
    name: "Session 1",
    start: 0,
    end: 4,
    tests: [
      ["Sleep", "Sleep", "sleep"],
      ["Circadian (morning)", "Circadian", "circadian_morning"],
      ["Bioimpedance (morning)", "Bioimpedance", "bioimpedance_morning"],
      ["Saturation, Temp, Resp. Rate, BP", "Bioimpedance", "vitals_morning"],
      ["STP (morning)", "STP", "stp_morning"],
      ["Chimp (morning)", "Chimp", "chimp_morning"],
      ["Urine analysis", "Urine", "urine", "Days 1, 2, 6 only"],
    ],
  },
  {
    name: "Session 2",
    start: 4,
    end: 8,
    tests: [
      ["Circadian (midday)", "Circadian", "circadian_midday"],
      ["Heart Time", "Heart Time", "heart_time", "Days 2–5 only"],
      ["Hof Protocol", "Hof", "hof"],
    ],
  },
  {
    name: "Session 3",
    start: 8,
    end: 12,
    tests: [
      ["Circadian (evening)", "Circadian", "circadian_evening"],
      ["PR Presentation", "—", "pr_presentation", "Day 7 only"],
      ["Summary Report", "—", "summary_report", "Day 7 only"],
    ],
  },
  {
    name: "Session 4",
    start: 12,
    end: 24,
    tests: [
      ["Circadian (midnight)", "Circadian", "circadian_midnight"],
      ["Water intake", "Water", "water"],
      ["Daily Report", "Report", "daily_report"],
      ["Bioimpedance (evening)", "Bioimpedance", "bioimpedance_evening"],
      ["STP (evening)", "STP", "stp_evening"],
      ["Chimp (evening)", "Chimp", "chimp_evening"],
      ["Space Dragon Test A4", "—", "space_dragon", "Days 4 and 6 only"],
    ],
  },
];

const $ = (id) => document.getElementById(id);
const state = {
  user: null,
  profile: null,
  day: 1,
  missionDay: null,
  completions: new Map(),
  unsubscribers: [],
  dayUnsubscribers: [],
  previousSession: null,
  pulseSession: null,
};

const configured = !Object.values(firebaseConfig).some((value) => value.startsWith("PASTE_"));
if (!configured) $("setup-banner").classList.remove("hidden");

const app = configured ? initializeApp(firebaseConfig) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getFirestore(app) : null;

function utcString(date = new Date()) {
  return date.toISOString().replace("T", "  ").replace(".000Z", " UTC").replace("Z", " UTC");
}

function missionSeconds() {
  if (!state.missionDay?.wakeUpTime) return null;
  const anchor = new Date(state.missionDay.wakeUpTime).getTime();
  return Math.max(0, (Date.now() - anchor) / 1000);
}

function formatMission(seconds) {
  if (seconds === null) return "T+--:--:--";
  const total = Math.floor(seconds);
  const hours = String(Math.floor(total / 3600)).padStart(2, "0");
  const minutes = String(Math.floor(total % 3600 / 60)).padStart(2, "0");
  const secs = String(total % 60).padStart(2, "0");
  return `T+${hours}:${minutes}:${secs}`;
}

function activeSession(seconds) {
  if (seconds === null) return null;
  const hours = seconds / 3600;
  return Math.min(3, Math.floor(hours / 4));
}

function testApplies(test, day) {
  const key = test[2];
  if (key === "urine") return [1, 2, 6].includes(day);
  if (key === "heart_time") return day >= 2 && day <= 5;
  if (["pr_presentation", "summary_report"].includes(key)) return day === 7;
  if (key === "space_dragon") return [4, 6].includes(day);
  return true;
}

function visibleTests(session, day) {
  return session.tests.filter((test) => testApplies(test, day));
}

function completionId(sessionNumber, testKey, uid) {
  return `${state.day}_${sessionNumber}_${testKey}_${uid}`;
}

function renderDots() {
  $("day-dots").innerHTML = Array.from({ length: 7 }, (_, index) =>
    `<span class="dot ${index + 1 <= state.day ? "filled" : ""}" aria-label="Day ${index + 1}"></span>`,
  ).join("");
}

function renderSessions() {
  if (!state.user) return;
  const current = activeSession(missionSeconds());
  $("day-label").textContent = `Mission Day ${state.day}`;
  $("session-line").textContent = current === null ? "Mission day not started" : `Session ${current + 1} active`;
  renderDots();

  $("sessions-view").innerHTML = SESSIONS.map((session, index) => {
    const tests = visibleTests(session, state.day);
    const status = current === null ? "upcoming" : index === current ? "active" : index < current ? "past" : "upcoming";
    const windowEnd = session.end === 24 ? "T+24:00:00" : `T+${String(session.end).padStart(2, "0")}:00:00`;
    return `<section class="session ${SESSION_ACCENTS[index]} ${status}">
      <div class="session-head ${index === state.pulseSession ? "pulse" : ""}">
        <span class="name">${session.name}</span>
        <span class="window">T+${String(session.start).padStart(2, "0")}:00:00 – ${windowEnd}</span>
        <span class="badge ${index === current ? "now" : ""}">${index === current ? "Active" : status}</span>
      </div>
      ${tests.length ? tests.map((test) => renderTest(test, index + 1)).join("") : "<div class=\"empty\">No tests scheduled.</div>"}
    </section>`;
  }).join("");

  document.querySelectorAll("[data-complete]").forEach((button) => {
    button.addEventListener("click", () => markDone(button.dataset.session, button.dataset.test));
  });
}

function renderTest(test, sessionNumber) {
  const id = completionId(sessionNumber, test[2], state.user.uid);
  const completion = state.completions.get(id);
  return `<div class="test ${completion ? "done" : ""}">
    <span class="mark">${completion ? "✓" : ""}</span>
    <span class="label">${test[0]}${test[3] ? `<span class="only">${test[3]}</span>` : ""}</span>
    <span class="sheet">Sheet: ${test[1]}</span>
    ${completion ? `<span class="done-stamp">done</span>` : `<button class="btn-mark" type="button" data-complete="1" data-session="${sessionNumber}" data-test="${test[2]}">Mark done</button>`}
  </div>`;
}

function renderDashboard() {
  const doneByKey = new Map();
  state.completions.forEach((completion) => {
    if (!doneByKey.has(completion.testKey)) doneByKey.set(completion.testKey, []);
    doneByKey.get(completion.testKey).push(completion.crewCode);
  });
  let rows = "";
  SESSIONS.forEach((session, index) => {
    const tests = visibleTests(session, state.day);
    rows += `<tr class="sess-row ${SESSION_ACCENTS[index]}"><td colspan="4">${session.name}</td></tr>`;
    tests.forEach((test) => {
      const done = doneByKey.get(test[2]) || [];
      const pending = CREW_CODES.filter((code) => !done.includes(code));
      rows += `<tr><td>${test[0]}</td><td><div class="codes">${done.length ? done.map((code) => `<span class="yes">${code}</span>`).join("") : '<span class="none">—</span>'}</div></td><td><div class="codes">${pending.map((code) => `<span class="no">${code}</span>`).join("")}</div></td><td class="count">${done.length}/${CREW_CODES.length}</td></tr>`;
    });
  });
  $("dash-day").textContent = state.day;
  $("dash-summary").textContent = `${state.completions.size} completions`;
  $("dash-body").innerHTML = rows;
}

function renderClocks() {
  const seconds = missionSeconds();
  $("utc-clock").textContent = utcString();
  $("cmd-utc").textContent = utcString();
  $("mission-clock").textContent = formatMission(seconds);
  $("mission-clock").classList.toggle("unset", seconds === null);
  const current = activeSession(seconds);
  if (current !== null && current !== state.previousSession) {
    state.pulseSession = current;
    playSessionChime(current);
    window.setTimeout(() => {
      state.pulseSession = null;
      renderSessions();
    }, 1200);
  }
  state.previousSession = current;
  renderSessions();
}

function playSessionChime(sessionIndex) {
  const key = `aatc-chime-day-${state.day}-session-${sessionIndex + 1}`;
  if (window.localStorage.getItem(key)) return;
  window.localStorage.setItem(key, "1");
  try {
    const audioContext = new AudioContext();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = 440;
    gain.gain.value = 0.3;
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.2);
    oscillator.addEventListener("ended", () => audioContext.close(), { once: true });
  } catch { }
}

function updateAnchorPreview() {
  const hours = Number($("in-hh").value) || 0;
  const minutes = Number($("in-mm").value) || 0;
  const seconds = Number($("in-ss").value) || 0;
  const entered = (hours * 3600 + minutes * 60 + seconds) * 1000;
  $("anchor-preview").textContent = utcString(new Date(Date.now() - entered));
}

function showToast(message, error = false) {
  let toast = $("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    document.body.append(toast);
  }
  toast.textContent = message;
  toast.classList.toggle("err", error);
  window.setTimeout(() => toast.remove(), 4000);
}

async function markDone(sessionNumber, testKey) {
  const id = completionId(sessionNumber, testKey, state.user.uid);
  try {
    await setDoc(doc(db, "completions", id), {
      uid: state.user.uid,
      crewCode: state.profile.crewCode,
      displayName: state.profile.crewCode,
      completedAt: new Date().toISOString(),
      dayNumber: state.day,
      sessionNumber: Number(sessionNumber),
      testKey,
    });
  } catch (error) {
    showToast(`Could not mark test done: ${error.message}`, true);
  }
}

function clearSubscriptions() {
  state.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
  state.dayUnsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
}

function subscribeToDay() {
  state.dayUnsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
  const dayRef = doc(db, "missionDay", String(state.day));
  state.dayUnsubscribers.push(onSnapshot(dayRef, (snapshot) => {
    state.missionDay = snapshot.exists() ? snapshot.data() : null;
    const saved = state.missionDay?.wakeUpTime;
    $("last-saved").textContent = saved ? `Day ${state.day} anchor = ${utcString(new Date(saved))}` : "Not set";
    renderClocks();
  }, (error) => showToast(`Mission day unavailable: ${error.message}`, true)));

  const completionsQuery = query(collection(db, "completions"), where("dayNumber", "==", state.day));
  state.dayUnsubscribers.push(onSnapshot(completionsQuery, (snapshot) => {
    state.completions = new Map(snapshot.docs.map((item) => [item.id, item.data()]));
    renderSessions();
    renderDashboard();
  }, (error) => showToast(`Dashboard unavailable: ${error.message}`, true)));
}

function subscribeToActiveDay() {
  const activeDayRef = doc(db, "missionControl", "current");
  state.unsubscribers.push(onSnapshot(activeDayRef, (snapshot) => {
    if (!snapshot.exists()) return;
    const activeDay = Number(snapshot.data().dayNumber);
    if (!Number.isInteger(activeDay) || activeDay < 1 || activeDay > 7 || activeDay === state.day) return;
    state.day = activeDay;
    $("day-select").value = String(activeDay);
    state.previousSession = null;
    state.pulseSession = null;
    subscribeToDay();
    renderDashboard();
  }, (error) => showToast(`Active mission day unavailable: ${error.message}`, true)));
}

async function setActiveDay() {
  const dayNumber = Number($("day-select").value);
  try {
    await setDoc(doc(db, "missionControl", "current"), {
      dayNumber,
      setBy: state.user.uid,
      updatedAt: new Date().toISOString(),
    });
    state.day = dayNumber;
    state.previousSession = null;
    state.pulseSession = null;
    subscribeToDay();
    renderDashboard();
    showToast(`Mission Day ${dayNumber} is now active.`);
  } catch (error) {
    showToast(`Could not set active day: ${error.message}`, true);
  }
}

async function setMissionTime(reset = false) {
  let entered = 0;
  if (!reset) {
    const hours = Number($("in-hh").value);
    const minutes = Number($("in-mm").value);
    const seconds = Number($("in-ss").value);
    if (!Number.isInteger(hours) || hours < 0 || !Number.isInteger(minutes) || minutes < 0 || minutes > 59 || !Number.isInteger(seconds) || seconds < 0 || seconds > 59) {
      showToast("Enter a valid mission time.", true);
      return;
    }
    entered = (hours * 3600 + minutes * 60 + seconds) * 1000;
  }
  try {
    const now = new Date();
    await setDoc(doc(db, "missionDay", String(state.day)), {
      wakeUpTime: new Date(now.getTime() - entered).toISOString(),
      setBy: state.user.uid,
    });
    showToast(reset ? "Mission time reset to T+00:00:00." : "Mission time saved.");
  } catch (error) {
    showToast(`Could not save mission time: ${error.message}`, true);
  }
}

async function resetDay() {
  if (!window.confirm(`Clear all completions for Mission Day ${state.day}? This cannot be undone.`)) return;
  const ids = [...state.completions.keys()];
  try {
    await Promise.all(ids.map((id) => deleteDoc(doc(db, "completions", id))));
    showToast(`Cleared ${ids.length} completions.`);
  } catch (error) {
    showToast(`Could not reset day: ${error.message}`, true);
  }
}

function configureUi() {
  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("login-btn").disabled = true;
    $("login-error").textContent = "";
    try {
      await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value);
    } catch (error) {
      $("login-error").textContent = "Login failed. Check your email and password.";
    } finally {
      $("login-btn").disabled = false;
    }
  });
  $("logout-btn").addEventListener("click", () => signOut(auth));
  $("set-day-btn").addEventListener("click", setActiveDay);
  [$("in-hh"), $("in-mm"), $("in-ss")].forEach((input) => input.addEventListener("input", updateAnchorPreview));
  $("set-time-btn").addEventListener("click", () => setMissionTime());
  $("reset-time-btn").addEventListener("click", () => setMissionTime(true));
  $("reset-day-btn").addEventListener("click", resetDay);
  $("tab-sessions").addEventListener("click", () => switchTab("sessions"));
  $("tab-dashboard").addEventListener("click", () => switchTab("dashboard"));
  updateAnchorPreview();
}

function switchTab(tab) {
  const sessions = tab === "sessions";
  $("sessions-view").classList.toggle("hidden", !sessions);
  $("dashboard-view").classList.toggle("hidden", sessions);
  $("tab-sessions").classList.toggle("active", sessions);
  $("tab-dashboard").classList.toggle("active", !sessions);
}

function enterApp() {
  $("login-view").classList.add("hidden");
  $("app-view").classList.remove("hidden");
  $("crew-chip").textContent = state.profile.crewCode;
  $("crew-chip").classList.toggle("commander", state.profile.role === "commander");
  $("commander-panel").classList.toggle("hidden", state.profile.role !== "commander");
  subscribeToActiveDay();
  subscribeToDay();
  renderDashboard();
}

configureUi();
if (auth) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      state.user = null;
      state.profile = null;
      clearSubscriptions();
      $("app-view").classList.add("hidden");
      $("login-view").classList.remove("hidden");
      return;
    }
    try {
      const profileSnapshot = await getDoc(doc(db, "users", user.uid));
      if (!profileSnapshot.exists()) throw new Error("User profile is missing.");
      state.user = user;
      state.profile = profileSnapshot.data();
      enterApp();
    } catch (error) {
      await signOut(auth);
      $("login-error").textContent = error.message;
    }
  });
}
window.setInterval(renderClocks, 1000);
