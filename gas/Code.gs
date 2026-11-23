/**
 * EQUIPMENT Unique: ระบบเบิก-คืนอุปกรณ์ Survey (BPNP) ผ่าน LINE
 * Backend API for the LIFF app (https://liff.line.me/2012756966-P652TGXb)
 *
 * Deploy: Web app, Execute as: Me, Who has access: Anyone
 * The LIFF page POSTs JSON as text/plain (no CORS preflight): {action, idToken, ...}
 * Every request proves who the user is with the LINE ID token, checked at
 * https://api.line.me/oauth2/v2.1/verify against the LINE Login channel ID.
 *
 * Script Properties
 *   LINE_TOKEN   Messaging API channel access token (EQUIPMENT Unique @076uejbw) - secret
 *   RICHMENU_ID  set by setupRichMenu()
 *
 * One-time setup in the editor: run setup() then installTriggers().
 */
var VERSION = '1.0.0';
var SHEET_ID = '1IHMkxezi10zE0iHq_TTs_w1dA-v5N5d4K_hnjEGKy3Y';
var LIFF_ID = '2012756966-P652TGXb';
var LOGIN_CHANNEL_ID = '2012756966';
var TZ = 'Asia/Bangkok';

var SCHEMA = {
  Assets: ['code', 'kit', 'category', 'type', 'name', 'brand', 'model', 'serial', 'office', 'status', 'ticketId',
    'holder', 'holderName', 'since', 'calLast', 'calDue', 'note', 'updatedAt'],
  Kits: ['kit', 'name', 'category', 'main', 'items', 'office'],
  Tickets: ['ticketId', 'empId', 'name', 'lineUserId', 'purpose', 'site', 'createdAt', 'dueAt', 'status', 'items',
    'returned', 'outBy', 'outAt', 'closedAt', 'remindedAt', 'overdueAt', 'note'],
  TicketItems: ['ticketId', 'code', 'kit', 'name', 'outAt', 'returnedAt', 'cond', 'note', 'returnedBy',
    'receivedBy', 'receivedAt'],
  Issues: ['issueId', 'at', 'code', 'name', 'ticketId', 'type', 'note', 'empId', 'reporter', 'status',
    'resolvedAt', 'resolvedBy'],
  Users: ['lineUserId', 'empId', 'name', 'lineName', 'role', 'status', 'lang', 'phoneEntered', 'createdAt',
    'approvedBy', 'approvedAt', 'lastSeen'],
  Employees: ['empId', 'name', 'nameEn', 'nickname', 'nicknameEn', 'position', 'email', 'phone', 'team', 'active', 'source'],
  Events: ['at', 'actor', 'action', 'ref', 'detail'],
  Settings: ['key', 'value', 'note']
};

var DEFAULTS = {
  RETURN_TIME: '17:30', CAL_WARN_DAYS: '30', CAL_BLOCK: 'FALSE', REMIND_BEFORE_MIN: '60',
  OVERDUE_DAILY_HOUR: '8', NOTIFY_ADMINS_OVERDUE: 'TRUE'
};

var CODE_RE = /^UN-SV-(GN|DR|DL|OF)-(\d{3})-([A-Z]{2})-(\d{3})(-DUP\d)?$/;
var KIT_RE = /^UN-SV-(GN|DR|DL|OF)-(\d{3})$/;
var GROUP_RE = /^UN-SV-(GN|DR|DL|OF)-000-([A-Z]{2})(-BIN)?$/;
var TICKET_RE = /^TK-\d{4}-\d{4}$/;

/* ---------------- entry points ---------------- */

function doGet() {
  return json_({ ok: true, app: 'EQUIPMENT Unique', version: VERSION });
}

function doPost(e) {
  var t0 = Date.now(), req = {};
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (x) {
    return json_({ ok: false, error: 'BAD_REQUEST' });
  }
  try {
    var data = route_(req);
    console.log('api ' + req.action + ' ' + (Date.now() - t0) + 'ms ok');
    return json_({ ok: true, data: data });
  } catch (err) {
    console.log('api ' + req.action + ' ' + (Date.now() - t0) + 'ms err ' + (err && err.message));
    return json_({ ok: false, error: String((err && err.message) || err), code: (err && err.code) || '' });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(msg, code) {
  var e = new Error(msg);
  e.code = code || 'ERR';
  throw e;
}

/* ---------------- routing ---------------- */

var OPEN_ACTIONS = { me: 1, register: 1, requestReview: 1, setLang: 1 };
var STAFF_ACTIONS = { checkOut: 1, receive: 1, overview: 1, approveUser: 1, setRole: 1, resolveIssue: 1, assetList: 1 };

function route_(req) {
  var who = auth_(req.idToken);
  var user = userBySub_(who.sub);
  var a = req.action;
  if (!OPEN_ACTIONS[a]) {
    if (!user || user.status !== 'ACTIVE') fail_('ยังไม่ได้ลงทะเบียนหรือบัญชียังไม่ได้รับอนุมัติ', 'NOT_ACTIVE');
    if (STAFF_ACTIONS[a] && !isStaff_(user)) fail_('บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้', 'FORBIDDEN');
    touch_(user);
  }
  switch (a) {
    case 'me': return me_(who, user);
    case 'register': return register_(who, user, req);
    case 'requestReview': return requestReview_(who, user, req);
    case 'setLang': return setLang_(who, user, req);
    case 'lookup': return lookup_(user, req);
    case 'borrow': return borrow_(user, req);
    case 'ticket': return ticketView_(user, req.ticketId);
    case 'mine': return mine_(user);
    case 'repeat': return repeat_(user);
    case 'returnItems': return returnItems_(user, req);
    case 'checkOut': return checkOut_(user, req);
    case 'receive': return receive_(user, req);
    case 'overview': return overview_(user);
    case 'approveUser': return approveUser_(user, req);
    case 'setRole': return setRole_(user, req);
    case 'resolveIssue': return resolveIssue_(user, req);
    case 'assetList': return assetList_(user, req);
    default: fail_('ไม่รู้จักคำสั่งนี้', 'BAD_ACTION');
  }
}

/* ---------------- LINE ID token ---------------- */

function auth_(idToken) {
  if (!idToken) fail_('กรุณาเปิดผ่านแอป LINE', 'AUTH');
  var cache = CacheService.getScriptCache();
  var key = 'tk:' + hash_(idToken);
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post', muteHttpExceptions: true,
    payload: { id_token: idToken, client_id: LOGIN_CHANNEL_ID }
  });
  var body = {};
  try { body = JSON.parse(res.getContentText()); } catch (x) { /* ignore */ }
  if (res.getResponseCode() !== 200 || !body.sub) {
    var expired = /expire/i.test(body.error_description || '');
    fail_(expired ? 'การยืนยันตัวตนหมดอายุ กรุณาเปิดใหม่' : 'ยืนยันตัวตนกับ LINE ไม่สำเร็จ', expired ? 'AUTH_EXPIRED' : 'AUTH');
  }
  var who = { sub: body.sub, name: body.name || '', picture: body.picture || '' };
  var ttl = Math.max(30, Math.min(600, Math.floor((body.exp || 0) - Date.now() / 1000) - 30));
  cache.put(key, JSON.stringify(who), ttl);
  return who;
}

