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
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js?v=17";
import {
  ACTIVE_DAY_DOC,
  ASSIGN_ALL,
  CREW_CODES,
  DAY_MS,
  MAX_DAY,
  SESSIONS,
  SESSION_ACCENTS,
  activeSession,
  doneCodes as doneCodesFor,
  escapeAttr,
  escapeHtml,
  formatMission,
  resolveClock as resolveClockFrom,
  rosterFor,
  sessionItems as sessionItemsFor,
  utcString,
  visibleTests,
} from "./mission.js?v=17";

// Armstrong urine colour scale. The swatches on screen carry these colours so
// the crew matches a colour to a colour, not a colour to a number — the printed
// chart by the toilet is the reference, this is the same chart on the tablet.
const COLOUR_SCALE = [
  { score: 1, hex: "#F8F3B0", ink: "#2a1c02", status: "Well hydrated" },
  { score: 2, hex: "#F7EC85", ink: "#2a1c02", status: "Well hydrated" },
  { score: 3, hex: "#F5E14F", ink: "#2a1c02", status: "Adequate" },
  { score: 4, hex: "#F2D32A", ink: "#2a1c02", status: "Adequate" },
  { score: 5, hex: "#E9BB16", ink: "#2a1c02", status: "Mild dehydration" },
  { score: 6, hex: "#D99A0D", ink: "#2a1c02", status: "Mild dehydration" },
  { score: 7, hex: "#C4700A", ink: "#fff4e2", status: "Dehydrated" },
  { score: 8, hex: "#9C4A08", ink: "#fff4e2", status: "Dehydrated" },
];

const VOID_OUTBOX_KEY = "aatc-void-outbox";
const FOOD_OUTBOX_KEY = "aatc-food-outbox";

// Open Food Facts: free, no key, and it answers with a permissive CORS header,
// so the browser can ask it directly. Coverage is good for branded goods and
// thin for anything repackaged, which is why every field it fills stays
// editable and a log with no barcode at all is a first-class case.
const OFF_ENDPOINT = "https://world.openfoodfacts.org/api/v2/product/";

// Three roles. The commander runs the mission day; the admin runs the
// application and holds the urine log as well. Everyone else is crew.
const COMMAND_ROLES = ["commander", "admin"];




const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  profile: null,
  anchors: new Map(),        // dayNumber -> UTC ISO string, from missionDay/{1..7}
  pointerDay: null,          // commander-selected day, from missionDay/active
  day: 1,                    // derived: pointer day plus whole elapsed mission days
  baseDay: null,             // the day whose anchor the clock is counting from
  dayDataDay: null,          // the day the completions and tasks listeners are bound to
  completions: new Map(),
  tasks: new Map(),          // commander-added tasks for the current day
  completionsVersion: 0,
  unsubscribers: [],
  completionsUnsubscribe: null,
  tasksUnsubscribe: null,
  previousSession: null,
  pulseSession: null,
  selectedSession: null,
  renderKey: "",
  voidColour: null,          // Armstrong score selected in the Log Urine form
  myVoids: new Map(),        // this crew member's own entries
  myVoidsUnsubscribe: null,
  allVoids: new Map(),       // every entry, admin only
  allVoidsUnsubscribe: null,
  myMeals: new Map(),
  myMealsUnsubscribe: null,
  allMeals: new Map(),
  allMealsUnsubscribe: null,
  editingMealId: null,
  foodItems: new Map(),      // the crew's own food list, shared
  foodItemsUnsubscribe: null,
  scanStream: null,          // live camera track while scanning a barcode
  scanTimer: null,
  editingVoidId: null,       // set while correcting an existing entry
};

const configured = !Object.values(firebaseConfig).some(
  (value) => typeof value === "string" && value.startsWith("PASTE_"),
);
if (!configured) $("setup-banner").classList.remove("hidden");

const app = configured ? initializeApp(firebaseConfig) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getFirestore(app) : null;

/* ------------------------------------------------------------------ time -- */

// The shared module holds the arithmetic; these bind it to this app's state.
function resolveClock(now = Date.now()) {
  return resolveClockFrom({ anchors: state.anchors, pointerDay: state.pointerDay, now });
}

function sessionItems(sessionIndex) {
  return sessionItemsFor(sessionIndex, state.day, state.tasks);
}

function doneCodes(item) {
  return doneCodesFor(item, state.completions, state.day);
}







/* --------------------------------------------------------------- helpers -- */

// FE04 commands the mission, FE07 administers the app. Both drive Mission
// Control; only the admin can read the urine log back.
function canCommand() {
  return COMMAND_ROLES.includes(state.profile?.role);
}

function isAdmin() {
  return state.profile?.role === "admin";
}






function isMine(item) {
  if (!item.assignedTo || item.assignedTo === ASSIGN_ALL) return true;
  return item.assignedTo === state.profile?.crewCode;
}

function completionId(sessionNumber, testKey, uid) {
  return `${state.day}_${sessionNumber}_${testKey}_${uid}`;
}

