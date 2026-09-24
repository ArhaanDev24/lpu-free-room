/* LPU Free Room - understands a spoken or typed question and answers it.
 *
 *   "free rooms in block 34 fifth floor at 2 pm"
 *   "which block has the most free rooms now"
 *   "which floor in block 33 tomorrow at 10"
 *   "is 34-504 free"            "when is 34 504 free on friday"
 *   "a lab for 60 students after lunch"
 *   (teachers) "timetable of K24CG"   "timetable of room 34-504"
 *
 * Rule based and offline: rooms, blocks and sections are only accepted when
 * they exist in the published data, so "10 30" is read as a time, never as
 * a room. Depends on FR (freeroom.js).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./freeroom.js"));
  else root.NLU = factory(root.FR);
})(typeof self !== "undefined" ? self : this, function (FR) {
  "use strict";

  var WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
                eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  var ORD = { ground: 0, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
              seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
  var WEEK = { mon: 0, monday: 0, tue: 1, tues: 1, tuesday: 1, wed: 2, wednesday: 2,
               thu: 3, thur: 3, thurs: 3, thursday: 3, fri: 4, friday: 4, sat: 5,
               saturday: 5, sun: 6, sunday: 6 };
  var ORDWORD = ["ground", "first", "second", "third", "fourth", "fifth", "sixth",
                 "seventh", "eighth", "ninth", "tenth"];

  function norm(s) {
    return (" " + String(s || "").toLowerCase() + " ")
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/\b([ap])\.\s?m\.?/g, " $1m ")
      .replace(/o'?\s?clock/g, " ")
      .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g,
               function (w) { return String(WORDS[w]); })
      .replace(/half an hour/g, "30 minutes")
      .replace(/[?!,;"]/g, " ")
      .replace(/\s+/g, " ");
  }

  function toMin(h, m, ap) {
    h = +h; m = +(m || 0);
    if (ap === "pm" && h < 12) h += 12;
    else if (ap === "am" && h === 12) h = 0;
    else if (!ap && h >= 1 && h <= 7) h += 12;     // "at 2" means 2 PM on campus
    return h * 60 + m;
  }

  function cut(state, re, fn) {
    var m = re.exec(state.t);
    if (!m) return false;
    var r = fn(m);
    if (r !== false) state.t = state.t.replace(m[0], " ");
    return r !== false;
  }

  function parse(text, ctx) {
    var model = ctx.model, tmodel = ctx.tmodel, now = FR.nowInfo(ctx.now);
    var st = { t: norm(text) }, q = { raw: text, rooms: [] }, m;

    // rooms first, and only ones that exist: "34-504", "34 504", "34504"
    var roomRe = /\b(\d{1,3}[a-z]?)\s?-?\s?(\d{3}[a-z]?)\b/g, found = [];
    while ((m = roomRe.exec(st.t))) {
      var name = (m[1] + "-" + m[2]).toUpperCase();
      if (model.byName[name]) found.push([m[0], name]);
    }
    var joined = /\b(\d{4,6}[a-z]?)\b/g;
    while ((m = joined.exec(st.t))) {
      for (var k = 1; k <= 3; k++) {
        var cand = (m[1].slice(0, k) + "-" + m[1].slice(k)).toUpperCase();
        if (model.byName[cand]) { found.push([m[0], cand]); break; }
      }
    }
    found.forEach(function (f) {
      if (q.rooms.indexOf(f[1]) < 0) q.rooms.push(f[1]);
      st.t = st.t.replace(f[0], " ");
    });

    // sections (teachers only), e.g. K24CG
    if (tmodel) {
      var secRe = /\b([a-z]\d[a-z0-9]{2,9})\b/g;
      while ((m = secRe.exec(st.t))) {
        var sec = m[1].toUpperCase();
        if (tmodel.sections.indexOf(sec) >= 0) { q.section = sec; st.t = st.t.replace(m[0], " "); break; }
      }
      cut(st, /\b(?:staff|teacher|faculty)\s*(?:id|code|login)?\s*(\d{4,6})\b/, function (x) {
        if (tmodel.teachers.indexOf(x[1]) < 0) return false;
        q.teacher = x[1];
      });
    }

    cut(st, /\bblock\s*(?:no\.?|number)?\s*(\d{1,3}[a-z]?)\b/, function (x) {
      var b = x[1].toUpperCase();
      if (model.blocks.indexOf(b) < 0) { q.unknownBlock = b; return; }
      q.block = b;
    }) || cut(st, /\b(\d{1,3}[a-z]?)\s*(?:no\.?\s*)?block\b/, function (x) {
      var b = x[1].toUpperCase();
      if (model.blocks.indexOf(b) < 0) { q.unknownBlock = b; return; }
      q.block = b;
    });

    cut(st, /\b(ground|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d{1,2})(?:st|nd|rd|th)?\s+floor\b/,
        function (x) { q.floor = x[1] in ORD ? ORD[x[1]] : +x[1]; }) ||
      cut(st, /\bfloor\s*(?:no\.?|number)?\s*(ground|\d{1,2})\b/,
          function (x) { q.floor = x[1] === "ground" ? 0 : +x[1]; });

    cut(st, /\b(\d{2,3})\s*\+?\s*(?:students?|people|persons?|seats?|seater|members?|capacity)\b/,
        function (x) { q.minCap = +x[1]; }) ||
      cut(st, /\b(?:capacity|seating|strength)\s*(?:of|for|above|over|more than|at least)?\s*(\d{2,3})\b/,
          function (x) { q.minCap = +x[1]; }) ||
      cut(st, /\bat\s*least\s*(\d{2,3})\b/, function (x) { q.minCap = +x[1]; });

    // day
    if (cut(st, /\bday after tomorrow\b/, function () { q.day = (now.di + 2) % 7; })) {}
    else if (cut(st, /\btomorrow\b/, function () { q.day = (now.di + 1) % 7; })) {}
    else if (cut(st, /\btoday\b/, function () { q.day = now.di; })) {}
    else cut(st, /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)\b/,
             function (x) { q.day = WEEK[x[1]]; });

    // how long
    var dur = null;
    cut(st, /\bfor\s+(?:an?|1)\s*(?:hour|hr)\b/, function () { dur = 60; }) ||
      cut(st, /\bfor\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/, function (x) { dur = Math.round(+x[1] * 60); }) ||
      cut(st, /\bfor\s+(\d{2,3})\s*(?:minutes?|mins?)\b/, function (x) { dur = +x[1]; });

    // when
    var s = null, e = null;
    if (cut(st, /\b(right now|now|currently|at the moment|at present|abhi)\b/, function () { s = now.t; q.now = true; })) {}
    else if (cut(st, /\bnext\s+(?:slot|class|hour|period|lecture)\b/, function () {
      var next = FR.LADDER.A.filter(function (w) { return w[0] > now.t; })[0];
      s = next ? next[0] : now.t + 60;
    })) {}
    else if (cut(st, /\b(?:from|between)?\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:to|till|until|-|and)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/,
                 function (x) {
                   if (+x[1] > 23 || +x[4] > 23) return false;
                   if (!x[3] && x[6]) {
                     var r = FR.parseTime(x[1] + ":" + (x[2] || "00") + "-" + x[4] + ":" + (x[5] || "00") + " " + x[6].toUpperCase());
                     if (!r) return false;
                     s = r[0]; e = r[1]; return;
                   }
                   s = toMin(x[1], x[2], x[3]); e = toMin(x[4], x[5], x[6] || x[3]);
                   if (e <= s && e + 720 <= 1440) e += 720;
                 })) {}
    else if (cut(st, /\b(?:at|around|by|after|from|@)?\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/,
                 function (x) { s = toMin(x[1], x[2], x[3]); })) {}
    else if (cut(st, /\b(?:at|around|by|after|from)\s+(\d{1,2})(?:[:.](\d{2}))?\b/, function (x) {
      if (+x[1] > 23) return false;
      s = toMin(x[1], x[2], "");
    })) {}
    else if (cut(st, /\b(\d{1,2})[:.](\d{2})\b/, function (x) { s = toMin(x[1], x[2], ""); })) {}
    else if (cut(st, /\bafter lunch\b/, function () { s = 810; })) {}
    else if (cut(st, /\b(?:lunch|lunch time)\b/, function () { s = 720; e = 810; })) {}
    else if (cut(st, /\bmorning\b/, function () { s = 510; e = 720; })) {}
    else if (cut(st, /\bafternoon\b/, function () { s = 720; e = 1020; })) {}
    else cut(st, /\bevening\b/, function () { s = 1020; e = 1140; });

    if (q.day == null) q.day = now.di;
    if (s == null) {
      s = q.day === now.di || (now.t >= 480 && now.t <= 1150) ? now.t : 540;
      q.timeAssumed = true;
      if (q.day === now.di) q.now = true;
    }
    if (e == null) e = s + (dur || 50);
    q.start = Math.max(0, s); q.end = Math.min(1440, e);

    // room type: "lab", "byod", or any Type value in the data
    var t = st.t;
    if (/\blabs?\b|\blaborator(?:y|ies)\b/.test(t)) q.type = "LAB";
    model.types.slice().sort(function (a, b) { return b.length - a.length; }).some(function (v) {
      var lv = String(v).toLowerCase();
      if (lv.length > 2 && t.indexOf(" " + lv) >= 0) { q.type = v; return true; }
      return false;
    });

    // what is being asked
    var any = function (re) { return re.test(t); };
    if (q.rooms.length && ctx.teacher && any(/\b(timetable|time table|schedule)\b/)) q.intent = "open_room";
    else if (q.rooms.length && any(/\bwhen\b|free (?:slots?|times?|windows?|periods?)|\btimings?\b|\bschedule\b|\bwhole day\b|\ball day\b/)) q.intent = "room_windows";
    else if (q.rooms.length) q.intent = "room_status";
    else if (ctx.teacher && q.section) q.intent = "open_section";
    else if (ctx.teacher && q.teacher) q.intent = "open_teacher";
    else if (any(/\b(?:which|what)\s+(?:block|building)|\bblock\s*wise\b|\bbest block\b/)) q.intent = "which_block";
    else if (any(/\b(?:which|what)\s+floor|\bfloor\s*wise\b/)) q.intent = "which_floor";
    else if (any(/\bhow many\b|\bcount\b|\bnumber of\b/)) q.intent = "count";
    else q.intent = "free_list";
    return q;
  }

  // ---------------------------------------------------------------- answer --

  function dayWord(q, ctx) {
    var now = FR.nowInfo(ctx.now);
    if (q.day === now.di) return "today";
    if (q.day === (now.di + 1) % 7) return "tomorrow";
    return "on " + FR.DAY_NAMES[q.day];
  }

  // "labs for 60+ in block 34, floor 5"
  function kind(q, n) {
    var k = q.type ? String(q.type).toLowerCase() + (/lab/i.test(q.type) ? "" : " room") : "room";
    if (n !== 1) k += "s";
    return k + (q.minCap ? " for " + q.minCap + "+" : "");
  }

  function loc(q) {
    var p = [];
    if (q.block) p.push("block " + q.block);
    if (q.floor != null) p.push(q.floor === 0 ? "ground floor" : "floor " + q.floor);
    return p.length ? " in " + p.join(", ") : "";
  }

  function sayRoom(n) { return String(n).replace("-", " "); }

  function sayList(names, max) {
    var list = names.slice(0, max).map(sayRoom);
    if (list.length <= 1) return list.join("");
    return list.slice(0, -1).join(", ") + " and " + list[list.length - 1];
  }

  function when(q, ctx) {
    return (q.now ? "right now (" + FR.span(q.start, q.end) + ")" :
      dayWord(q, ctx) + ", " + FR.span(q.start, q.end));
  }

  function tally(rooms, key) {
    var c = {};
    rooms.forEach(function (r) { var k = r[key]; if (k != null) c[k] = (c[k] || 0) + 1; });
    return Object.keys(c).map(function (k) { return [k, c[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; });
  }

  function answer(q, ctx) {
    var model = ctx.model, tmodel = ctx.tmodel;
    var f = { block: q.block, floor: q.floor, type: q.type, minCap: q.minCap };
    var out = { q: q, rooms: [], filters: { di: q.day, s: q.start, e: q.end, block: q.block || "",
                floor: q.floor == null ? "" : q.floor, type: q.type || "", minCap: q.minCap || "" } };
    var capNote = q.minCap && !model.rooms.some(function (r) { return r.cap; }) ?
      " No room has seating details yet, so the seating filter matched nothing." : "";

    if (q.unknownBlock && !q.block) {
      out.text = "There is no block " + q.unknownBlock + " in the timetable.";
      out.speak = out.text;
      return out;
    }

    if (q.intent === "open_room" || q.intent === "open_section" || q.intent === "open_teacher") {
      var what = q.intent === "open_room" ? ["room", q.rooms[0]] :
                 q.intent === "open_section" ? ["section", q.section] : ["teacher", q.teacher];
      out.open = { field: what[0], key: what[1], di: q.day };
      out.text = "Opening the timetable of " + (what[0] === "teacher" ? "staff " : what[0] + " ") + what[1] + ".";
      out.speak = out.text;
      return out;
    }

    if (q.intent === "room_status" || q.intent === "room_windows") {
      var r = model.byName[q.rooms[0]];
      out.rooms = [r];
      var shared = r.shared ? " It is a shared venue, so several classes can use it at once." : "";
      if (q.intent === "room_windows") {
        var w = model.freeWindows(r.i, q.day, 480, 1200);
        if (!w.length) out.text = r.name + " is booked all day " + dayWord(q, ctx) + " between 8 AM and 8 PM.";
        else out.text = r.name + " is free " + dayWord(q, ctx) + " " +
          w.map(function (x) { return x[1] >= 1200 ? "after " + FR.clock(x[0]) : FR.span(x[0], x[1]); })
            .join(", ").replace(/, ([^,]*)$/, " and $1") + ".";
        out.text += shared;
        out.speak = out.text.replace(/\u2013/g, " to ").replace(r.name, sayRoom(r.name));
        return out;
      }
      if (model.isFree(r.i, q.day, q.start, q.end)) {
        var win = model.freeWindows(r.i, q.day, 0, 1440).filter(function (x) {
          return x[0] <= q.start && x[1] >= q.end;
        })[0];
        out.text = r.name + " is free " + when(q, ctx) + "." +
          (win && win[1] < 1440 ? " It stays free until " + FR.clock(win[1]) + "." : " It stays free for the rest of the day.");
      } else {
        var hit = model.busyOn(r.i, q.day).filter(function (b) { return b[0] < q.end && q.start < b[1]; });
        var until = hit.length ? hit[hit.length - 1][1] : q.end;
        var next = model.freeWindows(r.i, q.day, until, 1440)[0];
        var who = "";
        if (tmodel) {
          var bs = tmodel.at(r.name, q.day, q.start, q.end);
          if (bs.length) who = " (" + bs.map(function (b) { return b.course + " for " + b.section; }).join(", ") + ")";
        }
        // say what is booked, so a partly busy slot doesn't read as a contradiction
        out.text = r.name + " is booked " + hit.map(function (b) { return FR.span(b[0], b[1]); }).join(" and ") + " " +
          dayWord(q, ctx) + who + ", so it is not free " + (q.now ? "right now" : FR.span(q.start, q.end)) + "." +
          (next ? " It is free from " + FR.clock(next[0]) +
            (next[1] >= 1440 ? " for the rest of the day." : " until " + FR.clock(next[1]) + ".") : "");
      }
      out.text += shared;
      out.speak = out.text.replace(/\u2013/g, " to ").replace(r.name, sayRoom(r.name));
      return out;
    }

    var free = model.free(q.day, q.start, q.end, f);
    out.rooms = free;

    if (q.intent === "which_block") {
      var tb = tally(model.free(q.day, q.start, q.end, { floor: q.floor, type: q.type, minCap: q.minCap }), "block");
      if (!tb.length) { out.text = "No rooms are free " + when(q, ctx) + "." + capNote; out.speak = out.text; return out; }
      out.text = "Block " + tb[0][0] + " has the most free rooms " + when(q, ctx) + ": " + tb[0][1] + "." +
        (tb.length > 1 ? " Next: " + tb.slice(1, 4).map(function (x) { return "block " + x[0] + " with " + x[1]; })
          .join(", ") + "." : "");
      out.filters.block = tb[0][0];
      out.rooms = model.free(q.day, q.start, q.end, { block: tb[0][0], floor: q.floor, type: q.type, minCap: q.minCap });
      out.speak = out.text.replace(/\u2013/g, " to ");
      return out;
    }

    if (q.intent === "which_floor") {
      if (q.block) {
        var tf = tally(model.free(q.day, q.start, q.end, { block: q.block, type: q.type, minCap: q.minCap }), "floor");
        if (!tf.length) out.text = "Nothing is free in block " + q.block + " " + when(q, ctx) + ".";
        else out.text = "In block " + q.block + ", " + tf.slice(0, 4).map(function (x) {
          return (+x[0] === 0 ? "the ground floor" : "floor " + x[0]) + " has " + x[1];
        }).join(", ").replace(/, ([^,]*)$/, " and $1") + " free " + (tf.length === 1 && tf[0][1] === 1 ? "room " : "rooms ") + when(q, ctx) + ".";
        if (tf.length) out.filters.floor = +tf[0][0];
      } else {
        var combos = {};
        model.free(q.day, q.start, q.end, { type: q.type, minCap: q.minCap }).forEach(function (r) {
          if (r.block == null || r.floor == null) return;
          var k = r.block + "|" + r.floor;
          combos[k] = (combos[k] || 0) + 1;
        });
        var top = Object.keys(combos).sort(function (a, b) { return combos[b] - combos[a]; }).slice(0, 3);
        out.text = top.length ? "Most free rooms " + when(q, ctx) + ": " + top.map(function (k) {
          var p = k.split("|");
          return "block " + p[0] + " " + (+p[1] === 0 ? "ground floor" : "floor " + p[1]) + " (" + combos[k] + ")";
        }).join(", ") + "." : "No rooms are free " + when(q, ctx) + ".";
        if (top.length) { var p0 = top[0].split("|"); out.filters.block = p0[0]; out.filters.floor = +p0[1]; }
      }
      out.rooms = model.free(q.day, q.start, q.end, { block: out.filters.block, floor: out.filters.floor,
                                                      type: q.type, minCap: q.minCap });
      out.speak = out.text.replace(/\u2013/g, " to ");
      return out;
    }

    if (!free.length) {
      out.text = "No free " + kind(q, 2) + loc(q) + " " + when(q, ctx) + "." + capNote;
      // widen the search one step so the answer still points somewhere
      var alt = null;
      if (q.floor != null && q.block) {
        var af = tally(model.free(q.day, q.start, q.end, { block: q.block, type: q.type, minCap: q.minCap }), "floor");
        if (af.length) alt = "Block " + q.block + " has free " + kind(q, 2) + " on " + af.slice(0, 3).map(function (x) {
          return +x[0] === 0 ? "the ground floor" : "floor " + x[0];
        }).join(", ") + ".";
      }
      if (!alt && q.block) {
        var ab = tally(model.free(q.day, q.start, q.end, { floor: q.floor, type: q.type, minCap: q.minCap }), "block");
        if (ab.length) alt = "Try block " + ab.slice(0, 3).map(function (x) { return x[0] + " (" + x[1] + ")"; })
          .join(", ") + ".";
      }
      if (alt) out.text += " " + alt;
      out.speak = out.text.replace(/\u2013/g, " to ");
      return out;
    }
    var n = free.length, names = free.map(function (r) { return r.name; });
    if (q.intent === "count") {
      var byB = tally(free, "block").slice(0, 3);
      out.text = n + " free " + kind(q, n) + loc(q) + " " + when(q, ctx) + "." +
        (!q.block && byB.length ? " Most are in block " + byB.map(function (x) {
          return x[0] + " (" + x[1] + ")"; }).join(", ") + "." : "");
    } else {
      out.text = n + " free " + kind(q, n) + loc(q) + " " + when(q, ctx) + ": " +
        names.slice(0, 12).join(", ") + (n > 12 ? " and " + (n - 12) + " more" : "") + ".";
    }
    out.speak = (n + " free " + kind(q, n) + loc(q) + " " + when(q, ctx) + ". " +
      (n > 1 ? "For example " : "") + sayList(names, 4) + ".").replace(/\u2013/g, " to ");
    return out;
  }

  function ask(text, ctx) { return answer(parse(text, ctx), ctx); }

  return { parse: parse, answer: answer, ask: ask, norm: norm, ORDWORD: ORDWORD };
});
