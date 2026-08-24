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
import { firebaseConfig } from "./firebase-config.js?v=18";
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
} from "./mission.js?v=18";

// Three roles. The commander runs the mission day; the admin runs the
// application and has the same authority over it. Everyone else is crew.
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
// Control.
function canCommand() {
  return COMMAND_ROLES.includes(state.profile?.role);
}

function isMine(item) {
  if (!item.assignedTo || item.assignedTo === ASSIGN_ALL) return true;
  return item.assignedTo === state.profile?.crewCode;
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

  $("task-assignee").innerHTML = `<option value="${ASSIGN_ALL}">Everyone</option>`
    + CREW_CODES.map((code) => `<option value="${code}">${code}</option>`).join("");
  $("task-form").addEventListener("submit", addTask);

  updateAnchorPreview();
}

function switchTab(tab) {
  $("session-nav").classList.toggle("hidden", tab !== "sessions");
  $("sessions-view").classList.toggle("hidden", tab !== "sessions");
  $("dashboard-view").classList.toggle("hidden", tab !== "dashboard");
  $("tab-sessions").classList.toggle("active", tab === "sessions");
  $("tab-dashboard").classList.toggle("active", tab === "dashboard");
}

function enterApp() {
  $("login-view").classList.add("hidden");
  $("app-view").classList.remove("hidden");
  $("crew-chip").textContent = state.profile.crewCode;
  $("crew-chip").classList.toggle("commander", canCommand());
  $("commander-panel").classList.toggle("hidden", !canCommand());
  $("tasks-panel").classList.toggle("hidden", !canCommand());
  syncDaySelect();
  renderTaskList();
  subscribeMissionDays();
  subscribeDayData();
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