// Task titles are free text typed by a human, so they are escaped rather than
// interpolated raw into the row markup.


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
  const items = sessionItems(selected);
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
      ${items.length ? items.map((item) => renderItem(item, selected + 1)).join("") : "<div class=\"empty\">No tests scheduled.</div>"}
    </section>`;

  document.querySelectorAll("[data-complete]").forEach((button) => {
    button.addEventListener("click", () => markDone(button.dataset.session, button.dataset.test));
  });
  document.querySelectorAll("[data-remove-task]").forEach((button) => {
    button.addEventListener("click", () => removeTask(button.dataset.removeTask, button.dataset.title));
  });
}

function renderItem(item, sessionNumber) {
  const mine = isMine(item);
  const done = doneCodes(item);
  const stored = state.completions.get(completionId(sessionNumber, item.key, state.user.uid));
  const myDone = Boolean(stored) && Number(stored.dayNumber) === state.day;
  // A task assigned to someone else is still shown to everyone, ticked when
  // that person has done it -- the crew can see what is outstanding and whose.
  const settled = mine ? myDone : done.includes(item.assignedTo);

  const assignee = item.taskId
    ? `<span class="assignee ${item.assignedTo === ASSIGN_ALL ? "all" : ""}">${
        item.assignedTo === ASSIGN_ALL ? "Everyone" : item.assignedTo}</span>`
    : "";
  const removal = item.taskId && canCommand()
    ? `<button class="btn-remove" type="button" data-remove-task="${item.taskId}" data-title="${escapeAttr(item.label)}" title="Remove task" aria-label="Remove task">✕</button>`
    : "";

  let action;
  if (!mine) {
    action = settled
      ? `<span class="done-stamp">done by ${item.assignedTo}</span>`
      : `<span class="waiting">with ${item.assignedTo}</span>`;
  } else if (myDone) {
    action = `<span class="done-stamp">done</span>`;
  } else {
    action = `<button class="btn-mark" type="button" data-complete="1" data-session="${sessionNumber}" data-test="${item.key}">Mark done</button>`;
  }

  return `<div class="test ${settled ? "done" : ""} ${item.taskId ? "added" : ""}">
    <span class="mark">${settled ? "✓" : ""}</span>
    <span class="label">${escapeHtml(item.label)}${item.note ? `<span class="only">${item.note}</span>` : ""}${assignee}</span>
    ${item.sheet ? `<span class="sheet">Sheet: ${item.sheet}</span>` : `<span class="sheet added-tag">Added task</span>`}
    ${action}
    ${removal}
  </div>`;
}

function renderDashboard() {
  let rows = "";
  let doneCount = 0;
  let dueCount = 0;
  SESSIONS.forEach((session, index) => {
    const items = sessionItems(index);
    if (!items.length) return;
    rows += `<tr class="sess-row ${SESSION_ACCENTS[index]}"><td colspan="4">${session.name}</td></tr>`;
    items.forEach((item) => {
      // An added task counts against its assignee only, so a one-person task
      // reads 0/1 rather than looking like six people are late.
      const roster = rosterFor(item);
      const done = doneCodes(item).filter((code) => roster.includes(code));
      const pending = roster.filter((code) => !done.includes(code));
      doneCount += done.length;
      dueCount += roster.length;
      const tag = item.taskId ? '<span class="added-tag">Added</span>' : "";
      rows += `<tr><td>${escapeHtml(item.label)} ${tag}</td>`
        + `<td><div class="codes">${done.length ? done.map((code) => `<span class="yes">${code}</span>`).join("") : '<span class="none">—</span>'}</div></td>`
        + `<td><div class="codes">${pending.length ? pending.map((code) => `<span class="no">${code}</span>`).join("") : '<span class="none">—</span>'}</div></td>`
        + `<td class="count">${done.length}/${roster.length}</td></tr>`;
    });
  });

  $("dash-day").textContent = state.day;
  // Counts only what is actually due today. A test dropped from the protocol
  // can leave completion documents behind; they must not pad today's total.
  $("dash-summary").textContent = `${doneCount} / ${dueCount} completed`;
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
    renderTaskList();
    subscribeDayData();
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
  updateVoidAuto();
  updateFoodAuto();

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
  if (canCommand()) $("day-select").value = String(state.day);
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
  // Only the crew member a task is assigned to can tick it off. The button is
  // not rendered for anyone else; this catches a stale screen mid-reassignment.
  const task = state.tasks.get(testKey);
  if (task && task.assignedTo && task.assignedTo !== ASSIGN_ALL
      && task.assignedTo !== state.profile.crewCode) {
    showToast(`That task is assigned to ${task.assignedTo}.`, true);
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
  if (state.tasksUnsubscribe) {
    state.tasksUnsubscribe();
    state.tasksUnsubscribe = null;
  }
  if (state.myVoidsUnsubscribe) {
    state.myVoidsUnsubscribe();
    state.myVoidsUnsubscribe = null;
  }
  if (state.allVoidsUnsubscribe) {
    state.allVoidsUnsubscribe();
    state.allVoidsUnsubscribe = null;
  }
  if (state.myMealsUnsubscribe) {
    state.myMealsUnsubscribe();
    state.myMealsUnsubscribe = null;
  }
  if (state.allMealsUnsubscribe) {
    state.allMealsUnsubscribe();
    state.allMealsUnsubscribe = null;
  }
  state.myVoids = new Map();
  state.allVoids = new Map();
  if (state.foodItemsUnsubscribe) {
    state.foodItemsUnsubscribe();
    state.foodItemsUnsubscribe = null;
  }
  state.myMeals = new Map();
  state.allMeals = new Map();
  state.foodItems = new Map();
  state.dayDataDay = null;
  state.anchors = new Map();
  state.completions = new Map();
  state.tasks = new Map();
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
    subscribeDayData();
  }, (error) => showToast(`Mission day unavailable: ${describeError(error)}`, true)));
}

// Completions and added tasks are both scoped to one mission day and rebind
// together at the rollover.
function subscribeDayData() {
  if (!db || !state.user) return;
  if (state.dayDataDay === state.day) return;
  if (state.completionsUnsubscribe) state.completionsUnsubscribe();
  if (state.tasksUnsubscribe) state.tasksUnsubscribe();

  const boundDay = state.day;
  state.dayDataDay = boundDay;

  // Yesterday's ticks must not survive the rollover on screen. Drop them now
  // rather than leaving them up until the new day's first snapshot arrives —
  // a checklist that shows work already done is worse than one that shows none.
  state.completions = new Map();
  state.tasks = new Map();
  state.completionsVersion += 1;

  const completionsQuery = query(collection(db, "completions"), where("dayNumber", "==", boundDay));
  state.completionsUnsubscribe = onSnapshot(completionsQuery, (snapshot) => {
    if (state.dayDataDay !== boundDay) return; // a later day already took over
    state.completions = new Map(snapshot.docs.map((item) => [item.id, item.data()]));
    state.completionsVersion += 1;
    paint(true);
  }, (error) => showToast(`Dashboard unavailable: ${describeError(error)}`, true));

  const tasksQuery = query(collection(db, "tasks"), where("dayNumber", "==", boundDay));
  state.tasksUnsubscribe = onSnapshot(tasksQuery, (snapshot) => {
    if (state.dayDataDay !== boundDay) return;
    state.tasks = new Map(snapshot.docs.map((item) => [item.id, item.data()]));
    state.completionsVersion += 1;
    renderTaskList();
    paint(true);
  }, (error) => showToast(`Added tasks unavailable: ${describeError(error)}`, true));
}

/* ---------------------------------------------------------- added tasks -- */

// Tasks belong to the mission day they were added on. They appear in their
// session for the whole crew; only the person they are assigned to can tick
// one off, but everybody can see that it is outstanding and with whom.
async function addTask(event) {
  event.preventDefault();
  const title = $("task-title").value.trim();
  if (!title) return;

  const sessionNumber = Number($("task-session").value);
  const assignedTo = $("task-assignee").value;
  const taskId = `task_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  try {
    await setDoc(doc(db, "tasks", taskId), {
      dayNumber: state.day,
      sessionNumber,
      title,
      assignedTo,
      createdBy: state.user.uid,
      createdAt: new Date().toISOString(),
    });
    $("task-form").reset();
    $("task-session").value = String(sessionNumber);
    showToast(`Task added to Session ${sessionNumber} for ${assignedTo === ASSIGN_ALL ? "everyone" : assignedTo}.`);
  } catch (error) {
    showToast(`Could not add the task: ${describeError(error)}`, true);
  }
}

async function removeTask(taskId, title) {
  if (!window.confirm(`Remove "${title}" from Mission Day ${state.day}?`)) return;
  try {
    await deleteDoc(doc(db, "tasks", taskId));
    showToast("Task removed.");
  } catch (error) {
    showToast(`Could not remove the task: ${describeError(error)}`, true);
  }
}

