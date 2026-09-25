/* LPU Free Room - screens and syncing. Every rule about rooms and time lives
 * in lib/freeroom.js; every rule about questions lives in lib/nlu.js. */
(function () {
  "use strict";

  var CFG = window.FR_CONFIG || { dataBase: "../data/" };
  var Cap = window.Capacitor;
  var NATIVE = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  var EXTENSION = !!CFG.extension || location.protocol === "chrome-extension:";
  var DATA_BASES = CFG.dataBases || [CFG.dataBase];
  var dataBase = DATA_BASES[0];
  var TYPE = { L: "Lecture", P: "Practical", T: "Tutorial" };
  var S = {
    user: null, man: null, model: null, tmodel: null,
    di: 0, s: 0, e: 0, slot: "now", filters: { block: "", floor: "", type: "", cap: "" },
    speak: true, lastSync: 0, sheet: null
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function load(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function drop(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function teacherSession() {
    return EXTENSION && window.chrome && chrome.storage && chrome.storage.session;
  }
  function saveUser(user) {
    if (EXTENSION && user.role === "teacher") {
      drop("fr.user");
      if (!teacherSession()) return Promise.reject(new Error("Secure teacher sign-in is unavailable. Reload the extension."));
      return chrome.storage.session.set({ "fr.user": user });
    }
    save("fr.user", user);
    return teacherSession() ? chrome.storage.session.remove("fr.user") : Promise.resolve();
  }
  function restoreUser() {
    var legacy = load("fr.user");
    if (!teacherSession()) {
      if (EXTENSION && legacy && legacy.role === "teacher") { drop("fr.user"); return Promise.resolve(null); }
      return Promise.resolve(legacy);
    }
    return chrome.storage.session.get("fr.user").then(function (items) {
      if (items["fr.user"]) return items["fr.user"];
      if (legacy && legacy.role === "teacher") {
        drop("fr.user");
        if (legacy.exp && legacy.exp < Date.now()) return null;
        return chrome.storage.session.set({ "fr.user": legacy }).then(function () { return legacy; });
      }
      return legacy;
    });
  }
  function dropUser() {
    drop("fr.user");
    if (teacherSession()) return chrome.storage.session.remove("fr.user");
    return Promise.resolve();
  }
  function isTeacher() { return !!(S.user && S.user.role === "teacher"); }

  var toastTimer;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 3200);
  }

  function fetchData(name, options, preferred, read) {
    var bases = preferred ? [preferred].concat(DATA_BASES.filter(function (b) { return b !== preferred; })) : DATA_BASES;
    function attempt(i) {
      return fetch(bases[i] + name, options).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return read ? read(r) : r;
      }).then(function (value) {
        dataBase = bases[i];
        return value;
      }).catch(function (e) {
        if (i + 1 < bases.length) return attempt(i + 1);
        throw e;
      });
    }
    return attempt(0);
  }

  function when(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + ", " +
      d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  // ------------------------------------------------------------- syncing --

  // One tiny manifest is checked every time; the room file (and, for
  // teachers, the sealed timetable) is downloaded only when its name - a
  // hash of its content - has changed since the last download.
  var syncing = null;
  function sync(force) {
    if (syncing) return syncing;
    $("btnSync").classList.add("spin");
    setStatus("Checking for a newer timetable…");
    syncing = fetchData("manifest.json?t=" + Date.now(), { cache: "no-store" }, null, function (r) {
      return r.json().then(function (man) {
        if (!man || man.v !== 1 || (man.free && typeof man.free !== "string")) throw new Error("Invalid manifest");
        return man;
      });
    })
      .then(function (man) {
        var old = S.man || {};
        if (!man.free) {
          S.man = man; save("fr.man", man);
          return "none";
        }
        var job = Promise.resolve();
        if (force || old.free !== man.free || !S.model) {
          job = fetchData(man.free, undefined, dataBase, function (r) {
            return r.json().then(function (pub) { FR.openPublic(pub); return pub; });
          }).then(function (pub) {
            save("fr.pub", pub);
            setModel(pub);
          });
        }
        return job.then(function () {
          var teacherChanged = old.teacher !== man.teacher;
          S.man = man; save("fr.man", man);
          if (isTeacher() && (force || teacherChanged || !S.tmodel)) return syncTeacher(force || teacherChanged);
        });
      })
      .then(function (r) {
        S.lastSync = Date.now();
        if (r === "none" && !S.model) setStatus("No timetable has been published yet.");
        else setStatus(fresh());
        render();
      })
      .catch(function () {
        setStatus(S.model ? "Can't check for updates. Showing saved timetable from " + when(S.model.built) + "." :
          "Can't reach the timetable. Check your connection and tap refresh.");
        render();
      })
      .then(function () { syncing = null; $("btnSync").classList.remove("spin"); });
    return syncing;
  }

  function fresh() {
    if (!S.model) return "";
    var c = S.model.counts || {};
    var age = Date.now() - new Date(S.model.built).getTime();
    return (age > 14 * 86400000 ? "Timetable may be outdated. Published " : "Published ") +
      when(S.model.built) + ", " + (c.exclusiveRooms || 0) + " rooms" +
      (isTeacher() && !S.tmodel ? ". Class details are not loaded yet." : "");
  }

  function setStatus(msg) { $("status").textContent = msg; }

  function syncTeacher(changed) {
    if (!S.man || !S.man.teacher) { S.tmodel = null; return Promise.resolve(); }
    var cached = load("fr.teach"), got;
    if (!changed && cached && cached.name === S.man.teacher) got = Promise.resolve(FR.fromB64(cached.b64));
    else {
      got = fetchData(S.man.teacher, undefined, dataBase, function (r) { return r.arrayBuffer(); }).then(function (b) {
        var u = new Uint8Array(b);
        save("fr.teach", { name: S.man.teacher, b64: FR.toB64(u) });
        return u;
      });
    }
    return got.then(openSealed).catch(function (e) {
      toast(e.message || "Couldn't open class details.");
    });
  }

  function openSealed(bytes) {
    return FR.unseal(bytes, S.user.key).catch(function () {
      // the admin may have rotated the key - fetch the current one
      return auth({ a: "key", token: S.user.token }).then(function (r) {
        S.user.key = r.key;
        return saveUser(S.user).then(function () { return FR.unseal(bytes, r.key); });
      });
    }).then(function (t) { S.tmodel = FR.openTeacher(t); });
  }

  function setModel(pub) {
    var first = !S.model;
    S.model = FR.openPublic(pub);
    if (first) pickNow();
    fillFilters();
  }

  function pickNow() {
    var n = FR.nowInfo();
    S.di = n.di;
    S.slot = "now";
    if (n.t < 420 || n.t > 1230) {        // outside class hours: the first slot
      var first = (S.model && S.model.slots[0]) || FR.LADDER.A[0];
      S.slot = first[0] + "-" + first[1];
      S.s = first[0]; S.e = first[1];
      if (n.t > 1230) S.di = (n.di + 1) % 7;
    } else { S.s = n.t; S.e = n.t + 50; }
  }

  // ---------------------------------------------------------------- auth --

  function auth(body) {
    var endpoint = S.man && S.man.auth;
    if (!S.man) return Promise.reject(new Error("Can't reach the timetable service. Check your connection and try again."));
    if (!endpoint) {
      return Promise.reject(new Error("Teacher sign-in isn't switched on yet. The admin has to publish once with the sign-in service address."));
    }
    return fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) throw new Error(j.error || "The sign-in service said no.");
      return j;
    }, function (e) {
      if (e instanceof SyntaxError) throw new Error("The sign-in service sent an unreadable reply.");
      throw e.message && e.message.indexOf("service") >= 0 ? e : new Error("Can't reach the sign-in service. Check your connection.");
    });
  }

  var tMode = "in";
  function setTMode(m) {
    tMode = m;
    var tab = m.replace("2", "");
    document.querySelectorAll("[data-tm]").forEach(function (b) {
      b.setAttribute("aria-selected", String(b.getAttribute("data-tm") === tab));
    });
    document.querySelectorAll("#fTeacher [data-show]").forEach(function (el) {
      el.hidden = el.getAttribute("data-show").split(" ").indexOf(m) < 0;
    });
    $("tEmail").readOnly = m === "up2" || m === "reset2";
    $("tPassLabel").textContent = m === "reset2" ? "New password (8+ characters)" : m === "up" ? "Choose a password (8+ characters)" : "Password";
    $("tPass").autocomplete = m === "in" ? "current-password" : "new-password";
    $("tGo").textContent = { "in": "Sign in", up: "Email me a code", up2: "Create account", reset: "Email me a code", reset2: "Set new password" }[m];
    $("tHint").textContent = m === "up2" || m === "reset2" ?
      "We sent a 6-digit code to " + $("tEmail").value.trim() + ". It works for 10 minutes." :
      "Only @lpu.co.in addresses can create a teacher account.";
    $("loginErr").textContent = "";
  }

  function signedIn(r) {
    S.user = { role: "teacher", email: r.email, name: r.name, token: r.token, exp: r.exp, key: r.key };
    return saveUser(S.user).then(function () {
      enter();
      return syncTeacher(true).then(render);
    }).catch(function (e) {
      S.user = null;
      throw e;
    });
  }

  function wireLogin() {
    document.querySelectorAll("[data-role]").forEach(function (b) {
      b.addEventListener("click", function () {
        var t = b.getAttribute("data-role") === "teacher";
        document.querySelectorAll("[data-role]").forEach(function (x) { x.setAttribute("aria-selected", String(x === b)); });
        $("fStudent").hidden = t;
        $("fTeacher").hidden = !t;
        $("loginErr").textContent = "";
        if (t) setTMode("in");
      });
    });
    document.querySelectorAll("[data-tm]").forEach(function (b) {
      b.addEventListener("click", function () { setTMode(b.getAttribute("data-tm")); });
    });

    $("fStudent").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var email = $("sEmail").value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $("loginErr").textContent = "Enter a valid email address."; return; }
      S.user = { role: "student", email: email, name: $("sName").value.trim() };
      saveUser(S.user).then(enter).catch(function () {
        S.user = null;
        $("loginErr").textContent = "Couldn't save sign-in. Please try again.";
      });
    });

    $("fTeacher").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var email = $("tEmail").value.trim().toLowerCase(), pass = $("tPass").value, otp = $("tOtp").value.trim();
      var err = $("loginErr");
      err.textContent = "";
      if (!/^[a-z0-9._%+\-]+@lpu\.co\.in$/.test(email)) { err.textContent = "Use your @lpu.co.in email address."; return; }
      if ((tMode === "in" || tMode === "up" || tMode === "reset2") && pass.length < 8) {
        err.textContent = "The password needs at least 8 characters."; return;
      }
      if ((tMode === "up2" || tMode === "reset2") && !/^\d{6}$/.test(otp)) { err.textContent = "Enter the 6-digit code from your email."; return; }
      if (tMode === "up" && !$("tName").value.trim()) { err.textContent = "Enter your name."; return; }
      var go = $("tGo");
      go.disabled = true;
      var ready = S.man && S.man.auth ? Promise.resolve() : sync(false);
      ready.then(function () {
        if (tMode === "in") return auth({ a: "login", email: email, password: pass }).then(signedIn);
        if (tMode === "up") return auth({ a: "signupStart", email: email, name: $("tName").value.trim() }).then(function () { setTMode("up2"); });
        if (tMode === "up2") {
          return auth({ a: "signupVerify", email: email, otp: otp, password: pass, name: $("tName").value.trim() }).then(signedIn);
        }
        if (tMode === "reset") return auth({ a: "resetStart", email: email }).then(function () { setTMode("reset2"); });
        return auth({ a: "resetVerify", email: email, otp: otp, password: pass }).then(signedIn);
      }).catch(function (e) { err.textContent = e.message; })
        .then(function () { go.disabled = false; });
    });
  }

  function showLogin() {
    $("main").hidden = true;
    $("login").hidden = false;
  }

  function enter() {
    $("login").hidden = true;
    $("main").hidden = false;
    $("whoRole").textContent = isTeacher() ? "Teacher" : "Student";
    $("whoName").textContent = S.user.name || S.user.email;
    document.querySelectorAll(".teacher-only").forEach(function (el) { el.hidden = !isTeacher(); });
    if (!isTeacher() && !$("pTT").hidden) showTab("pFree");
    render();
  }

  // ---------------------------------------------------------- free rooms --

  function details(r) {
    if (!r.details) return "";
    var parts = [];
    if (r.type) parts.push(r.type);
    if (r.cap) parts.push(r.cap + " seats");
    Object.keys(r.details).forEach(function (k) {
      if (parts.length >= 3 || /type|cap|^block$|^floor$/i.test(k)) return;
      parts.push(k + ": " + r.details[k]);
    });
    return parts.join(", ");
  }

  function plate(r, extra) {
    var tag = isTeacher() ? "button" : "div";
    var d = details(r);
    return "<" + tag + (tag === "button" ? ' type="button"' : "") + ' class="plate ' + (extra || "") +
      '" data-room="' + esc(r.name) + '"><span class="rn">' + esc(r.name) + "</span>" +
      (d ? '<span class="rd">' + esc(d) + "</span>" : "") + "</" + tag + ">";
  }

  function floorName(f) { return f == null ? "Other" : f === 0 ? "Ground floor" : "Floor " + f; }

  function groupHTML(rooms, cls) {
    var blocks = [], at = {};
    rooms.forEach(function (r) {
      var b = r.shared ? "~" : (r.block || "?");
      if (!(b in at)) { at[b] = blocks.length; blocks.push({ b: b, floors: {}, order: [], n: 0 }); }
      var g = blocks[at[b]], f = r.shared ? "shared" : String(r.floor);
      if (!g.floors[f]) { g.floors[f] = []; g.order.push(f); }
      g.floors[f].push(r);
      g.n++;
    });
    return blocks.map(function (g) {
      var label = g.b === "~" ? "Shared" : g.b;
      return '<section class="blk"><div class="blk-no"' + (g.b === "~" ? ' style="font-size:22px"' : "") + ">" +
        esc(label) + "<small>" + g.n + (g.n === 1 ? " room" : " rooms") + "</small></div><div>" +
        g.order.sort(function (a, b) { return (+a) - (+b); }).map(function (f) {
          return '<div class="fl"><span class="fl-no">' + (f === "shared" ? "Shared venues" : floorName(f === "null" ? null : +f)) +
            '</span><div class="plates">' + g.floors[f].map(function (r) {
              return plate(r, typeof cls === "function" ? cls(r) : cls);
            }).join("") + "</div></div>";
        }).join("") + "</div></section>";
    }).join("");
  }

  function fillFilters() {
    var m = S.model;
    if (!m) return;
    var f = S.filters;
    $("fBlock").innerHTML = '<option value="">All</option>' + m.blocks.map(function (b) {
      return "<option" + (b === f.block ? " selected" : "") + ">" + esc(b) + "</option>";
    }).join("");
    fillFloors();
    $("fTypeBox").hidden = !m.types.length;
    $("fType").innerHTML = '<option value="">All</option>' + m.types.map(function (t) {
      return "<option" + (t === f.type ? " selected" : "") + ">" + esc(t) + "</option>";
    }).join("");
  }

  function fillFloors() {
    var floors = S.model.floorsOf(S.filters.block || null);
    if (S.filters.floor !== "" && floors.indexOf(+S.filters.floor) < 0) S.filters.floor = "";
    $("fFloor").innerHTML = '<option value="">All</option>' + floors.map(function (f) {
      return '<option value="' + f + '"' + (String(f) === String(S.filters.floor) ? " selected" : "") + ">" +
        (f === 0 ? "Ground" : f) + "</option>";
    }).join("");
  }

  function renderStrips() {
    var m = S.model, active = m.activeDays(), n = FR.nowInfo();
    $("dayStrip").innerHTML = FR.DAYS.map(function (d, i) {
      if (i === 6 && !active[6] && S.di !== 6) return "";
      var label = i === n.di ? "Today" : i === (n.di + 1) % 7 ? "Tomorrow" : FR.DAY_NAMES[i].slice(0, 3);
      return '<button type="button" class="chip' + (active[i] ? "" : " quiet") + '" role="tab" data-day="' + i +
        '" aria-selected="' + (i === S.di) + '">' + label + "</button>";
    }).join("");
    var chips = ['<button type="button" class="chip" role="tab" data-slot="now" aria-selected="' + (S.slot === "now") + '">Now</button>'];
    m.slots.forEach(function (w) {
      var k = w[0] + "-" + w[1];
      chips.push('<button type="button" class="chip" role="tab" data-slot="' + k + '" aria-selected="' + (S.slot === k) + '">' +
        FR.span(w[0], w[1]) + "</button>");
    });
    chips.push('<button type="button" class="chip" role="tab" data-slot="custom" aria-selected="' + (S.slot === "custom") + '">Custom</button>');
    $("slotStrip").innerHTML = chips.join("");
    $("customBox").hidden = S.slot !== "custom";
    var sel = $("slotStrip").querySelector('[aria-selected="true"]');
    if (sel && sel.scrollIntoView && !renderStrips.done) { sel.scrollIntoView({ inline: "center", block: "nearest" }); renderStrips.done = 1; }
  }

  function renderFree() {
    var m = S.model, list = $("freeList");
    if (!m) {
      $("dayStrip").innerHTML = $("slotStrip").innerHTML = "";
      $("freeSummary").textContent = "";
      list.innerHTML = '<div class="empty"><b>No timetable yet</b>Rooms appear here as soon as the admin publishes a timetable.</div>';
      return;
    }
    if (S.slot === "now") { var n = FR.nowInfo(); S.s = n.t; S.e = n.t + 50; }
    renderStrips();
    var f = S.filters;
    var rooms = m.free(S.di, S.s, S.e, { block: f.block, floor: f.floor, type: f.type, minCap: f.cap });
    var dayWord = S.di === FR.nowInfo().di ? "today" : FR.DAY_NAMES[S.di];
    $("freeSummary").innerHTML = "<b>" + rooms.length + "</b> free " + (rooms.length === 1 ? "room" : "rooms") + ", " +
      esc(dayWord) + " " + FR.span(S.s, S.e) +
      (f.cap && !m.rooms.some(function (r) { return r.cap; }) ? ". No room has seating details yet." : "");
    list.innerHTML = rooms.length ? groupHTML(rooms, "") :
      '<div class="empty"><b>Nothing free here</b>Clear a filter or pick another time.</div>';
  }

  // ----------------------------------------------------------- all rooms --

  function renderRooms() {
    var m = S.model, box = $("roomList");
    if (!m) { box.innerHTML = '<div class="empty"><b>No timetable yet</b>The room list appears once a timetable is published.</div>'; $("roomSummary").textContent = ""; return; }
    var q = $("roomQ").value.trim().toUpperCase(), n = FR.nowInfo();
    var rooms = m.rooms.filter(function (r) {
      return !q || r.name.indexOf(q) >= 0 || (r.block && ("BLOCK " + r.block) === q) ||
        String(r.type || "").toUpperCase().indexOf(q) >= 0;
    });
    var withD = rooms.filter(function (r) { return r.details; }).length;
    $("roomSummary").innerHTML = "<b>" + rooms.length + "</b> rooms" + (withD ? ", " + withD + " with details" : "") +
      ". Green edge: free right now.";
    box.innerHTML = rooms.length ? groupHTML(rooms, function (r) {
      if (r.shared) return "shared";
      return m.isFree(r.i, n.di, n.t, n.t + 1) ? "" : "busy";
    }) : '<div class="empty"><b>No room matches</b>Try a room number like 34-504, or a block like 34.</div>';
  }

  // ------------------------------------------------------------------ ask --

  var EXAMPLES = ["Free rooms near me now in block 34", "Which block has the most free rooms?",
                  "Which floor in block 33 at 2 pm?", "Is 34-504 free tomorrow at 10?",
                  "A lab for 60 students after lunch"];

  function plugin(name) {
    if (!NATIVE) return null;
    try { return (Cap.Plugins && Cap.Plugins[name]) || Cap.registerPlugin(name); } catch (e) { return null; }
  }

  function listen() {
    if (NATIVE) {
      var SR = plugin("SpeechRecognition");
      if (!SR) return Promise.reject(new Error("Voice input isn't available on this phone."));
      return SR.available().then(function (a) {
        if (!a.available) throw new Error("This phone has no speech service. Install or enable the Google app.");
        return SR.requestPermissions();
      }).then(function (p) {
        if (p.speechRecognition !== "granted") throw new Error("Microphone permission is off. Allow it in Settings to ask by voice.");
        return SR.start({ language: "en-IN", maxResults: 3, prompt: "Ask about free rooms", partialResults: false, popup: true });
      }).then(function (r) { return (r && r.matches && r.matches[0]) || ""; });
    }
    var W = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!W) return Promise.reject(new Error("Voice input isn't available in this browser. Type the question instead."));
    return new Promise(function (resolve, reject) {
      var rec = new W();
      rec.lang = "en-IN"; rec.interimResults = false; rec.maxAlternatives = 1;
      rec.onresult = function (e) { resolve(e.results[0][0].transcript); };
      rec.onerror = function (e) {
        reject(new Error(e.error === "not-allowed" ? "Microphone permission is off for this site." : "Didn't catch that. Try again."));
      };
      rec.onend = function () { resolve(""); };
      rec.start();
    });
  }

  function say(text) {
    if (!S.speak || !text) return;
    if (NATIVE) {
      var T = plugin("TextToSpeech");
      if (T) T.speak({ text: text, lang: "en-IN", rate: 1.0, pitch: 1.0, volume: 1.0, category: "ambient" }).catch(function () {});
      return;
    }
    if (window.speechSynthesis) {
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = "en-IN";
      speechSynthesis.speak(u);
    }
  }

  function bubble(cls, html) {
    var d = document.createElement("div");
    d.className = "msg " + cls;
    d.innerHTML = html;
    $("chat").appendChild(d);
    d.scrollIntoView({ block: "end", behavior: "smooth" });
    return d;
  }

  function askQuestion(text) {
    text = String(text || "").trim();
    if (!text) return;
    bubble("me", esc(text));
    if (!S.model) { bubble("bot", "The timetable isn't loaded yet. Tap refresh at the top and try again."); return; }
    var a;
    try {
      a = NLU.ask(text, { model: S.model, tmodel: S.tmodel, teacher: isTeacher(), now: new Date() });
    } catch (e) {
      bubble("bot", "I couldn't work that out. Try: free rooms in block 34 at 2 pm.");
      return;
    }
    var html = esc(a.text);
    var rooms = (a.rooms || []).filter(Boolean);
    if (rooms.length) {
      html += '<div class="plates">' + rooms.slice(0, 24).map(function (r) { return plate(r, ""); }).join("") + "</div>";
    }
    if (!a.open && a.q.intent !== "room_status" && a.q.intent !== "room_windows" && !(a.q.unknownBlock && !a.q.block)) {
      html += '<button type="button" class="more" data-apply="1">' +
        (rooms.length ? "Show on the free rooms screen" : "Change the filters on the free rooms screen") + "</button>";
    }
    var b = bubble("bot", html);
    b._answer = a;
    say(a.speak);
    if (a.open) openTimeline(a.open.field, a.open.key, a.open.di);
  }

  function applyAnswer(a) {
    var f = a.filters;
    S.di = f.di;
    var match = S.model.slots.filter(function (w) { return w[0] === f.s && w[1] === f.e; })[0];
    S.slot = a.q.now ? "now" : match ? f.s + "-" + f.e : "custom";
    S.s = f.s; S.e = f.e;
    $("tFrom").value = FR.hhmm(f.s); $("tTo").value = FR.hhmm(f.e);
    S.filters = { block: f.block || "", floor: f.floor === "" || f.floor == null ? "" : String(f.floor),
                  type: S.model.types.indexOf(f.type) >= 0 ? f.type : "", cap: f.minCap || "" };
    if (EXTENSION) save("fr.filters", S.filters);
    $("fCap").value = S.filters.cap;
    fillFilters();
    showTab("pFree");
  }

  // ----------------------------------------------------------- timelines --

  var FIELD_NAME = { room: "Room", section: "Section", teacher: "Staff", course: "Course" };

  function evText(b, field) {
    var g = b.group && b.group !== "0" ? " (group " + b.group + ")" : "";
    if (field === "room") return [b.course + " " + b.type, b.section + g + ", staff " + b.teacher];
    if (field === "section") return [b.course + " " + b.type, b.room + g + ", staff " + b.teacher];
    if (field === "teacher") return [b.course + " " + b.section, b.room + ", " + (TYPE[b.type] || b.type)];
    return [b.section + " " + b.type, b.room + ", staff " + b.teacher];
  }

  function timelineHTML(items, field, opts) {
    var t0 = 480, t1 = 1200, PX = 1.15;
    items.forEach(function (b) {
      t0 = Math.min(t0, Math.floor(b.start / 60) * 60);
      t1 = Math.max(t1, Math.ceil(b.end / 60) * 60);
    });
    var y = function (t) { return ((t - t0) * PX).toFixed(1); };
    var out = [];
    for (var t = t0; t <= t1; t += 60) {
      out.push('<div class="hr" style="top:' + y(t) + 'px"><span>' + FR.clock(t).replace(":00", "") + "</span></div>");
    }
    if (opts.band) out.push('<div class="band" style="top:' + y(opts.band[0]) + "px;height:" + ((opts.band[1] - opts.band[0]) * PX).toFixed(1) + 'px"></div>');
    (opts.gaps || []).forEach(function (g) {
      if (g[1] - g[0] < 20) return;
      out.push('<div class="gap" style="top:' + y(g[0]) + "px;height:" + ((g[1] - g[0]) * PX).toFixed(1) + 'px">free ' + FR.span(g[0], g[1]) + "</div>");
    });
    if (opts.now != null && opts.now > t0 && opts.now < t1) out.push('<div class="now" style="top:' + y(opts.now) + 'px"></div>');

    // side-by-side lanes for anything that overlaps
    items.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    var clusters = [], cur = null, end = -1;
    items.forEach(function (b) {
      if (!cur || b.start >= end) { cur = []; clusters.push(cur); end = b.end; } else end = Math.max(end, b.end);
      cur.push(b);
    });
    clusters.forEach(function (c) {
      var lanes = [];
      c.forEach(function (b) {
        var L = 0;
        while (lanes[L] != null && lanes[L] > b.start) L++;
        lanes[L] = b.end;
        b._lane = L;
      });
      var n = lanes.length;
      var clash = n > 1 && c.some(function (a) {
        return c.some(function (b) {
          return a !== b && a.start < b.end && b.start < a.end && (a.course !== b.course || a.section !== b.section);
        });
      });
      c.forEach(function (b) {
        var tx = evText(b, field);
        out.push('<button type="button" class="ev t-' + esc(b.type) + (clash ? " clash" : "") + '" data-id="' + b.id +
          '" style="top:' + y(b.start) + "px;height:" + Math.max(20, (b.end - b.start) * PX - 2).toFixed(1) +
          "px;left:calc(" + (b._lane * 100 / n) + "% + 1px);width:calc(" + (100 / n) + '% - 3px)"><b>' + esc(tx[0]) +
          "</b><span>" + esc(tx[1]) + "</span><i>" + FR.span(b.start, b.end) + "</i></button>");
      });
    });
    return '<p class="legend"><span><i></i>Lecture</span><span><i class="p"></i>Practical</span><span><i class="t"></i>Tutorial</span>' +
      (field === "room" ? '<span><i class="f"></i>Free</span>' : "") + '<span><i class="c"></i>Overlap</span></p>' +
      '<div class="tl" style="height:' + y(t1) + 'px">' + out.join("") + "</div>";
  }

  function openTimeline(field, key, di) {
    if (!isTeacher()) return;
    if (!S.tmodel) { toast("Class details are still loading. Try again in a moment."); return; }
    S.sheet = { field: field, key: key, di: di == null ? S.di : di };
    $("sheet").hidden = false;
    renderSheet();
  }

  function renderSheet() {
    var sh = S.sheet, all = S.tmodel.of(sh.field, sh.key);
    var counts = [0, 0, 0, 0, 0, 0, 0];
    all.forEach(function (b) { counts[b.di]++; });
    $("shTitle").textContent = (sh.field === "room" ? "" : FIELD_NAME[sh.field] + " ") + sh.key;
    var sub = all.length + " classes a week";
    if (sh.field === "room") {
      var r = S.model.byName[sh.key];
      if (r) sub = (details(r) ? details(r) + ". " : "") + sub + (r.shared ? ". Shared venue" : "");
    }
    $("shSub").textContent = sub;
    $("shDays").innerHTML = FR.DAYS.map(function (d, i) {
      if (i === 6 && !counts[6]) return "";
      return '<button type="button" class="chip' + (counts[i] ? "" : " quiet") + '" data-sday="' + i + '" aria-selected="' +
        (i === sh.di) + '">' + FR.DAY_NAMES[i].slice(0, 3) + (counts[i] ? " " + counts[i] : "") + "</button>";
    }).join("");
    var items = all.filter(function (b) { return b.di === sh.di; });
    var n = FR.nowInfo(), opts = { now: sh.di === n.di ? n.t : null };
    if (sh.field === "room" && S.model.byName[sh.key]) {
      var ri = S.model.byName[sh.key].i;
      opts.gaps = S.model.freeWindows(ri, sh.di, 480, 1200);
      if (sh.di === S.di) opts.band = [S.s, S.e];
    }
    $("shBody").innerHTML = items.length || opts.gaps ? timelineHTML(items, sh.field, opts) :
      '<div class="empty"><b>Nothing on ' + FR.DAY_NAMES[sh.di] + "</b>Pick another day above.</div>";
    $("shInfo").hidden = true;
  }

  function showEvent(id) {
    var b = S.tmodel.list[id], box = $("shInfo");
    var rows = [["Course", b.course], ["Section", b.section + (b.group && b.group !== "0" ? ", group " + b.group : "")],
                ["Room", b.room], ["Staff", b.teacher], ["Type", TYPE[b.type] || b.type],
                ["Time", FR.DAY_NAMES[b.di] + ", " + FR.span(b.start, b.end)]];
    var jumps = [["section", b.section], ["teacher", b.teacher], ["room", b.room], ["course", b.course]].filter(function (j) {
      return !(j[0] === S.sheet.field && j[1] === S.sheet.key) && j[1];
    });
    box.innerHTML = "<h3>" + esc(b.course) + " " + esc(b.section) + "</h3><dl>" + rows.map(function (r) {
      return "<dt>" + r[0] + "</dt><dd>" + esc(r[1]) + "</dd>";
    }).join("") + '</dl><div class="row">' + jumps.map(function (j) {
      return '<button type="button" data-jump="' + j[0] + '" data-key="' + esc(j[1]) + '">' + FIELD_NAME[j[0]] + " week</button>";
    }).join("") + "</div>";
    box.hidden = false;
  }

  // teacher search across sections, staff, courses and rooms
  function suggest() {
    var q = $("ttQ").value.trim().toUpperCase(), box = $("ttSuggest");
    if (!S.tmodel) { box.innerHTML = ""; $("ttHint").textContent = "Class details are still loading."; return; }
    $("ttHint").textContent = q ? "" : "Search any section, staff ID, course or room to see its week.";
    if (!q) { box.innerHTML = ""; return; }
    var out = [];
    [["section", S.tmodel.sections], ["teacher", S.tmodel.teachers], ["course", S.tmodel.courses], ["room", S.tmodel.rooms]]
      .forEach(function (g) {
        var hits = g[1].filter(function (v) { return String(v).toUpperCase().indexOf(q) >= 0; });
        hits.sort(function (a, b) { return (String(a).indexOf(q) === 0 ? 0 : 1) - (String(b).indexOf(q) === 0 ? 0 : 1) || (a < b ? -1 : 1); });
        hits.slice(0, 8).forEach(function (v) { out.push([g[0], v]); });
      });
    box.innerHTML = out.length ? out.map(function (x) {
      return '<button type="button" data-open="' + x[0] + '" data-key="' + esc(x[1]) + '"><span class="k">' +
        FIELD_NAME[x[0]] + '</span><span class="v">' + esc(x[1]) + "</span></button>";
    }).join("") : '<div class="empty"><b>No match</b>Check the spelling, e.g. K24CG, CSE101 or 34-504.</div>';
  }

  // ------------------------------------------------------------- wiring --

  function showTab(id) {
    ["pFree", "pAsk", "pRooms", "pTT"].forEach(function (p) { $(p).hidden = p !== id; });
    document.querySelectorAll("[data-tab]").forEach(function (b) {
      b.setAttribute("aria-selected", String(b.getAttribute("data-tab") === id));
    });
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    if ($("main").hidden) return;
    if (!$("pFree").hidden) renderFree();
    if (!$("pRooms").hidden) renderRooms();
    if (!$("pTT").hidden) suggest();
    if (!$("pAsk").hidden && !$("examples").children.length) {
      $("examples").innerHTML = EXAMPLES.map(function (x) {
        return '<button type="button" class="chip quiet" data-ex="' + esc(x) + '">' + esc(x) + "</button>";
      }).join("");
    }
  }

  function wireMain() {
    if (EXTENSION) {
      $("btnNow").hidden = false;
      $("btnPanel").hidden = !!CFG.panel;
    }
    $("btnNow").addEventListener("click", function () {
      S.di = FR.nowInfo().di;
      S.slot = "now";
      showTab("pFree");
    });
    $("btnPanel").addEventListener("click", function () {
      if (!window.chrome || !chrome.sidePanel || typeof chrome.sidePanel.open !== "function" || !chrome.windows) {
        return toast("Side panel isn't available in this Chrome version.");
      }
      chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }).catch(function () {
        toast("Couldn't open the side panel. Try Chrome's side panel menu.");
      });
    });
    document.querySelectorAll("[data-tab]").forEach(function (b) {
      b.addEventListener("click", function () { showTab(b.getAttribute("data-tab")); });
    });
    $("btnSync").addEventListener("click", function () { sync(true); });
    $("btnOut").addEventListener("click", function () {
      if (!confirm("Sign out of LPU Free Room?")) return;
      S.user = null; S.tmodel = null;
      drop("fr.teach");
      $("chat").innerHTML = "";
      showLogin();
      dropUser().catch(function () {
        $("loginErr").textContent = "Couldn't clear the sign-in session. Reload Chrome before using this device again.";
      });
    });

    $("dayStrip").addEventListener("click", function (e) {
      var b = e.target.closest("[data-day]");
      if (!b) return;
      S.di = +b.getAttribute("data-day");
      if (S.slot === "now" && S.di !== FR.nowInfo().di) {
        var w = S.model.slots.filter(function (x) { return x[1] > S.s; })[0] || S.model.slots[0];
        if (w) { S.slot = w[0] + "-" + w[1]; S.s = w[0]; S.e = w[1]; }
      }
      renderFree();
    });
    $("slotStrip").addEventListener("click", function (e) {
      var b = e.target.closest("[data-slot]");
      if (!b) return;
      var k = b.getAttribute("data-slot");
      S.slot = k;
      if (k === "now") { S.di = FR.nowInfo().di; }
      else if (k === "custom") {
        $("tFrom").value = FR.hhmm(S.s); $("tTo").value = FR.hhmm(S.e);
      } else { var p = k.split("-"); S.s = +p[0]; S.e = +p[1]; }
      renderFree();
    });
    function custom() {
      var a = $("tFrom").value.split(":"), b = $("tTo").value.split(":");
      if (a.length < 2 || b.length < 2) return;
      var s = +a[0] * 60 + +a[1], e = +b[0] * 60 + +b[1];
      if (e <= s) { toast("The end time has to be after the start."); return; }
      S.s = s; S.e = e;
      renderFree();
    }
    $("tFrom").addEventListener("change", custom);
    $("tTo").addEventListener("change", custom);
    function rememberFilters() { if (EXTENSION) save("fr.filters", S.filters); }
    $("fBlock").addEventListener("change", function () { S.filters.block = this.value; fillFloors(); rememberFilters(); renderFree(); });
    $("fFloor").addEventListener("change", function () { S.filters.floor = this.value; rememberFilters(); renderFree(); });
    $("fType").addEventListener("change", function () { S.filters.type = this.value; rememberFilters(); renderFree(); });
    $("fCap").addEventListener("input", function () { S.filters.cap = this.value ? +this.value : ""; rememberFilters(); renderFree(); });

    $("roomQ").addEventListener("input", renderRooms);
    $("ttQ").addEventListener("input", suggest);
    $("ttSuggest").addEventListener("click", function (e) {
      var b = e.target.closest("[data-open]");
      if (b) openTimeline(b.getAttribute("data-open"), b.getAttribute("data-key"));
    });

    // tapping any room plate opens its week (teachers)
    document.addEventListener("click", function (e) {
      var p = e.target.closest("button.plate[data-room]");
      if (p) { openTimeline("room", p.getAttribute("data-room")); return; }
      var ap = e.target.closest("[data-apply]");
      if (ap) { var m = ap.closest(".msg"); if (m && m._answer) applyAnswer(m._answer); return; }
      var ex = e.target.closest("[data-ex]");
      if (ex) askQuestion(ex.getAttribute("data-ex"));
    });

    $("askForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var t = $("askText").value;
      $("askText").value = "";
      askQuestion(t);
    });
    $("mic").addEventListener("click", function () {
      var mic = $("mic");
      if (mic.classList.contains("on")) return;
      mic.classList.add("on");
      listen().then(function (t) {
        mic.classList.remove("on");
        if (t) askQuestion(t); else toast("Didn't catch that. Tap the mic and try again.");
      }, function (e) { mic.classList.remove("on"); toast(e.message); });
    });
    $("speakOn").checked = S.speak;
    $("speakOn").addEventListener("change", function () { S.speak = this.checked; save("fr.speak", S.speak); });

    $("shClose").addEventListener("click", function () { $("sheet").hidden = true; S.sheet = null; });
    $("sheet").addEventListener("click", function (e) {
      if (e.target === $("sheet")) { $("sheet").hidden = true; S.sheet = null; return; }
      var d = e.target.closest("[data-sday]");
      if (d) { S.sheet.di = +d.getAttribute("data-sday"); renderSheet(); return; }
      var ev = e.target.closest(".ev[data-id]");
      if (ev) { showEvent(+ev.getAttribute("data-id")); return; }
      var j = e.target.closest("[data-jump]");
      if (j) { openTimeline(j.getAttribute("data-jump"), j.getAttribute("data-key"), S.sheet.di); }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !$("sheet").hidden) { $("sheet").hidden = true; S.sheet = null; }
    });

    // coming back to the app: check for a newer timetable at most every 10 minutes
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && Date.now() - S.lastSync > 600000) sync(false);
      if (!document.hidden) render();
    });
    setInterval(function () { if (S.slot === "now" && !$("pFree").hidden && !document.hidden) renderFree(); }, 60000);
  }

  // ------------------------------------------------------------------ boot --

  function boot() {
    S.speak = load("fr.speak") !== false;
    if (EXTENSION) {
      var filters = load("fr.filters") || {};
      S.filters = { block: filters.block || "", floor: filters.floor || "", type: filters.type || "", cap: filters.cap || "" };
      $("fCap").value = S.filters.cap;
    }
    var man = load("fr.man"), pub = load("fr.pub");
    if (man && pub) {
      S.man = man;
      try { setModel(pub); } catch (e) { drop("fr.pub"); }
    }
    wireLogin();
    wireMain();
    restoreUser().then(function (user) {
      S.user = user;
      if (S.user && S.user.role === "teacher" && S.user.exp && S.user.exp < Date.now()) {
        S.user = null;
        dropUser().catch(function () {});
        $("loginErr").textContent = "Your teacher sign-in expired. Sign in again.";
      }
      if (S.user) enter(); else showLogin();
      if (S.model) setStatus("Saved timetable from " + when(S.model.built) + ". Checking for updates…");
      var cached = load("fr.teach");
      var opened = isTeacher() && cached && man && cached.name === man.teacher ?
        openSealed(FR.fromB64(cached.b64)).catch(function () {}) : Promise.resolve();
      opened.then(function () { render(); sync(false); });
    }).catch(function () {
      S.user = null;
      showLogin();
      $("loginErr").textContent = "Couldn't restore sign-in. Reload the extension.";
      sync(false);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