function hash_(s) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s)).slice(0, 32);
}

/* ---------------- sheet helpers ---------------- */

var _ss = null, _tables = {};

function ss_() {
  if (!_ss) _ss = SpreadsheetApp.openById(SHEET_ID);
  return _ss;
}

function table_(name) {
  if (_tables[name]) return _tables[name];
  var sh = ss_().getSheetByName(name);
  if (!sh) fail_('ไม่พบแท็บ ' + name + ' ในชีตฐานข้อมูล', 'SETUP');
  var vals = sh.getDataRange().getDisplayValues();
  var head = vals[0].map(function (h) { return String(h).trim(); });
  var rows = [];
  for (var i = 1; i < vals.length; i++) {
    if (!vals[i].join('')) continue;
    var o = { _r: i + 1 };
    for (var j = 0; j < head.length; j++) if (head[j]) o[head[j]] = vals[i][j];
    rows.push(o);
  }
  _tables[name] = { sh: sh, head: head, rows: rows };
  return _tables[name];
}

function rows_(name) { return table_(name).rows; }

function fresh_() { _tables = {}; }

/* one write per row: the span between the first and last changed column, other cells keep their values */
function update_(name, row, fields) {
  var t = table_(name), lo = 1e9, hi = -1;
  Object.keys(fields).forEach(function (k) {
    var c = t.head.indexOf(k);
    if (c < 0) return;
    row[k] = fields[k] == null ? '' : String(fields[k]);
    lo = Math.min(lo, c); hi = Math.max(hi, c);
  });
  if (hi < 0) return;
  var vals = [];
  for (var c = lo; c <= hi; c++) vals.push(row[t.head[c]] == null ? '' : String(row[t.head[c]]));
  var rng = t.sh.getRange(row._r, lo + 1, 1, hi - lo + 1);
  rng.setNumberFormat('@');
  rng.setValues([vals]);
}

/* write many rows of the same table in one call when they are contiguous */
function updateMany_(name, list) {
  list.forEach(function (x) { update_(name, x.row, x.fields); });
}

function append_(name, objs) {
  if (!objs.length) return;
  var t = table_(name);
  var data = objs.map(function (o) {
    return t.head.map(function (h) { return o[h] == null ? '' : String(o[h]); });
  });
  var start = t.sh.getLastRow() + 1;
  var rng = t.sh.getRange(start, 1, data.length, t.head.length);
  rng.setNumberFormat('@');
  rng.setValues(data);
  objs.forEach(function (o, i) { o._r = start + i; t.rows.push(o); });
}

function setting_(k) {
  var r = rows_('Settings').filter(function (x) { return x.key === k; })[0];
  return r && r.value !== '' ? r.value : DEFAULTS[k];
}

function event_(actor, action, ref, detail) {
  append_('Events', [{ at: now_(), actor: actor, action: action, ref: ref || '', detail: detail ? JSON.stringify(detail).slice(0, 2000) : '' }]);
}

function now_() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ss"); }

function parseTime_(s) {
  if (!s) return null;
  var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 7, +m[5], +(m[6] || 0)));
}