function renderTaskList() {
  if (!canCommand()) return;
  $("tasks-panel-day").textContent = `Mission Day ${state.day}`;

  const entries = [...state.tasks.entries()]
    .sort((a, b) => Number(a[1].sessionNumber) - Number(b[1].sessionNumber)
      || String(a[1].createdAt).localeCompare(String(b[1].createdAt)));

  if (!entries.length) {
    $("task-list").innerHTML = '<p class="hint">No added tasks for this day.</p>';
    return;
  }

  $("task-list").innerHTML = entries.map(([id, task]) => {
    const roster = task.assignedTo && task.assignedTo !== ASSIGN_ALL ? [task.assignedTo] : CREW_CODES;
    const done = doneCodes({ key: id }).filter((code) => roster.includes(code));
    return `<div class="task-row">
      <span class="task-session-tag">S${task.sessionNumber}</span>
      <span class="task-row-title">${escapeHtml(task.title)}</span>
      <span class="assignee ${task.assignedTo === ASSIGN_ALL ? "all" : ""}">${
        task.assignedTo === ASSIGN_ALL ? "Everyone" : task.assignedTo}</span>
      <span class="count">${done.length}/${roster.length}</span>
      <button class="btn-remove" type="button" data-remove-task="${id}" data-title="${escapeAttr(task.title)}" aria-label="Remove task">✕</button>
    </div>`;
  }).join("");

  $("task-list").querySelectorAll("[data-remove-task]").forEach((button) => {
    button.addEventListener("click", () => removeTask(button.dataset.removeTask, button.dataset.title));
  });
}

/* ------------------------------------------------------------- log void -- */

// A crew member sees their own entries and nobody else's. The query is filtered
// by uid because the rule is per-document: an unfiltered list is refused.
function subscribeMyVoids() {
  if (!db || !state.user) return;
  if (state.myVoidsUnsubscribe) state.myVoidsUnsubscribe();
  const mine = query(collection(db, "voids"), where("uid", "==", state.user.uid));
  state.myVoidsUnsubscribe = onSnapshot(mine, (snapshot) => {
    state.myVoids = new Map(snapshot.docs.map((item) => [item.id, item.data()]));
    renderMyLog();
  }, (error) => showToast(`Your urine log is unavailable: ${describeError(error)}`, true));
}

