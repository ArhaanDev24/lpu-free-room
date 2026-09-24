// Loads docs/app/index.html in jsdom with a fake published timetable and a
// fake sign-in service, then clicks through the student and teacher flows.
const path = require("path"), fs = require("fs");
const { JSDOM, VirtualConsole } = require(process.env.JSDOM || "jsdom");
const FR = require("../docs/app/lib/freeroom.js");
const APP = path.join(__dirname, "../docs/app/");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// fake timetable built with the real pipeline
let seed = 3; const rnd = n => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return (((t ^ t >>> 14) >>> 0) / 4294967296 * n) | 0; };
const labels = Object.keys(require("./oracle.json"));
const rooms = []; for (const b of [25, 34]) for (let f = 1; f <= 5; f++) for (let r = 1; r <= 6; r++) rooms.push(`${b}-${f}0${r}`);
rooms.push("GROUND");
const lines = ["RoomNumber,AttendanceType,AttDay,AttendanceTime,TeacherLogin,Section,CourseCode,StudentGroup"];
for (let i = 0; i < 3000; i++) lines.push([rooms[rnd(rooms.length)], "LPT"[rnd(3)], ["MON","TUE","WED","THU","FRI","SAT","SUN"][rnd(7)], labels[rnd(labels.length)], 20000 + rnd(80), "K2" + rnd(5) + "CG" + rnd(9), "CSE" + (100 + rnd(50)), rnd(2)].join(","));
const bookings = FR.readTimetable(lines.join("\n")).bookings;
const details = FR.readDetails([["Room", "Type", "Capacity"], ["34-101", "BYOD", "72"], ["34-102", "Computer Lab", "60"]]);
const pub = FR.buildPublic(bookings, details);
const KEY = Buffer.from(require("crypto").randomBytes(32)).toString("base64");
const log = [];