function fmt_(d, p) { return Utilities.formatDate(d, TZ, p || "yyyy-MM-dd'T'HH:mm:ss"); }

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) fail_('ระบบกำลังบันทึกรายการอื่นอยู่ กรุณาลองใหม่อีกครั้ง', 'BUSY');
  try {
    fresh_();
    var out = fn();
    SpreadsheetApp.flush();
    return out;
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- users ---------------- */

function normEmp_(s) { return String(s || '').replace(/\D/g, '').replace(/^0+/, ''); }
function normPhone_(s) {
  var d = String(s || '').replace(/\D/g, '');
  if (d.indexOf('66') === 0 && d.length === 11) d = '0' + d.slice(2);
  if (d.length === 9 && d[0] !== '0') d = '0' + d;
  return d;
}

function userBySub_(sub) {
  return rows_('Users').filter(function (u) { return u.lineUserId === sub; })[0] || null;
}

function employee_(empId) {
  var k = normEmp_(empId);
  return rows_('Employees').filter(function (e) {
    return normEmp_(e.empId) === k && String(e.active).toUpperCase() !== 'FALSE';
  })[0] || null;
}

function isStaff_(u) { return !!u && (u.role === 'ADMIN' || u.role === 'CHECKER'); }

function admins_() {
  return rows_('Users').filter(function (u) { return u.status === 'ACTIVE' && u.role === 'ADMIN'; });
}

function staff_() {
  return rows_('Users').filter(function (u) { return u.status === 'ACTIVE' && isStaff_(u); });
}

function touch_(u) {
  var today = now_().slice(0, 10);
  if (String(u.lastSeen || '').slice(0, 10) !== today) update_('Users', u, { lastSeen: now_() });
}

function pubUser_(u, emp) {
  if (!u) return null;
  return {
    name: u.name, empId: u.empId, role: u.role, status: u.status, lang: u.lang || 'th',
    nameEn: emp ? emp.nameEn : '', nickname: emp ? emp.nickname : '', position: emp ? emp.position : ''
  };
}

function me_(who, user) {
  var out = { liffId: LIFF_ID, version: VERSION, lineName: who.name };
  out.settings = { returnTime: setting_('RETURN_TIME'), calWarnDays: +setting_('CAL_WARN_DAYS'), calBlock: setting_('CAL_BLOCK') === 'TRUE' };
  if (!user) { out.registered = false; return out; }
  out.registered = true;
  out.user = pubUser_(user, employee_(user.empId));
  if (user.status === 'ACTIVE') {
    touch_(user);
    var mine = rows_('Tickets').filter(function (t) { return t.lineUserId === user.lineUserId && (t.status === 'OPEN' || t.status === 'PARTIAL'); });
    out.openTickets = mine.map(ticketCard_);
    if (isStaff_(user)) {
      out.pendingUsers = rows_('Users').filter(function (u) { return u.status === 'PENDING'; }).length;
      out.overdue = rows_('Tickets').filter(function (t) { return (t.status === 'OPEN' || t.status === 'PARTIAL') && isOverdue_(t); }).length;
      out.openIssues = rows_('Issues').filter(function (i) { return i.status === 'OPEN'; }).length;
    }
  }
  return out;
}

function setLang_(who, user, req) {
  if (!user) return { lang: req.lang };
  var lang = req.lang === 'en' ? 'en' : 'th';
  update_('Users', user, { lang: lang });
  return { lang: lang };
}

/* register: empId + phone must match the employee register; otherwise admins review */
function register_(who, user, req) {
  if (user && user.status === 'ACTIVE') return me_(who, user);
  var empId = normEmp_(req.empId), phone = normPhone_(req.phone);
  if (!empId) fail_('กรุณากรอกรหัสพนักงาน', 'INPUT');
  if (!/^0\d{8,9}$/.test(phone)) fail_('กรุณากรอกเบอร์โทร 10 หลัก', 'INPUT');
  var cache = CacheService.getScriptCache();
  var k1 = 'rg:' + who.sub, k2 = 're:' + empId;
  var n1 = +(cache.get(k1) || 0), n2 = +(cache.get(k2) || 0);
  if (n1 >= 5 || n2 >= 5) fail_('กรอกไม่ตรงหลายครั้งเกินไป กรุณาลองใหม่ในอีก 1 ชั่วโมง หรือติดต่อผู้ดูแลระบบ', 'LOCKED');
  return withLock_(function () {
    user = userBySub_(who.sub);
    var emp = employee_(empId);
    var taken = rows_('Users').filter(function (u) {
      return normEmp_(u.empId) === empId && u.status === 'ACTIVE' && u.lineUserId !== who.sub;
    })[0];
    if (taken) {
      notifyAdmins_('reg_taken', { empId: empId, name: emp ? emp.name : '', lineName: who.name });
      fail_('รหัสพนักงานนี้ลงทะเบียนกับ LINE อื่นแล้ว ระบบแจ้งผู้ดูแลแล้ว หากเป็นของคุณกรุณาติดต่อผู้ดูแลระบบ', 'EMP_TAKEN');
    }
    var match = emp && emp.phone && normPhone_(emp.phone) === phone;
    if (!match) {
      cache.put(k1, String(n1 + 1), 3600);
      cache.put(k2, String(n2 + 1), 3600);
      // tell the screen whether an admin review is possible (employee found but phone missing/different)
      return { matched: false, canReview: true, found: !!emp, hasPhone: !!(emp && emp.phone) };
    }
    var fields = {
      lineUserId: who.sub, empId: emp.empId, name: emp.name || emp.nameEn, lineName: who.name, role: 'USER',
      status: 'ACTIVE', lang: req.lang === 'en' ? 'en' : 'th', phoneEntered: '', createdAt: now_(),
      approvedBy: 'hr-match', approvedAt: now_(), lastSeen: now_()
    };
    if (user) update_('Users', user, fields); else append_('Users', [fields]);
    event_(fields.name, 'REGISTER', emp.empId, { by: 'hr-match' });
    notifyAdmins_('reg_ok', { empId: emp.empId, name: fields.name });
    return { matched: true, me: me_(who, userBySub_(who.sub)) };
  });
}

function requestReview_(who, user, req) {
  if (user && user.status === 'ACTIVE') return me_(who, user);
  var empId = normEmp_(req.empId), phone = normPhone_(req.phone), name = String(req.name || '').trim().slice(0, 80);
  if (!empId) fail_('กรุณากรอกรหัสพนักงาน', 'INPUT');
  if (!/^0\d{8,9}$/.test(phone)) fail_('กรุณากรอกเบอร์โทร 10 หลัก', 'INPUT');
  return withLock_(function () {
    user = userBySub_(who.sub);
    var emp = employee_(empId);
    var fields = {
      lineUserId: who.sub, empId: empId, name: emp ? (emp.name || emp.nameEn) : (name || who.name), lineName: who.name,
      role: 'USER', status: 'PENDING', lang: req.lang === 'en' ? 'en' : 'th', phoneEntered: phone, createdAt: now_(),
      approvedBy: '', approvedAt: '', lastSeen: now_()
    };
    if (user) update_('Users', user, fields); else append_('Users', [fields]);
    event_(fields.name, 'REGISTER_REQ', empId, { inRegister: !!emp });
    notifyAdmins_('reg_review', { empId: empId, name: fields.name, inRegister: !!emp, lineName: who.name });
    return me_(who, userBySub_(who.sub));
  });
}

function approveUser_(staff, req) {
  return withLock_(function () {
    var u = rows_('Users').filter(function (x) { return x.lineUserId === req.lineUserId; })[0];
    if (!u) fail_('ไม่พบผู้ใช้', 'NOT_FOUND');
    if (req.approve) {
      var dup = rows_('Users').filter(function (x) { return x !== u && x.status === 'ACTIVE' && normEmp_(x.empId) === normEmp_(u.empId); })[0];
      if (dup) fail_('รหัสพนักงานนี้มีบัญชีที่ใช้งานอยู่แล้ว (' + dup.name + ')', 'EMP_TAKEN');
      update_('Users', u, { status: 'ACTIVE', approvedBy: staff.name, approvedAt: now_() });
      push_(u.lineUserId, card_(u.lang, 'green', t_(u.lang, 'บัญชีพร้อมใช้งานแล้ว', 'Your account is ready'),
        [t_(u.lang, 'ผู้ดูแลอนุมัติบัญชีของคุณแล้ว เริ่มเบิกอุปกรณ์ได้เลย', 'An admin approved your account. You can borrow equipment now.')],
        t_(u.lang, 'เปิดระบบ', 'Open'), liffUrl_('')));
    } else {
      update_('Users', u, { status: 'REJECTED', approvedBy: staff.name, approvedAt: now_() });
    }
    event_(staff.name, req.approve ? 'USER_APPROVE' : 'USER_REJECT', u.empId, { user: u.name });
    return overview_(staff);
  });
}

function setRole_(staff, req) {
  if (staff.role !== 'ADMIN') fail_('เฉพาะผู้ดูแลระบบ', 'FORBIDDEN');
  var role = { USER: 1, CHECKER: 1, ADMIN: 1 }[req.role] ? req.role : null;
  if (!role) fail_('สิทธิ์ไม่ถูกต้อง', 'INPUT');
  return withLock_(function () {
    var u = rows_('Users').filter(function (x) { return x.lineUserId === req.lineUserId; })[0];
    if (!u) fail_('ไม่พบผู้ใช้', 'NOT_FOUND');
    update_('Users', u, { role: role });
    event_(staff.name, 'SET_ROLE', u.empId, { role: role });
    return overview_(staff);
  });
}

/* ---------------- assets ---------------- */

function parseScan_(raw) {
  var s = String(raw || '').trim();
  var m = s.match(/[?&](c|t)=([^&#\s]+)/);
  if (m) return { kind: m[1] === 't' ? 'ticket' : 'code', value: decodeURIComponent(m[2]).toUpperCase() };
  s = s.toUpperCase().replace(/\s+/g, '');
  if (TICKET_RE.test(s)) return { kind: 'ticket', value: s };
  return { kind: 'code', value: s };
}

function assetMap_() {
  var m = {};
  rows_('Assets').forEach(function (a) { m[a.code.toUpperCase()] = a; });
  return m;
}

function calState_(a) {
  if (!a.calDue) return '';
  var due = new Date(a.calDue + 'T00:00:00+07:00');
  var days = Math.floor((due - new Date()) / 86400000);
  if (days < 0) return 'OVERDUE';
  if (days <= +setting_('CAL_WARN_DAYS')) return 'SOON';
  return 'OK';
}

function pubAsset_(a, me) {
  var cal = calState_(a);
  var blocked = a.status !== 'AVAILABLE' || (cal === 'OVERDUE' && setting_('CAL_BLOCK') === 'TRUE');
  return {
    code: a.code, kit: a.kit, category: a.category, type: a.type, name: a.name, brand: a.brand, model: a.model,
    serial: a.serial, status: a.status, ticketId: a.ticketId, holderName: a.holderName, since: a.since,
    mine: !!(me && a.holder && normEmp_(a.holder) === normEmp_(me.empId)),
    calDue: a.calDue, cal: cal, ok: !blocked, note: a.note
  };
}

function lookup_(user, req) {
  var p = parseScan_(req.code);
  if (!p.value) fail_('ไม่พบรหัส', 'INPUT');
  if (p.kind === 'ticket') {
    var t = rows_('Tickets').filter(function (x) { return x.ticketId === p.value; })[0];
    if (!t) fail_('ไม่พบใบเบิก ' + p.value, 'NOT_FOUND');
    return { type: 'ticket', ticketId: t.ticketId };
  }
  var map = assetMap_(), code = p.value;
  var a = map[code];
  if (a) {
    if (a.kit) return kitResult_(user, a.kit, code);
    return { type: 'item', item: pubAsset_(a, user) };
  }
  if (KIT_RE.test(code)) return kitResult_(user, code, '');
  var g = code.match(GROUP_RE);
  if (g) {
    var prefix = 'UN-SV-' + g[1] + '-000-' + g[2] + '-';
    var items = rows_('Assets').filter(function (x) { return x.code.indexOf(prefix) === 0; }).map(function (x) { return pubAsset_(x, user); });
    if (!items.length) fail_('ไม่พบอุปกรณ์กลุ่ม ' + code, 'NOT_FOUND');
    return { type: 'group', group: code, name: items[0].name, items: items };
  }
  fail_('ไม่พบรหัส ' + code + ' ในทะเบียนอุปกรณ์', 'NOT_FOUND');
}

function kitResult_(user, kit, scanned) {
  var k = rows_('Kits').filter(function (x) { return x.kit === kit; })[0];
  var items = rows_('Assets').filter(function (x) { return x.kit === kit; }).map(function (x) { return pubAsset_(x, user); });
  if (!items.length) fail_('ไม่พบชุดอุปกรณ์ ' + kit, 'NOT_FOUND');
  items.sort(function (a, b) { return (a.code === (k && k.main) ? -1 : 0) - (b.code === (k && k.main) ? -1 : 0) || (a.code < b.code ? -1 : 1); });
  return { type: 'kit', kit: kit, name: k ? k.name : kit, main: k ? k.main : '', scanned: scanned, items: items };
}

/* ---------------- tickets ---------------- */

function nextTicketId_() {
  var ym = Utilities.formatDate(new Date(), TZ, 'yyMM');
  var max = 0;
  rows_('Tickets').forEach(function (t) {
    var m = String(t.ticketId).match(/^TK-(\d{4})-(\d{4})$/);
    if (m && m[1] === ym) max = Math.max(max, +m[2]);
  });
  return 'TK-' + ym + '-' + ('000' + (max + 1)).slice(-4);
}

function defaultDue_() {
  var hm = String(setting_('RETURN_TIME')).split(':');
  var d = new Date();
  var today = Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
  var due = parseTime_(today + 'T' + ('0' + hm[0]).slice(-2) + ':' + ('0' + (hm[1] || '00')).slice(-2));
  if (due <= d) due = new Date(due.getTime() + 86400000);
  return due;
}

function borrow_(user, req) {
  var codes = (req.codes || []).map(function (c) { return String(c).toUpperCase().trim(); }).filter(String);
  if (!codes.length) fail_('ยังไม่ได้เลือกอุปกรณ์', 'INPUT');
  if (codes.length > 120) fail_('เบิกได้ไม่เกิน 120 ชิ้นต่อใบ', 'INPUT');
  var due = req.dueAt ? parseTime_(req.dueAt) : defaultDue_();
  if (!due) fail_('วันเวลาคืนไม่ถูกต้อง', 'INPUT');
  if (due.getTime() < Date.now() - 5 * 60000) fail_('วันเวลาคืนต้องไม่อยู่ในอดีต', 'INPUT');
  if (due.getTime() > Date.now() + 62 * 86400000) fail_('กำหนดคืนต้องไม่เกิน 60 วัน', 'INPUT');
  return withLock_(function () {
    var map = assetMap_(), bad = [];
    var uniq = codes.filter(function (c, i) { return codes.indexOf(c) === i; });
    uniq.forEach(function (c) {
      var a = map[c];
      if (!a) bad.push({ code: c, why: 'NOT_FOUND' });
      else if (a.status !== 'AVAILABLE') bad.push({ code: c, why: a.status, holder: a.holderName, ticketId: a.ticketId });
      else if (calState_(a) === 'OVERDUE' && setting_('CAL_BLOCK') === 'TRUE') bad.push({ code: c, why: 'CAL_OVERDUE' });
    });
    if (bad.length) {
      var e = new Error('มีอุปกรณ์ที่เบิกไม่ได้ ' + bad.length + ' รายการ');
      e.code = 'UNAVAILABLE';
      e.message = JSON.stringify({ msg: 'มีอุปกรณ์ที่เบิกไม่ได้ ' + bad.length + ' รายการ', bad: bad });
      throw e;
    }
    var id = nextTicketId_(), at = now_();
    var emp = employee_(user.empId);
    append_('Tickets', [{
      ticketId: id, empId: user.empId, name: user.name, lineUserId: user.lineUserId,
      purpose: String(req.purpose || '').slice(0, 300), site: String(req.site || '').slice(0, 120),
      createdAt: at, dueAt: fmt_(due), status: 'OPEN', items: uniq.length, returned: 0,
      outBy: '', outAt: '', closedAt: '', remindedAt: '', overdueAt: '', note: ''
    }]);
    append_('TicketItems', uniq.map(function (c) {
      var a = map[c];
      return { ticketId: id, code: a.code, kit: a.kit, name: a.name, outAt: at, returnedAt: '', cond: '', note: '', returnedBy: '', receivedBy: '', receivedAt: '' };
    }));
    uniq.forEach(function (c) {
      update_('Assets', map[c], { status: 'ON_LOAN', ticketId: id, holder: user.empId, holderName: user.name, since: at, updatedAt: at });
    });
    event_(user.name, 'BORROW', id, { items: uniq.length, due: fmt_(due) });
    return ticketView_(user, id);
  });
}

function isOverdue_(t) {
  var d = parseTime_(t.dueAt);
  return !!d && d.getTime() < Date.now();
}

function ticketCard_(t) {
  return {
    ticketId: t.ticketId, name: t.name, createdAt: t.createdAt, dueAt: t.dueAt, status: t.status,
    items: +t.items || 0, returned: +t.returned || 0, overdue: (t.status === 'OPEN' || t.status === 'PARTIAL') && isOverdue_(t),
    purpose: t.purpose, site: t.site
  };
}

function ticketView_(user, ticketId) {
  var t = rows_('Tickets').filter(function (x) { return x.ticketId === ticketId; })[0];
  if (!t) fail_('ไม่พบใบเบิก ' + ticketId, 'NOT_FOUND');
  var own = t.lineUserId === user.lineUserId;
  if (!own && !isStaff_(user)) fail_('ใบเบิกนี้เป็นของผู้อื่น', 'FORBIDDEN');
  var map = assetMap_();
  var items = rows_('TicketItems').filter(function (x) { return x.ticketId === ticketId; }).map(function (x) {
    var a = map[x.code.toUpperCase()] || {};
    return {
      code: x.code, kit: x.kit, name: x.name, brand: a.brand || '', model: a.model || '', returnedAt: x.returnedAt,
      cond: x.cond, note: x.note, receivedBy: x.receivedBy, cal: a.code ? calState_(a) : '', calDue: a.calDue || ''
    };
  });
  var card = ticketCard_(t);
  card.own = own;
  card.empId = t.empId;
  card.outBy = t.outBy;
  card.outAt = t.outAt;
  card.closedAt = t.closedAt;
  card.items_ = items;
  card.kits = kitNames_(items);
  return card;
}

function kitNames_(items) {
  var ks = {};
  items.forEach(function (i) { if (i.kit) ks[i.kit] = 1; });
  var out = {};
  rows_('Kits').forEach(function (k) { if (ks[k.kit]) out[k.kit] = k.name; });
  return out;
}

function mine_(user) {
  var all = rows_('Tickets').filter(function (t) { return t.lineUserId === user.lineUserId; });
  all.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
  return {
    open: all.filter(function (t) { return t.status === 'OPEN' || t.status === 'PARTIAL'; }).map(ticketCard_),
    closed: all.filter(function (t) { return t.status === 'CLOSED'; }).slice(0, 15).map(ticketCard_)
  };
}

/* items of my latest ticket, with what is available now */
function repeat_(user) {
  var all = rows_('Tickets').filter(function (t) { return t.lineUserId === user.lineUserId; });
  all.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
  if (!all.length) return { items: [] };
  var last = all[0], map = assetMap_();
  var items = rows_('TicketItems').filter(function (x) { return x.ticketId === last.ticketId; }).map(function (x) {
    var a = map[x.code.toUpperCase()];
    return a ? pubAsset_(a, user) : null;
  }).filter(Boolean);
  return { ticketId: last.ticketId, createdAt: last.createdAt, items: items, kits: kitNames_(items) };
}

/* return: items [{code, cond: OK|DAMAGED|LOST, note}] */
function returnItems_(user, req) {
  var list = (req.items || []).filter(function (x) { return x && x.code; });
  if (!list.length) fail_('ยังไม่ได้เลือกอุปกรณ์ที่จะคืน', 'INPUT');
  return withLock_(function () {
    var t = rows_('Tickets').filter(function (x) { return x.ticketId === req.ticketId; })[0];
    if (!t) fail_('ไม่พบใบเบิก', 'NOT_FOUND');
    var own = t.lineUserId === user.lineUserId, staff = isStaff_(user);
    if (!own && !staff) fail_('ใบเบิกนี้เป็นของผู้อื่น', 'FORBIDDEN');
    if (t.status === 'CLOSED') fail_('ใบเบิกนี้คืนครบแล้ว', 'CLOSED');
    var map = assetMap_(), at = now_(), issues = [], done = 0;
    var tItems = rows_('TicketItems').filter(function (x) { return x.ticketId === t.ticketId; });
    list.forEach(function (r) {
      var ti = tItems.filter(function (x) { return x.code.toUpperCase() === String(r.code).toUpperCase() && !x.returnedAt; })[0];
      if (!ti) return;
      var cond = { OK: 1, DAMAGED: 1, LOST: 1 }[r.cond] ? r.cond : 'OK';
      var note = String(r.note || '').slice(0, 300);
      if (cond !== 'OK' && !note) fail_('กรุณาระบุรายละเอียดของอุปกรณ์ที่ชำรุดหรือสูญหาย (' + ti.code + ')', 'INPUT');
      update_('TicketItems', ti, {
        returnedAt: at, cond: cond, note: note, returnedBy: user.name,
        receivedBy: staff && !own ? user.name : '', receivedAt: staff && !own ? at : ''
      });
      var a = map[ti.code.toUpperCase()];
      if (a) {
        update_('Assets', a, {
          status: cond === 'OK' ? 'AVAILABLE' : cond === 'DAMAGED' ? 'REPAIR' : 'LOST',
          ticketId: '', holder: '', holderName: '', since: '', updatedAt: at,
          note: cond === 'OK' ? a.note : (cond === 'DAMAGED' ? 'ชำรุด' : 'สูญหาย') + ' ' + at.slice(0, 10) + ' (' + t.ticketId + '): ' + note
        });
      }
      if (cond !== 'OK') issues.push({ code: ti.code, name: ti.name, type: cond, note: note });
      done++;
    });
    if (!done) fail_('อุปกรณ์ที่เลือกคืนไปแล้ว', 'INPUT');
    var returned = tItems.filter(function (x) { return x.returnedAt; }).length;
    var closed = returned >= tItems.length;
    update_('Tickets', t, { returned: returned, status: closed ? 'CLOSED' : 'PARTIAL', closedAt: closed ? at : '' });
    if (issues.length) {
      var base = rows_('Issues').length;
      append_('Issues', issues.map(function (x, i) {
        return {
          issueId: 'IS-' + at.slice(2, 4) + at.slice(5, 7) + '-' + ('000' + (base + i + 1)).slice(-4), at: at, code: x.code, name: x.name,
          ticketId: t.ticketId, type: x.type, note: x.note, empId: t.empId, reporter: user.name, status: 'OPEN', resolvedAt: '', resolvedBy: ''
        };
      }));
      notifyStaffIssues_(t, issues, user);
    }
    event_(user.name, 'RETURN', t.ticketId, { items: done, issues: issues.length, closed: closed });
    return ticketView_(user, t.ticketId);
  });
}

/* staff confirms the hand-over (replaces signatures on the paper form) */
function checkOut_(staff, req) {
  return withLock_(function () {
    var t = rows_('Tickets').filter(function (x) { return x.ticketId === req.ticketId; })[0];
    if (!t) fail_('ไม่พบใบเบิก', 'NOT_FOUND');
    if (!t.outBy) {
      update_('Tickets', t, { outBy: staff.name, outAt: now_() });
      event_(staff.name, 'CHECK_OUT', t.ticketId, {});
    }
    return ticketView_(staff, t.ticketId);
  });
}

/* staff confirms the returned items are back in the store */
function receive_(staff, req) {
  return withLock_(function () {
    var t = rows_('Tickets').filter(function (x) { return x.ticketId === req.ticketId; })[0];
    if (!t) fail_('ไม่พบใบเบิก', 'NOT_FOUND');
    var at = now_(), n = 0;
    rows_('TicketItems').forEach(function (x) {
      if (x.ticketId === t.ticketId && x.returnedAt && !x.receivedBy) { update_('TicketItems', x, { receivedBy: staff.name, receivedAt: at }); n++; }
    });
    if (n) event_(staff.name, 'RECEIVE', t.ticketId, { items: n });
    return ticketView_(staff, t.ticketId);
  });
}

/* ---------------- staff overview ---------------- */

function overview_(staff) {
  var assets = rows_('Assets'), counts = {};
  assets.forEach(function (a) { counts[a.status] = (counts[a.status] || 0) + 1; });
  var open = rows_('Tickets').filter(function (t) { return t.status === 'OPEN' || t.status === 'PARTIAL'; }).map(ticketCard_);
  open.sort(function (a, b) { return (b.overdue - a.overdue) || (a.dueAt < b.dueAt ? -1 : 1); });
  var calSoon = assets.filter(function (a) { var c = calState_(a); return c === 'SOON' || c === 'OVERDUE'; })
    .map(function (a) { return { code: a.code, name: a.name, model: a.model, calDue: a.calDue, cal: calState_(a), status: a.status }; });
  return {
    role: staff.role,
    counts: counts, total: assets.length,
    open: open,
    issues: rows_('Issues').filter(function (i) { return i.status === 'OPEN'; }).map(function (i) {
      return { issueId: i.issueId, at: i.at, code: i.code, name: i.name, ticketId: i.ticketId, type: i.type, note: i.note, reporter: i.reporter };
    }),
    pending: rows_('Users').filter(function (u) { return u.status === 'PENDING'; }).map(function (u) {
      var emp = employee_(u.empId);
      return {
        lineUserId: u.lineUserId, empId: u.empId, name: u.name, lineName: u.lineName, createdAt: u.createdAt,
        inRegister: !!emp, registerName: emp ? (emp.name || emp.nameEn) : '', position: emp ? emp.position : '',
        phoneHint: u.phoneEntered ? u.phoneEntered.slice(0, 3) + '-•••-' + u.phoneEntered.slice(-3) : '',
        phoneMatches: !!(emp && emp.phone && normPhone_(emp.phone) === normPhone_(u.phoneEntered)),
        registerHasPhone: !!(emp && emp.phone)
      };
    }),
    users: staff.role === 'ADMIN' ? rows_('Users').filter(function (u) { return u.status === 'ACTIVE'; }).map(function (u) {
      return { lineUserId: u.lineUserId, empId: u.empId, name: u.name, role: u.role, lastSeen: u.lastSeen };
    }) : [],
    calSoon: calSoon,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit'
  };
}

function assetList_(staff, req) {
  var st = String(req.status || '');
  return rows_('Assets').filter(function (a) { return !st || a.status === st; }).slice(0, 400).map(function (a) { return pubAsset_(a, null); });
}

function resolveIssue_(staff, req) {
  return withLock_(function () {
    var i = rows_('Issues').filter(function (x) { return x.issueId === req.issueId; })[0];
    if (!i) fail_('ไม่พบรายการแจ้งปัญหา', 'NOT_FOUND');
    update_('Issues', i, { status: 'CLOSED', resolvedAt: now_(), resolvedBy: staff.name });
    if (req.available) {
      var a = assetMap_()[String(i.code).toUpperCase()];
      if (a && (a.status === 'REPAIR' || a.status === 'LOST')) update_('Assets', a, { status: 'AVAILABLE', updatedAt: now_() });
    }
    event_(staff.name, 'ISSUE_CLOSE', i.issueId, { available: !!req.available });
    return overview_(staff);
  });
}

/* ---------------- LINE messages ---------------- */

function t_(lang, th, en) { return lang === 'en' ? en : th; }

function liffUrl_(q) { return 'https://liff.line.me/' + LIFF_ID + (q ? '?' + q : ''); }

var COLORS = { red: '#95191F', green: '#1E7A46', blue: '#1F4E8C', amber: '#A15C07', grey: '#555555' };

function card_(lang, color, title, lines, button, url) {
  var body = lines.filter(Boolean).map(function (l) {
    return { type: 'text', text: String(l).slice(0, 400), wrap: true, size: 'sm', color: '#333333' };
  });
  var bubble = {
    type: 'bubble', size: 'kilo',
    header: { type: 'box', layout: 'vertical', backgroundColor: COLORS[color] || COLORS.red, paddingAll: '14px',
      contents: [{ type: 'text', text: 'EQUIPMENT Unique', color: '#FFFFFFAA', size: 'xxs' },
        { type: 'text', text: title, color: '#FFFFFF', weight: 'bold', size: 'md', wrap: true }] },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body.length ? body : [{ type: 'text', text: ' ' }] }
  };
  if (button && url) {
    bubble.footer = { type: 'box', layout: 'vertical', contents: [{ type: 'button', style: 'primary', color: COLORS[color] || COLORS.red, height: 'sm',
      action: { type: 'uri', label: String(button).slice(0, 40), uri: url } }] };
  }
  return { type: 'flex', altText: (title + ' · ' + lines.filter(Boolean).join(' ')).slice(0, 380), contents: bubble };
}

function push_(to, message) {
  var token = PropertiesService.getScriptProperties().getProperty('LINE_TOKEN');
  if (!token || !to) return { ok: false, error: 'NO_TOKEN' };
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token, 'X-Line-Retry-Key': Utilities.getUuid() },
    payload: JSON.stringify({ to: to, messages: [message] })
  });
  var code = res.getResponseCode();
  if (code === 400 && message.type === 'flex') {
    return push_(to, { type: 'text', text: message.altText });
  }
  if (code !== 200) console.log('push ' + code + ' ' + res.getContentText().slice(0, 300));
  return { ok: code === 200, code: code };
}