// Deleting a measurement cannot be undone, so the confirmation names the entry
// rather than asking a vague question someone taps through at 3 a.m.
async function deleteVoid(id, entry) {
  const what = `${entry.crewCode} · Day ${entry.missionDay} · ${entry.missionTime || "no mission time"} · ${entry.volumeMl} mL`;
  if (!window.confirm(`Delete this entry permanently?

${what}

This cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, "voids", id));
    showToast("Entry deleted.");
  } catch (error) {
    showToast(`Could not delete: ${describeError(error)}`, true);
  }
}

function voidRowActions(container, source) {
  container.querySelectorAll("[data-delete-void]").forEach((button) => {
    const id = button.dataset.deleteVoid;
    button.addEventListener("click", () => deleteVoid(id, source.get(id)));
  });
}

function renderMyLog() {
  const entries = [...state.myVoids.entries()]
    .sort((a, b) => String(b[1].utcDateTime).localeCompare(String(a[1].utcDateTime)));

  $("mylog-summary").textContent = entries.length
    ? `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`
    : "";

  if (!entries.length) {
    $("mylog-body").innerHTML = '<p class="empty">Nothing logged yet. Use the Log Urine button.</p>';
    return;
  }

  $("mylog-body").innerHTML = entries.map(([id, entry]) => {
    const colour = COLOUR_SCALE.find((item) => item.score === Number(entry.colourScore));
    return `<div class="mylog-row">
      <span class="mylog-when">
        <strong>Day ${entry.missionDay}</strong>
        <span class="mono">${entry.missionTime || "T+--:--:--"}</span>
        <small class="mono">${String(entry.utcDateTime).replace("T", " ").slice(0, 19)} UTC</small>
      </span>
      <span class="mylog-volume mono">${entry.volumeMl} mL</span>
      <span class="mylog-colour" title="Colour ${entry.colourScore}${colour ? ` — ${colour.status}` : ""}"
            style="background:${colour ? colour.hex : "transparent"};color:${colour ? colour.ink : "inherit"}">${entry.colourScore}</span>
      ${entry.correctedAt ? '<span class="corrected" title="Corrected after filing">corrected</span>' : ""}
      <button class="btn btn-small" type="button" data-edit-void="${id}">Edit</button>
      <button class="btn btn-small btn-danger" type="button" data-delete-void="${id}">Delete</button>
    </div>`;
  }).join("");

  $("mylog-body").querySelectorAll("[data-edit-void]").forEach((button) => {
    button.addEventListener("click", () => openVoidModal(button.dataset.editVoid));
  });
  voidRowActions($("mylog-body"), state.myVoids);
}

// The admin sees every entry, because the junk that has to go is rarely their
// own -- a test value typed by somebody else cannot be corrected by anyone but
// its author, and it should not be in the dataset at all.
function subscribeAllVoids() {
  if (!db || !isAdmin()) return;
  if (state.allVoidsUnsubscribe) state.allVoidsUnsubscribe();
  state.allVoidsUnsubscribe = onSnapshot(collection(db, "voids"), (snapshot) => {
    state.allVoids = new Map(snapshot.docs.map((item) => [item.id, item.data()]));
    renderAllVoids();
  }, (error) => showToast(`Urine log unavailable: ${describeError(error)}`, true));
}

function renderAllVoids() {
  const entries = [...state.allVoids.entries()]
    .sort((a, b) => String(b[1].utcDateTime).localeCompare(String(a[1].utcDateTime)));

  $("allvoids-summary").textContent = entries.length
    ? `${entries.length} ${entries.length === 1 ? "entry" : "entries"}, newest first`
    : "nothing logged yet";

  if (!entries.length) {
    $("allvoids-body").innerHTML = "";
    return;
  }

  $("allvoids-body").innerHTML = entries.map(([id, entry]) => {
    const colour = COLOUR_SCALE.find((item) => item.score === Number(entry.colourScore));
    return `<div class="mylog-row">
      <span class="crew-chip">${escapeHtml(String(entry.crewCode))}</span>
      <span class="mylog-when">
        <strong>Day ${entry.missionDay}</strong>
        <span class="mono">${entry.missionTime || "T+--:--:--"}</span>
        <small class="mono">${String(entry.utcDateTime).replace("T", " ").slice(0, 19)} UTC</small>
      </span>
      <span class="mylog-volume mono">${entry.volumeMl} mL</span>
      <span class="mylog-colour" style="background:${colour ? colour.hex : "transparent"};color:${colour ? colour.ink : "inherit"}">${entry.colourScore}</span>
      ${entry.correctedAt ? '<span class="corrected">corrected</span>' : ""}
      <button class="btn btn-small btn-danger" type="button" data-delete-void="${id}">Delete</button>
    </div>`;
  }).join("");

  voidRowActions($("allvoids-body"), state.allVoids);
}

// A void cannot be measured twice. Every entry is written to the device before
// the network is touched, and stays there until the sheet has taken it — so a
// dead connection, a closed lid or a refresh mid-submit costs nothing.
// Two logs, one queue mechanism. A measurement reaches the device before it
// reaches the network and stays there until Firestore confirms it, so a dead
// connection, a closed lid or a refresh mid-submit costs nothing either way.
const OUTBOXES = {
  urine: {
    key: VOID_OUTBOX_KEY,
    badge: "void-pending",
    collection: "voids",
    noun: "urine",
    fields: ["uid", "crewCode", "missionDay", "missionTime", "utcDateTime", "volumeMl", "colourScore"],
  },
  food: {
    key: FOOD_OUTBOX_KEY,
    badge: "food-pending",
    collection: "meals",
    noun: "food",
    fields: ["uid", "crewCode", "missionDay", "missionTime", "utcDateTime",
             "barcode", "productName", "kcalPer100g", "grams", "totalKcal", "source"],
  },
};

function readOutbox(box) {
  try {
    const raw = window.localStorage.getItem(box.key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function writeOutbox(box, entries) {
  try {
    window.localStorage.setItem(box.key, JSON.stringify(entries));
  } catch (error) {
    showToast("This device cannot save the entry locally. Write it on paper.", true);
  }
  renderPending(box, entries.length);
}

function renderPending(box, count) {
  const badge = $(box.badge);
  badge.textContent = String(count);
  badge.classList.toggle("hidden", count === 0);
  badge.title = count === 1 ? "1 entry waiting to be sent" : `${count} entries waiting to be sent`;

  // The menu is closed most of the time, so the count has to be visible on the
  // button itself or a stuck entry goes unnoticed.
  const total = Object.values(OUTBOXES)
    .reduce((sum, other) => sum + readOutbox(other).length, 0);
  const totalBadge = $("pending-total");
  totalBadge.textContent = String(total);
  totalBadge.classList.toggle("hidden", total === 0);
}

function toggleFabMenu(open) {
  const menu = $("fab-menu");
  const next = open === undefined ? menu.classList.contains("hidden") : open;
  menu.classList.toggle("hidden", !next);
  $("fab-toggle").classList.toggle("open", next);
  $("fab-toggle").setAttribute("aria-expanded", String(next));
}

// The document id is the crew code and the moment the entry was made, so a
// retry after a lost response rewrites the same document instead of adding a
// second row. Neither a void nor a meal can be duplicated by a retry.
function entryDocId(payload) {
  return `${payload.crewCode}_${payload.utcDateTime.replace(/[:.]/g, "-")}`;
}

async function postEntry(box, entry) {
  const document = {};
  box.fields.forEach((field) => { document[field] = entry.payload[field] ?? null; });
  await setDoc(doc(db, box.collection, entryDocId(entry.payload)), document);
}

let flushing = false;

async function flushOutbox(box, { announce = false } = {}) {
  if (flushing) return;
  let entries = readOutbox(box);
  if (!entries.length) return;
  if (!db || !state.user) return;

  flushing = true;
  let sent = 0;
  try {
    while (entries.length) {
      try {
        await postEntry(box, entries[0]);
      } catch (error) {
        if (announce || sent) {
          showToast(`${entries.length} ${box.noun} ${entries.length === 1 ? "entry is" : "entries are"} waiting to be sent: ${describeError(error)}`, true);
        }
        break;
      }
      entries = entries.slice(1);
      writeOutbox(box, entries);
      sent += 1;
    }
  } finally {
    flushing = false;
  }

  if (sent && announce) showToast(sent === 1 ? `${box.noun === "urine" ? "Urine" : "Food"} entry logged.` : `${sent} entries logged.`);
  else if (sent) showToast(`${sent} queued ${box.noun} ${sent === 1 ? "entry" : "entries"} sent.`);
}

function flushAll(options) {
  flushOutbox(OUTBOXES.urine, options);
  flushOutbox(OUTBOXES.food, options);
}

// The columns the protocol asks for, in that order.
const VOID_CSV_COLUMNS = [
  ["crewCode", "Crew Code"],
  ["missionDay", "Mission Day"],
  ["missionTime", "Mission Time"],
  ["utcDateTime", "UTC Date & Time"],
  ["volumeMl", "Volume (mL)"],
  ["colourScore", "Colour (1-8)"],
  ["correctedAt", "Corrected (UTC)"],
];

// A BOM so Excel opens the file as UTF-8 rather than mangling it.
function downloadCsv(csv, filename) {
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function exportVoidsCsv() {
  const button = $("export-voids-btn");
  button.disabled = true;
  try {
    const snapshot = await getDocs(collection(db, "voids"));
    const rows = snapshot.docs
      .map((item) => item.data())
      .sort((a, b) => String(a.crewCode).localeCompare(String(b.crewCode))
        || String(a.utcDateTime).localeCompare(String(b.utcDateTime)));

    if (!rows.length) {
      showToast("No urine entries logged yet.", true);
      return;
    }

    const csv = [VOID_CSV_COLUMNS.map(([, header]) => header).join(",")]
      .concat(rows.map((row) => VOID_CSV_COLUMNS.map(([field]) => csvCell(row[field])).join(",")))
      .join("\r\n");

    downloadCsv(csv, `aatc_urine_log_${new Date().toISOString().slice(0, 10)}.csv`);

    showToast(`Exported ${rows.length} ${rows.length === 1 ? "entry" : "entries"}.`);
  } catch (error) {
    showToast(`Could not export: ${describeError(error)}`, true);
  } finally {
    button.disabled = false;
  }
}

function renderSwatches() {
  $("void-colours").innerHTML = COLOUR_SCALE.map((colour) =>
    `<button class="swatch" type="button" data-colour="${colour.score}" style="background:${colour.hex};color:${colour.ink}"
       aria-label="Colour ${colour.score} — ${colour.status}">${colour.score}</button>`,
  ).join("");

  document.querySelectorAll("[data-colour]").forEach((button) => {
    button.addEventListener("click", () => selectColour(Number(button.dataset.colour)));
  });
}

function selectColour(score) {
  state.voidColour = score;
  document.querySelectorAll("[data-colour]").forEach((button) => {
    button.classList.toggle("selected", Number(button.dataset.colour) === score);
  });
  const colour = COLOUR_SCALE.find((item) => item.score === score);
  const caption = $("void-colour-caption");
  caption.textContent = `${score} — ${colour.status}`;
}

function updateVoidAuto() {
  if ($("void-modal").classList.contains("hidden")) return;

  // While correcting, show the entry's own time. The clock has moved on since
  // it was filed, and that original moment is what stays on the record.
  const existing = state.editingVoidId ? state.myVoids.get(state.editingVoidId) : null;
  if (existing) {
    $("void-auto").textContent = [
      existing.crewCode,
      `Mission Day ${existing.missionDay}`,
      existing.missionTime || "T+--:--:--",
      `${String(existing.utcDateTime).replace("T", "  ").slice(0, 19)} UTC`,
    ].join("   ·   ");
    return;
  }

  const clock = resolveClock();
  $("void-auto").textContent = [
    state.profile?.crewCode ?? "—",
    `Mission Day ${state.day}`,
    formatMission(clock.seconds),
    utcString(),
  ].join("   ·   ");
}

function openVoidModal(editId = null) {
  if (!state.profile) return;
  const existing = editId ? state.myVoids.get(editId) : null;

  state.editingVoidId = existing ? editId : null;
  state.voidColour = null;
  $("void-form").reset();
  $("void-error").textContent = "";
  $("void-colour-caption").textContent = "Match the chart posted by the toilet.";
  document.querySelectorAll("[data-colour]").forEach((button) => button.classList.remove("selected"));

  $("void-title").textContent = existing ? "Correct entry" : "Log Urine";
  $("void-submit").textContent = existing ? "Save correction" : "Submit";

  if (existing) {
    $("void-volume").value = existing.volumeMl;
    selectColour(Number(existing.colourScore));
  }

  $("void-modal").classList.remove("hidden");
  updateVoidAuto();
  $("void-volume").focus();
  $("void-volume").select();
}

function closeVoidModal() {
  $("void-modal").classList.add("hidden");
  state.editingVoidId = null;
}

async function submitVoid(event) {
  event.preventDefault();
  const volumeMl = Number($("void-volume").value);
  if (!Number.isFinite(volumeMl) || volumeMl <= 0) {
    $("void-error").textContent = "Enter the volume in millilitres.";
    return;
  }
  if (state.voidColour === null) {
    $("void-error").textContent = "Select the colour that matches the chart.";
    return;
  }

  // A correction changes the reading, never who filed it or when. It goes
  // straight to Firestore rather than through the queue: an unsent measurement
  // must not be lost, but an unsent correction can simply be made again.
  if (state.editingVoidId) {
    try {
      await updateDoc(doc(db, "voids", state.editingVoidId), {
        volumeMl,
        colourScore: state.voidColour,
        correctedAt: new Date().toISOString(),
      });
      closeVoidModal();
      showToast("Entry corrected.");
    } catch (error) {
      $("void-error").textContent = describeError(error);
    }
    return;
  }

  const clock = resolveClock();
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    payload: {
      uid: state.user.uid,
      crewCode: state.profile.crewCode,
      missionDay: state.day,
      // Empty rather than a fake reading when no day has been anchored yet.
      // utcDateTime is always exact, so mission time stays reconstructable.
      missionTime: clock.seconds === null ? "" : formatMission(clock.seconds),
      utcDateTime: new Date().toISOString(),
      volumeMl,
      colourScore: state.voidColour,
    },
  };

  writeOutbox(OUTBOXES.urine, [...readOutbox(OUTBOXES.urine), entry]);
  closeVoidModal();
  await flushOutbox(OUTBOXES.urine, { announce: true });
}


/* ------------------------------------------------------------- log food -- */

function foodField(id) { return $(id).value.trim(); }

// Total energy is the measure; the amount and the per-100 g figure are only a
// way of arriving at it. Whenever both are known the total is filled in, and it
// stays editable because a repackaged habitat portion often has neither.
function recomputeFoodTotal() {
  const per100 = Number($("food-kcal100").value);
  const grams = Number($("food-grams").value);
  if (!Number.isFinite(per100) || !Number.isFinite(grams) || per100 <= 0 || grams <= 0) return;
  $("food-total").value = Math.round(per100 * grams / 100);
}

// Only the network call is guarded. Wrapping the form updates too would let a
// local mistake report itself as "could not reach the database", which sends
// the operator to check the wifi over a bug in this file.
async function fetchProduct(barcode) {
  const url = `${OFF_ENDPOINT}${encodeURIComponent(barcode)}.json`
    + "?fields=product_name,brands,nutriments,quantity";

  // Without this a stalled request looks like a frozen form for as long as the
  // browser feels like waiting.
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    // Open Food Facts answers an unknown barcode with 404, not with a body
    // saying so. Most Polish shelf products are not in it, so this is the
    // ordinary case, not a failure.
    if (response.status === 404) return { status: 0 };
    if (!response.ok) {
      const error = new Error(`the food database answered ${response.status}`);
      error.reachable = true;
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (error.reachable) throw error;
    if (error.name === "AbortError") {
      throw new Error("the food database did not answer within 12 seconds");
    }
    // A blocked host, no DNS, captive portal or no connection all land here as
    // the same opaque TypeError, so say what is actually known.
    throw new Error(`could not reach the food database (${error.name}: ${error.message})`);
  } finally {
    window.clearTimeout(timer);
  }
}

// Anything the crew has already identified once. Open Food Facts is thin on
// Polish shelf products and knows nothing about a habitat's repacked rations,
// so the first person to type a barcode in teaches it to everybody.
async function lookupCatalogue(barcode) {
  try {
    const snapshot = await getDoc(doc(db, "foodItems", barcode));
    return snapshot.exists() ? snapshot.data() : null;
  } catch (error) {
    return null;
  }
}

async function rememberFood(barcode, productName, kcalPer100g) {
  if (!productName || !kcalPer100g) return;
  try {
    await setDoc(doc(db, "foodItems", foodItemId(barcode, productName)), {
      barcode: barcode || null,
      productName,
      kcalPer100g,
      addedBy: state.profile.crewCode,
      addedAt: new Date().toISOString(),
    }, { merge: true });
  } catch (error) {
    // Saving to the shared list is a convenience for the next person. The
    // crew member's own entry is already filed; never fail their log over it.
  }
}

async function lookupBarcode(code) {
  const barcode = String(code || foodField("food-barcode")).replace(/\D/g, "");
  if (!barcode) {
    $("food-error").textContent = "Type or scan a barcode first.";
    return;
  }

  $("food-barcode").value = barcode;
  $("food-error").textContent = "";
  $("food-lookup-btn").disabled = true;
  $("food-scan-hint").textContent = "Looking up...";

  const known = await lookupCatalogue(barcode);
  if (known) {
    $("food-name").value = known.productName || "";
    if (known.kcalPer100g) $("food-kcal100").value = known.kcalPer100g;
    $("food-scan-hint").textContent = known.kcalPer100g
      ? `${known.productName} - ${known.kcalPer100g} kcal per 100 g, from the crew list (added by ${known.addedBy}). Enter how much was eaten.`
      : `${known.productName}, from the crew list. Type the energy.`;
    $("food-lookup-btn").disabled = false;
    $("food-grams").focus();
    recomputeFoodTotal();
    return;
  }

  let data;
  try {
    data = await fetchProduct(barcode);
  } catch (error) {
    $("food-scan-hint").textContent = `${error.message}. Type the name and energy yourself.`;
    $("food-name").focus();
    return;
  } finally {
    $("food-lookup-btn").disabled = false;
  }

  if (data.status !== 1 || !data.product) {
    // Not an error: an analog habitat repacks most of its food. Fill the rest
    // in by hand and the entry counts the same.
    $("food-scan-hint").textContent = `Barcode ${barcode} is not in the food database. Type the name and energy - it will be saved for the whole crew.`;
    $("food-name").focus();
    return;
  }

  const product = data.product;
  const name = [product.product_name, product.brands].filter(Boolean).join(" - ");
  const nutriments = product.nutriments || {};
  const per100 = Number(nutriments["energy-kcal_100g"]);

  $("food-name").value = name || `Barcode ${barcode}`;

  if (Number.isFinite(per100) && per100 > 0) {
    $("food-kcal100").value = per100;
    $("food-scan-hint").textContent = `${name} - ${per100} kcal per 100 g. Enter how much was eaten.`;
    $("food-grams").focus();
    recomputeFoodTotal();
    return;
  }

  // Some products carry only kilojoules. A conversion is better than nothing,
  // and it is marked so nobody mistakes it for a measured figure.
  const kj100 = Number(nutriments["energy-kj_100g"] ?? nutriments["energy_100g"]);
  if (Number.isFinite(kj100) && kj100 > 0) {
    const converted = Math.round(kj100 / 4.184);
    $("food-kcal100").value = converted;
    $("food-scan-hint").textContent = `${name} - ${converted} kcal per 100 g, converted from ${kj100} kJ. Enter how much was eaten.`;
    $("food-grams").focus();
    recomputeFoodTotal();
    return;
  }

  $("food-scan-hint").textContent = `${name} - the database has no energy figure. Type it yourself.`;
  $("food-total").focus();
}

// Camera scanning uses the browser's own BarcodeDetector where it exists
// (Chrome, and Android in particular). Safari has no such API, so the barcode
// field is always typeable and nothing here depends on the camera.
async function startScan() {
  if (!("BarcodeDetector" in window)) {
    $("food-scan-hint").textContent =
      "This browser cannot scan. Type the barcode digits and press Look up.";
    $("food-barcode").focus();
    return;
  }

  try {
    const detector = new window.BarcodeDetector({
      formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"],
    });
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
    state.scanStream = stream;

    const video = $("food-video");
    video.srcObject = stream;
    await video.play();
    $("food-scanner").classList.remove("hidden");
    $("food-scan-hint").textContent = "Point the camera at the barcode.";

    state.scanTimer = window.setInterval(async () => {
      try {
        const found = await detector.detect(video);
        if (!found.length) return;
        const code = found[0].rawValue;
        stopScan();
        await lookupBarcode(code);
      } catch (error) {
        // A frame that cannot be decoded is normal; keep looking.
      }
    }, 350);
  } catch (error) {
    stopScan();
    $("food-scan-hint").textContent =
      "No camera available. Type the barcode digits and press Look up.";
  }
}

function stopScan() {
  if (state.scanTimer) {
    window.clearInterval(state.scanTimer);
    state.scanTimer = null;
  }
  if (state.scanStream) {
    state.scanStream.getTracks().forEach((track) => track.stop());
    state.scanStream = null;
  }
  const video = $("food-video");
  if (video) video.srcObject = null;
  $("food-scanner").classList.add("hidden");
}

function updateFoodAuto() {
  if ($("food-modal").classList.contains("hidden")) return;
  const existing = state.editingMealId ? state.myMeals.get(state.editingMealId) : null;
  if (existing) {
    $("food-auto").textContent = [
      existing.crewCode,
      `Mission Day ${existing.missionDay}`,
      existing.missionTime || "T+--:--:--",
      `${String(existing.utcDateTime).replace("T", "  ").slice(0, 19)} UTC`,
    ].join("   ·   ");
    return;
  }
  const clock = resolveClock();
  $("food-auto").textContent = [
    state.profile?.crewCode ?? "-",
    `Mission Day ${state.day}`,
    formatMission(clock.seconds),
    utcString(),
  ].join("   ·   ");
}

function openFoodModal(editId = null) {
  if (!state.profile) return;
  const existing = editId ? state.myMeals.get(editId) : null;

  state.editingMealId = existing ? editId : null;
  $("food-form").reset();
  $("food-error").textContent = "";
  $("food-scan-hint").textContent = "";
  $("food-known-hint").textContent = "";
  $("food-title").textContent = existing ? "Correct entry" : "Log Food";
  $("food-submit").textContent = existing ? "Save correction" : "Submit";

  if (existing) {
    $("food-barcode").value = existing.barcode || "";
    $("food-name").value = existing.productName || "";
    $("food-kcal100").value = existing.kcalPer100g ?? "";
    $("food-grams").value = existing.grams ?? "";
    $("food-total").value = existing.totalKcal ?? "";
  }

  $("food-modal").classList.remove("hidden");
  updateFoodAuto();
  (existing ? $("food-grams") : $("food-barcode")).focus();
}

function closeFoodModal() {
  stopScan();
  $("food-modal").classList.add("hidden");
  state.editingMealId = null;
}

async function submitFood(event) {
  event.preventDefault();
  const productName = foodField("food-name");
  const totalKcal = Number($("food-total").value);

  if (!productName) {
    $("food-error").textContent = "Name the food.";
    return;
  }
  if (!Number.isFinite(totalKcal) || totalKcal <= 0) {
    $("food-error").textContent = "Enter the total energy in kcal.";
    return;
  }

  const numberOrNull = (id) => {
    const value = Number($(id).value);
    return $(id).value.trim() === "" || !Number.isFinite(value) ? null : value;
  };
  const barcode = foodField("food-barcode").replace(/\D/g, "");

  if (state.editingMealId) {
    try {
      await updateDoc(doc(db, "meals", state.editingMealId), {
        barcode: barcode || null,
        productName,
        kcalPer100g: numberOrNull("food-kcal100"),
        grams: numberOrNull("food-grams"),
        totalKcal,
        correctedAt: new Date().toISOString(),
      });
      closeFoodModal();
      showToast("Entry corrected.");
    } catch (error) {
      $("food-error").textContent = describeError(error);
    }
    return;
  }

  const clock = resolveClock();
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    payload: {
      uid: state.user.uid,
      crewCode: state.profile.crewCode,
      missionDay: state.day,
      missionTime: clock.seconds === null ? "" : formatMission(clock.seconds),
      utcDateTime: new Date().toISOString(),
      barcode: barcode || null,
      productName,
      kcalPer100g: numberOrNull("food-kcal100"),
      grams: numberOrNull("food-grams"),
      totalKcal,
      source: barcode ? "barcode" : "manual",
    },
  };

  writeOutbox(OUTBOXES.food, [...readOutbox(OUTBOXES.food), entry]);
  closeFoodModal();
  await flushOutbox(OUTBOXES.food, { announce: true });
  await rememberFood(entry.payload.barcode, productName, entry.payload.kcalPer100g);
}

async function deleteMeal(id, entry) {
  const what = `${entry.crewCode} · Day ${entry.missionDay} · ${entry.productName} · ${entry.totalKcal} kcal`;
  if (!window.confirm(`Delete this entry permanently?\n\n${what}\n\nThis cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, "meals", id));
    showToast("Entry deleted.");
  } catch (error) {
    showToast(`Could not delete: ${describeError(error)}`, true);
  }
}

