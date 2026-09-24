// Runs backend/Code.gs against in-memory stand-ins for the Google services.
const vm = require("vm"), fs = require("fs"), nc = require("crypto");
const FR = require("../docs/app/lib/freeroom.js");
const signed = b => Array.from(b, x => (x > 127 ? x - 256 : x));
const bytes = v => Buffer.from(typeof v === "string" ? Buffer.from(v, "utf8") : Uint8Array.from(v, x => x & 255));
const outbox = [], cache = new Map(), props = new Map();
let sheetRows = [];
const sheet = {
  setName() { return sheet; }, appendRow(r) { sheetRows.push(r.slice()); },
  getLastRow() { return sheetRows.length; },
  getRange(r, c, nr = 1, nc2 = 1) {
    return {
      createTextFinder(t) { return { matchEntireCell() { return this; }, findNext() {
        for (let i = r - 1; i < r - 1 + nr; i++) if (String(sheetRows[i][c - 1]).toLowerCase() === t.toLowerCase()) return { getRow: () => i + 1 };
        return null; } }; },
      getValues() { return sheetRows.slice(r - 1, r - 1 + nr).map(row => row.slice(c - 1, c - 1 + nc2)); },
      setValue(v) { sheetRows[r - 1][c - 1] = v; },
      setValues(vs) { vs.forEach((row, i) => row.forEach((v, j) => { sheetRows[r - 1 + i][c - 1 + j] = v; })); }
    };
  }
};
const ctx = {
  Utilities: {
    DigestAlgorithm: { SHA_256: "sha256" }, Charset: { UTF_8: "utf8" },
    computeDigest: (a, v) => signed(nc.createHash("sha256").update(bytes(v)).digest()),
    computeHmacSha256Signature: (v, k) => signed(nc.createHmac("sha256", Buffer.from(k, "utf8")).update(Buffer.from(v, "utf8")).digest()),
    base64Encode: v => bytes(v).toString("base64"),
    base64EncodeWebSafe: v => bytes(v).toString("base64").replace(/\+/g, "-").replace(/\//g, "_"),
    base64DecodeWebSafe: s => signed(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64")),
    newBlob: v => ({ getBytes: () => signed(bytes(v)), getDataAsString: () => bytes(v).toString("utf8") }),
    getUuid: () => nc.randomUUID(), formatDate: d => d.toISOString().slice(0, 13)
  },
  CacheService: { getScriptCache: () => ({ get: k => cache.has(k) ? cache.get(k) : null, put: (k, v) => cache.set(k, v), remove: k => cache.delete(k) }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k) || null, setProperty: (k, v) => props.set(k, v) }) },
  SpreadsheetApp: { create: () => ({ getSheets: () => [sheet], getId: () => "SHEET1" }),
                    openById: () => ({ getSheetByName: () => sheet, getUrl: () => "https://sheet" }) },
  MailApp: { getRemainingDailyQuota: () => 100, sendEmail: o => outbox.push(o) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: { MimeType: { JSON: "json" }, createTextOutput: s => ({ s, setMimeType() { return this; } }) },
  Logger: { log: m => ctx._log.push(m) }, _log: [], Date, JSON, Math, String, Number, Error
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + "/../backend/Code.gs", "utf8"), ctx);
const call = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).s);
const code = () => /(\d{6})/.exec(outbox[outbox.length - 1].subject)[1];
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

ctx.setup();
const admin = props.get("ADMIN_SECRET");
ok(/ADMIN SECRET/.test(ctx._log[0]) && admin.length >= 20, "setup logs admin secret");
ok(Buffer.from(props.get("DATA_KEY"), "base64").length === 32, "data key is 32 bytes");