function notifyAdmins_(kind, d) {
  admins_().forEach(function (u) {
    var L = u.lang, msg;
    if (kind === 'reg_ok') {
      msg = card_(L, 'blue', t_(L, 'มีผู้ลงทะเบียนใหม่', 'New registration'),
        [d.name + ' (' + d.empId + ')', t_(L, 'รหัสและเบอร์ตรงทะเบียน ใช้งานได้ทันที', 'Employee ID and phone matched. Account is active.')]);
    } else if (kind === 'reg_review') {
      msg = card_(L, 'red', t_(L, 'รออนุมัติบัญชีใหม่', 'Account waiting for approval'),
        [d.name + ' (' + d.empId + ')' + (d.lineName ? ' · LINE: ' + d.lineName : ''),
          d.inRegister ? t_(L, 'อยู่ในทะเบียน แต่เบอร์ไม่ตรงหรือทะเบียนไม่มีเบอร์', 'In the register, but the phone differs or is missing')
            : t_(L, 'ไม่พบรหัสนี้ในทะเบียน', 'This employee ID is not in the register')],
        t_(L, 'ตรวจและอนุมัติ', 'Review'), liffUrl_('v=admin'));
    } else if (kind === 'reg_taken') {
      msg = card_(L, 'amber', t_(L, 'มีคนพยายามใช้รหัสพนักงานซ้ำ', 'Employee ID used again'),
        [d.empId + (d.name ? ' ' + d.name : '') + ' · LINE: ' + d.lineName,
          t_(L, 'รหัสนี้ผูกกับ LINE อื่นอยู่แล้ว ถ้าเป็นเจ้าของจริง ให้แก้ในแท็บ Users', 'This ID is already linked to another LINE account. Fix it in the Users tab if needed.')]);
    }
    if (msg) push_(u.lineUserId, msg);
  });
}

