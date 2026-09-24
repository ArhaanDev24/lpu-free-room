/**
 * LPU Free Room - teacher accounts and one-time codes.
 *
 * What it does
 *   - Teachers create an account only with an @lpu.co.in address, proven by
 *     a 6-digit code emailed to that address.
 *   - After sign-in it hands the app the key that opens the sealed class
 *     details. Students never call this service.
 *   - Accounts live in a Google Sheet that setup() creates in your Drive, so
 *     you can see (and delete) who has signed up.
 *
 * Deploy once (use a personal Gmail account; a college Workspace account may
 * block "Anyone" access):
 *   1. script.google.com > New project > paste this file over Code.gs > Save.
 *   2. Choose setup in the function list > Run > allow the permissions.
 *      The log shows the ADMIN SECRET and the accounts sheet link.
 *   3. Deploy > New deployment > type Web app. Execute as: Me.
 *      Who has access: Anyone. Deploy, then copy the Web app URL (/exec).
 *   4. Paste the URL and the admin secret into the admin page and publish.
 */

var DOMAIN_RE = /^[a-z0-9._%+\-]+@lpu\.co\.in$/;
var OTP_MINUTES = 10;
var TOKEN_DAYS = 30;
var MAX_SENDS = 3;       // codes per address per 15 minutes
var MAX_HOURLY = 80;     // codes per hour overall, protects the daily mail quota
var MAX_FAILS = 8;       // wrong passwords per address per 15 minutes

function setup() {
  var p = PropertiesService.getScriptProperties();
  if (!p.getProperty('SECRET')) p.setProperty('SECRET', randomB64_(32));
  if (!p.getProperty('DATA_KEY')) p.setProperty('DATA_KEY', randomB64_(32));
  if (!p.getProperty('ADMIN_SECRET')) p.setProperty('ADMIN_SECRET', randomB64_(18).replace(/[+\/=]/g, 'x'));
  var id = p.getProperty('SHEET_ID');
  if (!id) {
    var ss = SpreadsheetApp.create('LPU Free Room accounts');
    ss.getSheets()[0].setName('users').appendRow(['Email', 'Name', 'Role', 'Salt', 'Hash', 'Created', 'LastLogin']);
    id = ss.getId();
    p.setProperty('SHEET_ID', id);
  }
  Logger.log('ADMIN SECRET (paste into the admin page): ' + p.getProperty('ADMIN_SECRET'));
  Logger.log('Accounts sheet: ' + SpreadsheetApp.openById(id).getUrl());
  Logger.log('Emails left today: ' + MailApp.getRemainingDailyQuota());
}

// Run only if the key may have leaked, then publish again from the admin page.
function rotateDataKey() {
  PropertiesService.getScriptProperties().setProperty('DATA_KEY', randomB64_(32));
  Logger.log('New data key set. Publish the timetable again from the admin page.');
}

function doGet() { return json_({ ok: true, service: 'lpu-free-room' }); }