function mealRow(id, entry, { showCrew = false, canEdit = false } = {}) {
  const amount = entry.grams ? `${entry.grams} g` : "";
  return `<div class="mylog-row">
    ${showCrew ? `<span class="crew-chip">${escapeHtml(String(entry.crewCode))}</span>` : ""}
    <span class="mylog-when">
      <strong>Day ${entry.missionDay}</strong>
      <span class="mono">${entry.missionTime || "T+--:--:--"}</span>
      <small class="mono">${String(entry.utcDateTime).replace("T", " ").slice(0, 19)} UTC</small>
    </span>
    <span class="meal-name">${escapeHtml(entry.productName)}${
      amount ? `<small class="mono"> · ${amount}</small>` : ""}${
      entry.barcode ? `<small class="mono barcode-tag">${escapeHtml(String(entry.barcode))}</small>` : ""}</span>
    <span class="mylog-volume mono">${entry.totalKcal} kcal</span>
    ${entry.correctedAt ? '<span class="corrected">corrected</span>' : ""}
    ${canEdit ? `<button class="btn btn-small" type="button" data-edit-meal="${id}">Edit</button>` : ""}
    <button class="btn btn-small btn-danger" type="button" data-delete-meal="${id}">Delete</button>
  </div>`;
}

function mealRowActions(container, source) {
  container.querySelectorAll("[data-edit-meal]").forEach((button) => {
    button.addEventListener("click", () => openFoodModal(button.dataset.editMeal));
  });
  container.querySelectorAll("[data-delete-meal]").forEach((button) => {
    const id = button.dataset.deleteMeal;
    button.addEventListener("click", () => deleteMeal(id, source.get(id)));
  });
}

