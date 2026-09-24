// Runs docs/admin in jsdom against an in-memory GitHub + sign-in service:
// first publish, then a details-only update that reuses the sealed timetable.
const path = require("path"), fs = require("fs"), nc = require("crypto");
const { JSDOM, VirtualConsole } = require(process.env.JSDOM || "jsdom");
const FR = require("../docs/app/lib/freeroom.js");
const DIR = path.join(__dirname, "../docs/");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await sleep(40); return f(); };

const KEY = nc.randomBytes(32).toString("base64"), SECRET = "admin-secret-1";
// in-memory repository
let files = { "docs/data/manifest.json": Buffer.from('{"v":1,"free":null,"teacher":null,"auth":null}'), "docs/app/index.html": Buffer.from("x"),
              "docs/data/free.0123456789ab.json": Buffer.from("{}") };
const blobs = {}, trees = {}, commits = {}; let head = "c0"; commits.c0 = { tree: "t0" }; trees.t0 = files; const commitLog = [];
const sha = b => nc.createHash("sha1").update(b).digest("hex");
function gh(url, opts) {
  const u = new URL(url), p = u.pathname.replace("/repos/tj/lpu-free-room", ""), m = (opts && opts.method) || "GET";
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const raw = opts && opts.headers && /raw/.test(opts.headers.Accept);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
  if (!opts || !opts.headers || opts.headers.Authorization !== "Bearer good-token") return J({ message: "Bad credentials" }, 401);
  if (p === "" && m === "GET") return J({ permissions: { push: true } });
  if (p.startsWith("/contents/")) {
    const fp = decodeURIComponent(p.slice(10));
    if (files[fp] && raw) return new Response(files[fp]);
    const kids = Object.keys(files).filter(k => k.startsWith(fp + "/"));
    if (kids.length) return J(kids.map(k => ({ path: k })));
    return J({ message: "Not Found" }, 404);
  }
  if (p === "/git/ref/heads/main") return J({ object: { sha: head } });
  if (p.startsWith("/git/commits/") && m === "GET") return J({ tree: { sha: commits[p.slice(13)].tree } });
  if (p === "/git/blobs") { const b = Buffer.from(body.content, "base64"), s = sha(b); blobs[s] = b; return J({ sha: s }); }
  if (p === "/git/trees") {
    const t = Object.assign({}, trees[body.base_tree]);
    body.tree.forEach(e => { if (e.sha === null) delete t[e.path]; else t[e.path] = blobs[e.sha]; });
    const s = "t" + Object.keys(trees).length; trees[s] = t; return J({ sha: s });
  }
  if (p === "/git/commits" && m === "POST") { const s = "c" + Object.keys(commits).length; commits[s] = { tree: body.tree, parents: body.parents }; commitLog.push(body.message); return J({ sha: s }); }
  if (p === "/git/refs/heads/main" && m === "PATCH") { head = body.sha; files = trees[commits[head].tree]; return J({}); }
  return J({ message: "unhandled " + m + " " + p }, 500);
}
function fakeFetch(url, opts) {
  url = String(url);
  if (url.startsWith("https://api.github.com")) return Promise.resolve(gh(url, opts));
  if (url.startsWith("https://auth.test")) {
    const q = JSON.parse(opts.body);
    return Promise.resolve(new Response(JSON.stringify(q.a === "adminKey" && q.secret === SECRET ? { ok: true, key: KEY } : { ok: false, error: "Wrong admin secret." })));
  }
  return Promise.reject(new Error("offline " + url));
}

