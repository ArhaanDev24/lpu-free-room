const FR = require("../docs/app/lib/freeroom.js");
const NLU = require("../docs/app/lib/nlu.js");
const assert = require("assert");
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

// 1. time labels: every distinct label in the live file, against Python's output
const oracle = require("./oracle.json");
let bad = 0;
for (const [lab, want] of Object.entries(oracle)) {
  const got = FR.parseTime(lab);
  if (JSON.stringify(got) !== JSON.stringify(want)) { bad++; console.log("label", lab, got, want); }
}
ok(bad === 0, "time labels");
console.log("labels checked:", Object.keys(oracle).length, "mismatches:", bad);
ok(FR.parseTime("garbage") === null && FR.parseTime("") === null && FR.parseTime(null) === null, "bad labels");
ok(JSON.stringify(FR.parseTime("16:10-17:00")) === "[970,1020]", "24h label");
ok(JSON.stringify(FR.parseTime("1:40-2:30")) === "[820,870]", "suffixless afternoon");

// 2. CSV
const t = FR.parseCSV('\uFEFFa,b,c\r\n1,"x, y",3\n\n"q""q",,\r\nlast,row,"multi\nline"');
ok(t.length === 5 && t[1][1] === "x, y" && t[3][0] === 'q"q' && t[4][2] === "multi\nline" && t[0][0] === "a", "csv " + JSON.stringify(t));

// 3. timetable read
const csv = [
  "RoomNumber,AttendanceType,AttDay,AttendanceTime,TeacherLogin,Section,CourseCode,StudentGroup",
  "34-504,L,Mon,02:00-02:50 PM,111,k24cg,cse101,0",
  "34-504,P,MON,01:40-02:30 PM,112,K24AB,CSE102,",
  "GROUND,L,TUE,09-10 AM,113,K24CG,PEL101,0",
  "34-505,L,XYZ,09-10 AM,113,K24CG,PEL101,0",
  "34-506,L,WED,bad,113,K24CG,PEL101,0",
  ",,,,,,,",
].join("\n");
const tt = FR.readTimetable(csv);
ok(tt.bookings.length === 3 && tt.unreadable.length === 2, "read counts");
ok(tt.bookings[0].section === "K24CG" && tt.bookings[0].course === "CSE101" && tt.bookings[1].group === "0" && tt.bookings[0].row === 2, "read fields");
ok(tt.unreadable[0].row === 5 && tt.unreadable[1].row === 6, "row numbers " + JSON.stringify(tt.unreadable));

// 4. realistic synthetic timetable, then round trip + self check
const labels = Object.keys(oracle);
const days = ["MON","TUE","WED","THU","FRI","SAT"];
let seed = 7; const rnd = n => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return (((t ^ t >>> 14) >>> 0) / 4294967296 * n) | 0; };
const rooms = [];
for (const b of [25, 26, 27, 33, 34, 36, "55A"]) for (let f = 1; f <= 7; f++) for (let r = 1; r <= 9; r++) rooms.push(`${b}-${f}0${r}`);
rooms.push("GROUND", "MYCLASS-ONLINE", "14-301L");
const lines = ["RoomNumber,AttendanceType,AttDay,AttendanceTime,TeacherLogin,Section,CourseCode,StudentGroup"];
for (let i = 0; i < 20000; i++) {
  lines.push([rooms[rnd(rooms.length)], "LPT"[rnd(3)], days[rnd(6)], labels[rnd(labels.length)], 10000 + rnd(900),
              "K" + (20 + rnd(6)) + "C" + rnd(90), "CSE" + (100 + rnd(400)), rnd(3)].join(","));
}
const big = FR.readTimetable(lines.join("\n"));
ok(big.bookings.length === 20000 && big.unreadable.length === 0, "big read");
const det = FR.readDetails([["Room No", "Type", "Capacity", "exclusive"], ["34-101", "BYOD", "72", "TRUE"],
                            ["34-102", "Computer Lab", "60", ""], ["99-101", "Regular", "45", ""]]);