function subscribeMyMeals() {
  if (!db || !state.user) return;
  if (state.myMealsUnsubscribe) state.myMealsUnsubscribe();
  const mine = query(collection(db, "meals"), where("uid", "==", state.user.uid));
  state.myMealsUnsubscribe = onSnapshot(mine, (snapshot) => {
    state.myMeals = new Map(snapshot.docs.map((item) => [item.id, item.data()]));
    renderFoodLog();
  }, (error) => showToast(`Your food log is unavailable: ${describeError(error)}`, true));
}

function subscribeAllMeals() {
  if (!db || !isAdmin()) return;
  if (state.allMealsUnsubscribe) state.allMealsUnsubscribe();
  state.allMealsUnsubscribe = onSnapshot(collection(db, "meals"), (snapshot) => {
    state.allMeals = new Map(snapshot.docs.map((item) => [item.id, item.data()]));
    renderAllMeals();
  }, (error) => showToast(`Food log unavailable: ${describeError(error)}`, true));
}

function renderFoodLog() {
  const entries = [...state.myMeals.entries()]
    .sort((a, b) => String(b[1].utcDateTime).localeCompare(String(a[1].utcDateTime)));

  const today = entries.filter(([, entry]) => Number(entry.missionDay) === state.day);
  const todayKcal = today.reduce((sum, [, entry]) => sum + Number(entry.totalKcal || 0), 0);

  $("foodlog-summary").textContent = entries.length
    ? `${todayKcal} kcal today · ${entries.length} ${entries.length === 1 ? "entry" : "entries"} in all`
    : "";

  $("foodlog-body").innerHTML = entries.length
    ? entries.map(([id, entry]) => mealRow(id, entry, { canEdit: true })).join("")
    : '<p class="empty">Nothing logged yet. Use the Log Food button.</p>';

  mealRowActions($("foodlog-body"), state.myMeals);
}

