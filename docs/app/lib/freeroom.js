/* LPU Free Room - the free-room logic, kept apart from every screen.
 *
 * The admin page uses it to turn a UMS timetable report and a room-details
 * file into two small published files; the app uses it to read them back and
 * answer "which rooms are free". It runs unchanged in a browser (window.FR)
 * and in Node (require), so the tested code is the shipped code.
 *
 * parseTime is a line-for-line port of engine.parse_time_label from the
 * timetable-audit site, so both tools read every label the same way.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FR = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
  var DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
                   "Saturday", "Sunday"];
  var TIME_RE = /^\s*(\d{1,2})(?::(\d{2}))?\s*[-\u2013]\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\s*$/i;
  var EXCLUSIVE_RE = /^\d{1,3}[A-Z]?-\d[\w.\-]*$/;
  var SHARED_WORDS = ["GROUND", "FARM", "HOSPITAL", "OPD", "MYCLASS", "ACADEMIC",
                      "ASSIGNMENT", "SPORTS", "LIBRARY", "AUDITORIUM", "ONLINE"];

  // the two 50-minute ladders from engine.PATTERN_SLOTS
  function ladder(first) {
    var out = [];
    for (var i = 0; i < 11; i++) out.push([first + 50 * i, first + 50 * i + 50]);
    return out;
  }
  var LADDER = { A: ladder(510), B: ladder(520) };

  // --------------------------------------------------------------- parsing --

  function parseTime(label) {
    if (label == null) return null;
    var m = TIME_RE.exec(String(label));
    if (!m) return null;
    var h1 = +m[1], m1 = +(m[2] || 0), h2 = +m[3], m2 = +(m[4] || 0);
    var suf = (m[5] || "").toUpperCase(), start = null, end = null;
    if (suf) {
      // the single suffix labels the END of the band; the start is the
      // latest 12-hour reading that still falls before it
      var eh = h2 % 12;
      if (suf === "PM") eh += 12;
      var sh = h1 % 12;
      var ends = [eh * 60 + m2, eh * 60 + m2 + 720];
      var starts = [(sh + 12) * 60 + m1, sh * 60 + m1];
      outer:
      for (var i = 0; i < 2; i++) {
        for (var j = 0; j < 2; j++) {
          if (starts[j] < ends[i] && ends[i] - starts[j] <= 240) {
            start = starts[j]; end = ends[i];
            break outer;
          }
        }
      }
      if (start === null) return null;
    } else {
      if (h1 < 8) h1 += 12;          // 1:40-2:30 is afternoon shorthand
      start = h1 * 60 + m1;
      end = h2 * 60 + m2;
      if (end <= start) end += 720;
    }
    if (!(start >= 0 && start < end && end <= 1440)) return null;
    return [start, end];
  }

  function normDay(d) {
    var s = String(d == null ? "" : d).trim().toUpperCase().slice(0, 3);
    return DAYS.indexOf(s) >= 0 ? s : null;
  }

  function normRoom(r) {
    return String(r == null ? "" : r).trim().toUpperCase();
  }

  // a real room one class at a time, as opposed to a ground, lab farm or
  // online slot that many classes share
  function isExclusive(name) {
    var n = normRoom(name);
    for (var i = 0; i < SHARED_WORDS.length; i++) {
      if (n.indexOf(SHARED_WORDS[i]) >= 0) return false;
    }
    return EXCLUSIVE_RE.test(n);
  }

  function blockOf(name) {
    var m = /^(\d{1,3}[A-Z]?)-/.exec(normRoom(name));
    return m ? m[1] : null;
  }

  function floorOf(name) {
    var m = /^\d{1,3}[A-Z]?-(\d)/.exec(normRoom(name));
    return m ? +m[1] : null;
  }

  function roomKey(name) {
    var m = /^(\d{1,3})([A-Z]?)-(.*)$/.exec(name);
    return m ? [0, +m[1], m[2], m[3]] : [1, 0, "", name];
  }

  function roomCmp(a, b) {
    var x = roomKey(a), y = roomKey(b);
    for (var i = 0; i < 4; i++) {
      if (x[i] < y[i]) return -1;
      if (x[i] > y[i]) return 1;
    }
    return 0;
  }

  // RFC 4180 reader, lenient the same way Python's csv module is: a quote
  // only opens a quoted field at the start of the field
  function parseCSV(text) {
    text = String(text || "");
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var rows = [], row = [], f = "", q = false, i = 0, n = text.length, c;
    while (i < n) {
      c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { f += '"'; i += 2; continue; }
          q = false; i++; continue;
        }
        f += c; i++; continue;
      }
      if (c === '"' && f === "") { q = true; i++; continue; }
      if (c === ",") { row.push(f); f = ""; i++; continue; }
      if (c === "\r" || c === "\n") {
        row.push(f); rows.push(row); row = []; f = "";
        if (c === "\r" && text[i + 1] === "\n") i++;
        i++; continue;
      }
      f += c; i++;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  // UMS report -> bookings, each remembering its CSV row number
  function readTimetable(text) {
    var rows = parseCSV(text), head = rows[0] || [], idx = {};
    head.forEach(function (h, i) { idx[String(h).trim().toLowerCase()] = i; });
    var need = ["roomnumber", "attday", "attendancetime"];
    var missing = need.filter(function (k) { return !(k in idx); });
    var bookings = [], unreadable = [];
    function col(r, k) {
      var i = idx[k];
      return i != null && i < r.length ? String(r[i]).trim() : "";
    }
    if (missing.length) {
      return { bookings: bookings, unreadable: unreadable, missing: missing,
               header: head };
    }
    for (var n = 1; n < rows.length; n++) {
      var r = rows[n];
      if (!r.length || r.every(function (c) { return !String(c).trim(); })) continue;
      var label = col(r, "attendancetime"), t = parseTime(label);
      var day = normDay(col(r, "attday")), room = normRoom(col(r, "roomnumber"));
      if (!t || !day || !room) {
        unreadable.push({ row: n + 1, raw: label, day: col(r, "attday"), room: room });
        continue;
      }
      bookings.push({
        row: n + 1, room: room, day: day, start: t[0], end: t[1],
        type: col(r, "attendancetype").toUpperCase(),
        teacher: col(r, "teacherlogin"),
        section: col(r, "section").toUpperCase(),
        course: col(r, "coursecode").toUpperCase(),
        group: col(r, "studentgroup") || "0"
      });
    }
    return { bookings: bookings, unreadable: unreadable, missing: [], header: head };
  }

  function guessRoomColumn(head) {
    for (var i = 0; i < head.length; i++) {
      if (/room/i.test(String(head[i]))) return i;
    }
    return 0;
  }

  // a table (array of rows, header first) -> {fields, rows: {ROOM: {field: v}}}
  function readDetails(table, roomCol, keepCols) {
    var head = (table[0] || []).map(function (h) { return String(h == null ? "" : h).trim(); });
    var ri = roomCol == null ? guessRoomColumn(head) : roomCol;
    var cols = keepCols || head.map(function (h, i) { return i; }).filter(function (i) {
      return i !== ri && head[i] && !/^exclusive$/i.test(head[i]);
    });
    var fields = cols.map(function (i) { return head[i]; });
    var rows = {};
    for (var n = 1; n < table.length; n++) {
      var r = table[n] || [], name = normRoom(r[ri]);
      if (!name) continue;
      var d = rows[name] || {};
      cols.forEach(function (c, k) {
        var v = r[c];
        if (v == null) return;
        v = String(v).trim();
        if (v === "") return;
        d[fields[k]] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
      });
      rows[name] = d;
    }
    return { fields: fields, rows: rows };
  }

  function mergeDetails(base, add) {
    var fields = (base && base.fields || []).slice(), rows = {};
    (add.fields || []).forEach(function (f) { if (fields.indexOf(f) < 0) fields.push(f); });
    [base && base.rows || {}, add.rows || {}].forEach(function (src) {
      Object.keys(src).forEach(function (k) {
        rows[k] = Object.assign(rows[k] || {}, src[k]);
      });
    });
    return { fields: fields, rows: rows };
  }

  // ------------------------------------------------------------ encoding --

  // busy intervals travel as 5-minute ticks, two base-36 digits each; a
  // start is rounded down and an end up, so rounding can only ever widen a
  // booking, never make a busy room look free
  function enc2(n) { var s = n.toString(36); return s.length < 2 ? "0" + s : s; }

  function merge(iv) {
    iv.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var out = [];
    iv.forEach(function (x) {
      var last = out[out.length - 1];
      if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
      else out.push([x[0], x[1]]);
    });
    return out;
  }

  function encDay(iv) {
    return merge(iv).map(function (x) { return enc2(x[0]) + enc2(x[1]); }).join("");
  }

  function decDay(s) {
    var out = [];
    for (var i = 0; i + 3 < s.length; i += 4) {
      out.push([parseInt(s.substr(i, 2), 36) * 5, parseInt(s.substr(i + 2, 2), 36) * 5]);
    }
    return out;
  }

  function roomList(bookings, details) {
    var set = {};
    bookings.forEach(function (b) { set[b.room] = 1; });
    Object.keys(details.rows || {}).forEach(function (r) { set[r] = 1; });
    return Object.keys(set).sort(roomCmp);
  }

  // what every user downloads: rooms, their details and when each is busy
  function buildPublic(bookings, details, built) {
    details = details || { fields: [], rows: {} };
    var fields = (details.fields || []).slice();
    var names = roomList(bookings, details), idx = {};
    names.forEach(function (n, i) { idx[n] = i; });
    var per = names.map(function () { return [[], [], [], [], [], [], []]; });
    bookings.forEach(function (b) {
      per[idx[b.room]][DAYS.indexOf(b.day)].push(
        [Math.floor(b.start / 5), Math.ceil(b.end / 5)]);
    });
    var busy = per.map(function (days) { return days.map(encDay).join("|"); });
    var rooms = names.map(function (n) {
      var shared = isExclusive(n) ? 0 : 1, d = details.rows ? details.rows[n] : null;
      if (!d && !shared) return n;
      var e = [n, shared];
      if (d) fields.forEach(function (f) { e.push(d[f] == null ? "" : d[f]); });
      return e;
    });
    // the windows classes actually use, for one-tap slot picking
    var cnt = {}, excl = 0;
    bookings.forEach(function (b) {
      if (!isExclusive(b.room)) return;
      excl++;
      var k = b.start + "-" + b.end;
      cnt[k] = (cnt[k] || 0) + 1;
    });
    var floor = Math.max(20, Math.round(excl * 0.003));
    var slots = Object.keys(cnt).filter(function (k) { return cnt[k] >= floor; })
      .sort(function (a, b) { return cnt[b] - cnt[a]; }).slice(0, 30)
      .map(function (k) { return k.split("-").map(Number); })
      .sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var withDetails = names.filter(function (n) { return details.rows && details.rows[n]; }).length;
    return {
      v: 1, built: built || new Date().toISOString(), days: DAYS, fields: fields,
      rooms: rooms, busy: busy, slots: slots,
      counts: {
        bookings: bookings.length, rooms: names.length,
        exclusiveRooms: names.filter(isExclusive).length, withDetails: withDetails
      }
    };
  }

  // what only verified teachers can open: every booking, column by column
  function buildTeacher(bookings, pub) {
    var names = (pub.rooms || []).map(function (r) { return typeof r === "string" ? r : r[0]; });
    var ridx = {};
    names.forEach(function (n, i) { ridx[n] = i; });
    function dict() {
      var list = [], at = {};
      return { list: list, get: function (v) {
        if (!(v in at)) { at[v] = list.length; list.push(v); }
        return at[v];
      } };
    }
    var C = dict(), S = dict(), T = dict(), Y = dict(), G = dict();
    var sorted = bookings.slice().sort(function (a, b) {
      return ridx[a.room] - ridx[b.room] || DAYS.indexOf(a.day) - DAYS.indexOf(b.day) ||
             a.start - b.start || a.end - b.end;
    });
    var cols = [[], [], [], [], [], [], [], [], []];
    sorted.forEach(function (b) {
      cols[0].push(ridx[b.room]); cols[1].push(DAYS.indexOf(b.day));
      cols[2].push(b.start); cols[3].push(b.end);
      cols[4].push(C.get(b.course)); cols[5].push(S.get(b.section));
      cols[6].push(T.get(b.teacher)); cols[7].push(Y.get(b.type));
      cols[8].push(G.get(b.group));
    });
    return { v: 1, built: pub.built, rooms: names, courses: C.list, sections: S.list,
             teachers: T.list, types: Y.list, groups: G.list, b: cols };
  }

  function bookingsFromTeacher(t) {
    var B = t.b, out = [];
    for (var i = 0; i < B[0].length; i++) {
      out.push({ room: t.rooms[B[0][i]], day: DAYS[B[1][i]], start: B[2][i], end: B[3][i],
                 course: t.courses[B[4][i]], section: t.sections[B[5][i]],
                 teacher: t.teachers[B[6][i]], type: t.types[B[7][i]],
                 group: t.groups[B[8][i]] });
    }
    return out;
  }

  function detailsFromPublic(p) {
    var fields = p.fields || [], rows = {};
    (p.rooms || []).forEach(function (r) {
      if (typeof r === "string" || r.length <= 2) return;
      var d = {};
      fields.forEach(function (f, k) { if (r[k + 2] !== "" && r[k + 2] != null) d[f] = r[k + 2]; });
      if (Object.keys(d).length) rows[r[0]] = d;
    });
    return { fields: fields.slice(), rows: rows };
  }

  // -------------------------------------------------------------- reading --

  function findField(fields, re) {
    for (var i = 0; i < fields.length; i++) if (re.test(fields[i])) return fields[i];
    return null;
  }

  function nowInfo(date) {
    var d = date || new Date();
    return { di: (d.getDay() + 6) % 7, t: d.getHours() * 60 + d.getMinutes() };
  }

  function openPublic(p) {
    var fields = p.fields || [];
    var F = { type: findField(fields, /type/i), cap: findField(fields, /cap/i),
              block: findField(fields, /^block$/i), floor: findField(fields, /^floor$/i) };
    var byName = {};
    var rooms = p.rooms.map(function (r, i) {
      var arr = typeof r !== "string", name = arr ? r[0] : r;
      var det = null;
      if (arr && r.length > 2) {
        det = {};
        fields.forEach(function (f, k) {
          var v = r[k + 2];
          if (v !== "" && v != null) det[f] = v;
        });
        if (!Object.keys(det).length) det = null;
      }
      var block = blockOf(name), floor = floorOf(name);
      if (det && F.block && det[F.block] != null) block = String(det[F.block]).toUpperCase();
      if (det && F.floor && det[F.floor] != null) {
        var fl = parseInt(det[F.floor], 10);
        if (!isNaN(fl)) floor = fl;
      }
      var room = {
        i: i, name: name, shared: arr ? !!r[1] : false, details: det,
        block: block, floor: floor,
        type: det && F.type && det[F.type] != null ? String(det[F.type]) : null,
        cap: det && F.cap && det[F.cap] != null ? (Number(det[F.cap]) || null) : null
      };
      byName[name] = room;
      return room;
    });
    var busy = p.busy.map(function (s) { return s.split("|").map(decDay); });

    function busyOn(ri, di) { return (busy[ri] && busy[ri][di]) || []; }

    function isFree(ri, di, s, e) {
      var b = busyOn(ri, di);
      for (var k = 0; k < b.length; k++) if (b[k][0] < e && s < b[k][1]) return false;
      return true;
    }

    function matches(r, f) {
      if (r.shared && !f.shared) return false;
      if (f.block && r.block !== String(f.block).toUpperCase()) return false;
      if (f.floor != null && f.floor !== "" && r.floor !== +f.floor) return false;
      if (f.type && String(r.type || "").toUpperCase().indexOf(String(f.type).toUpperCase()) < 0) return false;
      if (f.minCap && !(r.cap >= +f.minCap)) return false;
      if (f.q && r.name.indexOf(String(f.q).toUpperCase().trim()) < 0) return false;
      return true;
    }

    function free(di, s, e, f) {
      f = f || {};
      return rooms.filter(function (r) { return matches(r, f) && isFree(r.i, di, s, e); });
    }

    // free stretches of one room between from and to
    function freeWindows(ri, di, from, to) {
      from = from == null ? 480 : from; to = to == null ? 1200 : to;
      var out = [], t = from;
      busyOn(ri, di).forEach(function (b) {
        if (b[1] <= from || b[0] >= to) return;
        if (b[0] > t) out.push([t, Math.min(b[0], to)]);
        t = Math.max(t, b[1]);
      });
      if (t < to) out.push([t, to]);
      return out;
    }

    function uniq(list) {
      var seen = {}, out = [];
      list.forEach(function (v) { if (v != null && !seen[v]) { seen[v] = 1; out.push(v); } });
      return out;
    }

    var blocks = uniq(rooms.filter(function (r) { return !r.shared; }).map(function (r) { return r.block; }))
      .sort(function (a, b) { return (parseInt(a, 10) - parseInt(b, 10)) || (a < b ? -1 : a > b ? 1 : 0); });
    var types = uniq(rooms.map(function (r) { return r.type; })).sort();

    return {
      built: p.built, fields: fields, rooms: rooms, byName: byName, slots: p.slots || [],
      counts: p.counts || {}, blocks: blocks, types: types, days: DAYS,
      busyOn: busyOn, isFree: isFree, free: free, freeWindows: freeWindows, matches: matches,
      floorsOf: function (block) {
        return uniq(rooms.filter(function (r) {
          return !r.shared && (!block || r.block === block);
        }).map(function (r) { return r.floor; })).sort(function (a, b) { return a - b; });
      },
      activeDays: function () {
        var on = [0, 0, 0, 0, 0, 0, 0];
        busy.forEach(function (d) { d.forEach(function (iv, i) { if (iv.length) on[i] = 1; }); });
        return on;
      }
    };
  }

  function openTeacher(t) {
    var list = bookingsFromTeacher(t);
    list.forEach(function (b, i) { b.id = i; b.di = DAYS.indexOf(b.day); });
    var cache = {};
    function index(field) {
      if (cache[field]) return cache[field];
      var m = {};
      list.forEach(function (b) { (m[b[field]] = m[b[field]] || []).push(b); });
      cache[field] = m;
      return m;
    }
    return {
      built: t.built, list: list, rooms: t.rooms, sections: t.sections,
      teachers: t.teachers, courses: t.courses,
      of: function (field, key) { return (index(field)[key] || []).slice(); },
      at: function (room, di, s, e) {
        return (index("room")[room] || []).filter(function (b) {
          return b.di === di && b.start < e && s < b.end;
        });
      }
    };
  }

  // ------------------------------------------------------ bytes and crypto --

  function utf8(s) { return new TextEncoder().encode(s); }
  function unutf8(b) { return new TextDecoder().decode(b); }

  function toB64(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function fromB64(b64) {
    var s = atob(b64), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function pipe(bytes, stream) {
    return new Response(new Blob([bytes]).stream().pipeThrough(stream))
      .arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  function gzip(bytes) { return pipe(bytes, new CompressionStream("gzip")); }
  function gunzip(bytes) { return pipe(bytes, new DecompressionStream("gzip")); }

  function sha256hex(bytes) {
    return crypto.subtle.digest("SHA-256", bytes).then(function (h) {
      return Array.prototype.map.call(new Uint8Array(h), function (x) {
        return (x < 16 ? "0" : "") + x.toString(16);
      }).join("");
    });
  }

  var MAGIC = [70, 82, 49];          // "FR1"

  function aesKey(b64) {
    return crypto.subtle.importKey("raw", fromB64(b64), "AES-GCM", false,
                                   ["encrypt", "decrypt"]);
  }

  // object -> gzip -> AES-GCM; compressed first, since ciphertext never shrinks
  function seal(obj, keyB64) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return gzip(utf8(JSON.stringify(obj))).then(function (z) {
      return aesKey(keyB64).then(function (k) {
        return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, k, z);
      });
    }).then(function (ct) {
      var c = new Uint8Array(ct), out = new Uint8Array(3 + 12 + c.length);
      out.set(MAGIC, 0); out.set(iv, 3); out.set(c, 15);
      return out;
    });
  }

  function unseal(bytes, keyB64) {
    if (!(bytes[0] === 70 && bytes[1] === 82 && bytes[2] === 49)) {
      return Promise.reject(new Error("not a teacher data file"));
    }
    return aesKey(keyB64).then(function (k) {
      return crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(3, 15) }, k,
                                   bytes.subarray(15));
    }).then(function (z) { return gunzip(new Uint8Array(z)); })
      .then(function (raw) { return JSON.parse(unutf8(raw)); });
  }

  // ------------------------------------------------------------ self check --

  // Recomputes every free-room answer straight from the bookings and
  // compares it with what the published file will say. "unsafe" counts a
  // room the file calls free while a class is actually in it - must be 0.
  function selfCheck(bookings, p) {
    var m = openPublic(p), windows = LADDER.A.concat(LADDER.B, p.slots || []);
    var checks = 0, unsafe = 0, wider = 0, examples = [];
    for (var di = 0; di < 7; di++) {
      var dayB = bookings.filter(function (b) { return b.day === DAYS[di]; });
      windows.forEach(function (w) {
        var busy = {};
        dayB.forEach(function (b) { if (b.start < w[1] && w[0] < b.end) busy[b.room] = 1; });
        var file = {};
        m.free(di, w[0], w[1]).forEach(function (r) { file[r.name] = 1; });
        m.rooms.forEach(function (r) {
          if (r.shared) return;
          checks++;
          var actuallyFree = !busy[r.name];
          if (file[r.name] && !actuallyFree) {
            unsafe++;
            if (examples.length < 5) examples.push(r.name + " " + DAYS[di] + " " + hhmm(w[0]));
          } else if (!file[r.name] && actuallyFree) wider++;
        });
      });
    }
    var notBusy = 0;
    bookings.forEach(function (b) {
      var r = m.byName[b.room];
      if (!r || m.isFree(r.i, DAYS.indexOf(b.day), b.start, b.end)) notBusy++;
    });
    return { checks: checks, unsafe: unsafe, wider: wider, bookingsNotBusy: notBusy,
             examples: examples, ok: unsafe === 0 && notBusy === 0 };
  }

  // ------------------------------------------------------------ formatting --

  function hhmm(t) {
    var h = Math.floor(t / 60), m = t % 60;
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }

  function clock(t) {
    var h = Math.floor(t / 60) % 24, m = t % 60, ap = h < 12 ? "AM" : "PM";
    var h12 = h % 12 || 12;
    return h12 + ":" + (m < 10 ? "0" : "") + m + " " + ap;
  }

  function span(s, e) {
    var a = clock(s), b = clock(e);
    if (a.slice(-2) === b.slice(-2)) a = a.slice(0, -3);
    return a + "\u2013" + b;
  }

  return {
    DAYS: DAYS, DAY_NAMES: DAY_NAMES, LADDER: LADDER,
    parseTime: parseTime, normDay: normDay, normRoom: normRoom,
    isExclusive: isExclusive, blockOf: blockOf, floorOf: floorOf, roomCmp: roomCmp,
    parseCSV: parseCSV, readTimetable: readTimetable, readDetails: readDetails,
    guessRoomColumn: guessRoomColumn, mergeDetails: mergeDetails,
    buildPublic: buildPublic, buildTeacher: buildTeacher,
    bookingsFromTeacher: bookingsFromTeacher, detailsFromPublic: detailsFromPublic,
    openPublic: openPublic, openTeacher: openTeacher, nowInfo: nowInfo,
    encDay: encDay, decDay: decDay,
    utf8: utf8, toB64: toB64, fromB64: fromB64, gzip: gzip, gunzip: gunzip,
    sha256hex: sha256hex, seal: seal, unseal: unseal, selfCheck: selfCheck,
    hhmm: hhmm, clock: clock, span: span
  };
});