ok(det.fields.join() === "Type,Capacity" && det.rows["34-101"].Capacity === 72, "details " + JSON.stringify(det));
const pub = FR.buildPublic(big.bookings, det, "2026-09-23T00:00:00Z");
const chk = FR.selfCheck(big.bookings, pub);
console.log("self check:", JSON.stringify(chk));
ok(chk.ok && chk.wider === 0, "self check");
const m = FR.openPublic(JSON.parse(JSON.stringify(pub)));
ok(m.byName["99-101"] && m.byName["99-101"].type === "Regular" && m.isFree(m.byName["99-101"].i, 0, 0, 1440), "detail-only room is always free");
ok(m.byName["GROUND"].shared && !m.byName["34-101"].shared, "shared flags");
ok(m.byName["34-102"].cap === 60 && m.byName["34-504"].details === null, "details decode");
ok(m.blocks.join() === "25,26,27,33,34,36,55A,99,14".split(",").sort((a,b)=>parseInt(a)-parseInt(b)||(a<b?-1:1)).join(), "blocks " + m.blocks.join());
ok(m.byName["55A-503"].block === "55A" && m.byName["55A-503"].floor === 5, "block/floor");

// direct brute-force comparison over random windows (not just ladder slots)
let mism = 0;
for (let k = 0; k < 400; k++) {
  const di = rnd(6), s = 480 + rnd(144) * 5, e = s + 10 + rnd(24) * 5;
  const busy = new Set(big.bookings.filter(b => b.day === FR.DAYS[di] && b.start < e && s < b.end).map(b => b.room));
  const want = m.rooms.filter(r => !r.shared && !busy.has(r.name)).map(r => r.name).join();
  const got = m.free(di, s, e).map(r => r.name).join();
  if (want !== got) mism++;
}
ok(mism === 0, "random windows " + mism);

// filters
const f1 = m.free(0, 600, 650, { block: "34", floor: 5 });
ok(f1.every(r => r.block === "34" && r.floor === 5), "filter block/floor");
ok(m.free(0, 600, 650, { minCap: 65 }).every(r => r.cap >= 65), "filter cap");
ok(m.free(0, 600, 650, { type: "lab" }).every(r => /lab/i.test(r.type)), "filter type");

// free windows
const r504 = m.byName["34-504"];
const w = m.freeWindows(r504.i, 0, 480, 1200);
ok(w.every(x => m.isFree(r504.i, 0, x[0], x[1])), "windows are free");

