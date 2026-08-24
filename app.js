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
  getFirestore,
  onSnapshot,
  query,
  setDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js?v=4";

const CREW_CODES = ["FE01", "FE02", "FE03", "FE04", "FE05", "FE06", "FE07"];
const SESSION_ACCENTS = ["s1", "s2", "s3", "s4"];
const MAX_DAY = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// The commander-selected day lives in the missionDay collection alongside the
// per-day anchors, under the reserved id "active". Keeping it there means it is
// covered by the same security rule as the anchors themselves — one rule to
// deploy, not two, and no collection that a stale rule set has never heard of.
const ACTIVE_DAY_DOC = "active";

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
  anchors: new Map(),        // dayNumber -> UTC ISO string, from missionDay/{1..7}
  pointerDay: null,          // commander-selected day, from missionDay/active
  day: 1,                    // derived: pointer day plus whole elapsed mission days
  baseDay: null,             // the day whose anchor the clock is counting from
  completionsDay: null,      // the day the completions listener is bound to
  completions: new Map(),
  completionsVersion: 0,
  unsubscribers: [],
  completionsUnsubscribe: null,
  previousSession: null,
  pulseSession: null,
  selectedSession: null,
  renderKey: "",
};

const configured = !Object.values(firebaseConfig).some(
  (value) => typeof value === "string" && value.startsWith("PASTE_"),
);
if (!configured) $("setup-banner").classList.remove("hidden");

const app = configured ? initializeApp(firebaseConfig) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getFirestore(app) : null;

/* ------------------------------------------------------------------ time -- */