function renderAllMeals() {
  const entries = [...state.allMeals.entries()]
    .sort((a, b) => String(b[1].utcDateTime).localeCompare(String(a[1].utcDateTime)));

  $("allmeals-summary").textContent = entries.length
    ? `${entries.length} ${entries.length === 1 ? "entry" : "entries"}, newest first`
    : "nothing logged yet";

  $("allmeals-body").innerHTML = entries
    .map(([id, entry]) => mealRow(id, entry, { showCrew: true })).join("");

  mealRowActions($("allmeals-body"), state.allMeals);
}

const MEAL_CSV_COLUMNS = [
  ["crewCode", "Crew Code"],
  ["missionDay", "Mission Day"],
  ["missionTime", "Mission Time"],
  ["utcDateTime", "UTC Date & Time"],
  ["productName", "Food"],
  ["barcode", "Barcode"],
  ["kcalPer100g", "kcal per 100 g"],
  ["grams", "Amount (g)"],
  ["totalKcal", "Total (kcal)"],
  ["source", "Source"],
  ["correctedAt", "Corrected (UTC)"],
];

async function exportMealsCsv() {
  const button = $("export-meals-btn");
  button.disabled = true;
  try {
    const snapshot = await getDocs(collection(db, "meals"));
    const rows = snapshot.docs
      .map((item) => item.data())
      .sort((a, b) => String(a.crewCode).localeCompare(String(b.crewCode))
        || String(a.utcDateTime).localeCompare(String(b.utcDateTime)));

    if (!rows.length) {
      showToast("No food entries logged yet.", true);
      return;
    }

    const csv = [MEAL_CSV_COLUMNS.map(([, header]) => header).join(",")]
      .concat(rows.map((row) => MEAL_CSV_COLUMNS.map(([field]) => csvCell(row[field])).join(",")))
      .join("\r\n");

    downloadCsv(csv, `aatc_food_log_${new Date().toISOString().slice(0, 10)}.csv`);
    showToast(`Exported ${rows.length} ${rows.length === 1 ? "entry" : "entries"}.`);
  } catch (error) {
    showToast(`Could not export: ${describeError(error)}`, true);
  } finally {
    button.disabled = false;
  }
}


/* ------------------------------------------------- the crew's food list -- */

// Open Food Facts holds almost nothing for Polish shelf products -- nine real
// barcodes tried, none found -- and nothing at all for repacked rations. There
// is no better public database to point at, so the crew keeps its own: entered
// once, by one person, and filled in for everyone after that.
function foodItemId(barcode, productName) {
  if (barcode) return barcode;
  return `n_${productName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 80)}`;
}

function subscribeFoodItems() {
  if (!db || !state.user) return;
  if (state.foodItemsUnsubscribe) state.foodItemsUnsubscribe();
  state.foodItemsUnsubscribe = onSnapshot(collection(db, "foodItems"), (snapshot) => {
    state.foodItems = new Map(snapshot.docs.map((item) => [item.id, item.data()]));
    renderFoodDatalist();
    renderFoodItems();
  }, (error) => showToast(`Food list unavailable: ${describeError(error)}`, true));
}

function renderFoodDatalist() {
  const names = [...state.foodItems.values()]
    .map((item) => item.productName)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  $("food-known-list").innerHTML = names
    .map((name) => `<option value="${escapeAttr(name)}"></option>`).join("");
}

function findFoodItemByName(name) {
  const wanted = String(name).trim().toLowerCase();
  if (!wanted) return null;
  for (const item of state.foodItems.values()) {
    if (String(item.productName).trim().toLowerCase() === wanted) return item;
  }
  return null;
}

// Choosing from the list is the fast path: no barcode, no internet, no typing
// a number off a packet that may not even be the one in your hand.
function applyKnownFood() {
  const item = findFoodItemByName($("food-known").value);
  if (!item) {
    $("food-known-hint").textContent = "";
    return;
  }
  $("food-name").value = item.productName;
  if (item.kcalPer100g) $("food-kcal100").value = item.kcalPer100g;
  if (item.barcode) $("food-barcode").value = item.barcode;
  $("food-known-hint").textContent = item.kcalPer100g
    ? `${item.kcalPer100g} kcal per 100 g. Enter how much was eaten.`
    : "No energy figure on the list yet - type it.";
  recomputeFoodTotal();
  $("food-grams").focus();
}

