// Extension integration: source fallback, quick controls, and teacher-session migration.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require(process.env.JSDOM || "jsdom");

const root = path.join(__dirname, "..");
const app = path.join(root, "docs/app");
const manifest = require("../docs/data/manifest.json");
const publicData = JSON.parse(fs.readFileSync(path.join(root, "docs/data", manifest.free), "utf8"));
const extensionManifest = require("../manifest.json");
let passed = 0;
function check(value, label) { if (!value) throw new Error(label); passed++; }
function pause(ms = 150) { return new Promise(resolve => setTimeout(resolve, ms)); }

const html = fs.readFileSync(path.join(app, "index.html"), "utf8");
async function boot(panel, legacy, storedFilters) {
  const calls = [], opened = [], session = {};
  const config = `<script>window.FR_CONFIG = ${JSON.stringify({
    extension: true, panel, dataBase: "../data/",
    dataBases: ["https://arhaandev24.github.io/lpu-free-room/data/", "https://raw.githubusercontent.com/ArhaanDev24/lpu-free-room/main/docs/data/"]
  })}</script>`;
  const page = html.replace('<script src="config.js"></script>', config)
    .replace(/<script src="([^"]+)"><\/script>/g, (_, src) =>
      `<script>${fs.readFileSync(path.join(app, src), "utf8").replace(/<\/script/g, "<\\/script")}</script>`);
  const dom = new JSDOM(page, {
    url: "https://extension.test/app/", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) {
      w.Response = Response;
      w.fetch = async url => {
        url = String(url); calls.push(url);
        if (url.includes("github.io")) return new Response("missing", { status: 404 });
        if (url.includes("script.google.com")) return new Response(JSON.stringify({
          ok: true, role: "teacher", email: "t@lpu.co.in", name: "Teacher", token: "new-token",
          key: "new-key", exp: Date.now() + 600000
        }));
        if (url.includes("manifest.json")) return new Response(JSON.stringify({ ...manifest, teacher: null }));
        if (url.includes(manifest.free)) return new Response(JSON.stringify(publicData));
        return new Response("missing", { status: 404 });
      };
      w.chrome = {
        storage: { session: {
          get: async key => ({ [key]: session[key] }),
          set: async items => Object.assign(session, items),
          remove: async key => { delete session[key]; }
        } },
        sidePanel: { open: async options => { opened.push(options.windowId); } },
        windows: { WINDOW_ID_CURRENT: -2 }
      };
      w.confirm = () => true;
      w.scrollTo = () => {};
      w.HTMLElement.prototype.scrollIntoView = () => {};
      if (legacy) w.localStorage.setItem("fr.user", JSON.stringify(legacy));
      if (storedFilters) w.localStorage.setItem("fr.filters", JSON.stringify(storedFilters));
    }
  });
  await pause();
  return { dom, w: dom.window, d: dom.window.document, calls, opened, session };
}

(async () => {
  check(extensionManifest.manifest_version === 3, "Manifest V3");
  check(extensionManifest.side_panel.default_path === "extension/panel.html", "side panel path");
  check(extensionManifest.permissions.includes("storage") && extensionManifest.permissions.includes("sidePanel"), "extension permissions");

  let x = await boot(false, { role: "student", email: "s@example.com" });
  check(x.calls.some(u => u.includes("github.io")) && x.calls.some(u => u.includes("raw.githubusercontent.com")), "Pages fallback");
  check(x.d.querySelectorAll("#freeList .plate").length > 0, "published rooms shown");
  check(x.d.getElementById("status").textContent.includes("Published"), "publication age visible");
  check(!x.d.getElementById("btnNow").hidden && !x.d.getElementById("btnPanel").hidden, "popup quick actions shown");
  x.d.getElementById("fBlock").value = "34";
  x.d.getElementById("fBlock").dispatchEvent(new x.w.Event("change"));
  check(JSON.parse(x.w.localStorage.getItem("fr.filters")).block === "34", "block preference saved");
  x.d.querySelector('[data-tab="pAsk"]').click();
  x.w.webkitSpeechRecognition = function () {
    this.start = () => this.onresult({ results: [[{ transcript: "free rooms in block 34 at 2 pm" }]] });
  };
  x.d.getElementById("mic").click();
  await pause(0);
  check(x.d.querySelectorAll("#chat .msg.bot").length === 1, "voice transcript answered");
  x.d.getElementById("btnNow").click();
  check(!x.d.getElementById("pFree").hidden && x.d.querySelector('[data-slot="now"]').getAttribute("aria-selected") === "true", "Now shortcut");
  x.d.getElementById("btnPanel").click();
  await pause(0);
  check(x.opened[0] === -2, "side panel opened for current window");
  x.w.close();

  x = await boot(false, { role: "student", email: "s@example.com" }, { block: "34", floor: "3", type: "", cap: "" });
  check(x.d.getElementById("fBlock").value === "34" && x.d.getElementById("fFloor").value === "3",
    "saved location filters restored: " + x.d.getElementById("fBlock").value + "/" + x.d.getElementById("fFloor").value);
  x.w.close();

  x = await boot(true, { role: "student", email: "s@example.com" });
  check(x.d.getElementById("btnPanel").hidden, "side panel hides its own opener");
  x.w.close();

  const teacher = { role: "teacher", email: "t@lpu.co.in", name: "Teacher", token: "token", key: "key", exp: Date.now() + 600000 };
  x = await boot(false, teacher);
  check(x.w.localStorage.getItem("fr.user") === null, "legacy teacher secret removed from localStorage");
  check(x.session["fr.user"] && x.session["fr.user"].token === "token", "teacher secret migrated to session storage");
  x.d.getElementById("btnOut").click();
  await pause(0);
  check(!x.session["fr.user"], "teacher session cleared on sign out");
  x.w.close();

  x = await boot(false, null);
  x.d.querySelector('[data-role="teacher"]').click();
  x.d.getElementById("tEmail").value = "t@lpu.co.in";
  x.d.getElementById("tPass").value = "teacherpass";
  x.d.getElementById("fTeacher").dispatchEvent(new x.w.Event("submit", { cancelable: true }));
  await pause();
  check(x.session["fr.user"] && x.session["fr.user"].token === "new-token", "new teacher sign-in stored in session");
  check(x.w.localStorage.getItem("fr.user") === null, "new teacher secret absent from localStorage");
  x.w.close();

  console.log(`${passed} passed, 0 failed`);
})().catch(error => { console.error(error); process.exit(1); });
