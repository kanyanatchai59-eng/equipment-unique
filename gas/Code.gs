/**
 * EQUIPMENT Unique: ระบบเบิก-คืนอุปกรณ์ Survey (BPNP) ผ่าน LINE
 * Backend API for the LIFF app (https://liff.line.me/2012756966-P652TGXb)
 *
 * Deploy: Web app, Execute as: Me, Who has access: Anyone
 * The LIFF page POSTs JSON as text/plain (no CORS preflight): {action, accessToken, ...}
 * Every request proves who the user is with the LIFF access token, checked at
 * https://api.line.me/oauth2/v2.1/verify against the LINE Login channel ID.
 *
 * Script Properties
 *   LINE_TOKEN   Messaging API channel access token (EQUIPMENT Unique @076uejbw) - secret
 *   RICHMENU_ID  set by setupRichMenu()
 *   SHEET_ID     optional: use another spreadsheet (the test copy) instead of the live database
 *
 * v1.2 merges the Survey Inventory register (HO level): every asset has a location (HO, a project
 * code or a shop) on top of its status, HO staff move instruments between HO, projects and shops,
 * and the daily QR borrowing only offers what is at the borrower's own project.
 *
 * One-time setup in the editor: run setup() then installTriggers().
 */
var VERSION = '1.2.0';
var SHEET_ID = '1IHMkxezi10zE0iHq_TTs_w1dA-v5N5d4K_hnjEGKy3Y';
var LIFF_ID = '2012756966-P652TGXb';
var LOGIN_CHANNEL_ID = '2012756966';
var TZ = 'Asia/Bangkok';

var SCHEMA = {
  Assets: ['code', 'kit', 'category', 'type', 'name', 'brand', 'model', 'serial', 'office', 'status', 'ticketId',
    'holder', 'holderName', 'since', 'calLast', 'calDue', 'note', 'updatedAt',
    'location', 'reservedFor', 'custodian', 'calType', 'calCert', 'po', 'owner', 'warrantyStart', 'warrantyEnd', 'confirmed'],
  Kits: ['kit', 'name', 'category', 'main', 'items', 'office'],
  Tickets: ['ticketId', 'empId', 'name', 'lineUserId', 'purpose', 'site', 'createdAt', 'dueAt', 'status', 'items',
    'returned', 'outBy', 'outAt', 'closedAt', 'remindedAt', 'overdueAt', 'note'],
  TicketItems: ['ticketId', 'code', 'kit', 'name', 'outAt', 'returnedAt', 'cond', 'note', 'returnedBy',
    'receivedBy', 'receivedAt'],
  Issues: ['issueId', 'at', 'code', 'name', 'ticketId', 'type', 'note', 'empId', 'reporter', 'status',
    'resolvedAt', 'resolvedBy'],
  Users: ['lineUserId', 'empId', 'name', 'lineName', 'role', 'status', 'lang', 'phoneEntered', 'createdAt',
    'approvedBy', 'approvedAt', 'lastSeen'],
  Employees: ['empId', 'name', 'nameEn', 'nickname', 'nicknameEn', 'position', 'email', 'phone', 'team', 'active', 'source', 'project'],
  Events: ['at', 'actor', 'action', 'ref', 'detail'],
  Settings: ['key', 'value', 'note'],
  Projects: ['code', 'name', 'closedAt', 'note', 'createdAt'],
  CalRules: ['type', 'months', 'lead', 'note']
};
/* tables a database made before v1.2 may not have yet: read as empty until setup() adds them */
var OPTIONAL_TABLES = { Projects: 1, CalRules: 1 };