function notifyStaffIssues_(t, issues, by) {
  staff_().forEach(function (u) {
    var L = u.lang;
    var lines = issues.map(function (x) {
      return (x.type === 'LOST' ? t_(L, 'สูญหาย', 'Lost') : t_(L, 'ชำรุด', 'Damaged')) + ' · ' + x.name + ' (' + x.code + ')' + (x.note ? ': ' + x.note : '');
    });
    lines.unshift(t.ticketId + ' · ' + t.name);
    push_(u.lineUserId, card_(L, 'red', t_(L, 'แจ้งอุปกรณ์ชำรุด/สูญหาย', 'Damaged or lost equipment'), lines.slice(0, 8),
      t_(L, 'เปิดใบเบิก', 'Open ticket'), liffUrl_('t=' + t.ticketId)));
  });
}

/* ---------------- scheduled reminders ---------------- */

function cronHourly() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    fresh_();
    var now = Date.now(), before = +setting_('REMIND_BEFORE_MIN') * 60000;
    var users = {};
    rows_('Users').forEach(function (u) { users[u.lineUserId] = u; });
    var open = rows_('Tickets').filter(function (t) { return t.status === 'OPEN' || t.status === 'PARTIAL'; });
    var newlyOverdue = [];
    open.forEach(function (t) {
      var due = parseTime_(t.dueAt);
      if (!due) return;
      var u = users[t.lineUserId] || {}, L = u.lang, left = (+t.items || 0) - (+t.returned || 0);
      if (!t.remindedAt && due.getTime() > now && due.getTime() - now <= before) {
        push_(t.lineUserId, card_(L, 'amber', t_(L, 'ใกล้ถึงเวลาคืนอุปกรณ์', 'Return due soon'),
          [t.ticketId + ' · ' + left + t_(L, ' รายการที่ยังไม่คืน', ' item(s) not returned'),
            t_(L, 'กำหนดคืน ', 'Due ') + fmt_(due, 'd MMM HH:mm')], t_(L, 'คืนอุปกรณ์', 'Return'), liffUrl_('t=' + t.ticketId)));
        update_('Tickets', t, { remindedAt: now_() });
      }
      if (due.getTime() < now && !t.overdueAt) {
        push_(t.lineUserId, card_(L, 'red', t_(L, 'เลยกำหนดคืนอุปกรณ์', 'Equipment overdue'),
          [t.ticketId + ' · ' + left + t_(L, ' รายการที่ยังไม่คืน', ' item(s) not returned'),
            t_(L, 'กำหนดคืน ', 'Was due ') + fmt_(due, 'd MMM HH:mm'),
            t_(L, 'ถ้าต้องใช้ต่อ กรุณาแจ้งผู้ดูแล', 'If you still need it, please tell the admin')], t_(L, 'คืนอุปกรณ์', 'Return'), liffUrl_('t=' + t.ticketId)));
        update_('Tickets', t, { overdueAt: now_() });
        newlyOverdue.push(t);
      }
    });
    var hour = +Utilities.formatDate(new Date(), TZ, 'H');
    var props = PropertiesService.getScriptProperties(), today = now_().slice(0, 10);
    var daily = hour === +setting_('OVERDUE_DAILY_HOUR') && props.getProperty('LAST_DAILY') !== today;
    if (daily) {
      props.setProperty('LAST_DAILY', today);
      open.filter(function (t) { return isOverdue_(t) && newlyOverdue.indexOf(t) < 0; }).forEach(function (t) {
        var u = users[t.lineUserId] || {}, L = u.lang;
        push_(t.lineUserId, card_(L, 'red', t_(L, 'ยังมีอุปกรณ์ค้างคืน', 'Equipment still overdue'),
          [t.ticketId + ' · ' + t_(L, 'กำหนดคืน ', 'Was due ') + fmt_(parseTime_(t.dueAt), 'd MMM HH:mm')], t_(L, 'คืนอุปกรณ์', 'Return'), liffUrl_('t=' + t.ticketId)));
      });
    }
    if (setting_('NOTIFY_ADMINS_OVERDUE') === 'TRUE' && (newlyOverdue.length || daily)) {
      var all = open.filter(isOverdue_);
      if (all.length) {
        admins_().forEach(function (a) {
          var L = a.lang;
          push_(a.lineUserId, card_(L, 'red', t_(L, 'รายการค้างคืน ', 'Overdue tickets: ') + all.length,
            all.slice(0, 8).map(function (t) { return t.ticketId + ' · ' + t.name + ' · ' + fmt_(parseTime_(t.dueAt), 'd MMM HH:mm'); }),
            t_(L, 'ดูภาพรวม', 'Overview'), liffUrl_('v=admin')));
        });
      }
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- one-time setup (run from the editor) ---------------- */

function setup() {
  var ss = ss_();
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var head = SCHEMA[name];
    var cur = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0] : [];
    head.forEach(function (h) {
      if (cur.indexOf(h) < 0) { sh.getRange(1, cur.length + 1).setValue(h); cur.push(h); }
    });
    sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), cur.length).setNumberFormat('@');
    sh.setFrozenRows(1);
  });
  Object.keys(DEFAULTS).forEach(function (k) {
    fresh_();
    if (!rows_('Settings').filter(function (x) { return x.key === k; }).length) append_('Settings', [{ key: k, value: DEFAULTS[k], note: '' }]);
  });
  Logger.log('setup done: ' + ss.getUrl());
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'cronHourly') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('cronHourly').timeBased().everyHours(1).create();
  Logger.log('cronHourly every hour');
}

