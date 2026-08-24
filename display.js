// display.js — the wall display.
//
// Read-only by construction: it subscribes, it renders, it never writes. Every
// mission fact it shows comes from mission.js, the same module the crew app
// uses, so a screen on the wall cannot disagree with a phone in a hand.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  getFirestore,
  onSnapshot,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js?v=13";
import {
  ACTIVE_DAY_DOC,
  ASSIGN_ALL,
  CREW_CODES,
  MAX_DAY,
  SESSIONS,
  SESSION_ACCENTS,
  activeSession,
  doneCodes,
  escapeHtml,
  formatMission,
  resolveClock,
  rosterFor,
  sessionItems,
  utcString,
} from "./mission.js?v=13";

const $ = (id) => document.getElementById(id);

const state = {
  anchors: new Map(),
  pointerDay: null,
  day: 1,
  dayDataDay: null,
  completions: new Map(),
  tasks: new Map(),
  completionsUnsubscribe: null,
  tasksUnsubscribe: null,
  renderKey: "",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

function setStatus(text) {
  $("wall-status").textContent = text;
}

/* ---------------------------------------------------------------- render -- */

function renderItems(target, items) {
  if (!items.length) {
    target.innerHTML = '<p class="empty">Nothing scheduled.</p>';
    return;
  }

  target.innerHTML = items.map((item) => {
    const roster = rosterFor(item);
    const done = doneCodes(item, state.completions, state.day).filter((code) => roster.includes(code));
    const pending = roster.filter((code) => !done.includes(code));
    const complete = pending.length === 0;
    return `<div class="wall-item ${complete ? "complete" : ""}">
      <span class="wall-item-mark">${complete ? "✓" : ""}</span>
      <span class="wall-item-label">${escapeHtml(item.label)}${
        item.taskId
          ? `<span class="assignee ${item.assignedTo === ASSIGN_ALL ? "all" : ""}">${
              item.assignedTo === ASSIGN_ALL ? "Everyone" : item.assignedTo}</span>`
          : ""}</span>
      <span class="wall-item-pending">${
        pending.length ? pending.map((code) => `<span class="no">${code}</span>`).join(" ") : "<span class=\"yes\">all done</span>"}</span>
      <span class="wall-item-count">${done.length}/${roster.length}</span>
    </div>`;
  }).join("");
}

function renderDashboard() {
  let rows = "";
  let doneTotal = 0;
  let dueTotal = 0;

  SESSIONS.forEach((session, index) => {
    const items = sessionItems(index, state.day, state.tasks);
    if (!items.length) return;
    rows += `<tr class="sess-row ${SESSION_ACCENTS[index]}"><td colspan="4">${session.name}</td></tr>`;
    items.forEach((item) => {
      const roster = rosterFor(item);
      const done = doneCodes(item, state.completions, state.day).filter((code) => roster.includes(code));
      const pending = roster.filter((code) => !done.includes(code));
      doneTotal += done.length;
      dueTotal += roster.length;
      rows += `<tr><td>${escapeHtml(item.label)}${item.taskId ? ' <span class="added-tag">Added</span>' : ""}</td>`
        + `<td><div class="codes">${done.length ? done.map((code) => `<span class="yes">${code}</span>`).join("") : '<span class="none">—</span>'}</div></td>`
        + `<td><div class="codes">${pending.length ? pending.map((code) => `<span class="no">${code}</span>`).join("") : '<span class="none">—</span>'}</div></td>`
        + `<td class="count">${done.length}/${roster.length}</td></tr>`;
    });
  });

  $("wall-dash-body").innerHTML = rows;
  $("wall-dash-summary").textContent = dueTotal ? `${doneTotal} / ${dueTotal} completed` : "";
}

function paint() {
  const clock = resolveClock({ anchors: state.anchors, pointerDay: state.pointerDay });
  const current = activeSession(clock.seconds);

  if (clock.day !== state.day) {
    state.day = clock.day;
    subscribeDayData();
  }

  $("wall-mission").textContent = formatMission(clock.seconds);
  $("wall-mission").classList.toggle("unset", clock.seconds === null);
  $("wall-utc").textContent = utcString();
  $("wall-day").textContent = `Mission Day ${state.day}`;

  $("wall-dots").innerHTML = Array.from({ length: MAX_DAY }, (_, index) =>
    `<span class="dot ${index + 1 <= state.day ? "filled" : ""}"></span>`).join("");

  if (current === null) {
    $("wall-session").textContent = "Mission day not started";
    $("wall-window").textContent = "Waiting for the Commander to start the day";
  } else {
    const session = SESSIONS[current];
    $("wall-session").textContent = session.name;
    $("wall-window").textContent =
      `T+${String(session.start).padStart(2, "0")}:00:00 – T+${String(session.end).padStart(2, "0")}:00:00`;
  }

  const key = `${state.day}|${current}|${state.completions.size}|${state.tasks.size}`;
  if (key !== state.renderKey) {
    state.renderKey = key;

    const currentIndex = current ?? 0;
    const nextIndex = current === null ? 1 : Math.min(SESSIONS.length - 1, current + 1);

    $("wall-current-title").textContent = current === null
      ? `Due first — ${SESSIONS[0].name}`
      : `Due now — ${SESSIONS[currentIndex].name}`;
    renderItems($("wall-current"), sessionItems(currentIndex, state.day, state.tasks));

    document.querySelectorAll(".wall-panel h2")[1].textContent = `Next up — ${SESSIONS[nextIndex].name}`;
    renderItems($("wall-next"), currentIndex === nextIndex ? [] : sessionItems(nextIndex, state.day, state.tasks));

    renderDashboard();
  }
}

/* --------------------------------------------------------- subscriptions -- */

function subscribeMissionDays() {
  onSnapshot(collection(db, "missionDay"), (snapshot) => {
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
    state.renderKey = "";
    setStatus(`live · updated ${utcString().slice(12)}`);
    paint();
    subscribeDayData();
  }, (error) => setStatus(`mission day unavailable: ${error.code ?? error.message}`));
}

function subscribeDayData() {
  if (state.dayDataDay === state.day) return;
  if (state.completionsUnsubscribe) state.completionsUnsubscribe();
  if (state.tasksUnsubscribe) state.tasksUnsubscribe();

  const boundDay = state.day;
  state.dayDataDay = boundDay;
  state.completions = new Map();
  state.tasks = new Map();
  state.renderKey = "";

  state.completionsUnsubscribe = onSnapshot(
    query(collection(db, "completions"), where("dayNumber", "==", boundDay)),
    (snapshot) => {
      if (state.dayDataDay !== boundDay) return;
      state.completions = new Map(snapshot.docs.map((item) => [item.id, item.data()]));
      state.renderKey = "";
      setStatus(`live · updated ${utcString().slice(12)}`);
      paint();
    },
    (error) => setStatus(`dashboard unavailable: ${error.code ?? error.message}`),
  );

  state.tasksUnsubscribe = onSnapshot(
    query(collection(db, "tasks"), where("dayNumber", "==", boundDay)),
    (snapshot) => {
      if (state.dayDataDay !== boundDay) return;
      state.tasks = new Map(snapshot.docs.map((item) => [item.id, item.data()]));
      state.renderKey = "";
      paint();
    },
    (error) => setStatus(`tasks unavailable: ${error.code ?? error.message}`),
  );
}

/* ------------------------------------------------------------------- ui -- */

$("display-login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("display-login-btn").disabled = true;
  $("display-login-error").textContent = "";
  try {
    await signInWithEmailAndPassword(auth, $("display-email").value.trim(), $("display-password").value);
  } catch (error) {
    $("display-login-error").textContent = "Sign-in failed. Check the display account details.";
  } finally {
    $("display-login-btn").disabled = false;
  }
});

onAuthStateChanged(auth, (user) => {
  if (!user) {
    $("display-login").classList.remove("hidden");
    $("display-main").classList.add("hidden");
    return;
  }
  $("display-login").classList.add("hidden");
  $("display-main").classList.remove("hidden");
  setStatus("connecting…");
  subscribeMissionDays();
  subscribeDayData();
  paint();
});

window.setInterval(paint, 1000);

// A wall display runs for days. Reload nightly so a browser that has quietly
// lost its Firestore stream comes back on its own rather than showing a frozen
// clock to a crew that trusts it.
window.setTimeout(() => window.location.reload(), 12 * 60 * 60 * 1000);