var DEFAULTS = {
  RETURN_TIME: '17:30', CAL_WARN_DAYS: '30', CAL_BLOCK: 'FALSE', REMIND_BEFORE_MIN: '60',
  OVERDUE_DAILY_HOUR: '8', NOTIFY_ADMINS_OVERDUE: 'TRUE',
  HOME_PROJECT: 'BPNP', HO_CAL_BLOCK: 'TRUE'
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

/* roles: USER borrows; VIEWER also reads the back office; CHECKER also confirms hand-over/returns and approves
   sign-ups; STORE also moves instruments between HO, projects and shops and edits the register; ADMIN everything */
var ROLES = ['USER', 'VIEWER', 'CHECKER', 'STORE', 'ADMIN'];
var OPEN_ACTIONS = { me: 1, register: 1, requestReview: 1, setLang: 1 };
var READ_ACTIONS = { overview: 1, assetList: 1, adminAssets: 1, assetDetail: 1, ticketsList: 1, dashboard: 1, usersList: 1,
  projectsList: 1, calList: 1 };
var STAFF_ACTIONS = { checkOut: 1, receive: 1, approveUser: 1, resolveIssue: 1, ticketDue: 1 };
var STORE_ACTIONS = { assetSave: 1, move: 1, projectSave: 1, projectStatus: 1, calRuleSave: 1 };
var ADMIN_ACTIONS = { setRole: 1, userSave: 1, employeeSave: 1, settingsSave: 1 };

/* who really pressed the button when an admin acts in another user's view (for the Events log) */
var _actBy = '';

function route_(req) {
  var who = auth_(req);
  var user = userBySub_(who.sub);
  var a = req.action;
  _actBy = '';
  _memo = {};
  // admin acting as another user: every rule below applies to that user, the log names the admin
  if (req.asUser && a !== 'setLang') {
    if (!user || user.status !== 'ACTIVE' || user.role !== 'ADMIN') fail_('เฉพาะผู้ดูแลระบบกดแทนผู้อื่นได้', 'FORBIDDEN');
    var target = rows_('Users').filter(function (u) { return u.lineUserId === req.asUser; })[0];
    if (!target) fail_('ไม่พบผู้ใช้ที่จะกดแทน', 'AS_NOT_FOUND');
    if (target.status !== 'ACTIVE') fail_('บัญชีที่จะกดแทนยังใช้งานไม่ได้ (' + target.status + ')', 'AS_INACTIVE');
    _actBy = user.name;
    user = target;
    who = { sub: target.lineUserId, name: target.lineName || target.name };
  }
  if (!OPEN_ACTIONS[a]) {
    if (!user || user.status !== 'ACTIVE') fail_('ยังไม่ได้ลงทะเบียนหรือบัญชียังไม่ได้รับอนุมัติ', 'NOT_ACTIVE');
    if (READ_ACTIONS[a] && !canRead_(user)) fail_('บัญชีนี้ไม่มีสิทธิ์ดูหลังบ้าน', 'FORBIDDEN');
    if (STAFF_ACTIONS[a] && !isStaff_(user)) fail_('บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้', 'FORBIDDEN');
    if (STORE_ACTIONS[a] && !canStore_(user)) fail_('เฉพาะผู้ดูแลคลังหรือผู้ดูแลระบบ', 'FORBIDDEN');
    if (ADMIN_ACTIONS[a] && user.role !== 'ADMIN') fail_('เฉพาะผู้ดูแลระบบ', 'FORBIDDEN');
    if (!_actBy) touch_(user);
  }
  switch (a) {
    case 'me': { var m = me_(who, user); if (_actBy) m.actingAs = true; return m; }
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
    case 'adminAssets': return adminAssets_(user);
    case 'assetDetail': return assetDetail_(user, req);
    case 'assetSave': return assetSave_(user, req);
    case 'ticketsList': return ticketsList_(user, req);
    case 'ticketDue': return ticketDue_(user, req);
    case 'dashboard': return dashboard_(user, req);
    case 'usersList': return usersList_(user);
    case 'userSave': return userSave_(user, req);
    case 'employeeSave': return employeeSave_(user, req);
    case 'settingsSave': return settingsSave_(user, req);
    case 'move': return move_(user, req);
    case 'projectsList': return projectsList_(user);
    case 'projectSave': return projectSave_(user, req);
    case 'projectStatus': return projectStatus_(user, req);
    case 'calList': return calList_(user, req);
    case 'calRuleSave': return calRuleSave_(user, req);
    default: fail_('ไม่รู้จักคำสั่งนี้', 'BAD_ACTION');
  }
}

/* ---------------- LINE identity ----------------
 * The LIFF app (scope: profile) sends its access token. We check it belongs to our LINE Login
 * channel (GET /oauth2/v2.1/verify) and read the userId from /v2/profile.
 * An ID token (scope openid) is also accepted when the page sends one.
 * Source: developers.line.biz/en/reference/line-login/#verify-access-token and #get-user-profile */

function auth_(req) {
  if (req.accessToken) return authAccess_(req.accessToken);
  if (req.idToken) return authId_(req.idToken);
  fail_('ยังไม่ได้เข้าสู่ระบบ LINE กรุณาเปิดใหม่', 'AUTH_EXPIRED');
}

function authAccess_(token) {
  var cache = CacheService.getScriptCache();
  var key = 'at:' + hash_(token);
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var v = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify?access_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  var vb = {};
  try { vb = JSON.parse(v.getContentText()); } catch (x) { /* ignore */ }
  if (v.getResponseCode() !== 200) fail_('การยืนยันตัวตนหมดอายุ กรุณาเปิดใหม่', 'AUTH_EXPIRED');
  if (String(vb.client_id) !== LOGIN_CHANNEL_ID) fail_('ยืนยันตัวตนกับ LINE ไม่สำเร็จ', 'AUTH');
  var p = UrlFetchApp.fetch('https://api.line.me/v2/profile', { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  var pb = {};
  try { pb = JSON.parse(p.getContentText()); } catch (x) { /* ignore */ }
  if (p.getResponseCode() !== 200 || !pb.userId) fail_('อ่านข้อมูลบัญชี LINE ไม่สำเร็จ กรุณาเปิดใหม่', 'AUTH_EXPIRED');
  var who = { sub: pb.userId, name: pb.displayName || '', picture: pb.pictureUrl || '' };
  cache.put(key, JSON.stringify(who), Math.max(30, Math.min(600, (+vb.expires_in || 0) - 30)));
  return who;
}

function authId_(idToken) {
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

var _ss = null, _tables = {}, _memo = {};

function sheetId_() {
  return PropertiesService.getScriptProperties().getProperty('SHEET_ID') || SHEET_ID;
}

function ss_() {
  if (!_ss) _ss = SpreadsheetApp.openById(sheetId_());
  return _ss;
}

function table_(name) {
  if (_tables[name]) return _tables[name];
  var sh = ss_().getSheetByName(name);
  if (!sh && OPTIONAL_TABLES[name]) return (_tables[name] = { sh: null, head: SCHEMA[name].slice(), rows: [] });
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

function fresh_() { _tables = {}; _memo = {}; }

/* one write per row: the span between the first and last changed column, other cells keep their values */
function update_(name, row, fields) {
  var t = table_(name), lo = 1e9, hi = -1;
  var missing = Object.keys(fields).filter(function (k) { return t.head.indexOf(k) < 0 && SCHEMA[name] && SCHEMA[name].indexOf(k) >= 0 && fields[k] !== '' && fields[k] != null; });
  if (missing.length) fail_('แท็บ ' + name + ' ยังไม่มีคอลัมน์ ' + missing.join(', ') + ' ให้ผู้ดูแลรัน setup() ก่อน', 'SETUP');
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
  if (!t.sh) fail_('ยังไม่มีแท็บ ' + name + ' ในชีตฐานข้อมูล ให้ผู้ดูแลรัน setup() ก่อน', 'SETUP');
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
  if (_actBy) { actor = actor + ' (กดแทนโดย ' + _actBy + ')'; detail = detail || {}; detail.actBy = _actBy; }
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

function isStaff_(u) { return !!u && (u.role === 'ADMIN' || u.role === 'STORE' || u.role === 'CHECKER'); }
function canRead_(u) { return !!u && (isStaff_(u) || u.role === 'VIEWER'); }
function canStore_(u) { return !!u && (u.role === 'ADMIN' || u.role === 'STORE'); }

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
  out.user.project = userProject_(user);
  out.caps = { read: canRead_(user), staff: isStaff_(user), store: canStore_(user), admin: user.role === 'ADMIN' };
  if (user.status === 'ACTIVE') {
    touch_(user);
    var mine = rows_('Tickets').filter(function (t) { return t.lineUserId === user.lineUserId && (t.status === 'OPEN' || t.status === 'PARTIAL'); });
    out.openTickets = mine.map(ticketCard_);
    if (canRead_(user)) {
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
  var role = ROLES.indexOf(req.role) >= 0 ? req.role : null;
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

/* ---- calibration: rule per instrument type (months, recall lead days), the certificate's due date wins ----
 * Same logic as Survey Inventory: due = calDue, else calLast + months (calendar months, clamped to month end);
 * recall = due - lead days; OVERDUE from the day after due, SOON from the recall day, MISSING when a rule
 * applies but there is no date, NONE when the type has no cycle, INACTIVE once disposal starts.
 * Assets without calType keep the v1.1 behaviour (calDue with CAL_WARN_DAYS). */
function today_() { return now_().slice(0, 10); }

function ymd_(y, m, d) { return y + '-' + ('0' + m).slice(-2) + '-' + ('0' + d).slice(-2); }

function addMonths_(s, n) {
  var p = String(s).split('-').map(Number), m = p[1] - 1 + n, y = p[0] + Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return ymd_(y, m + 1, Math.min(p[2], last));
}

function addDays_(s, n) {
  var p = String(s).split('-').map(Number), x = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return ymd_(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate());
}

function rulesMap_() {
  if (_memo.rules) return _memo.rules;
  var m = {};
  rows_('CalRules').forEach(function (r) { if (r.type) m[String(r.type).trim().toUpperCase()] = { type: r.type, months: +r.months || 0, lead: +r.lead || 0 }; });
  return (_memo.rules = m);
}

function calInfo_(a) {
  if (a.status === 'DISPOSAL_PENDING' || a.status === 'RETIRED') return { state: a.calType || a.calDue ? 'INACTIVE' : '', due: a.calDue || '', recall: '' };
  var due, lead;
  if (a.calType) {
    var r = rulesMap_()[String(a.calType).trim().toUpperCase()];
    if (!r || !r.months) return { state: 'NONE', due: a.calDue || '', recall: '' };
    due = isYmd_(a.calDue) ? a.calDue : (isYmd_(a.calLast) ? addMonths_(a.calLast, r.months) : '');
    if (!due) return { state: 'MISSING', due: '', recall: '' };
    lead = r.lead;
  } else {
    if (!isYmd_(a.calDue)) return { state: '', due: '', recall: '' };
    due = a.calDue; lead = +setting_('CAL_WARN_DAYS');
  }
  var recall = addDays_(due, -lead), today = today_();
  return { state: today > due ? 'OVERDUE' : today >= recall ? 'SOON' : 'OK', due: due, recall: recall };
}

function calState_(a) { return calInfo_(a).state; }

function isYmd_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

/* ---- where things are: a project code (HO is a project), or a shop while at repair/calibration ---- */
function homeProject_() { return String(setting_('HOME_PROJECT') || 'BPNP').toUpperCase(); }

function locOf_(a) { return String(a.location || (a.status === 'RETIRED' ? '' : homeProject_())).toUpperCase(); }

function projectByCode_(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return null;
  var p = rows_('Projects').filter(function (x) { return String(x.code).toUpperCase() === code; })[0];
  if (p) return p;
  // a database without the Projects tab still knows HO and its own project
  if (!rows_('Projects').length && (code === 'HO' || code === homeProject_())) return { code: code, name: code === 'HO' ? 'สำนักงานใหญ่' : code, closedAt: '' };
  return null;
}

function userProject_(user) {
  if (!user) return '';
  var k = 'up:' + user.empId;
  if (_memo[k] === undefined) {
    var e = employee_(user.empId);
    _memo[k] = String((e && e.project) || homeProject_()).toUpperCase();
  }
  return _memo[k];
}

function pubAsset_(a, me) {
  var ci = calInfo_(a), loc = locOf_(a);
  var here = !me || loc === userProject_(me);
  var blocked = a.status !== 'AVAILABLE' || !here || (ci.state === 'OVERDUE' && setting_('CAL_BLOCK') === 'TRUE');
  return {
    code: a.code, kit: a.kit, category: a.category, type: a.type, name: a.name, brand: a.brand, model: a.model,
    serial: a.serial, status: a.status, ticketId: a.ticketId, holderName: a.holderName, since: a.since,
    mine: !!(me && a.holder && normEmp_(a.holder) === normEmp_(me.empId)),
    calDue: ci.due, cal: ci.state, ok: !blocked, note: a.note, location: loc, elsewhere: !here
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
    var map = assetMap_(), bad = [], myProj = userProject_(user);
    var uniq = codes.filter(function (c, i) { return codes.indexOf(c) === i; });
    uniq.forEach(function (c) {
      var a = map[c];
      if (!a) bad.push({ code: c, why: 'NOT_FOUND' });
      else if (a.status !== 'AVAILABLE') bad.push({ code: c, why: a.status, holder: a.holderName, ticketId: a.ticketId });
      else if (locOf_(a) !== myProj) bad.push({ code: c, why: 'ELSEWHERE', location: locOf_(a) });
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
  if (!own && !canRead_(user)) fail_('ใบเบิกนี้เป็นของผู้อื่น', 'FORBIDDEN');
  var map = assetMap_();
  var items = rows_('TicketItems').filter(function (x) { return x.ticketId === ticketId; }).map(function (x) {
    var a = map[x.code.toUpperCase()] || {};
    return {
      code: x.code, kit: x.kit, name: x.name, brand: a.brand || '', model: a.model || '', returnedAt: x.returnedAt,
      cond: x.cond, note: x.note, receivedBy: x.receivedBy, cal: a.code ? calState_(a) : '', calDue: a.code ? calInfo_(a).due : ''
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
    .map(function (a) { var ci = calInfo_(a); return { code: a.code, name: a.name, model: a.model, calDue: ci.due, cal: ci.state, status: a.status, location: locOf_(a) }; });
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
    sheetUrl: 'https://docs.google.com/spreadsheets/d/' + sheetId_() + '/edit'
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

/* ---------------- admin back office ---------------- */

/* statuses an editor may set directly; RESERVED, AT_REPAIR, AT_CAL, DISPOSAL_PENDING and RETIRED come only from move_ */
var ASSET_STATUSES = ['AVAILABLE', 'REPAIR', 'LOST', 'MISSING', 'CHECK'];
var MOVE_ONLY = { RESERVED: 1, AT_REPAIR: 1, AT_CAL: 1, DISPOSAL_PENDING: 1, RETIRED: 1, ON_LOAN: 1 };
var ASSET_FIELDS = ['kit', 'category', 'type', 'name', 'brand', 'model', 'serial', 'office', 'status', 'calLast', 'calDue', 'note',
  'calType', 'calCert', 'po', 'owner', 'warrantyStart', 'warrantyEnd'];

function snKey_(s) {
  s = String(s || '').trim().toUpperCase();
  return !s || s === '-' || s === 'N/A' || s.indexOf('ยังไม่ระบุ') === 0 ? '' : s;
}

function adminRow_(a) {
  var ci = calInfo_(a);
  return {
    code: a.code, kit: a.kit, category: a.category, type: a.type, name: a.name, brand: a.brand, model: a.model,
    serial: a.serial, office: a.office, status: a.status, ticketId: a.ticketId, holderName: a.holderName,
    since: a.since, calLast: a.calLast, calDue: ci.due, recall: ci.recall, cal: ci.state, calType: a.calType, calCert: a.calCert,
    note: a.note, location: locOf_(a), reservedFor: a.reservedFor, custodian: a.custodian, po: a.po, owner: a.owner,
    warrantyStart: a.warrantyStart, warrantyEnd: a.warrantyEnd, confirmed: String(a.confirmed).toUpperCase() !== 'FALSE'
  };
}

function adminAssets_(staff) {
  var assets = rows_('Assets').map(adminRow_);
  var kits = rows_('Kits').map(function (k) { return { kit: k.kit, name: k.name, category: k.category, main: k.main }; });
  return { assets: assets, kits: kits, statuses: ASSET_STATUSES, canEdit: canStore_(staff), projects: projectsLite_(), shops: shops_(),
    calTypes: Object.keys(rulesMap_()).map(function (k) { return rulesMap_()[k].type; }), home: homeProject_() };
}

function projectsLite_() {
  var list = rows_('Projects').map(function (p) { return { code: String(p.code).toUpperCase(), name: p.name, closed: !!p.closedAt }; });
  if (!list.length) list = [{ code: 'HO', name: 'สำนักงานใหญ่', closed: false }, { code: homeProject_(), name: homeProject_(), closed: false }];
  return list;
}

function shops_() {
  var s = {};
  rows_('Assets').forEach(function (a) { if ((a.status === 'AT_REPAIR' || a.status === 'AT_CAL') && a.location) s[a.location] = 1; });
  rows_('Events').forEach(function (e) {
    if (/^(MOVE_sendRepair|MOVE_sendCal|SI_)/.test(e.action) && e.detail.indexOf('"shop"') >= 0) {
      try { var d = JSON.parse(e.detail); if (d.shop) s[d.shop] = 1; } catch (x) { /* ignore */ }
    }
  });
  return Object.keys(s).sort();
}

function assetDetail_(staff, req) {
  var code = String(req.code || '').toUpperCase();
  var a = assetMap_()[code];
  if (!a) fail_('ไม่พบอุปกรณ์ ' + code, 'NOT_FOUND');
  var tick = {};
  rows_('Tickets').forEach(function (x) { tick[x.ticketId] = x; });
  var hist = rows_('TicketItems').filter(function (x) { return String(x.code).toUpperCase() === code; }).map(function (x) {
    var tk = tick[x.ticketId] || {};
    return { ticketId: x.ticketId, name: tk.name || '', empId: tk.empId || '', outAt: x.outAt, dueAt: tk.dueAt || '', returnedAt: x.returnedAt, cond: x.cond, note: x.note, site: tk.site || '' };
  });
  hist.sort(function (p, q) { return p.outAt < q.outAt ? 1 : -1; });
  var issues = rows_('Issues').filter(function (i) { return String(i.code).toUpperCase() === code; }).map(function (i) {
    return { issueId: i.issueId, at: i.at, type: i.type, note: i.note, status: i.status, reporter: i.reporter, ticketId: i.ticketId };
  });
  var moves = rows_('Events').filter(function (e) { return String(e.ref).toUpperCase() === code && /^(MOVE_|SI_|ASSET_)/.test(e.action); }).map(function (e) {
    var d = {};
    try { d = JSON.parse(e.detail || '{}'); } catch (x) { /* keep empty */ }
    return { at: e.at, actor: e.actor, action: e.action, d: d };
  });
  moves.sort(function (p, q) { return p.at < q.at ? 1 : -1; });
  var out = adminRow_(a);
  out.updatedAt = a.updatedAt;
  var k = a.kit ? rows_('Kits').filter(function (x) { return x.kit === a.kit; })[0] : null;
  out.kitName = k ? k.name : '';
  out.kitItems = a.kit ? rows_('Assets').filter(function (x) { return x.kit === a.kit; }).map(function (x) { return { code: x.code, name: x.name, status: x.status, location: locOf_(x) }; }) : [];
  return { asset: out, history: hist.slice(0, 40), loans: hist.length, issues: issues, moves: moves.slice(0, 60),
    canEdit: canStore_(staff), ops: canStore_(staff) ? allowedOps_(a) : [], projects: projectsLite_(), shops: shops_(),
    calTypes: Object.keys(rulesMap_()).map(function (x) { return rulesMap_()[x].type; }) };
}

function isDate_(s) { return s === '' || isYmd_(s); }

function assetSave_(admin, req) {
  var code = String(req.code || '').trim().toUpperCase();
  var f = req.fields || {};
  if (!code) fail_('กรุณากรอกรหัสอุปกรณ์', 'INPUT');
  if (!/^[A-Z0-9][A-Z0-9\/\-.]{2,40}$/.test(code)) fail_('รหัสอุปกรณ์ใช้ได้เฉพาะ A-Z 0-9 - / .', 'INPUT');
  return withLock_(function () {
    var a = assetMap_()[code], at = now_(), changes = {};
    var clean = {};
    ASSET_FIELDS.forEach(function (k) {
      if (f[k] === undefined) return;
      var v = String(f[k] == null ? '' : f[k]).trim().slice(0, k === 'note' ? 1200 : 300);
      if (k === 'kit' || k === 'type') v = v.toUpperCase();
      clean[k] = v;
    });
    if (clean.status !== undefined && ASSET_STATUSES.indexOf(clean.status) < 0) fail_('สถานะนี้เปลี่ยนผ่านหน้าแก้ไขไม่ได้ ให้ใช้รายการเคลื่อนย้าย', 'INPUT');
    ['calLast', 'calDue', 'warrantyStart', 'warrantyEnd'].forEach(function (k) {
      if (clean[k] !== undefined && !isDate_(clean[k])) fail_('วันที่ต้องเป็น ปปปป-ดด-วว (' + k + ')', 'INPUT');
    });
    var calLast = clean.calLast !== undefined ? clean.calLast : (a ? a.calLast : ''), calDue = clean.calDue !== undefined ? clean.calDue : (a ? a.calDue : '');
    if (calLast && calDue && calDue < calLast) fail_('วันครบกำหนดสอบเทียบต้องไม่ก่อนวันสอบเทียบล่าสุด', 'INPUT');
    if (calLast && calLast > today_()) fail_('วันสอบเทียบล่าสุดต้องไม่อยู่ในอนาคต', 'INPUT');
    var ws = clean.warrantyStart !== undefined ? clean.warrantyStart : (a ? a.warrantyStart : ''), we = clean.warrantyEnd !== undefined ? clean.warrantyEnd : (a ? a.warrantyEnd : '');
    if (ws && we && we < ws) fail_('วันหมดประกันต้องไม่ก่อนวันเริ่มประกัน', 'INPUT');
    if (clean.calType && !rulesMap_()[clean.calType.toUpperCase()]) fail_('ยังไม่มีกติกาสอบเทียบของประเภท ' + clean.calType + ' ให้เพิ่มในแท็บสอบเทียบก่อน', 'INPUT');
    if (clean.serial !== undefined && snKey_(clean.serial) && (!a || snKey_(a.serial) !== snKey_(clean.serial))) {
      var dupSn = rows_('Assets').filter(function (x) { return x !== a && snKey_(x.serial) === snKey_(clean.serial); })[0];
      if (dupSn) fail_('S/N ' + clean.serial + ' ซ้ำกับ ' + dupSn.code + ' ตรวจป้ายเครื่องก่อนบันทึก', 'DUP_SN');
    }
    if (req.isNew) {
      if (a) fail_('มีรหัส ' + code + ' อยู่แล้ว', 'DUP');
      var m = code.match(CODE_RE);
      var loc = String(f.location || homeProject_()).toUpperCase();
      if (!projectByCode_(loc)) fail_('ไม่พบโครงการ ' + loc, 'INPUT');
      var row = { code: code, kit: '', category: '', type: m ? m[3] : '', name: '', brand: '', model: '', serial: '', office: '',
        status: 'AVAILABLE', ticketId: '', holder: '', holderName: '', since: '', calLast: '', calDue: '', note: '', updatedAt: at,
        location: loc, reservedFor: '', custodian: '', calType: '', calCert: '', po: '', owner: '', warrantyStart: '', warrantyEnd: '', confirmed: 'TRUE' };
      if (m && m[2] !== '000') row.kit = code.split('-').slice(0, 4).join('-');
      if (m) row.category = { GN: 'GNSS', DR: 'Drone', DL: 'Digital Level', OF: 'Office' }[m[1]];
      Object.keys(clean).forEach(function (k) { if (clean[k] !== '' || k === 'note') row[k] = clean[k]; });
      if (!row.name) fail_('กรุณากรอกชื่ออุปกรณ์', 'INPUT');
      append_('Assets', [row]);
      if (row.kit && !rows_('Kits').filter(function (k) { return k.kit === row.kit; }).length) {
        append_('Kits', [{ kit: row.kit, name: row.category + ' set ' + row.kit.split('-')[3] + (row.model ? ' · ' + row.brand + ' ' + row.model : ''), category: row.category, main: code, items: 1, office: row.office }]);
      }
      event_(admin.name, 'ASSET_ADD', code, { name: row.name, kit: row.kit, location: loc });
    } else {
      if (!a) fail_('ไม่พบอุปกรณ์ ' + code, 'NOT_FOUND');
      if (clean.status !== undefined && MOVE_ONLY[a.status] && clean.status !== a.status) {
        fail_(a.status === 'ON_LOAN' ? 'อุปกรณ์นี้ถูกเบิกอยู่ (' + a.ticketId + ') ต้องคืนผ่านใบเบิกก่อนจึงเปลี่ยนสถานะได้'
          : 'สถานะ ' + a.status + ' เปลี่ยนผ่านรายการเคลื่อนย้ายเท่านั้น', a.status === 'ON_LOAN' ? 'ON_LOAN' : 'INPUT');
      }
      if (MOVE_ONLY[a.status]) delete clean.status;
      Object.keys(clean).forEach(function (k) { if (String(a[k] || '') !== clean[k]) changes[k] = [a[k] || '', clean[k]]; });
      if (!Object.keys(changes).length) return assetDetail_(admin, { code: code });
      var upd = {};
      Object.keys(changes).forEach(function (k) { upd[k] = clean[k]; });
      upd.updatedAt = at;
      update_('Assets', a, upd);
      event_(admin.name, changes.status ? 'ASSET_STATUS' : 'ASSET_EDIT', code, changes);
    }
    return assetDetail_(admin, { code: code });
  });
}

/* ---------------- HO level: reserve, issue, transfer, return, repair, calibration, disposal ----------------
 * Ported from Survey Inventory's move rules. Each op lists the statuses it starts from; the server checks them
 * again under the lock, so the screen cannot skip a step. A loaned item (ON_LOAN) must come back through its
 * ticket first. Every moved item gets one MOVE_<op> event with its state before and after. */
var MOVE_OPS = {
  reserve: ['AVAILABLE'], issue: ['AVAILABLE', 'RESERVED'], transfer: ['AVAILABLE'], returnHO: ['AVAILABLE', 'RESERVED'],
  repairWait: ['AVAILABLE', 'RESERVED'], sendRepair: ['REPAIR'], repairDone: ['AT_REPAIR'],
  sendCal: ['AVAILABLE'], calibrated: ['AT_CAL'], recordCal: ['AVAILABLE', 'RESERVED', 'REPAIR', 'AT_REPAIR'],
  requestDisposal: ['AVAILABLE', 'RESERVED', 'REPAIR', 'AT_REPAIR', 'AT_CAL', 'LOST', 'MISSING', 'CHECK'],
  completeDisposal: ['DISPOSAL_PENDING'], cancelDisposal: ['DISPOSAL_PENDING'],
  verify: ['AVAILABLE', 'RESERVED', 'REPAIR', 'AT_REPAIR', 'AT_CAL', 'LOST', 'MISSING', 'CHECK']
};
var KIT_OPS = { reserve: 1, issue: 1, transfer: 1, returnHO: 1 };

function opFits_(op, a) {
  if (MOVE_OPS[op].indexOf(a.status) < 0) return false;
  var loc = locOf_(a);
  if (op === 'reserve' || op === 'sendCal') return loc === 'HO';
  if (op === 'issue') return loc === 'HO';
  if (op === 'transfer') return loc !== 'HO';
  if (op === 'returnHO') return a.status === 'RESERVED' || loc !== 'HO';
  return true;
}

function allowedOps_(a) { return Object.keys(MOVE_OPS).filter(function (op) { return opFits_(op, a); }); }

function snap_(a) { return { status: a.status, location: locOf_(a), reservedFor: a.reservedFor || '', custodian: a.custodian || '' }; }

function move_(user, req) {
  var op = String(req.op || '');
  if (!MOVE_OPS[op]) fail_('ไม่รู้จักรายการนี้', 'INPUT');
  var codes = (req.codes || (req.code ? [req.code] : [])).map(function (c) { return String(c).trim().toUpperCase(); }).filter(String);
  codes = codes.filter(function (c, i) { return codes.indexOf(c) === i; });
  if (!codes.length) fail_('ยังไม่ได้เลือกเครื่อง', 'INPUT');
  if (codes.length > 200) fail_('ทำได้ไม่เกิน 200 รายการต่อครั้ง', 'INPUT');
  var note = String(req.note || '').trim().slice(0, 500);
  var custodian = String(req.custodian || '').trim().slice(0, 80);
  var shop = String(req.shop || '').trim().slice(0, 80);
  if ((op === 'requestDisposal' || op === 'completeDisposal' || op === 'cancelDisposal') && !note) fail_('กรุณาระบุเหตุผลหรือเลขเอกสาร', 'INPUT');
  if ((op === 'sendRepair' || op === 'sendCal') && !shop) fail_('กรุณาระบุชื่อร้าน', 'INPUT');
  var calLast = String(req.calLast || '').trim(), calDue = String(req.calDue || '').trim(), cert = String(req.cert || '').trim().slice(0, 80);
  if (op === 'calibrated' || op === 'recordCal') {
    if (!isYmd_(calLast)) fail_('กรุณาระบุวันที่สอบเทียบ (ปปปป-ดด-วว)', 'INPUT');
    if (calLast > today_()) fail_('วันที่สอบเทียบต้องไม่อยู่ในอนาคต', 'INPUT');
    if (calDue && (!isYmd_(calDue) || calDue < calLast)) fail_('วันครบกำหนดต้องไม่ก่อนวันสอบเทียบ', 'INPUT');
  }
  return withLock_(function () {
    var map = assetMap_(), at = now_(), bad = [], plan = [], seen = {};
    var proj = null, target = null;
    if (op === 'reserve' || op === 'issue' || op === 'transfer' || (op === 'verify' && req.status === 'RESERVED')) {
      proj = projectByCode_(req.project);
      if (!proj) fail_('ไม่พบโครงการ ' + (req.project || ''), 'INPUT');
      if (proj.closedAt) fail_('โครงการ ' + proj.code + ' ปิดแล้ว', 'INPUT');
      if (String(proj.code).toUpperCase() === 'HO') fail_('เลือกโครงการปลายทางที่ไม่ใช่ HO', 'INPUT');
      if (!custodian) fail_('กรุณาระบุผู้รับผิดชอบที่โครงการ', 'INPUT');
    }
    if (op === 'verify') {
      target = String(req.status || '');
      if (['AVAILABLE', 'RESERVED', 'REPAIR', 'AT_REPAIR', 'AT_CAL'].indexOf(target) < 0) fail_('สถานะที่ยืนยันไม่ถูกต้อง', 'INPUT');
      if (target === 'AT_REPAIR' || target === 'AT_CAL') { if (!shop) fail_('กรุณาระบุชื่อร้าน', 'INPUT'); }
      else if (target !== 'RESERVED') {
        var vp = projectByCode_(req.location);
        if (!vp) fail_('ไม่พบโครงการ ' + (req.location || ''), 'INPUT');
        if (vp.closedAt) fail_('โครงการ ' + vp.code + ' ปิดแล้ว', 'INPUT');
      }
    }
    var list = codes.slice();
    if (req.withKit && KIT_OPS[op]) {
      codes.forEach(function (c) {
        var a = map[c];
        // the rest of the case: same set, same place (a box left at the site does not travel with a drone kept at HO)
        if (a && a.kit) rows_('Assets').forEach(function (x) {
          if (x.kit === a.kit && x.status !== 'RETIRED' && locOf_(x) === locOf_(a) && list.indexOf(x.code.toUpperCase()) < 0) list.push(x.code.toUpperCase());
        });
      });
    }
    list.forEach(function (c) {
      if (seen[c]) return;
      seen[c] = 1;
      var a = map[c];
      if (!a) { bad.push({ code: c, why: 'NOT_FOUND' }); return; }
      if (a.status === 'ON_LOAN') { bad.push({ code: c, why: 'ON_LOAN', ticketId: a.ticketId, holder: a.holderName }); return; }
      if (!opFits_(op, a)) { bad.push({ code: c, why: 'STATE', status: a.status, location: locOf_(a) }); return; }
      var before = snap_(a), to = {}, ci = calInfo_(a), calFlag = '';
      switch (op) {
        case 'reserve': to = { status: 'RESERVED', location: 'HO', reservedFor: proj.code, custodian: custodian }; break;
        case 'issue': to = { status: 'AVAILABLE', location: proj.code, reservedFor: '', custodian: custodian }; break;
        case 'transfer':
          if (locOf_(a) === String(proj.code).toUpperCase()) { bad.push({ code: c, why: 'SAME_PROJECT' }); return; }
          to = { status: 'AVAILABLE', location: proj.code, reservedFor: '', custodian: custodian }; break;
        case 'returnHO': to = { status: 'AVAILABLE', location: 'HO', reservedFor: '', custodian: '' }; break;
        case 'repairWait': to = { status: 'REPAIR' }; break;
        case 'sendRepair': to = { status: 'AT_REPAIR', location: shop, reservedFor: '', custodian: '' }; break;
        case 'repairDone': to = { status: 'AVAILABLE', location: 'HO', reservedFor: '', custodian: '' }; break;
        case 'sendCal': to = { status: 'AT_CAL', location: shop, reservedFor: '', custodian: '' }; break;
        case 'calibrated':
        case 'recordCal':
          if (a.calLast && isYmd_(a.calLast) && calLast < a.calLast) { bad.push({ code: c, why: 'CAL_OLDER', calLast: a.calLast }); return; }
          var r = a.calType ? rulesMap_()[String(a.calType).toUpperCase()] : null;
          var due = calDue || (r && r.months ? addMonths_(calLast, r.months) : '');
          to = { calLast: calLast, calDue: due, calCert: cert || a.calCert || '' };
          if (op === 'calibrated') { to.status = 'AVAILABLE'; to.location = 'HO'; to.reservedFor = ''; to.custodian = ''; }
          break;
        case 'requestDisposal': to = { status: 'DISPOSAL_PENDING' }; break;
        case 'completeDisposal': to = { status: 'RETIRED', location: '', reservedFor: '', custodian: '' }; break;
        case 'cancelDisposal':
          var prev = lastEvent_(c, 'MOVE_requestDisposal');
          if (!prev || !prev.from) { bad.push({ code: c, why: 'NO_ORIGIN' }); return; }
          to = { status: prev.from.status, location: prev.from.location, reservedFor: prev.from.reservedFor || '', custodian: prev.from.custodian || '' };
          break;
        case 'verify':
          if (target === 'AVAILABLE' || target === 'REPAIR') to = { status: target, location: String(req.location).toUpperCase(), reservedFor: '', custodian: custodian };
          else if (target === 'RESERVED') to = { status: 'RESERVED', location: 'HO', reservedFor: proj.code, custodian: custodian };
          else to = { status: target, location: shop, reservedFor: '', custodian: '' };
          break;
      }
      // instruments past due or without calibration data cannot go out to a project (Survey Inventory's rule)
      var toProject = (op === 'issue' || op === 'transfer' || (op === 'verify' && to.status === 'AVAILABLE')) && String(to.location).toUpperCase() !== 'HO';
      if (toProject && (ci.state === 'OVERDUE' || ci.state === 'MISSING') && setting_('HO_CAL_BLOCK') === 'TRUE') {
        if (op !== 'verify') { bad.push({ code: c, why: 'CAL_' + ci.state, calDue: ci.due }); return; }
        // verify records where an instrument really is; with an expired calibration it needs a reason and is flagged
        if (!note) { bad.push({ code: c, why: 'CAL_NOTE', calDue: ci.due }); return; }
        calFlag = ci.state;
      }
      plan.push({ a: a, before: before, to: to, calFlag: calFlag });
    });
    if (bad.length) {
      var e = new Error(JSON.stringify({ msg: 'ทำรายการไม่ได้ ' + bad.length + ' รายการ', bad: bad }));
      e.code = 'MOVE_BLOCKED';
      throw e;
    }
    var confirm = { reserve: 1, issue: 1, transfer: 1, returnHO: 1, sendRepair: 1, repairDone: 1, sendCal: 1, calibrated: 1, verify: 1 }[op];
    var evs = [];
    plan.forEach(function (p) {
      var upd = {};
      Object.keys(p.to).forEach(function (k) { upd[k] = p.to[k]; });
      if (confirm) upd.confirmed = 'TRUE';
      upd.updatedAt = at;
      update_('Assets', p.a, upd);
      var d = { from: p.before, to: snap_(p.a) };
      if (note) d.note = note;
      if (shop) d.shop = shop;
      if (op === 'calibrated' || op === 'recordCal') d.cal = { calLast: p.to.calLast, calDue: p.to.calDue, cert: p.to.calCert };
      if (p.calFlag) d.calFlag = p.calFlag;
      if (list.length > codes.length) d.withKit = true;
      evs.push(evRow_(user.name, 'MOVE_' + op, p.a.code, d, at));
    });
    append_('Events', evs);
    return { op: op, moved: plan.length, assets: plan.map(function (p) { return adminRow_(p.a); }) };
  });
}

function evRow_(actor, action, ref, detail, at) {
  if (_actBy) { actor = actor + ' (กดแทนโดย ' + _actBy + ')'; detail = detail || {}; detail.actBy = _actBy; }
  return { at: at || now_(), actor: actor, action: action, ref: ref || '', detail: detail ? JSON.stringify(detail).slice(0, 2000) : '' };
}

function lastEvent_(code, action) {
  var best = null;
  rows_('Events').forEach(function (e) {
    if (e.action === action && String(e.ref).toUpperCase() === code && (!best || e.at >= best.at)) best = e;
  });
  if (!best) return null;
  try { return JSON.parse(best.detail || '{}'); } catch (x) { return null; }
}

/* ---------------- projects ---------------- */

function outstanding_(code) {
  code = String(code).toUpperCase();
  var out = [];
  rows_('Assets').forEach(function (a) {
    if (a.status === 'RETIRED') return;
    if (locOf_(a) === code || String(a.reservedFor).toUpperCase() === code) { out.push(a.code); return; }
    if (a.status === 'AT_REPAIR' || a.status === 'AT_CAL' || a.status === 'DISPOSAL_PENDING') {
      // at a shop, but it left from this project and has not come back yet
      var last = null;
      rows_('Events').forEach(function (e) {
        if (String(e.ref).toUpperCase() === a.code.toUpperCase() && /^(MOVE_|SI_)/.test(e.action) && (!last || e.at >= last.at)) last = e;
      });
      try { if (last && String(JSON.parse(last.detail).from.location).toUpperCase() === code) out.push(a.code); } catch (x) { /* ignore */ }
    }
  });
  return out;
}

function projectsList_(user) {
  var cnt = {};
  rows_('Assets').forEach(function (a) {
    if (a.status === 'RETIRED') return;
    var l = locOf_(a), r = String(a.reservedFor || '').toUpperCase();
    cnt[l] = cnt[l] || { at: 0, onLoan: 0, reserved: 0, cal: 0 };
    cnt[l].at++;
    if (a.status === 'ON_LOAN') cnt[l].onLoan++;
    var s = calState_(a);
    if (s === 'OVERDUE' || s === 'SOON' || s === 'MISSING') cnt[l].cal++;
    if (r) { cnt[r] = cnt[r] || { at: 0, onLoan: 0, reserved: 0, cal: 0 }; cnt[r].reserved++; }
  });
  var projects = rows_('Projects').map(function (p) {
    var c = cnt[String(p.code).toUpperCase()] || { at: 0, onLoan: 0, reserved: 0, cal: 0 };
    return { code: String(p.code).toUpperCase(), name: p.name, closedAt: p.closedAt, note: p.note, at: c.at, onLoan: c.onLoan, reserved: c.reserved, cal: c.cal };
  });
  var known = {};
  projects.forEach(function (p) { known[p.code] = 1; });
  var shops = Object.keys(cnt).filter(function (k) { return !known[k] && k; }).map(function (k) { return { name: k, at: cnt[k].at }; });
  return { projects: projects, shops: shops, canEdit: canStore_(user), home: homeProject_() };
}

function projectSave_(user, req) {
  var code = String(req.code || '').trim().toUpperCase(), name = String(req.name || '').trim().slice(0, 120), note = String(req.note || '').trim().slice(0, 300);
  if (!/^[A-Z0-9][A-Z0-9\-_.]{0,19}$/.test(code)) fail_('รหัสโครงการใช้ได้เฉพาะ A-Z 0-9 - _ . ไม่เกิน 20 ตัว', 'INPUT');
  if (!name) fail_('กรุณากรอกชื่อโครงการ', 'INPUT');
  return withLock_(function () {
    var p = rows_('Projects').filter(function (x) { return String(x.code).toUpperCase() === code; })[0];
    if (req.isNew) {
      if (p) fail_('มีรหัสโครงการ ' + code + ' อยู่แล้ว', 'DUP');
      append_('Projects', [{ code: code, name: name, closedAt: '', note: note, createdAt: now_() }]);
      event_(user.name, 'PROJECT_ADD', code, { name: name });
    } else {
      if (!p) fail_('ไม่พบโครงการ ' + code, 'NOT_FOUND');
      var ch = {};
      if (p.name !== name) ch.name = [p.name, name];
      if ((p.note || '') !== note) ch.note = [p.note || '', note];
      if (Object.keys(ch).length) { update_('Projects', p, { name: name, note: note }); event_(user.name, 'PROJECT_EDIT', code, ch); }
    }
    return projectsList_(user);
  });
}

function projectStatus_(user, req) {
  var code = String(req.code || '').trim().toUpperCase();
  if (code === 'HO') fail_('HO เป็นจุดรับคืนของระบบ ปิดไม่ได้', 'INPUT');
  return withLock_(function () {
    var p = rows_('Projects').filter(function (x) { return String(x.code).toUpperCase() === code; })[0];
    if (!p) fail_('ไม่พบโครงการ ' + code, 'NOT_FOUND');
    if (req.close) {
      if (p.closedAt) return projectsList_(user);
      var left = outstanding_(code);
      if (left.length) {
        var e = new Error(JSON.stringify({ msg: 'ยังมีเครื่องค้างที่โครงการนี้ ' + left.length + ' รายการ', codes: left.slice(0, 3), total: left.length }));
        e.code = 'PROJECT_BUSY';
        throw e;
      }
      update_('Projects', p, { closedAt: now_() });
      event_(user.name, 'PROJECT_CLOSE', code, {});
    } else if (p.closedAt) {
      update_('Projects', p, { closedAt: '' });
      event_(user.name, 'PROJECT_REOPEN', code, {});
    }
    return projectsList_(user);
  });
}

/* ---------------- calibration list and rules ---------------- */

function calList_(user) {
  var rules = rulesMap_(), use = {};
  var items = rows_('Assets').filter(function (a) { return a.calType || a.calDue || a.calLast; }).map(function (a) {
    var t = String(a.calType || '').toUpperCase();
    if (t) use[t] = (use[t] || 0) + 1;
    return adminRow_(a);
  });
  return {
    rules: Object.keys(rules).map(function (k) { return { type: rules[k].type, months: rules[k].months, lead: rules[k].lead, used: use[k] || 0 }; }),
    items: items, projects: projectsLite_(), canEdit: canStore_(user), today: today_()
  };
}

function calRuleSave_(user, req) {
  var type = String(req.type || '').trim().slice(0, 60);
  if (!type) fail_('กรุณากรอกประเภทเครื่อง', 'INPUT');
  var months = String(req.months), lead = String(req.lead);
  if (!req.remove) {
    if (!/^\d{1,2}$/.test(months) || +months > 60) fail_('รอบสอบเทียบต้องเป็นจำนวนเต็ม 0-60 เดือน', 'INPUT');
    if (!/^\d{1,3}$/.test(lead) || +lead > 180) fail_('เรียกกลับก่อนต้องเป็นจำนวนเต็ม 0-180 วัน', 'INPUT');
  }
  return withLock_(function () {
    var r = rows_('CalRules').filter(function (x) { return String(x.type).trim().toUpperCase() === type.toUpperCase(); })[0];
    if (req.remove) {
      if (!r) fail_('ไม่พบกติกา ' + type, 'NOT_FOUND');
      var used = rows_('Assets').filter(function (a) { return String(a.calType).toUpperCase() === type.toUpperCase(); }).length;
      if (used) fail_('ยังมีเครื่องประเภทนี้ ' + used + ' เครื่อง ลบกติกาไม่ได้ ให้ตั้งรอบเป็น 0 แทน', 'INPUT');
      update_('CalRules', r, { type: '', months: '', lead: '', note: 'ลบโดย ' + user.name + ' ' + now_() });
      event_(user.name, 'CALRULE_REMOVE', type, { months: r.months, lead: r.lead });
    } else if (r) {
      if (String(r.months) !== String(+months) || String(r.lead) !== String(+lead)) {
        event_(user.name, 'CALRULE_EDIT', type, { months: [r.months, +months], lead: [r.lead, +lead] });
        update_('CalRules', r, { months: +months, lead: +lead });
      }
    } else {
      append_('CalRules', [{ type: type, months: +months, lead: +lead, note: '' }]);
      event_(user.name, 'CALRULE_ADD', type, { months: +months, lead: +lead });
    }
    return calList_(user);
  });
}

function ticketsList_(staff, req) {
  var st = String(req.status || 'all'), q = String(req.q || '').trim().toUpperCase();
  var from = String(req.from || ''), to = String(req.to || '');
  var byCode = {};
  if (q) rows_('TicketItems').forEach(function (x) { if (String(x.code).toUpperCase().indexOf(q) >= 0) byCode[x.ticketId] = 1; });
  var list = rows_('Tickets').filter(function (t) {
    var open = t.status === 'OPEN' || t.status === 'PARTIAL';
    if (st === 'open' && !open) return false;
    if (st === 'overdue' && !(open && isOverdue_(t))) return false;
    if (st === 'closed' && t.status !== 'CLOSED') return false;
    if (from && t.createdAt.slice(0, 10) < from) return false;
    if (to && t.createdAt.slice(0, 10) > to) return false;
    if (q && !byCode[t.ticketId] && [t.ticketId, t.name, t.empId, t.site, t.purpose].join(' ').toUpperCase().indexOf(q) < 0) return false;
    return true;
  });
  list.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
  return {
    total: list.length,
    tickets: list.slice(0, 300).map(function (t) { var c = ticketCard_(t); c.empId = t.empId; c.outBy = t.outBy; c.closedAt = t.closedAt; return c; })
  };
}

function ticketDue_(staff, req) {
  var due = parseTime_(req.dueAt);
  if (!due) fail_('วันเวลาคืนไม่ถูกต้อง', 'INPUT');
  if (due.getTime() < Date.now() - 5 * 60000) fail_('วันเวลาคืนต้องไม่อยู่ในอดีต', 'INPUT');
  return withLock_(function () {
    var t = rows_('Tickets').filter(function (x) { return x.ticketId === req.ticketId; })[0];
    if (!t) fail_('ไม่พบใบเบิก', 'NOT_FOUND');
    if (t.status === 'CLOSED') fail_('ใบเบิกนี้คืนครบแล้ว', 'CLOSED');
    var old = t.dueAt;
    update_('Tickets', t, { dueAt: fmt_(due), remindedAt: '', overdueAt: '' });
    event_(staff.name, 'TICKET_DUE', t.ticketId, { from: old, to: fmt_(due) });
    return ticketView_(staff, t.ticketId);
  });
}

function dashboard_(staff, req) {
  var days = Math.max(1, Math.min(365, +req.days || 30));
  var now = Date.now(), since = now - days * 86400000;
  var sinceS = fmt_(new Date(since)).slice(0, 10);
  var inP = function (s) { return s && String(s).slice(0, 10) >= sinceS; };
  var tickets = rows_('Tickets'), items = rows_('TicketItems'), assets = rows_('Assets');
  var tP = tickets.filter(function (t) { return inP(t.createdAt); });
  var iP = items.filter(function (x) { return inP(x.outAt); });
  var rP = items.filter(function (x) { return inP(x.returnedAt); });
  var issuesP = rows_('Issues').filter(function (i) { return inP(i.at); });
  var closedP = tickets.filter(function (t) { return t.status === 'CLOSED' && inP(t.closedAt); });
  var onTime = closedP.filter(function (t) { return t.closedAt <= t.dueAt; }).length;
  var hours = closedP.map(function (t) { return (parseTime_(t.closedAt) - parseTime_(t.createdAt)) / 3600000; }).filter(function (h) { return h >= 0; });
  var byDay = {};
  for (var d = 0; d < days; d++) byDay[fmt_(new Date(now - (days - 1 - d) * 86400000)).slice(0, 10)] = { tickets: 0, items: 0 };
  tP.forEach(function (t) { var k = t.createdAt.slice(0, 10); if (byDay[k]) byDay[k].tickets++; });
  iP.forEach(function (x) { var k = x.outAt.slice(0, 10); if (byDay[k]) byDay[k].items++; });
  var amap = assetMap_(), kitName = {};
  rows_('Kits').forEach(function (k) { kitName[k.kit] = k.name; });
  var topI = {}, topU = {}, used = {};
  iP.forEach(function (x) {
    used[String(x.code).toUpperCase()] = 1;
    var key = x.kit || x.code;
    if (!topI[key]) { var a = amap[String(x.code).toUpperCase()] || {}; topI[key] = { key: key, name: x.kit ? (kitName[x.kit] || x.kit) : (x.name + (a.model ? ' · ' + a.model : '')), loans: {} }; }
    topI[key].loans[x.ticketId] = 1;
  });
  tP.forEach(function (t) { var k = t.empId + '|' + t.name; topU[k] = (topU[k] || 0) + 1; });
  var counts = {}, byLoc = {}, cal = {};
  assets.forEach(function (a) {
    counts[a.status] = (counts[a.status] || 0) + 1;
    if (a.status !== 'RETIRED') { var l = locOf_(a); byLoc[l] = (byLoc[l] || 0) + 1; }
    var s = calState_(a);
    if (s) cal[s] = (cal[s] || 0) + 1;
  });
  var pmap = {};
  projectsLite_().forEach(function (p) { pmap[p.code] = p.name; });
  var open = tickets.filter(function (t) { return t.status === 'OPEN' || t.status === 'PARTIAL'; });
  var borrowable = assets.filter(function (a) { return a.status === 'AVAILABLE' || a.status === 'ON_LOAN'; }).length;
  return {
    days: days, since: sinceS,
    kpi: {
      tickets: tP.length, items: iP.length, returned: rP.length, open: open.length,
      overdue: open.filter(isOverdue_).length,
      damaged: issuesP.filter(function (i) { return i.type === 'DAMAGED'; }).length,
      lost: issuesP.filter(function (i) { return i.type === 'LOST'; }).length,
      onTimePct: closedP.length ? Math.round(onTime * 100 / closedP.length) : null,
      avgHours: hours.length ? Math.round(hours.reduce(function (s, h) { return s + h; }, 0) / hours.length * 10) / 10 : null,
      usedPct: borrowable ? Math.round(Object.keys(used).length * 100 / borrowable) : 0,
      usedItems: Object.keys(used).length, borrowable: borrowable,
      users: rows_('Users').filter(function (u) { return u.status === 'ACTIVE'; }).length
    },
    counts: counts, total: assets.length,
    byLocation: Object.keys(byLoc).map(function (k) { return { code: k, name: pmap[k] || '', project: !!pmap[k], n: byLoc[k] }; })
      .sort(function (a, b) { return b.n - a.n; }),
    cal: cal,
    byDay: Object.keys(byDay).map(function (k) { return { day: k, tickets: byDay[k].tickets, items: byDay[k].items }; }),
    topItems: Object.keys(topI).map(function (k) { return { key: k, name: topI[k].name, loans: Object.keys(topI[k].loans).length }; })
      .sort(function (a, b) { return b.loans - a.loans; }).slice(0, 10),
    topUsers: Object.keys(topU).map(function (k) { var p = k.split('|'); return { empId: p[0], name: p[1], tickets: topU[k] }; })
      .sort(function (a, b) { return b.tickets - a.tickets; }).slice(0, 10),
    overdue: open.filter(isOverdue_).map(ticketCard_)
  };
}

function maskPhone_(p) { p = normPhone_(p); return p ? p.slice(0, 3) + '-•••-' + p.slice(-3) : ''; }

function usersList_(staff) {
  var isAdmin = staff.role === 'ADMIN';
  var emps = rows_('Employees');
  var users = rows_('Users').map(function (u) {
    var e = employee_(u.empId);
    return { lineUserId: u.lineUserId, empId: u.empId, name: u.name, lineName: u.lineName, role: u.role, status: u.status,
      lang: u.lang, createdAt: u.createdAt, approvedBy: u.approvedBy, lastSeen: u.lastSeen, position: e ? e.position : '',
      nameEn: e ? e.nameEn : '', inRegister: !!e, phoneEntered: isAdmin ? u.phoneEntered : maskPhone_(u.phoneEntered) };
  });
  var reg = {};
  rows_('Users').forEach(function (u) { if (u.status === 'ACTIVE') reg[normEmp_(u.empId)] = u.lineUserId; });
  var employees = emps.map(function (e) {
    return { empId: e.empId, name: e.name, nameEn: e.nameEn, nickname: e.nickname, nicknameEn: e.nicknameEn, position: e.position,
      email: e.email, phone: isAdmin ? e.phone : maskPhone_(e.phone), team: e.team, active: String(e.active).toUpperCase() !== 'FALSE',
      registered: !!reg[normEmp_(e.empId)], project: String(e.project || '').toUpperCase() };
  });
  var settings = {};
  Object.keys(DEFAULTS).forEach(function (k) { settings[k] = setting_(k); });
  return { users: users, employees: employees, settings: settings, me: staff.lineUserId, isAdmin: isAdmin, projects: projectsLite_(), home: homeProject_(),
    sheetUrl: isAdmin ? 'https://docs.google.com/spreadsheets/d/' + sheetId_() + '/edit' : '' };
}

function userSave_(admin, req) {
  return withLock_(function () {
    var u = rows_('Users').filter(function (x) { return x.lineUserId === req.lineUserId; })[0];
    if (!u) fail_('ไม่พบผู้ใช้', 'NOT_FOUND');
    var upd = {};
    if (req.role !== undefined) {
      if (ROLES.indexOf(req.role) < 0) fail_('สิทธิ์ไม่ถูกต้อง', 'INPUT');
      if (u.lineUserId === admin.lineUserId && req.role !== 'ADMIN') fail_('เปลี่ยนสิทธิ์ของตัวเองไม่ได้', 'INPUT');
      upd.role = req.role;
    }
    if (req.status !== undefined) {
      if (!{ ACTIVE: 1, DISABLED: 1 }[req.status]) fail_('สถานะไม่ถูกต้อง', 'INPUT');
      if (u.lineUserId === admin.lineUserId) fail_('ปิดบัญชีของตัวเองไม่ได้', 'INPUT');
      if (req.status === 'ACTIVE') {
        var dup = rows_('Users').filter(function (x) { return x !== u && x.status === 'ACTIVE' && normEmp_(x.empId) === normEmp_(u.empId); })[0];
        if (dup) fail_('รหัสพนักงานนี้มีบัญชีที่ใช้งานอยู่แล้ว (' + dup.name + ')', 'EMP_TAKEN');
        upd.approvedBy = admin.name; upd.approvedAt = now_();
      }
      upd.status = req.status;
    }
    if (!Object.keys(upd).length) fail_('ไม่มีอะไรเปลี่ยน', 'INPUT');
    var before = { role: u.role, status: u.status };
    update_('Users', u, upd);
    event_(admin.name, 'USER_SAVE', u.empId, { user: u.name, before: before, after: { role: u.role, status: u.status } });
    if (upd.status === 'ACTIVE' && before.status !== 'ACTIVE') {
      push_(u.lineUserId, card_(u.lang, 'green', t_(u.lang, 'บัญชีพร้อมใช้งานแล้ว', 'Your account is ready'),
        [t_(u.lang, 'ผู้ดูแลเปิดใช้บัญชีของคุณแล้ว', 'An admin activated your account.')], t_(u.lang, 'เปิดระบบ', 'Open'), liffUrl_('')));
    }
    return usersList_(admin);
  });
}

function employeeSave_(admin, req) {
  var f = req.fields || {};
  var empId = String(req.empId || '').trim();
  if (!/^[A-Za-z0-9]{3,20}$/.test(empId)) fail_('รหัสพนักงานใช้ได้เฉพาะตัวเลข/ตัวอักษร 3-20 ตัว', 'INPUT');
  var phone = f.phone !== undefined ? normPhone_(f.phone) : undefined;
  if (phone !== undefined && phone !== '' && !/^0\d{8,9}$/.test(phone)) fail_('เบอร์โทรต้องเป็น 9-10 หลัก ขึ้นต้นด้วย 0', 'INPUT');
  return withLock_(function () {
    var e = rows_('Employees').filter(function (x) { return normEmp_(x.empId) === normEmp_(empId) && x.empId.toUpperCase() === empId.toUpperCase(); })[0]
      || rows_('Employees').filter(function (x) { return normEmp_(x.empId) && normEmp_(x.empId) === normEmp_(empId); })[0];
    var keys = ['name', 'nameEn', 'nickname', 'nicknameEn', 'position', 'email', 'team', 'project'];
    var clean = {};
    keys.forEach(function (k) { if (f[k] !== undefined) clean[k] = String(f[k] || '').trim().slice(0, 120); });
    if (clean.project) {
      clean.project = clean.project.toUpperCase();
      if (!projectByCode_(clean.project)) fail_('ไม่พบโครงการ ' + clean.project, 'INPUT');
    }
    if (phone !== undefined) clean.phone = phone;
    if (f.active !== undefined) clean.active = f.active ? 'TRUE' : 'FALSE';
    if (req.isNew) {
      if (e) fail_('มีรหัสพนักงาน ' + empId + ' อยู่แล้ว', 'DUP');
      if (!clean.name && !clean.nameEn) fail_('กรุณากรอกชื่อ', 'INPUT');
      var row = { empId: empId, name: '', nameEn: '', nickname: '', nicknameEn: '', position: '', email: '', phone: '', team: 'Survey BPNP (MD)', active: 'TRUE', source: 'เพิ่มโดยผู้ดูแล ' + now_().slice(0, 10) };
      Object.keys(clean).forEach(function (k) { row[k] = clean[k]; });
      append_('Employees', [row]);
      event_(admin.name, 'EMP_ADD', empId, { name: row.name || row.nameEn });
    } else {
      if (!e) fail_('ไม่พบรหัสพนักงาน ' + empId, 'NOT_FOUND');
      var changed = {};
      Object.keys(clean).forEach(function (k) { if (String(e[k] || '') !== clean[k]) changed[k] = k === 'phone' ? 'changed' : clean[k]; });
      if (Object.keys(changed).length) {
        update_('Employees', e, clean);
        event_(admin.name, 'EMP_EDIT', e.empId, changed);
      }
    }
    return usersList_(admin);
  });
}

function settingsSave_(admin, req) {
  var v = req.values || {};
  var rules = {
    RETURN_TIME: function (x) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(x); },
    CAL_WARN_DAYS: function (x) { return /^\d{1,3}$/.test(x); },
    CAL_BLOCK: function (x) { return x === 'TRUE' || x === 'FALSE'; },
    REMIND_BEFORE_MIN: function (x) { return /^\d{1,4}$/.test(x); },
    OVERDUE_DAILY_HOUR: function (x) { return /^\d{1,2}$/.test(x) && +x <= 23; },
    NOTIFY_ADMINS_OVERDUE: function (x) { return x === 'TRUE' || x === 'FALSE'; },
    HOME_PROJECT: function (x) { return !!projectByCode_(x) && x !== 'HO'; },
    HO_CAL_BLOCK: function (x) { return x === 'TRUE' || x === 'FALSE'; }
  };
  var clean = {};
  Object.keys(v).forEach(function (k) {
    if (!rules[k]) return;
    var x = String(v[k]).trim().toUpperCase();
    if (!rules[k](x)) fail_('ค่าของ ' + k + ' ไม่ถูกต้อง', 'INPUT');
    clean[k] = x;
  });
  return withLock_(function () {
    var changed = {};
    Object.keys(clean).forEach(function (k) {
      var r = rows_('Settings').filter(function (x) { return x.key === k; })[0];
      if (r) { if (r.value !== clean[k]) { changed[k] = [r.value, clean[k]]; update_('Settings', r, { value: clean[k] }); } }
      else { changed[k] = ['', clean[k]]; append_('Settings', [{ key: k, value: clean[k], note: '' }]); }
    });
    if (Object.keys(changed).length) event_(admin.name, 'SETTINGS', '', changed);
    return usersList_(admin);
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
  fresh_();
  if (!rows_('Projects').length) {
    append_('Projects', [{ code: 'HO', name: 'สำนักงานใหญ่', closedAt: '', note: 'จุดรับคืนของระบบ ปิดไม่ได้', createdAt: now_() },
      { code: homeProject_(), name: homeProject_(), closedAt: '', note: '', createdAt: now_() }]);
  }
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

/* rich menu: 3 buttons that open the LIFF app. The PNG (2500x843) is read from the public GitHub repo,
   so this project does not need access to Google Drive. */
var RICHMENU_IMAGE_URL = 'https://raw.githubusercontent.com/kanyanatchai59-eng/equipment-unique/main/assets/richmenu.png';
function setupRichMenu() {
  var token = PropertiesService.getScriptProperties().getProperty('LINE_TOKEN');
  if (!token) throw new Error('need LINE_TOKEN in Script Properties');
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
  var img = UrlFetchApp.fetch(RICHMENU_IMAGE_URL, { muteHttpExceptions: true });
  if (img.getResponseCode() !== 200) throw new Error('image download ' + img.getResponseCode());
  var blob = img.getBlob();
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