function doPost(e) {
  var out;
  try {
    out = route_(JSON.parse((e && e.postData && e.postData.contents) || '{}'));
  } catch (err) {
    out = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  return json_(out);
}

function route_(q) {
  var a = q.a;
  if (a === 'key') {
    if (!verifyToken_(q.token)) fail_('Your sign-in has expired. Sign in again.');
    return { ok: true, key: prop_('DATA_KEY') };
  }
  if (a === 'adminKey') {
    if (!q.secret || String(q.secret) !== prop_('ADMIN_SECRET')) fail_('Wrong admin secret.');
    return { ok: true, key: prop_('DATA_KEY') };
  }

  var email = String(q.email || '').trim().toLowerCase();
  if (!DOMAIN_RE.test(email)) fail_('Use your @lpu.co.in email address.');

  if (a === 'signupStart') {
    if (!String(q.name || '').trim()) fail_('Enter your name.');
    if (findUser_(email)) fail_('An account with this email already exists. Sign in, or use Forgot password.');
    sendOtp_(email, 'signup');
    return { ok: true };
  }
  if (a === 'signupVerify') {
    checkPassword_(q.password);          // before the code is used up
    checkOtp_(email, 'signup', q.otp);
    var name = String(q.name || '').trim() || email.split('@')[0];
    return withLock_(function () {
      if (findUser_(email)) fail_('An account with this email already exists. Sign in instead.');
      var salt = randomB64_(16), now = new Date();
      sheet_().appendRow([email, name, 'teacher', salt, hashPw_(q.password, salt), now, now]);
      return session_(email, name);
    });
  }
  if (a === 'login') {
    var cache = CacheService.getScriptCache(), fk = 'f:' + email, fails = +(cache.get(fk) || 0);
    if (fails >= MAX_FAILS) fail_('Too many wrong passwords. Wait 15 minutes, or use Forgot password.');
    var u = findUser_(email);
    // the same message either way, so the form doesn't reveal who has an account
    if (!u || hashPw_(String(q.password || ''), u.salt) !== u.hash) {
      cache.put(fk, String(fails + 1), 900);
      fail_('Wrong email or password.');
    }
    cache.remove(fk);
    sheet_().getRange(u.row, 7).setValue(new Date());
    return session_(email, u.name);
  }
  if (a === 'resetStart') {
    if (!findUser_(email)) fail_('No account uses this email. Create one instead.');
    sendOtp_(email, 'reset');
    return { ok: true };
  }
  if (a === 'resetVerify') {
    checkPassword_(q.password);          // before the code is used up
    checkOtp_(email, 'reset', q.otp);
    return withLock_(function () {
      var u2 = findUser_(email);
      if (!u2) fail_('No account uses this email.');
      var salt2 = randomB64_(16);
      sheet_().getRange(u2.row, 4, 1, 2).setValues([[salt2, hashPw_(q.password, salt2)]]);
      sheet_().getRange(u2.row, 7).setValue(new Date());
      CacheService.getScriptCache().remove('f:' + email);
      return session_(email, u2.name);
    });
  }
  fail_('Unknown request.');
}

// ----------------------------------------------------------- one-time codes

function sendOtp_(email, purpose) {
  var c = CacheService.getScriptCache();
  var nk = 'n:' + email, sent = +(c.get(nk) || 0);
  if (sent >= MAX_SENDS) fail_('Too many codes asked for. Wait 15 minutes and try again.');
  var hk = 'h:' + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHH'), hourly = +(c.get(hk) || 0);
  if (hourly >= MAX_HOURLY) fail_('The code service is busy. Try again within an hour.');
  if (MailApp.getRemainingDailyQuota() < 1) fail_('Today\'s email limit is used up. Try again tomorrow.');
  var otp = otp_();
  c.put('o:' + purpose + ':' + email, JSON.stringify({ h: otpHash_(otp, email), n: 0 }), OTP_MINUTES * 60);
  c.put(nk, String(sent + 1), 900);
  c.put(hk, String(hourly + 1), 3700);
  MailApp.sendEmail({
    to: email,
    subject: 'LPU Free Room code: ' + otp,
    name: 'LPU Free Room',
    htmlBody: '<p>Your verification code for LPU Free Room is</p>' +
      '<p style="font-size:30px;font-weight:bold;letter-spacing:6px;margin:8px 0">' + otp + '</p>' +
      '<p>It works for ' + OTP_MINUTES + ' minutes. If you did not ask for it, ignore this email.</p>'
  });
}

function checkOtp_(email, purpose, otp) {
  var c = CacheService.getScriptCache(), k = 'o:' + purpose + ':' + email, v = c.get(k);
  if (!v) fail_('The code has expired. Ask for a new one.');
  var o = JSON.parse(v);
  if (o.n >= 5) { c.remove(k); fail_('Too many wrong codes. Ask for a new one.'); }
  if (otpHash_(String(otp || '').trim(), email) !== o.h) {
    o.n++;
    c.put(k, JSON.stringify(o), OTP_MINUTES * 60);
    fail_('That code is not right. Use the one in the latest email.');
  }
  c.remove(k);
}

function otp_() {
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
                                  Utilities.getUuid() + Utilities.getUuid() + Date.now());
  var n = 0;
  for (var i = 0; i < 4; i++) n = n * 256 + (b[i] & 255);
  return ('000000' + (n % 1000000)).slice(-6);
}

function otpHash_(otp, email) { return sha_(otp + '|' + email + '|' + prop_('SECRET')); }

// ------------------------------------------------------ passwords and tokens

function checkPassword_(pw) {
  if (String(pw || '').length < 8) fail_('The password needs at least 8 characters.');
}

function hashPw_(pw, salt) {
  var h = Utilities.computeHmacSha256Signature(String(pw) + '|' + salt, prop_('SECRET'));
  for (var i = 0; i < 500; i++) h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h);
  return Utilities.base64Encode(h);
}

function session_(email, name) {
  var exp = Date.now() + TOKEN_DAYS * 864e5;
  var payload = Utilities.base64EncodeWebSafe(Utilities.newBlob(JSON.stringify({ e: email, n: name, x: exp })).getBytes());
  var sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, prop_('SECRET')));
  return { ok: true, token: payload + '.' + sig, exp: exp, email: email, name: name, key: prop_('DATA_KEY') };
}

function verifyToken_(tok) {
  var p = String(tok || '').split('.');
  if (p.length !== 2) return null;
  var sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(p[0], prop_('SECRET')));
  if (sig !== p[1]) return null;
  var d = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(p[0])).getDataAsString());
  if (!d.x || d.x < Date.now()) return null;
  if (!findUser_(d.e)) return null;          // deleting the sheet row revokes access
  return d;
}

// ------------------------------------------------------------------ helpers

function findUser_(email) {
  var sh = sheet_(), last = sh.getLastRow();
  if (last < 2) return null;
  var cell = sh.getRange(2, 1, last - 1, 1).createTextFinder(email).matchEntireCell(true).findNext();
  if (!cell) return null;
  var row = cell.getRow(), v = sh.getRange(row, 1, 1, 7).getValues()[0];
  return { row: row, email: v[0], name: v[1], role: v[2], salt: v[3], hash: v[4] };
}

function sheet_() { return SpreadsheetApp.openById(prop_('SHEET_ID')).getSheetByName('users'); }

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function prop_(k) {
  var v = PropertiesService.getScriptProperties().getProperty(k);
  if (!v) fail_('The sign-in service is not set up yet. Run setup() in Apps Script.');
  return v;
}

function randomB64_(len) {
  var out = [];
  while (out.length < len) {
    out = out.concat(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
      Utilities.getUuid() + Utilities.getUuid() + Math.random() + Date.now()));
  }
  return Utilities.base64Encode(out.slice(0, len));
}

function sha_(s) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(m) { throw new Error(m); }
