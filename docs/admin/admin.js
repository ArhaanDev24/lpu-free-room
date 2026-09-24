/* LPU Free Room - admin page. Reads the uploads in the browser, builds the
 * published files with lib/freeroom.js, checks them, and commits them to the
 * repository in one commit so phones never see half an update. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var A = {
    set: {}, key: null, man: null,
    cur: { bookings: null, details: null },      // what is published now
    up: { bookings: null, details: null, mode: "replace", table: null },
    build: null
  };
  var DATA_DIR = "docs/data/";
  var SHEETJS = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function num(n) { return Number(n).toLocaleString("en-IN"); }
  function kb(n) { return n < 1024 ? n + " B" : (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB"; }
  function msg(id, text, cls) { var el = $(id); el.textContent = text; el.className = "msg " + (cls || ""); }
  function stat(v, label) { return '<div class="stat"><b>' + v + "</b><span>" + label + "</span></div>"; }

  // ------------------------------------------------------------ settings --

  function loadSettings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem("fra.settings") || "{}"); } catch (e) { s = {}; }
    if (!s.repo && /\.github\.io$/i.test(location.hostname)) {
      s.repo = location.hostname.split(".")[0] + "/" + location.pathname.split("/")[1];
    }
    ["token", "repo", "authUrl", "adminSecret", "branch"].forEach(function (k) {
      if (s[k]) $(k).value = s[k];
    });
  }

  function readSettings() {
    var s = {};
    ["token", "repo", "authUrl", "adminSecret", "branch"].forEach(function (k) { s[k] = $(k).value.trim(); });
    s.branch = s.branch || "main";
    s.repo = s.repo.replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "");
    localStorage.setItem("fra.settings", JSON.stringify(s));
    A.set = s;
    return s;
  }

  // ------------------------------------------------------------ GitHub --

  function gh(path, opts) {
    opts = opts || {};
    var headers = { Authorization: "Bearer " + A.set.token, "X-GitHub-Api-Version": "2022-11-28",
                    Accept: opts.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json" };
    if (opts.body) headers["Content-Type"] = "application/json";
    return fetch("https://api.github.com/repos/" + A.set.repo + (path ? "/" + path : ""), {
      method: opts.method || "GET", headers: headers, cache: "no-store",
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      if (opts.raw) {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error("GitHub said " + r.status + " for " + path);
        return opts.raw === "bytes" ? r.arrayBuffer().then(function (b) { return new Uint8Array(b); }) : r.text();
      }
      return r.text().then(function (t) {
        var j = {};
        try { j = t ? JSON.parse(t) : {}; } catch (e) { j = {}; }
        if (!r.ok) {
          var why = j.message || ("HTTP " + r.status);
          if (r.status === 401) why = "the token is wrong or expired";
          if (r.status === 403 || r.status === 404) why += " (check the repository name and that the token has Contents: Read and write on it)";
          throw new Error("GitHub: " + why);
        }
        return j;
      });
    });
  }

  function fileRaw(path, bytes) {
    return gh("contents/" + path + "?ref=" + encodeURIComponent(A.set.branch), { raw: bytes ? "bytes" : "text" });
  }

  // one commit: new blobs on top of the branch head, stale data files removed
  function commit(files, deletes, message) {
    var head, baseTree;
    return gh("git/ref/heads/" + A.set.branch).then(function (ref) {
      head = ref.object.sha;
      return gh("git/commits/" + head);
    }).then(function (c) {
      baseTree = c.tree.sha;
      var tree = [];
      return Object.keys(files).reduce(function (p, path) {
        return p.then(function () {
          var content = files[path];
          var bytes = typeof content === "string" ? FR.utf8(content) : content;
          return gh("git/blobs", { method: "POST", body: { content: FR.toB64(bytes), encoding: "base64" } })
            .then(function (b) { tree.push({ path: path, mode: "100644", type: "blob", sha: b.sha }); });
        });
      }, Promise.resolve()).then(function () {
        deletes.forEach(function (p) { tree.push({ path: p, mode: "100644", type: "blob", sha: null }); });
        return gh("git/trees", { method: "POST", body: { base_tree: baseTree, tree: tree } });
      });
    }).then(function (t) {
      return gh("git/commits", { method: "POST", body: { message: message, tree: t.sha, parents: [head] } });
    }).then(function (c) {
      return gh("git/refs/heads/" + A.set.branch, { method: "PATCH", body: { sha: c.sha } }).then(function () { return c; });
    });
  }

  // ------------------------------------------------------------- connect --

  function authCall(body) {
    return fetch(A.set.authUrl, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
                                  body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || "refused"); return j; });
  }

  function connect() {
    var s = readSettings();
    if (!s.token || !/^[\w.\-]+\/[\w.\-]+$/.test(s.repo)) { msg("connectMsg", "Enter the token and the repository as owner/name.", "bad"); return; }
    msg("connectMsg", "Connecting…");
    $("btnConnect").disabled = true;
    var notes = [];
    gh("").then(function (repo) {
      if (repo.permissions && !repo.permissions.push) throw new Error("This GitHub account can't write to " + s.repo + ".");
      notes.push("GitHub connected");
      if (!s.authUrl) { notes.push("no sign-in service yet: teachers can't sign in and class details won't be published"); return; }
      if (!s.adminSecret) { notes.push("enter the admin secret to publish class details for teachers"); return; }
      return authCall({ a: "adminKey", secret: s.adminSecret }).then(function (j) {
        A.key = j.key;
        notes.push("sign-in service connected");
      }, function (e) { notes.push("sign-in service refused: " + e.message); });
    }).then(loadCurrent).then(function () {
      var bad = notes.some(function (n) { return /no sign-in|refused|enter the/.test(n); });
      msg("connectMsg", notes.join(". ") + ".", bad ? "warn" : "ok");
      $("secConnect").className = "done";
      $("btnBuild").disabled = false;
    }).catch(function (e) {
      msg("connectMsg", e.message, "bad");
    }).then(function () { $("btnConnect").disabled = false; });
  }

  function loadCurrent() {
    A.cur = { bookings: null, details: null };
    return fileRaw(DATA_DIR + "manifest.json").then(function (t) {
      A.man = t ? JSON.parse(t) : null;
      if (!A.man || !A.man.free) {
        $("current").innerHTML = "Nothing published yet. Upload a timetable below.";
        return;
      }
      var m = A.man, c = m.counts || {};
      $("current").innerHTML = '<div class="stats">' + stat(num(c.bookings || 0), "classes") +
        stat(num(c.exclusiveRooms || 0), "rooms") + stat(num(c.withDetails || 0), "rooms with details") +
        stat(kb((m.sizes || {}).freeGzip || 0), "phone download") + "</div>Published " +
        esc(new Date(m.built).toLocaleString()) + (m.teacher ? ", with class details for teachers." : ", without class details.");
      return fileRaw(DATA_DIR + m.free).then(function (t2) {
        if (!t2) return;
        A.cur.details = FR.detailsFromPublic(JSON.parse(t2));
        if (!m.teacher || !A.key) return;
        return fileRaw(DATA_DIR + m.teacher, true).then(function (bytes) {
          if (!bytes) return;
          return FR.unseal(bytes, A.key).then(function (t3) {
            A.cur.bookings = FR.bookingsFromTeacher(t3);
          }, function () {
            $("current").innerHTML += " The class details were sealed with a different key, so upload the timetable again to republish.";
          });
        });
      });
    });
  }

  // ----------------------------------------------------------- timetable --

  function readFile(file, asBytes) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error("Couldn't read " + file.name)); };
      if (asBytes) r.readAsArrayBuffer(file); else r.readAsText(file);
    });
  }

  function onTimetable(file) {
    if (!file) return;
    $("ttOut").innerHTML = '<p class="msg">Reading ' + esc(file.name) + "…</p>";
    readFile(file).then(function (text) {
      var t = FR.readTimetable(text);
      if (t.missing.length) {
        A.up.bookings = null;
        $("ttOut").innerHTML = '<p class="msg bad">This file has no ' + t.missing.join(", ") +
          " column. Export the full UMS report and try again.</p>";
        return;
      }
      A.up.bookings = t.bookings;
      var b = t.bookings, set = function (k) { var o = {}; b.forEach(function (x) { o[x[k]] = 1; }); return Object.keys(o); };
      var rooms = set("room"), excl = rooms.filter(FR.isExclusive);
      var perDay = FR.DAYS.map(function (d) { return b.filter(function (x) { return x.day === d; }).length; });
      var html = '<div class="stats">' + stat(num(b.length), "classes read") + stat(num(t.unreadable.length), "rows unreadable") +
        stat(num(rooms.length), "rooms (" + num(excl.length) + " real)") + stat(num(set("section").length), "sections") +
        stat(num(set("teacher").length), "staff") + stat(num(set("course").length), "courses") + "</div>" +
        '<p class="lead">Per day: ' + FR.DAYS.map(function (d, i) { return d + " " + num(perDay[i]); }).join(", ") + "</p>";
      if (t.unreadable.length) {
        html += '<p class="msg warn">These rows were skipped because the time, day or room could not be read:</p><table><tr><th>CSV row</th><th>Time</th><th>Day</th><th>Room</th></tr>' +
          t.unreadable.slice(0, 12).map(function (u) {
            return "<tr><td>" + u.row + "</td><td>" + esc(u.raw) + "</td><td>" + esc(u.day) + "</td><td>" + esc(u.room) + "</td></tr>";
          }).join("") + "</table>" + (t.unreadable.length > 12 ? "<p>…and " + (t.unreadable.length - 12) + " more.</p>" : "");
      } else html += '<p class="msg ok">Every row was read.</p>';
      $("ttOut").innerHTML = html;
      $("secTT").className = "done";
      $("btnBuild").disabled = false;
      A.build = null; $("btnPublish").disabled = true;
    }).catch(function (e) { $("ttOut").innerHTML = '<p class="msg bad">' + esc(e.message) + "</p>"; });
  }

  // --------------------------------------------------------- room details --

  function loadSheetJS() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = SHEETJS;
      s.onload = function () { resolve(window.XLSX); };
      s.onerror = function () { reject(new Error("Couldn't load the Excel reader. Save the sheet as CSV and upload that instead.")); };
      document.head.appendChild(s);
    });
  }

  function onRooms(file) {
    if (!file) return;
    $("roomsOut").innerHTML = '<p class="msg">Reading ' + esc(file.name) + "…</p>";
    var excel = /\.xlsx?$/i.test(file.name);
    var got = excel ? Promise.all([readFile(file, true), loadSheetJS()]).then(function (r) {
      var wb = r[1].read(new Uint8Array(r[0]), { type: "array" });
      return wb.SheetNames.map(function (n) {
        return { name: n, rows: r[1].utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: "" }) };
      });
    }) : readFile(file).then(function (t) { return [{ name: file.name, rows: FR.parseCSV(t) }]; });
    got.then(function (sheets) {
      sheets = sheets.filter(function (s) { return s.rows.length > 1; });
      if (!sheets.length) throw new Error("The file has no rows under its header.");
      A.up.sheets = sheets;
      showRoomSheet(0);
    }).catch(function (e) { $("roomsOut").innerHTML = '<p class="msg bad">' + esc(e.message) + "</p>"; });
  }

  function showRoomSheet(si) {
    var sheet = A.up.sheets[si], head = sheet.rows[0].map(function (h) { return String(h).trim(); });
    var rc = FR.guessRoomColumn(head);
    var html = "";
    if (A.up.sheets.length > 1) {
      html += '<label>Sheet<select id="rSheet">' + A.up.sheets.map(function (s, i) {
        return "<option value=\"" + i + "\"" + (i === si ? " selected" : "") + ">" + esc(s.name) + "</option>";
      }).join("") + "</select></label>";
    }
    html += '<label>Room column<select id="rCol">' + head.map(function (h, i) {
      return "<option value=\"" + i + "\"" + (i === rc ? " selected" : "") + ">" + esc(h || "(column " + (i + 1) + ")") + "</option>";
    }).join("") + '</select></label><label>Show these details</label><div class="cols" id="rKeep"></div>' +
      '<div class="radio"><label><input type="radio" name="rMode" value="replace" checked> Replace all room details</label>' +
      '<label><input type="radio" name="rMode" value="merge"> Add to the published details</label></div><p class="msg" id="rMsg"></p>';
    $("roomsOut").innerHTML = html;
    function cols() {
      var r = +$("rCol").value;
      $("rKeep").innerHTML = head.map(function (h, i) {
        if (i === r || !h) return "";
        return '<label><input type="checkbox" value="' + i + '"' + (/^exclusive$/i.test(h) ? "" : " checked") + "> " + esc(h) + "</label>";
      }).join("");
      apply();
    }
    function apply() {
      var keep = Array.prototype.map.call($("rKeep").querySelectorAll("input:checked"), function (x) { return +x.value; });
      var d = FR.readDetails(sheet.rows, +$("rCol").value, keep);
      A.up.details = d;
      A.up.mode = document.querySelector("input[name=rMode]:checked").value;
      var names = Object.keys(d.rows), inTT = {};
      (A.up.bookings || A.cur.bookings || []).forEach(function (b) { inTT[b.room] = 1; });
      var known = Object.keys(inTT).length ? names.filter(function (n) { return inTT[n]; }).length : null;
      msg("rMsg", num(names.length) + " rooms with " + (d.fields.join(", ") || "no columns") +
        (known == null ? "." : ". " + num(known) + " of them appear in the timetable; the other " + num(names.length - known) +
          " will be listed as free all day."), names.length ? "ok" : "bad");
      $("secRooms").className = names.length ? "done" : "todo";
      A.build = null; $("btnPublish").disabled = true;
    }
    A.rCols = cols;
    A.rApply = apply;
    cols();
    $("btnBuild").disabled = false;
  }

  // ----------------------------------------------------- build and publish --

  function build() {
    var bookings = A.up.bookings || A.cur.bookings;
    if (!bookings) {
      $("buildOut").innerHTML = '<p class="msg bad">Upload a timetable first' +
        (A.man && A.man.teacher && !A.key ? " (the published one can only be reused when the sign-in service is connected)" : "") + ".</p>";
      return;
    }
    var details = A.up.details ? (A.up.mode === "merge" ? FR.mergeDetails(A.cur.details, A.up.details) : A.up.details) :
      (A.cur.details || { fields: [], rows: {} });
    $("buildOut").innerHTML = '<p class="msg">Building and checking…</p>';
    $("btnBuild").disabled = true;
    setTimeout(function () { try { run(); } catch (e) {
      $("buildOut").innerHTML = '<p class="msg bad">Build failed: ' + esc(e.message) + "</p>";
      $("btnBuild").disabled = false;
    } }, 30);
    function run() {
      var built = new Date().toISOString();
      var pub = FR.buildPublic(bookings, details, built);
      var chk = FR.selfCheck(bookings, pub);
      var pubText = JSON.stringify(pub);
      var tobj = FR.buildTeacher(bookings, pub);
      Promise.all([
        FR.gzip(FR.utf8(pubText)),
        A.key ? FR.seal(tobj, A.key) : Promise.resolve(null)
      ]).then(function (r) {
        A.build = { pub: pub, pubText: pubText, gz: r[0].length, sealed: r[1], chk: chk };
        var c = pub.counts;
        var html = '<div class="stats">' + stat(num(c.bookings), "classes") + stat(num(c.exclusiveRooms), "rooms") +
          stat(num(c.withDetails), "with details") + stat(pub.slots.length, "common slots") +
          stat(kb(r[0].length), "student download") + stat(r[1] ? kb(r[1].length) : "none", "teacher download") + "</div>";
        html += chk.ok ?
          '<p class="msg ok">Check passed: ' + num(chk.checks) + " room-and-slot answers match the timetable exactly" +
          (chk.wider ? " (" + num(chk.wider) + " shown busy only because a time was rounded to 5 minutes)" : "") + ".</p>" :
          '<p class="msg bad">Check failed: ' + chk.unsafe + " answers would show a busy room as free, " + chk.bookingsNotBusy +
          " classes not marked busy. Examples: " + esc(chk.examples.join(", ")) + ". Not publishing.</p>";
        if (!r[1]) html += '<p class="msg warn">Class details for teachers won\'t be published: connect the sign-in service first.</p>';
        $("buildOut").innerHTML = html;
        $("btnPublish").disabled = !chk.ok;
      }).catch(function (e) {
        $("buildOut").innerHTML = '<p class="msg bad">' + esc(e.message) + "</p>";
      }).then(function () { $("btnBuild").disabled = false; });
    }
  }

  function publish() {
    var b = A.build;
    if (!b || !b.chk.ok) return;
    $("btnPublish").disabled = true;
    msg("pubMsg", "Publishing…");
    var pubBytes = FR.utf8(b.pubText);
    Promise.all([FR.sha256hex(pubBytes), b.sealed ? FR.sha256hex(b.sealed) : Promise.resolve(null)]).then(function (h) {
      var freeName = "free." + h[0].slice(0, 12) + ".json";
      var teachName = b.sealed ? "teacher." + h[1].slice(0, 12) + ".bin" : null;
      var man = {
        v: 1, built: b.pub.built, free: freeName, teacher: teachName, auth: A.set.authUrl || null,
        counts: b.pub.counts, sizes: { free: pubBytes.length, freeGzip: b.gz, teacher: b.sealed ? b.sealed.length : 0 }
      };
      var files = {};
      files[DATA_DIR + freeName] = pubBytes;
      if (teachName) files[DATA_DIR + teachName] = b.sealed;
      files[DATA_DIR + "manifest.json"] = JSON.stringify(man, null, 1);
      return gh("contents/" + DATA_DIR.replace(/\/$/, "") + "?ref=" + encodeURIComponent(A.set.branch)).catch(function () { return []; })
        .then(function (list) {
          var stale = (Array.isArray(list) ? list : []).map(function (f) { return f.path; }).filter(function (p) {
            var n = p.slice(DATA_DIR.length);
            return /^(free|teacher)\.[0-9a-f]+\.(json|bin)$/.test(n) && n !== freeName && n !== teachName;
          });
          return commit(files, stale, "Publish timetable: " + b.pub.counts.bookings + " classes, " +
                        b.pub.counts.exclusiveRooms + " rooms");
        }).then(function (c) {
          A.man = man;
          msg("pubMsg", "Published. GitHub Pages goes live in about a minute; phones pick it up on their next check.", "ok");
          $("pubMsg").insertAdjacentHTML("beforeend", ' <a target="_blank" rel="noopener" href="https://github.com/' +
            esc(A.set.repo) + "/commit/" + c.sha + '">See the commit</a>');
          $("secBuild").className = "done";
          if (A.up.bookings) A.cur.bookings = A.up.bookings;
          A.cur.details = FR.detailsFromPublic(b.pub);
        });
    }).catch(function (e) {
      msg("pubMsg", e.message, "bad");
      $("btnPublish").disabled = false;
    });
  }

  // --------------------------------------------------------------- wiring --

  function dropZone(zone, input, fn) {
    input.addEventListener("change", function () { fn(input.files[0]); });
    zone.addEventListener("dragover", function (e) { e.preventDefault(); zone.classList.add("over"); });
    zone.addEventListener("dragleave", function () { zone.classList.remove("over"); });
    zone.addEventListener("drop", function (e) {
      e.preventDefault(); zone.classList.remove("over");
      if (e.dataTransfer.files[0]) fn(e.dataTransfer.files[0]);
    });
  }

  // one listener for whatever the room-details form currently shows
  $("roomsOut").addEventListener("change", function (e) {
    if (e.target.id === "rSheet") { showRoomSheet(+e.target.value); return; }
    if (e.target.id === "rCol") { A.rCols(); return; }
    if (e.target.name === "rMode" || e.target.type === "checkbox") A.rApply();
  });

  loadSettings();
  $("btnConnect").addEventListener("click", connect);
  $("btnBuild").addEventListener("click", build);
  $("btnPublish").addEventListener("click", publish);
  dropZone($("dropTT"), $("fileTT"), onTimetable);
  dropZone($("dropRooms"), $("fileRooms"), onRooms);
})();