(async () => {
  // 5. teacher file: build, seal, unseal, and it matches the bookings
  const tobj = FR.buildTeacher(big.bookings, pub);
  const key = FR.toB64(crypto.getRandomValues(new Uint8Array(32)));
  const sealed = await FR.seal(tobj, key);
  const back = await FR.unseal(sealed, key);
  const tm = FR.openTeacher(back);
  const norm = b => [b.room, b.day, b.start, b.end, b.course, b.section, b.teacher, b.type, b.group].join("|");
  const A = big.bookings.map(norm).sort(), B = tm.list.map(norm).sort();
  ok(A.join("\n") === B.join("\n"), "teacher round trip");
  let wrongKey = false;
  try { await FR.unseal(sealed, FR.toB64(crypto.getRandomValues(new Uint8Array(32)))); } catch (e) { wrongKey = true; }
  ok(wrongKey, "wrong key rejected");
  const pubBytes = FR.utf8(JSON.stringify(pub));
  const pubGz = await FR.gzip(pubBytes);
  console.log("sizes: public", pubBytes.length, "B raw,", pubGz.length, "B gzip | teacher sealed", sealed.length, "B for", big.bookings.length, "bookings");
  const rebuilt = FR.buildPublic(FR.bookingsFromTeacher(back), FR.detailsFromPublic(pub), pub.built);
  ok(JSON.stringify(rebuilt) === JSON.stringify(pub), "republish from teacher file is identical");

  // 6. questions
  const now = new Date(2026, 8, 21, 14, 5);   // Monday 14:05
  const ctx = { model: m, now, teacher: false };
  const P = s => NLU.parse(s, ctx);
  let q = P("free rooms in block 34 fifth floor at 2 pm");
  ok(q.intent === "free_list" && q.block === "34" && q.floor === 5 && q.start === 840 && q.end === 890 && q.day === 0, "q1 " + JSON.stringify(q));
  q = P("which block has the most free rooms now");
  ok(q.intent === "which_block" && q.start === 845 && q.now, "q2 " + JSON.stringify(q));
  q = P("which floor in block 33 tomorrow at 10");
  ok(q.intent === "which_floor" && q.block === "33" && q.day === 1 && q.start === 600, "q3 " + JSON.stringify(q));
  q = P("is 34-504 free");
  ok(q.intent === "room_status" && q.rooms[0] === "34-504", "q4 " + JSON.stringify(q));
  q = P("when is 34 504 free on friday");
  ok(q.intent === "room_windows" && q.rooms[0] === "34-504" && q.day === 4, "q5 " + JSON.stringify(q));
  q = P("is 34504 empty from 10 to 11:30");
  ok(q.rooms[0] === "34-504" && q.start === 600 && q.end === 690, "q6 " + JSON.stringify(q));
  q = P("a lab for 60 students after lunch");
  ok(q.type === "LAB" && q.minCap === 60 && q.start === 810, "q7 " + JSON.stringify(q));
  q = P("any room free between 2 and 4 pm on the ground floor of block 26");
  ok(q.start === 840 && q.end === 960 && q.floor === 0 && q.block === "26", "q8 " + JSON.stringify(q));
  q = P("free room at 10 30 in block 25");
  ok(q.block === "25" && !q.rooms.length, "q9 time digits not a room " + JSON.stringify(q));
  q = P("how many rooms are free at 9:20 a.m. for 2 hours");
  ok(q.intent === "count" && q.start === 560 && q.end === 680, "q10 " + JSON.stringify(q));
  q = P("free rooms in block 99 now");
  ok(q.block === "99", "q11 detail-only block");
  q = P("rooms in block 77");
  const a77 = NLU.answer(q, ctx);
  ok(/no block 77/i.test(a77.text), "q12 " + a77.text);
  q = P("second floor block 34 at two p.m.");
  ok(q.floor === 2 && q.start === 840, "q13 " + JSON.stringify(q));
  q = P("is 34-504 free from 2 to 4 pm");
  ok(q.start === 840 && q.end === 960, "q14 " + JSON.stringify(q));

  // answers are consistent with the model
  for (const s of ["free rooms in block 34 at 11", "which block has most free rooms at 3 pm", "which floor block 25 at 9:20",
                   "is 34-504 free at 2 pm", "when is 25-101 free", "how many free rooms at 10", "a byod room for 70 students at 12:40",
                   "free lab in block 34 on the 7th floor at 4 pm"]) {
    const a = NLU.ask(s, ctx);
    console.log("  Q:", s, "\n  A:", a.text.slice(0, 180));
    ok(a.text && a.speak && Array.isArray(a.rooms), "answer " + s);
    ok(a.rooms.every(r => m.isFree(r.i, a.q.day, a.q.start, a.q.end)) || a.q.intent.startsWith("room"), "answer rooms free " + s);
  }
  // teacher questions
  const tctx = { model: m, tmodel: tm, now, teacher: true };
  const sec = tm.sections[3];
  let ta = NLU.ask("show timetable of " + sec.toLowerCase(), tctx);
  ok(ta.open && ta.open.field === "section" && ta.open.key === sec, "teacher section " + ta.text);
  ta = NLU.ask("timetable of room 34-504", tctx);
  ok(ta.open && ta.open.field === "room" && ta.open.key === "34-504", "teacher room " + ta.text);
  ta = NLU.ask("is 34-504 free at 2 pm", tctx);
  console.log("  T:", ta.text);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