function utcString(date = new Date()) {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}  ${iso.slice(11, 19)} UTC`;
}

function utcTimeOnly(date = new Date()) {
  return `${date.toISOString().slice(11, 19)} UTC`;
}

// One mission day is 24 hours long. When the clock passes T+24:00:00 it wraps
// back to T+00:00:00 and the mission day advances — the commander does not have
// to be awake at the rollover for the crew to see the right day.
function resolveClock(now = Date.now()) {
  let baseDay = null;

  if (state.pointerDay !== null && state.anchors.has(state.pointerDay)) {
    baseDay = state.pointerDay;
  } else {
    let latestPast = null;
    let latestAny = null;
    state.anchors.forEach((iso, dayNumber) => {
      const stamp = Date.parse(iso);
      if (Number.isNaN(stamp)) return;
      if (latestAny === null || stamp > Date.parse(state.anchors.get(latestAny))) latestAny = dayNumber;
      if (stamp <= now && (latestPast === null || stamp > Date.parse(state.anchors.get(latestPast)))) {
        latestPast = dayNumber;
      }
    });
    baseDay = latestPast ?? latestAny;
  }

  if (baseDay === null) {
    return { day: state.pointerDay ?? 1, seconds: null, baseDay: null };
  }

  const elapsed = Math.max(0, now - Date.parse(state.anchors.get(baseDay)));
  return {
    day: Math.min(MAX_DAY, baseDay + Math.floor(elapsed / DAY_MS)),
    seconds: (elapsed % DAY_MS) / 1000,
    baseDay,
  };
}

function formatMission(seconds) {
  if (seconds === null) return "T+--:--:--";
  const total = Math.floor(seconds);
  const hours = String(Math.floor(total / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const secs = String(total % 60).padStart(2, "0");
  return `T+${hours}:${minutes}:${secs}`;
}

function activeSession(seconds) {
  if (seconds === null) return null;
  return Math.min(3, Math.floor(seconds / 3600 / 4));
}

/* --------------------------------------------------------------- helpers -- */

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

function describeError(error) {
  if (error?.code === "permission-denied") {
    return "Firestore rejected the write. Publish firestore.rules from this repo in the Firebase console (Firestore → Rules → Publish), then reload.";
  }
  return error?.message ?? String(error);
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
  window.clearTimeout(toast.dataset.timer);
  toast.dataset.timer = window.setTimeout(() => toast.remove(), 6000);
}

/* --------------------------------------------------------------- render -- */

function renderDots() {
  $("day-dots").innerHTML = Array.from({ length: MAX_DAY }, (_, index) =>
    `<span class="dot ${index + 1 <= state.day ? "filled" : ""}" aria-label="Day ${index + 1}"></span>`,
  ).join("");
}

function renderSessions(current) {
  if (!state.user) return;
  const selected = state.selectedSession === null ? (current ?? 0) : state.selectedSession;

  $("day-label").textContent = `Mission Day ${state.day}`;
  $("session-line").textContent = current === null
    ? "Mission day not started"
    : `Session ${current + 1} active`;
  renderDots();

  $("session-nav").innerHTML = SESSIONS.map((session, index) => {
    const label = current === index
      ? "Active"
      : current !== null && index < current ? "Past" : "Upcoming";
    return `<button class="session-nav-item ${index === selected ? "selected" : ""} ${index === current ? "active" : ""}" type="button" data-session-select="${index}">
      <span>${session.name}</span><small>${label}</small>
    </button>`;
  }).join("");

  document.querySelectorAll("[data-session-select]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedSession = Number(button.dataset.sessionSelect);
      paint(true);
    });
  });

  const session = SESSIONS[selected];
  const tests = visibleTests(session, state.day);
  const status = current === null
    ? "upcoming"
    : selected === current ? "active" : selected < current ? "past" : "upcoming";
  const windowEnd = `T+${String(session.end).padStart(2, "0")}:00:00`;

  $("sessions-view").innerHTML = `<section class="session ${SESSION_ACCENTS[selected]} ${status}">
      <div class="session-head ${selected === state.pulseSession ? "pulse" : ""}">
        <span class="name">${session.name}</span>
        <span class="window">T+${String(session.start).padStart(2, "0")}:00:00 – ${windowEnd}</span>
        <span class="badge ${selected === current ? "now" : ""}">${selected === current ? "Active" : status}</span>
      </div>
      ${tests.length ? tests.map((test) => renderTest(test, selected + 1)).join("") : "<div class=\"empty\">No tests scheduled.</div>"}
    </section>`;

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
    ${completion
      ? `<span class="done-stamp">done</span>`
      : `<button class="btn-mark" type="button" data-complete="1" data-session="${sessionNumber}" data-test="${test[2]}">Mark done</button>`}
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
    if (!tests.length) return;
    rows += `<tr class="sess-row ${SESSION_ACCENTS[index]}"><td colspan="4">${session.name}</td></tr>`;
    tests.forEach((test) => {
      const done = doneByKey.get(test[2]) || [];
      const pending = CREW_CODES.filter((code) => !done.includes(code));
      rows += `<tr><td>${test[0]}</td>`
        + `<td><div class="codes">${done.length ? done.map((code) => `<span class="yes">${code}</span>`).join("") : '<span class="none">—</span>'}</div></td>`
        + `<td><div class="codes">${pending.length ? pending.map((code) => `<span class="no">${code}</span>`).join("") : '<span class="none">—</span>'}</div></td>`
        + `<td class="count">${done.length}/${CREW_CODES.length}</td></tr>`;
    });
  });

  $("dash-day").textContent = state.day;
  $("dash-summary").textContent = `${state.completions.size} completions`;
  $("dash-body").innerHTML = rows;
}

// Runs once a second. Clocks are cheap to repaint; the session list is not, and
// rebuilding it every tick would steal focus from a button mid-press — so it is
// only rebuilt when something it depends on has actually changed.
function paint(force = false) {
  const clock = resolveClock();
  const current = activeSession(clock.seconds);

  if (clock.day !== state.day) {
    state.day = clock.day;
    state.selectedSession = null;
    state.previousSession = null;
    syncDaySelect();
    subscribeCompletions();
  }
  state.baseDay = clock.baseDay;

  $("utc-clock").textContent = utcString();
  $("cmd-utc").textContent = utcString();
  $("mission-clock").textContent = formatMission(clock.seconds);
  $("mission-clock").classList.toggle("unset", clock.seconds === null);
  $("display-mission-clock").textContent = formatMission(clock.seconds);
  $("display-day").textContent = `Mission Day ${state.day}`;
  $("display-session").textContent = current === null
    ? "Mission day not started"
    : `Session ${current + 1} active`;
  $("display-session-detail").textContent = current === null
    ? "Waiting for Commander to start the mission day."
    : `${SESSIONS[current].name} · ${visibleTests(SESSIONS[current], state.day).map((test) => test[0]).join(" · ")}`;

  if (current !== null && current !== state.previousSession) {
    state.pulseSession = current;
    playSessionChime(current);
    window.setTimeout(() => {
      state.pulseSession = null;
      paint(true);
    }, 1300);
  }
  state.previousSession = current;

  const key = `${state.day}|${current}|${state.selectedSession}|${state.pulseSession}|${state.completionsVersion}`;
  if (force || key !== state.renderKey) {
    state.renderKey = key;
    renderSessions(current);
    renderDashboard();
  }
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
  } catch (error) {
    // No audio device, or the browser has not granted an audio context yet.
    // The visual highlight still fires; a missing beep must not stop the app.
  }
}

/* --------------------------------------------------------- commander ops -- */

function syncDaySelect() {
  if (state.profile?.role === "commander") $("day-select").value = String(state.day);
}

function updateAnchorPreview() {
  const hours = Number($("in-hh").value) || 0;
  const minutes = Number($("in-mm").value) || 0;
  const seconds = Number($("in-ss").value) || 0;
  const entered = (hours * 3600 + minutes * 60 + seconds) * 1000;
  $("anchor-preview").textContent = utcString(new Date(Date.now() - entered));
}

function updateLastSaved() {
  const dayNumber = state.baseDay ?? state.day;
  const anchor = state.anchors.get(dayNumber);
  $("last-saved").textContent = anchor
    ? `Day ${dayNumber} anchor = ${utcString(new Date(anchor))}`
    : "Not set";
}

async function writeActiveDay(dayNumber) {
  await setDoc(doc(db, "missionDay", ACTIVE_DAY_DOC), {
    dayNumber,
    setBy: state.user.uid,
    updatedAt: new Date().toISOString(),
  });
}

async function setActiveDay() {
  const dayNumber = Number($("day-select").value);
  const hasAnchor = state.anchors.has(dayNumber);
  const startNow = !hasAnchor
    && window.confirm(`Day ${dayNumber} has no start time yet.\n\nStart it now at T+00:00:00?`);
  try {
    if (startNow) {
      await setDoc(doc(db, "missionDay", String(dayNumber)), {
        wakeUpTime: new Date().toISOString(),
        setBy: state.user.uid,
      });
    }
    await writeActiveDay(dayNumber);
    showToast(startNow
      ? `Mission Day ${dayNumber} started at T+00:00:00.`
      : `Mission Day ${dayNumber} is now active.`);
  } catch (error) {
    showToast(`Could not set active day: ${describeError(error)}`, true);
  }
}

async function setMissionTime(reset = false) {
  const dayNumber = Number($("day-select").value);
  let entered = 0;

  if (!reset) {
    const hours = Number($("in-hh").value);
    const minutes = Number($("in-mm").value);
    const seconds = Number($("in-ss").value);
    const valid = Number.isInteger(hours) && hours >= 0 && hours < 24
      && Number.isInteger(minutes) && minutes >= 0 && minutes < 60
      && Number.isInteger(seconds) && seconds >= 0 && seconds < 60;
    if (!valid) {
      showToast("Enter a mission time between T+00:00:00 and T+23:59:59.", true);
      return;
    }
    entered = (hours * 3600 + minutes * 60 + seconds) * 1000;
  }

  try {
    await setDoc(doc(db, "missionDay", String(dayNumber)), {
      wakeUpTime: new Date(Date.now() - entered).toISOString(),
      setBy: state.user.uid,
    });
    // Setting a day's mission time is also a statement that this is the day the
    // crew is on. Without this, the anchor moves but everyone stays on the old day.
    await writeActiveDay(dayNumber);
    showToast(reset
      ? `Day ${dayNumber} reset to T+00:00:00.`
      : `Day ${dayNumber} mission time saved.`);
  } catch (error) {
    showToast(`Could not save mission time: ${describeError(error)}`, true);
  }
}

async function resetDay() {
  if (!window.confirm(`Clear all completions for Mission Day ${state.day}? This cannot be undone.`)) return;
  const ids = [...state.completions.keys()];
  try {
    await Promise.all(ids.map((id) => deleteDoc(doc(db, "completions", id))));
    showToast(`Cleared ${ids.length} completions.`);
  } catch (error) {
    showToast(`Could not reset day: ${describeError(error)}`, true);
  }
}

async function markDone(sessionNumber, testKey) {
  if (state.baseDay === null) {
    showToast("No mission day has been started yet. Ask the Commander to start the day.", true);
    return;
  }
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
    showToast(`Could not mark test done: ${describeError(error)}`, true);
  }
}

/* ---------------------------------------------------------- subscriptions -- */

function clearSubscriptions() {
  state.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
  if (state.completionsUnsubscribe) {
    state.completionsUnsubscribe();
    state.completionsUnsubscribe = null;
  }
  state.completionsDay = null;
  state.anchors = new Map();
  state.completions = new Map();
}

// One listener covers every anchor plus the active-day pointer, so a rollover
// onto a day whose anchor was set days ago needs no extra read.
function subscribeMissionDays() {
  state.unsubscribers.push(onSnapshot(collection(db, "missionDay"), (snapshot) => {
    const anchors = new Map();
    let pointerDay = null;
    snapshot.forEach((item) => {
      if (item.id === ACTIVE_DAY_DOC) {
        const dayNumber = Number(item.data().dayNumber);
        if (Number.isInteger(dayNumber) && dayNumber >= 1 && dayNumber <= MAX_DAY) pointerDay = dayNumber;
        return;
      }
      const dayNumber = Number(item.id);
      const wakeUpTime = item.data().wakeUpTime;
      if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > MAX_DAY) return;
      if (typeof wakeUpTime === "string") anchors.set(dayNumber, wakeUpTime);
      else if (wakeUpTime?.toDate) anchors.set(dayNumber, wakeUpTime.toDate().toISOString());
    });
    state.anchors = anchors;
    state.pointerDay = pointerDay;
    updateLastSaved();
    paint(true);
    subscribeCompletions();
  }, (error) => showToast(`Mission day unavailable: ${describeError(error)}`, true)));
}

function subscribeCompletions() {
  if (state.completionsDay === state.day) return;
  if (state.completionsUnsubscribe) state.completionsUnsubscribe();
  state.completionsDay = state.day;

  const completionsQuery = query(collection(db, "completions"), where("dayNumber", "==", state.day));
  state.completionsUnsubscribe = onSnapshot(completionsQuery, (snapshot) => {
    state.completions = new Map(snapshot.docs.map((item) => [item.id, item.data()]));
    state.completionsVersion += 1;
    paint(true);
  }, (error) => showToast(`Dashboard unavailable: ${describeError(error)}`, true));
}

/* ------------------------------------------------------------------- ui -- */

function configureUi() {
  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!auth) {
      $("login-error").textContent = "Firebase is not configured yet.";
      return;
    }
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
  $("session-nav").classList.toggle("hidden", !sessions);
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
  syncDaySelect();
  subscribeMissionDays();
  subscribeCompletions();
  paint(true);
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
      if (!profileSnapshot.exists()) {
        throw new Error("No crew profile for this account. Ask the Data Officer to run the seed script.");
      }
      state.user = user;
      state.profile = profileSnapshot.data();
      enterApp();
    } catch (error) {
      await signOut(auth);
      $("login-error").textContent = describeError(error);
    }
  });
}

window.setInterval(() => paint(), 1000);