function renderFoodItems() {
  if (!isAdmin()) return;
  const items = [...state.foodItems.entries()]
    .sort((a, b) => String(a[1].productName).localeCompare(String(b[1].productName)));

  $("fooditems-summary").textContent = items.length
    ? `${items.length} ${items.length === 1 ? "food" : "foods"} known`
    : "empty - nothing will fill itself in yet";

  $("fooditems-body").innerHTML = items.map(([id, item]) => `<div class="mylog-row">
      <span class="meal-name">${escapeHtml(String(item.productName))}${
        item.barcode ? `<small class="mono barcode-tag">${escapeHtml(String(item.barcode))}</small>` : ""}</span>
      <span class="mylog-volume mono">${item.kcalPer100g ?? "?"} kcal/100g</span>
      <small class="hint">${escapeHtml(String(item.addedBy ?? ""))}</small>
      <button class="btn btn-small btn-danger" type="button" data-delete-fooditem="${id}">Delete</button>
    </div>`).join("");

  $("fooditems-body").querySelectorAll("[data-delete-fooditem]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.deleteFooditem;
      const item = state.foodItems.get(id);
      if (!window.confirm(`Remove "${item.productName}" from the crew food list?\n\nEntries already logged are untouched.`)) return;
      try {
        await deleteDoc(doc(db, "foodItems", id));
        showToast("Removed from the food list.");
      } catch (error) {
        showToast(`Could not remove: ${describeError(error)}`, true);
      }
    });
  });
}

// Pasted as "barcode,name,kcal" a line, because the Data Officer will be
// copying off packets in bulk, not adding them one at a time.
async function addFoodItems() {
  const lines = $("fooditems-paste").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return;

  const parsed = [];
  const rejected = [];
  lines.forEach((line) => {
    const parts = line.split(",").map((part) => part.trim());
    const barcode = (parts[0] || "").replace(/\D/g, "");
    const productName = parts[1] || "";
    const kcal = Number(parts[2]);
    if (!productName || !Number.isFinite(kcal) || kcal <= 0) {
      rejected.push(line);
      return;
    }
    parsed.push({ barcode, productName, kcalPer100g: kcal });
  });

  if (!parsed.length) {
    showToast("Nothing usable. Each line needs: barcode,name,kcal", true);
    return;
  }

  $("fooditems-add-btn").disabled = true;
  let added = 0;
  try {
    for (const item of parsed) {
      await setDoc(doc(db, "foodItems", foodItemId(item.barcode, item.productName)), {
        barcode: item.barcode || null,
        productName: item.productName,
        kcalPer100g: item.kcalPer100g,
        addedBy: state.profile.crewCode,
        addedAt: new Date().toISOString(),
      }, { merge: true });
      added += 1;
    }
    $("fooditems-paste").value = rejected.join("\n");
    showToast(rejected.length
      ? `Added ${added}. ${rejected.length} line(s) left in the box - each needs barcode,name,kcal.`
      : `Added ${added} to the crew food list.`);
  } catch (error) {
    showToast(`Stopped after ${added}: ${describeError(error)}`, true);
  } finally {
    $("fooditems-add-btn").disabled = false;
  }
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
  $("tab-mylog").addEventListener("click", () => switchTab("mylog"));
  $("tab-foodlog").addEventListener("click", () => switchTab("foodlog"));

  $("task-assignee").innerHTML = `<option value="${ASSIGN_ALL}">Everyone</option>`
    + CREW_CODES.map((code) => `<option value="${code}">${code}</option>`).join("");
  $("task-form").addEventListener("submit", addTask);
  $("export-voids-btn").addEventListener("click", exportVoidsCsv);

  renderSwatches();
  renderPending(OUTBOXES.urine, readOutbox(OUTBOXES.urine).length);
  renderPending(OUTBOXES.food, readOutbox(OUTBOXES.food).length);
  $("fab-toggle").addEventListener("click", () => toggleFabMenu());
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".fab-stack")) toggleFabMenu(false);
  });
  $("log-void-btn").addEventListener("click", () => { toggleFabMenu(false); openVoidModal(); });
  $("log-food-btn").addEventListener("click", () => { toggleFabMenu(false); openFoodModal(); });

  $("food-form").addEventListener("submit", submitFood);
  $("food-close").addEventListener("click", closeFoodModal);
  $("food-scan-btn").addEventListener("click", startScan);
  $("food-scan-stop").addEventListener("click", stopScan);
  $("food-lookup-btn").addEventListener("click", () => lookupBarcode());
  $("food-barcode").addEventListener("keydown", (event) => {
    // Hardware scanners type the digits and press Enter.
    if (event.key === "Enter") { event.preventDefault(); lookupBarcode(); }
  });
  [$("food-kcal100"), $("food-grams")].forEach((input) =>
    input.addEventListener("input", recomputeFoodTotal));
  $("food-modal").addEventListener("mousedown", (event) => {
    if (event.target === $("food-modal")) closeFoodModal();
  });
  $("export-meals-btn").addEventListener("click", exportMealsCsv);
  $("fooditems-add-btn").addEventListener("click", addFoodItems);
  $("food-known").addEventListener("input", applyKnownFood);
  $("food-known").addEventListener("change", applyKnownFood);
  $("void-close").addEventListener("click", closeVoidModal);
  $("void-form").addEventListener("submit", submitVoid);
  $("void-modal").addEventListener("mousedown", (event) => {
    if (event.target === $("void-modal")) closeVoidModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeVoidModal();
    closeFoodModal();
    toggleFabMenu(false);
  });

  // Anything still queued goes out as soon as there is a network again.
  window.addEventListener("online", () => flushAll());
  window.setInterval(() => flushAll(), 60000);
  flushAll();

  updateAnchorPreview();
}

function switchTab(tab) {
  $("session-nav").classList.toggle("hidden", tab !== "sessions");
  $("sessions-view").classList.toggle("hidden", tab !== "sessions");
  $("dashboard-view").classList.toggle("hidden", tab !== "dashboard");
  $("mylog-view").classList.toggle("hidden", tab !== "mylog");
  $("foodlog-view").classList.toggle("hidden", tab !== "foodlog");
  $("tab-sessions").classList.toggle("active", tab === "sessions");
  $("tab-dashboard").classList.toggle("active", tab === "dashboard");
  $("tab-mylog").classList.toggle("active", tab === "mylog");
  $("tab-foodlog").classList.toggle("active", tab === "foodlog");
}

function enterApp() {
  $("login-view").classList.add("hidden");
  $("app-view").classList.remove("hidden");
  $("crew-chip").textContent = state.profile.crewCode;
  $("crew-chip").classList.toggle("commander", canCommand());
  $("commander-panel").classList.toggle("hidden", !canCommand());
  $("tasks-panel").classList.toggle("hidden", !canCommand());
  $("data-officer-panel").classList.toggle("hidden", !isAdmin());
  syncDaySelect();
  renderTaskList();
  subscribeMissionDays();
  subscribeDayData();
  subscribeMyVoids();
  subscribeAllVoids();
  subscribeMyMeals();
  subscribeAllMeals();
  subscribeFoodItems();
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