let r = call({ a: "signupStart", email: "someone@gmail.com", name: "X" });
ok(!r.ok && /lpu\.co\.in/.test(r.error), "non-LPU email refused: " + r.error);
r = call({ a: "signupStart", email: "Tarun.J@LPU.co.in", name: "Tarun" });
ok(r.ok && outbox.length === 1 && outbox[0].to === "tarun.j@lpu.co.in", "code sent");
const c1 = code();
r = call({ a: "signupVerify", email: "tarun.j@lpu.co.in", otp: c1, password: "short", name: "Tarun" });
ok(!r.ok && /8 characters/.test(r.error), "short password refused first");
r = call({ a: "signupVerify", email: "tarun.j@lpu.co.in", otp: c1 === "000000" ? "111111" : "000000", password: "longenough1", name: "Tarun" });
ok(!r.ok && /not right/.test(r.error), "wrong code refused");
r = call({ a: "signupVerify", email: "tarun.j@lpu.co.in", otp: c1, password: "longenough1", name: "Tarun" });
ok(r.ok && r.token && r.key === props.get("DATA_KEY") && r.name === "Tarun" && r.exp > Date.now(), "account created: " + JSON.stringify(r).slice(0, 80));
const tok = r.token;
ok(sheetRows.length === 2 && sheetRows[1][0] === "tarun.j@lpu.co.in" && sheetRows[1][4] !== "longenough1", "stored hashed");
r = call({ a: "signupVerify", email: "tarun.j@lpu.co.in", otp: c1, password: "longenough1" });
ok(!r.ok && /expired/.test(r.error), "code can't be reused");
r = call({ a: "signupStart", email: "tarun.j@lpu.co.in", name: "Again" });
ok(!r.ok && /already exists/.test(r.error), "duplicate refused");
r = call({ a: "login", email: "tarun.j@lpu.co.in", password: "wrongpass1" });
ok(!r.ok && /Wrong email or password/.test(r.error), "wrong password");
r = call({ a: "login", email: "nobody@lpu.co.in", password: "whatever12" });
ok(!r.ok && /Wrong email or password/.test(r.error), "unknown user same message");
r = call({ a: "login", email: "tarun.j@lpu.co.in", password: "longenough1" });
ok(r.ok && r.key, "login");
r = call({ a: "key", token: tok });
ok(r.ok && r.key === props.get("DATA_KEY"), "key with token");
r = call({ a: "key", token: tok.slice(0, -3) + "AAA" });
ok(!r.ok, "tampered token refused");
const forged = Buffer.from(JSON.stringify({ e: "tarun.j@lpu.co.in", n: "x", x: Date.now() + 1e9 })).toString("base64") + "." + tok.split(".")[1];
ok(!call({ a: "key", token: forged }).ok, "forged payload refused");
r = call({ a: "resetStart", email: "tarun.j@lpu.co.in" });
ok(r.ok && outbox.length === 2, "reset code sent");
r = call({ a: "resetVerify", email: "tarun.j@lpu.co.in", otp: code(), password: "brandnew22" });
ok(r.ok, "reset done");
ok(!call({ a: "login", email: "tarun.j@lpu.co.in", password: "longenough1" }).ok, "old password dead");
ok(call({ a: "login", email: "tarun.j@lpu.co.in", password: "brandnew22" }).ok, "new password works");
ok(!call({ a: "adminKey", secret: "nope" }).ok, "admin secret checked");
r = call({ a: "adminKey", secret: admin });
ok(r.ok && r.key === props.get("DATA_KEY"), "admin key");
// lockouts
for (let i = 0; i < 8; i++) call({ a: "login", email: "tarun.j@lpu.co.in", password: "bad-guess-" + i });
r = call({ a: "login", email: "tarun.j@lpu.co.in", password: "brandnew22" });
ok(!r.ok && /Too many wrong passwords/.test(r.error), "password lockout");
cache.clear();
call({ a: "signupStart", email: "b@lpu.co.in", name: "B" });
for (let i = 0; i < 5; i++) call({ a: "signupVerify", email: "b@lpu.co.in", otp: "999999", password: "longenough1" });
r = call({ a: "signupVerify", email: "b@lpu.co.in", otp: code(), password: "longenough1" });
ok(!r.ok && /Too many wrong codes/.test(r.error), "code attempt limit (" + r.error + ")");
call({ a: "signupStart", email: "b@lpu.co.in", name: "B" }); call({ a: "signupStart", email: "b@lpu.co.in", name: "B" });
r = call({ a: "signupStart", email: "b@lpu.co.in", name: "B" });
ok(!r.ok && /Too many codes/.test(r.error), "send limit");
ok(!call({ a: "bogus", email: "b@lpu.co.in" }).ok, "unknown action");
// revoking: delete the sheet row
sheetRows.splice(1, 1);
ok(!call({ a: "key", token: tok }).ok, "deleted account loses access");

(async () => {
  // the key the service hands out really opens the sealed file
  const sealed = await FR.seal({ hello: "teachers" }, props.get("DATA_KEY"));
  ok((await FR.unseal(sealed, r.key || props.get("DATA_KEY"))).hello === "teachers", "service key opens sealed data");
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