(async () => {
  const sealed = await FR.seal(FR.buildTeacher(bookings, pub), KEY);
  const man = { v: 1, built: pub.built, free: "free.abc.json", teacher: "teacher.abc.bin", auth: "https://auth.test/exec", counts: pub.counts };
  const calls = [];
  function fakeFetch(url, opts) {
    url = String(url); calls.push(url);
    if (url.startsWith("https://auth.test")) {
      const q = JSON.parse(opts.body);
      log.push(q.a);
      let body = { ok: false, error: "Wrong email or password." };
      if (q.a === "login" && q.password === "rightpass1") body = { ok: true, token: "t.s", exp: Date.now() + 1e9, email: q.email, name: "TJ", key: KEY };
      if (q.a === "signupStart" || q.a === "resetStart") body = { ok: true };
      if (q.a === "signupVerify" && q.otp === "123456") body = { ok: true, token: "t.s", exp: Date.now() + 1e9, email: q.email, name: q.name, key: KEY };
      return Promise.resolve(new Response(JSON.stringify(body)));
    }
    const name = url.replace(/^\.\.\/data\//, "").replace(/\?.*$/, "");
    if (name === "manifest.json") return Promise.resolve(new Response(JSON.stringify(man)));
    if (name === man.free) return Promise.resolve(new Response(JSON.stringify(pub)));
    if (name === man.teacher) return Promise.resolve(new Response(sealed));
    return Promise.resolve(new Response("nope", { status: 404 }));
  }

  const vc = new VirtualConsole();
  const errors = [];
  vc.on("jsdomError", e => errors.push(e.message + (e.detail ? " " + e.detail : "")));
  vc.on("error", e => errors.push(String(e)));
  // jsdom resolves <script src> against url; load from disk instead
  const html = fs.readFileSync(APP + "index.html", "utf8");
  async function boot(storage) {
    const dom = new JSDOM(html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => `<script>${fs.readFileSync(APP + src, "utf8").replace(/<\/script/g, "<\\/script")}</script>`), {
      runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc, url: "https://tj.github.io/lpu-free-room/app/",
      beforeParse(w) {
        Object.assign(w, { fetch: fakeFetch, Response, Blob, CompressionStream, DecompressionStream, TextEncoder, TextDecoder });
        Object.defineProperty(w, "crypto", { value: globalThis.crypto });
        w.confirm = () => true;
        w.HTMLElement.prototype.scrollIntoView = function () {};
        w.scrollTo = () => {};
        if (storage) for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
      }
    });
    await sleep(300);
    return dom;
  }

  // ---------------------------------------------------------------- student
  let dom = await boot(), w = dom.window, d = w.document;
  const $ = id => d.getElementById(id);
  ok(!$("login").hidden && $("main").hidden, "starts at login");
  $("sEmail").value = "not-an-email";
  $("fStudent").dispatchEvent(new w.Event("submit", { cancelable: true }));
  ok(/valid email/.test($("loginErr").textContent), "bad student email refused");
  $("sEmail").value = "student@gmail.com"; $("sName").value = "Asha";
  $("fStudent").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await sleep(200);
  ok($("login").hidden && !$("main").hidden, "student in");
  ok($("whoRole").textContent === "Student" && $("whoName").textContent === "Asha", "header shows student");
  ok(d.querySelector('[data-tab="pTT"]').hidden, "no timetable tab for students");
  const m = FR.openPublic(pub), n = FR.nowInfo();
  // pick a fixed slot so the check doesn't depend on the clock
  const monBtn = d.querySelector('#dayStrip [data-day="0"]'); monBtn.click();
  const slotBtn = d.querySelector('#slotStrip [data-slot]:not([data-slot="now"]):not([data-slot="custom"])');
  ok(!!slotBtn, "slot chips rendered: " + $("slotStrip").children.length);
  slotBtn.click();
  const [s, e] = slotBtn.getAttribute("data-slot").split("-").map(Number);
  const want = m.free(0, s, e);
  const shown = [...d.querySelectorAll("#freeList .plate")].map(p => p.getAttribute("data-room"));
  ok(shown.join() === want.map(r => r.name).join(), `free list matches model (${shown.length} vs ${want.length})`);
  ok(new RegExp("^" + want.length + " free").test($("freeSummary").textContent), "summary count: " + $("freeSummary").textContent);
  ok(d.querySelector("#freeList .plate").tagName === "DIV", "student plates are not tappable");
  ok(!shown.includes("GROUND"), "shared venue excluded from free list");
  const withDet = d.querySelector('#freeList [data-room="34-101"] .rd, #freeList [data-room="34-102"] .rd');
  if (m.isFree(m.byName["34-101"].i, 0, s, e) || m.isFree(m.byName["34-102"].i, 0, s, e)) ok(withDet && /seats/.test(withDet.textContent), "details shown on plate");
  ok(!d.querySelector('#freeList [data-room="25-101"] .rd'), "room without details shows only its number");
  $("fBlock").value = "34"; $("fBlock").dispatchEvent(new w.Event("change"));
  const b34 = [...d.querySelectorAll("#freeList .plate")].map(p => p.getAttribute("data-room"));
  ok(b34.length && b34.every(x => x.startsWith("34-")), "block filter");
  ok([...$("fFloor").options].map(o => o.value).join() === ",1,2,3,4,5", "floors of block 34: " + [...$("fFloor").options].map(o => o.value));
  $("fFloor").value = "3"; $("fFloor").dispatchEvent(new w.Event("change"));
  ok([...d.querySelectorAll("#freeList .plate")].every(p => p.getAttribute("data-room").startsWith("34-3")), "floor filter");
  d.querySelector('[data-slot="custom"]').click();
  ok(!$("customBox").hidden, "custom times shown");
  $("tFrom").value = "10:00"; $("tTo").value = "12:00"; $("tFrom").dispatchEvent(new w.Event("change"));
  ok($("freeSummary").textContent.includes("10:00 AM") || $("freeSummary").textContent.includes("10:00\u201312:00"), "custom window: " + $("freeSummary").textContent);
  // all rooms
  d.querySelector('[data-tab="pRooms"]').click();
  ok(d.querySelectorAll("#roomList .plate").length === m.rooms.length, "all rooms listed: " + d.querySelectorAll("#roomList .plate").length);
  $("roomQ").value = "34-10"; $("roomQ").dispatchEvent(new w.Event("input"));
  ok([...d.querySelectorAll("#roomList .plate")].every(p => p.getAttribute("data-room").includes("34-10")), "room search");
  // ask
  d.querySelector('[data-tab="pAsk"]').click();
  ok(d.querySelectorAll("#examples .chip").length === 5, "example questions");
  $("askText").value = "free rooms in block 34 on floor 2 on monday at 10";
  $("askForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await sleep(50);
  const bot = d.querySelectorAll("#chat .msg.bot");
  ok(bot.length === 1 && /block 34, floor 2/.test(bot[0].textContent), "ask answered: " + (bot[0] && bot[0].textContent.slice(0, 90)));
  const exp = m.free(0, 600, 650, { block: "34", floor: 2 }).map(r => r.name).join();
  ok([...bot[0].querySelectorAll(".plate")].map(p => p.getAttribute("data-room")).join() === exp, "ask rooms match model");
  bot[0].querySelector("[data-apply]").click();
  ok(!$("pFree").hidden && $("fBlock").value === "34" && $("fFloor").value === "2", "answer applied to free screen");
  ok([...d.querySelectorAll("#freeList .plate")].map(p => p.getAttribute("data-room")).join() === exp, "applied list matches");
  $("mic").click(); await sleep(30);
  ok(/Voice input isn't available/.test($("toast").textContent), "no-voice fallback message");
  ok(!calls.some(u => u.includes("teacher.")), "students never download class details");
  const studentStore = { "fr.man": w.localStorage.getItem("fr.man"), "fr.pub": w.localStorage.getItem("fr.pub") };
  $("btnOut").click();
  ok(!$("login").hidden, "signed out");

  // second start: nothing re-downloaded when the manifest is unchanged
  calls.length = 0;
  dom = await boot(Object.assign({ "fr.user": JSON.stringify({ role: "student", email: "s@x.in" }) }, studentStore));
  w = dom.window; d = w.document;
  ok(calls.filter(u => u.includes("free.abc")).length === 0 && calls.some(u => u.includes("manifest.json")), "only the manifest is fetched on restart: " + calls.join(" "));
  ok(d.querySelectorAll("#freeList .plate").length > 0, "cached data shown");

  // ---------------------------------------------------------------- teacher
  calls.length = 0;
  dom = await boot(); w = dom.window; d = w.document;
  const $$ = id => d.getElementById(id);
  d.querySelector('[data-role="teacher"]').click();
  ok(!$$("fTeacher").hidden && $$("fStudent").hidden, "teacher form");
  $$("tEmail").value = "tj@gmail.com"; $$("tPass").value = "rightpass1";
  $$("fTeacher").dispatchEvent(new w.Event("submit", { cancelable: true }));
  ok(/lpu\.co\.in/.test($$("loginErr").textContent), "non-LPU teacher email refused in app");
  $$("tEmail").value = "tj@lpu.co.in"; $$("tPass").value = "wrongpass1";
  $$("fTeacher").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await sleep(150);
  ok(/Wrong email or password/.test($$("loginErr").textContent), "wrong password message: " + $$("loginErr").textContent);
  // sign-up flow shows the code step
  d.querySelector('[data-tm="up"]').click();
  ok(!$$("tName").closest("label").hidden && $$("tOtp").closest("label").hidden, "sign-up fields");
  $$("tName").value = "Tarun"; $$("tPass").value = "rightpass1";
  $$("fTeacher").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await sleep(150);
  ok(!$$("tOtp").closest("label").hidden && $$("tEmail").readOnly && /sent a 6-digit code/.test($$("tHint").textContent), "code step shown");
  $$("tOtp").value = "123456";
  $$("fTeacher").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await sleep(500);
  ok($$("login").hidden && $$("whoRole").textContent === "Teacher", "teacher signed up and in");
  ok(!d.querySelector('[data-tab="pTT"]').hidden, "timetable tab for teachers");
  ok(log.join() === "login,signupStart,signupVerify", "auth calls: " + log.join());
  ok(calls.some(u => u.includes("teacher.abc")), "teacher file downloaded");
  d.querySelector('#dayStrip [data-day="0"]').click();
  const plateBtn = d.querySelector("#freeList button.plate");
  ok(!!plateBtn, "teacher plates are buttons");
  plateBtn.click(); await sleep(30);
  const room = plateBtn.getAttribute("data-room");
  ok(!$$("sheet").hidden && $$("shTitle").textContent === room, "room timeline opens: " + $$("shTitle").textContent);
  const monCount = bookings.filter(b => b.room === room && b.day === "MON").length;
  ok(d.querySelectorAll("#shBody .ev").length === monCount, `timeline shows the room's Monday classes (${d.querySelectorAll("#shBody .ev").length}/${monCount})`);
  ok(d.querySelector("#shBody .band") && d.querySelectorAll("#shBody .gap").length > 0, "selected slot band and free gaps drawn");
  const ev = d.querySelector("#shBody .ev");
  if (ev) {
    ev.click();
    ok(!$$("shInfo").hidden && /Section/.test($$("shInfo").textContent), "class details panel");
    const jump = $$("shInfo").querySelector('[data-jump="section"]');
    const secKey = jump.getAttribute("data-key");
    jump.click();
    ok($$("shTitle").textContent === "Section " + secKey, "jump to section week");
    const secMon = bookings.filter(b => b.section === secKey && b.day === "MON").length;
    ok(d.querySelectorAll("#shBody .ev").length === secMon, "section day view count");
  }
  // overlap marking: find a room/day with overlapping different classes
  const byRD = {};
  bookings.forEach(b => (byRD[b.room + "|" + b.day] = byRD[b.room + "|" + b.day] || []).push(b));
  const clashKey = Object.keys(byRD).find(k => byRD[k].some(a => byRD[k].some(b => a !== b && a.start < b.end && b.start < a.end && (a.course !== b.course || a.section !== b.section))));
  if (clashKey) {
    const [cr, cd] = clashKey.split("|");
    $$("shClose").click();
    d.querySelector('[data-tab="pRooms"]').click();
    $$("roomQ").value = cr; $$("roomQ").dispatchEvent(new w.Event("input"));
    d.querySelector(`#roomList button.plate[data-room="${cr}"]`).click();
    d.querySelector(`#shDays [data-sday="${FR.DAYS.indexOf(cd)}"]`).click();
    ok(d.querySelectorAll("#shBody .ev.clash").length >= 2, "overlaps outlined in " + clashKey);
  }
  $$("shClose").click();
  ok($$("sheet").hidden, "sheet closes");
  d.querySelector('[data-tab="pTT"]').click();
  const sec = bookings[0].section;
  $$("ttQ").value = sec.slice(0, 4); $$("ttQ").dispatchEvent(new w.Event("input"));
  const sug = d.querySelector(`#ttSuggest [data-key="${sec}"]`);
  ok(!!sug, "search suggests the section");
  sug.click();
  ok($$("shTitle").textContent === "Section " + sec, "search opens the week");
  $$("shClose").click();
  d.querySelector('[data-tab="pAsk"]').click();
  $$("askText").value = "timetable of " + sec.toLowerCase();
  $$("askForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await sleep(30);
  ok(!$$("sheet").hidden && $$("shTitle").textContent === "Section " + sec, "voice-style command opens a timetable");
  $$("shClose").click();
  $$("askText").value = "is " + room + " free on monday at 2 pm";
  $$("askForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await sleep(30);
  const last = [...d.querySelectorAll("#chat .msg.bot")].pop().textContent;
  ok(new RegExp(room + " is (free|booked)").test(last) && !/next free/.test(last), "room status: " + last.slice(0, 160));

  // teacher restarts offline with cached data: class details still open
  const store = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); store[k] = w.localStorage.getItem(k); }
  dom = await boot(store);
  w = dom.window; d = w.document;
  ok(d.getElementById("whoRole").textContent === "Teacher", "teacher stays signed in");
  d.querySelector('#dayStrip [data-day="0"]').click();
  d.querySelector("#freeList button.plate").click(); await sleep(20);
  ok(!d.getElementById("sheet").hidden, "cached class details open after restart");

  ok(errors.length === 0, "no script errors: " + errors.slice(0, 3).join(" | "));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("CRASH", e); process.exit(1); });
