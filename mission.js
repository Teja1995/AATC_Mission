// mission.js — the mission's own facts and the pure functions over them.
//
// Imported by both the crew app and the wall display. The battery, the session
// windows and the clock arithmetic live here once, so a display hanging on a
// wall cannot quietly disagree with the app in someone's hand about what is due
// or what day it is.

export const CREW_CODES = ["FE01", "FE02", "FE03", "FE04", "FE05", "FE06", "FE07"];
export const SESSION_ACCENTS = ["s1", "s2", "s3", "s4"];
export const MAX_DAY = 7;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const ASSIGN_ALL = "ALL";

// The commander-selected day lives in the missionDay collection alongside the
// per-day anchors, under the reserved id "active". Keeping it there means it is
// covered by the same security rule as the anchors themselves.
export const ACTIVE_DAY_DOC = "active";

export const SESSIONS = [
  {
    name: "Session 1",
    start: 0,
    end: 4,
    tests: [
      ["Sleep", "Sleep", "sleep"],
      ["Circadian (morning)", "Circadian", "circadian_morning"],
      ["Bioimpedance (morning)", "Bioimpedance", "bioimpedance_morning"],
      ["Saturation, Temp, Resp. Rate, BP", "Bioimpedance", "vitals_morning"],
      ["Chimp (morning)", "Chimp", "chimp_morning"],
      ["Urine analysis", "Urine", "urine", "Day 1 only"],
    ],
  },
  {
    name: "Session 2",
    start: 4,
    end: 8,
    tests: [
      ["Circadian (midday)", "Circadian", "circadian_midday"],
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
      ["Chimp (evening)", "Chimp", "chimp_evening"],
      ["Space Dragon Test A4", "—", "space_dragon", "Days 4 and 6 only"],
    ],
  },
];

export function utcString(date = new Date()) {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}  ${iso.slice(11, 19)} UTC`;
}

export function utcTimeOnly(date = new Date()) {
  return `${date.toISOString().slice(11, 19)} UTC`;
}

// One mission day is 24 hours long. When the clock passes T+24:00:00 it wraps
// back to T+00:00:00 and the mission day advances — nobody has to be awake at
// the rollover for the right day to be on screen.
export function resolveClock({ anchors, pointerDay, now = Date.now() }) {
  let baseDay = null;

  if (pointerDay !== null && pointerDay !== undefined && anchors.has(pointerDay)) {
    baseDay = pointerDay;
  } else {
    let latestPast = null;
    let latestAny = null;
    anchors.forEach((iso, dayNumber) => {
      const stamp = Date.parse(iso);
      if (Number.isNaN(stamp)) return;
      if (latestAny === null || stamp > Date.parse(anchors.get(latestAny))) latestAny = dayNumber;
      if (stamp <= now && (latestPast === null || stamp > Date.parse(anchors.get(latestPast)))) {
        latestPast = dayNumber;
      }
    });
    baseDay = latestPast ?? latestAny;
  }

  if (baseDay === null) {
    return { day: pointerDay ?? 1, seconds: null, baseDay: null };
  }

  const elapsed = Math.max(0, now - Date.parse(anchors.get(baseDay)));
  return {
    day: Math.min(MAX_DAY, baseDay + Math.floor(elapsed / DAY_MS)),
    seconds: (elapsed % DAY_MS) / 1000,
    baseDay,
  };
}

export function formatMission(seconds) {
  if (seconds === null) return "T+--:--:--";
  const total = Math.floor(seconds);
  const hours = String(Math.floor(total / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const secs = String(total % 60).padStart(2, "0");
  return `T+${hours}:${minutes}:${secs}`;
}

export function activeSession(seconds) {
  if (seconds === null) return null;
  return Math.min(3, Math.floor(seconds / 3600 / 4));
}

export function testApplies(test, day) {
  const key = test[2];
  if (key === "urine") return day === 1;
  if (["pr_presentation", "summary_report"].includes(key)) return day === 7;
  if (key === "space_dragon") return [4, 6].includes(day);
  return true;
}

export function visibleTests(session, day) {
  return session.tests.filter((test) => testApplies(test, day));
}

// The fixed protocol tests and the commander's added tasks render through one
// shape, so a task behaves like a test everywhere — session list, dashboard and
// completion id alike — instead of needing a parallel path through each.
export function sessionItems(sessionIndex, day, tasks = new Map()) {
  const fixed = visibleTests(SESSIONS[sessionIndex], day).map((test) => ({
    key: test[2],
    label: test[0],
    sheet: test[1],
    note: test[3] ?? null,
    assignedTo: null,
    taskId: null,
  }));

  const added = [...tasks.entries()]
    .filter(([, task]) => Number(task.sessionNumber) === sessionIndex + 1)
    .sort((a, b) => String(a[1].createdAt).localeCompare(String(b[1].createdAt)))
    .map(([id, task]) => ({
      key: id,
      label: task.title,
      sheet: null,
      note: null,
      assignedTo: task.assignedTo || ASSIGN_ALL,
      taskId: id,
    }));

  return [...fixed, ...added];
}

// Who owes this item. A task assigned to one crew member is that member's
// alone; everything else is the whole crew's.
export function rosterFor(item) {
  return item.assignedTo && item.assignedTo !== ASSIGN_ALL ? [item.assignedTo] : CREW_CODES;
}

// Crew codes with a completion for this item on this day.
export function doneCodes(item, completions, day) {
  const codes = [];
  completions.forEach((completion) => {
    if (Number(completion.dayNumber) !== day) return;
    if (completion.testKey !== item.key) return;
    if (!codes.includes(completion.crewCode)) codes.push(completion.crewCode);
  });
  return codes;
}

// Free text typed by a human is escaped, never interpolated raw.
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