/* check the LINE token without sending a message */
function checkLine() {
  var token = PropertiesService.getScriptProperties().getProperty('LINE_TOKEN');
  if (!token) { Logger.log('LINE_TOKEN is not set'); return; }
  var h = { Authorization: 'Bearer ' + token };
  var info = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', { headers: h, muteHttpExceptions: true });
  var quota = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/quota/consumption', { headers: h, muteHttpExceptions: true });
  Logger.log(info.getResponseCode() + ' ' + info.getContentText());
  Logger.log('quota used this month: ' + quota.getContentText());
}

/* rich menu: 3 buttons that open the LIFF app. imageFileId = PNG 2500x843 on Google Drive */
function setupRichMenu(imageFileId) {
  imageFileId = imageFileId || PropertiesService.getScriptProperties().getProperty('RICHMENU_IMAGE');
  var token = PropertiesService.getScriptProperties().getProperty('LINE_TOKEN');
  if (!token || !imageFileId) throw new Error('need LINE_TOKEN and RICHMENU_IMAGE');
  var h = { Authorization: 'Bearer ' + token };
  var w = Math.floor(2500 / 3);
  var menu = {
    size: { width: 2500, height: 843 }, selected: true, name: 'EQUIPMENT Unique v1', chatBarText: 'เมนู · Menu',
    areas: [
      { bounds: { x: 0, y: 0, width: w, height: 843 }, action: { type: 'uri', label: 'Borrow', uri: liffUrl_('v=borrow') } },
      { bounds: { x: w, y: 0, width: w, height: 843 }, action: { type: 'uri', label: 'Return', uri: liffUrl_('v=return') } },
      { bounds: { x: 2 * w, y: 0, width: 2500 - 2 * w, height: 843 }, action: { type: 'uri', label: 'My items', uri: liffUrl_('v=mine') } }
    ]
  };
  var r1 = UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu', { method: 'post', contentType: 'application/json', headers: h, payload: JSON.stringify(menu), muteHttpExceptions: true });
  if (r1.getResponseCode() !== 200) throw new Error('create ' + r1.getContentText());
  var id = JSON.parse(r1.getContentText()).richMenuId;
  var blob = DriveApp.getFileById(imageFileId).getBlob().setContentType('image/png');
  var r2 = UrlFetchApp.fetch('https://api-data.line.me/v2/bot/richmenu/' + id + '/content', { method: 'post', contentType: 'image/png', headers: h, payload: blob.getBytes(), muteHttpExceptions: true });
  if (r2.getResponseCode() !== 200) throw new Error('image ' + r2.getContentText());
  var r3 = UrlFetchApp.fetch('https://api.line.me/v2/bot/user/all/richmenu/' + id, { method: 'post', headers: h, muteHttpExceptions: true });
  if (r3.getResponseCode() !== 200) throw new Error('default ' + r3.getContentText());
  var props = PropertiesService.getScriptProperties();
  var old = props.getProperty('RICHMENU_ID');
  props.setProperty('RICHMENU_ID', id);
  if (old && old !== id) UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu/' + old, { method: 'delete', headers: h, muteHttpExceptions: true });
  Logger.log('rich menu ' + id);
}