// timetable CSV
let seed = 11; const rnd = n => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return (((t ^ t >>> 14) >>> 0) / 4294967296 * n) | 0; };
const labels = Object.keys(require("./oracle.json"));
const lines = ["RoomNumber,AttendanceType,AttDay,AttendanceTime,TeacherLogin,Section,CourseCode,StudentGroup"];
for (let i = 0; i < 4000; i++) lines.push([`${[25, 33, 34][rnd(3)]}-${1 + rnd(6)}0${1 + rnd(8)}`, "LPT"[rnd(3)], ["MON","TUE","WED","THU","FRI","SAT"][rnd(6)], labels[rnd(labels.length)], 30000 + rnd(100), "K2" + rnd(5) + "Q" + rnd(20), "INT" + (200 + rnd(60)), rnd(2)].join(","));
lines.push("34-999,L,MON,nonsense,1,K1,C1,0");
const csv = lines.join("\r\n");

(async () => {
  const errors = [];
  const vc = new VirtualConsole(); vc.on("jsdomError", e => errors.push(e.message));
  const html = fs.readFileSync(DIR + "admin/index.html", "utf8")
    .replace('<script src="../app/lib/freeroom.js"></script>', () => "<script>" + fs.readFileSync(DIR + "app/lib/freeroom.js", "utf8") + "</script>")
    .replace('<script src="admin.js"></script>', () => "<script>" + fs.readFileSync(DIR + "admin/admin.js", "utf8") + "</script>");
  let carry = {};
  const boot = () => new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc, url: "https://tj.github.io/lpu-free-room/admin/",
    beforeParse(w) {
      Object.assign(w, { fetch: fakeFetch, Response, Blob, CompressionStream, DecompressionStream, TextEncoder, TextDecoder });
      Object.defineProperty(w, "crypto", { value: globalThis.crypto });
      for (const [k, v] of Object.entries(carry)) w.localStorage.setItem(k, v);
    } });
  let dom = boot(), w = dom.window, d = w.document, $ = id => d.getElementById(id);
  const upload = (id, name, text) => {
    const f = new w.File([text], name, { type: "text/csv" });
    Object.defineProperty($(id), "files", { value: [f], configurable: true });
    $(id).dispatchEvent(new w.Event("change"));
  };
  ok($("repo").value === "tj/lpu-free-room", "repo detected from the Pages address: " + $("repo").value);
  $("token").value = "bad-token"; $("btnConnect").click();
  await until(() => /GitHub/.test($("connectMsg").textContent));
  ok(/token is wrong/.test($("connectMsg").textContent), "bad token reported: " + $("connectMsg").textContent);
  $("token").value = "good-token"; $("authUrl").value = "https://auth.test/exec"; $("adminSecret").value = SECRET;
  $("btnConnect").click();
  await until(() => /connected\./.test($("connectMsg").textContent));
  ok(/GitHub connected. sign-in service connected/.test($("connectMsg").textContent), "connected: " + $("connectMsg").textContent);
  ok(/Nothing published yet/.test($("current").textContent), "empty repo recognised");

  upload("fileTT", "report.csv", csv);
  await until(() => /classes read/.test($("ttOut").textContent));
  ok(/4,000classesread/.test($("ttOut").textContent.replace(/\s/g, "")) && /1rowsunreadable/.test($("ttOut").textContent.replace(/\s/g, "")), "timetable stats: " + $("ttOut").textContent.slice(0, 80));
  ok(/nonsense/.test($("ttOut").textContent), "unreadable row listed");

  upload("fileRooms", "rooms.csv", "Room No,Type,Capacity,exclusive\n34-101,BYOD,72,TRUE\n34-102,Computer Lab,60,\n99-001,Seminar Hall,120,");
  await until(() => $("rMsg") && /rooms with/.test($("rMsg").textContent));
  ok(/3 rooms with Type, Capacity/.test($("rMsg").textContent) && /free all day/.test($("rMsg").textContent), "details read: " + $("rMsg").textContent);

  $("btnBuild").click();
  await until(() => /Check (passed|failed)/.test($("buildOut").textContent));
  ok(/Check passed/.test($("buildOut").textContent), "check: " + $("buildOut").textContent.slice(-160));
  ok(!$("btnPublish").disabled, "publish enabled");
  $("btnPublish").click();
  await until(() => /Published|GitHub/.test($("pubMsg").textContent));
  ok(/Published/.test($("pubMsg").textContent), "published: " + $("pubMsg").textContent);
  const man = JSON.parse(files["docs/data/manifest.json"]);
  ok(man.free && man.teacher && man.auth === "https://auth.test/exec" && files["docs/data/" + man.free] && files["docs/data/" + man.teacher], "manifest points at both files");
  ok(!files["docs/data/free.0123456789ab.json"] && files["docs/app/index.html"], "stale data file removed, app untouched");
  ok(commitLog.length === 1 && /4000 classes/.test(commitLog[0]), "one commit: " + commitLog[0]);
  const pub = JSON.parse(files["docs/data/" + man.free]);
  const direct = FR.buildPublic(FR.readTimetable(csv).bookings, FR.readDetails(FR.parseCSV("Room No,Type,Capacity,exclusive\n34-101,BYOD,72,TRUE\n34-102,Computer Lab,60,\n99-001,Seminar Hall,120,")), pub.built);
  ok(JSON.stringify(pub) === JSON.stringify(direct), "published file equals the reference build");
  ok(pub.fields.join() === "Type,Capacity", "exclusive column dropped by default");
  const t = await FR.unseal(new Uint8Array(files["docs/data/" + man.teacher]), KEY);
  ok(FR.bookingsFromTeacher(t).length === 4000, "sealed teacher file opens with the service key");
  const hash = (await FR.sha256hex(new Uint8Array(files["docs/data/" + man.free]))).slice(0, 12);
  ok(man.free === "free." + hash + ".json", "file named by its content hash");

  // later: the same browser on another day, only new room details, merged
  carry = { "fra.settings": w.localStorage.getItem("fra.settings") };
  dom = boot(); w = dom.window; d = w.document; $ = id => d.getElementById(id);
  ok($("token").value === "good-token", "settings remembered");
  $("btnConnect").click();
  await until(() => /connected\./.test($("connectMsg").textContent) && /Published/.test($("current").textContent));
  ok(/4,000classes/.test($("current").textContent.replace(/\s/g, "")), "current data shown: " + $("current").textContent.slice(0, 60));
  upload("fileRooms", "more.csv", "Room,Capacity,Projector\n25-101,65,Yes\n34-101,80,Yes");
  await until(() => $("rMsg") && /rooms with/.test($("rMsg").textContent));
  d.querySelector('input[name=rMode][value=merge]').click();
  d.querySelector('input[name=rMode][value=merge]').dispatchEvent(new w.Event("change", { bubbles: true }));
  $("btnBuild").click();
  await until(() => /Check (passed|failed)/.test($("buildOut").textContent) || /Upload a timetable/.test($("buildOut").textContent));
  ok(/Check passed/.test($("buildOut").textContent), "rebuild from the sealed timetable: " + $("buildOut").textContent.slice(0, 120));
  $("btnPublish").click();
  await until(() => /Published|GitHub/.test($("pubMsg").textContent));
  const man2 = JSON.parse(files["docs/data/manifest.json"]);
  const pub2 = FR.openPublic(JSON.parse(files["docs/data/" + man2.free]));
  ok(pub2.byName["34-101"].details.Capacity === 80 && pub2.byName["34-101"].details.Type === "BYOD" && pub2.byName["34-101"].details.Projector === "Yes", "merged details: " + JSON.stringify(pub2.byName["34-101"].details));
  ok(pub2.byName["99-001"].type === "Seminar Hall" && pub2.byName["25-101"].cap === 65, "old and new details kept");
  ok(pub2.counts.bookings === 4000 && man2.free !== man.free && !files["docs/data/" + man.free], "same timetable, new file, old one removed");
  ok(Object.keys(files).filter(k => k.startsWith("docs/data/")).length === 3, "data folder holds exactly 3 files");
  ok(errors.length === 0, "no script errors: " + errors.join(" | "));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("CRASH", e); process.exit(1); });
