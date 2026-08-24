// Run with: node tests/mission.test.mjs
// Pure checks over the shared mission module: the clock rollover, the
// day-conditional battery, and how added tasks merge into a session.
import { SESSIONS, MAX_DAY, resolveClock, formatMission, activeSession,
         sessionItems, rosterFor, doneCodes, escapeHtml } from "../mission.js";

let fails = 0;
const ok = (label, cond) => { if (!cond) { fails++; console.log("FAIL:", label); } else console.log("ok  :", label); };

// --- clock: rollover ---
const anchors = new Map([[3, "2026-08-25T06:00:00Z"]]);
const t0 = Date.parse("2026-08-25T06:00:00Z");
const at = (ms) => resolveClock({ anchors, pointerDay: 3, now: t0 + ms });
ok("T+0 is day 3 session 1", at(0).day === 3 && activeSession(at(0).seconds) === 0);
ok("T+23:59:59 still day 3", at((23*3600+59*60+59)*1000).day === 3);
ok("T+24:00:00 wraps to day 4 at T+00:00:00",
   at(24*3600*1000).day === 4 && formatMission(at(24*3600*1000).seconds) === "T+00:00:00");
ok("T+30h is day 4 session 2", at(30*3600*1000).day === 4 && activeSession(at(30*3600*1000).seconds) === 1);
ok("day clamps at 7", at(20*24*3600*1000).day === MAX_DAY);
ok("no anchor gives no clock", resolveClock({ anchors: new Map(), pointerDay: null }).seconds === null);

// --- battery: day-conditional tests ---
const labels = (i, d, tasks) => sessionItems(i, d, tasks).map((x) => x.label);
ok("urine only on day 1", labels(0,1).includes("Urine analysis") && !labels(0,2).includes("Urine analysis"));
ok("space dragon on days 4 and 6", labels(3,4).some(l=>l.startsWith("Space Dragon")) && !labels(3,5).some(l=>l.startsWith("Space Dragon")));
ok("day 7 reports present", labels(2,7).includes("PR Presentation") && labels(2,7).includes("Summary Report"));
ok("STP removed", !SESSIONS.flatMap(s=>s.tests).some(t=>t[2].startsWith("stp")));
ok("Heart Time removed", !SESSIONS.flatMap(s=>s.tests).some(t=>t[2]==="heart_time"));

// --- tasks merge into their session, with the right roster ---
const tasks = new Map([
  ["task_a", { sessionNumber: 2, title: "Photograph rack", assignedTo: "FE03", createdAt: "2026-08-25T10:00:00Z" }],
  ["task_b", { sessionNumber: 2, title: "Filter check", assignedTo: "ALL", createdAt: "2026-08-25T10:05:00Z" }],
]);
const s2 = sessionItems(1, 3, tasks);
ok("tasks land in their session", s2.length === 4 && s2[2].taskId === "task_a");
ok("personal task roster is one", rosterFor(s2[2]).length === 1 && rosterFor(s2[2])[0] === "FE03");
ok("shared task roster is the crew", rosterFor(s2[3]).length === 7);

// --- completions counted per day ---
const comps = new Map([
  ["x", { dayNumber: 3, testKey: "task_a", crewCode: "FE03" }],
  ["y", { dayNumber: 4, testKey: "task_a", crewCode: "FE05" }],
]);
ok("only this day's completions count",
   doneCodes(s2[2], comps, 3).join() === "FE03" && doneCodes(s2[2], comps, 4).join() === "FE05");

ok("html escaped", escapeHtml('<img src=x onerror=1>') === "&lt;img src=x onerror=1&gt;");

console.log(fails ? `\n${fails} FAILURE(S)` : "\nall mission-module checks passed");
process.exit(fails ? 1 : 0);
