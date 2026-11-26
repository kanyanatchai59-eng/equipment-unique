"""Merge a Survey Inventory export (xlsx, 4 sheets) into the EQUIPMENT Unique database.

Usage: python3 merge_si.py <base db.json> <survey inventory export.xlsx> <out prefix>
Writes <out>.json (sheet -> rows incl. header, the test harness format), <out>.xlsx (all tabs as text,
for uploading as a Google Sheet) and <out>-report.md (what was merged and what conflicts).

Rules
- The 30 instruments in both registers are matched by code and checked by S/N. Location/status/custodian come
  from Survey Inventory (the newer record); where it disagrees with the BPNP team's register the row is marked
  confirmed=FALSE and a SI_MERGE event keeps both versions.
- Instruments only in Survey Inventory are added. Codes "ยังไม่ระบุN" become TMP-NNN (the old code is kept in
  the note and in the events) because asset codes must be A-Z 0-9.
- All Survey Inventory movement history is copied as SI_<op> events with the state before and after.
- The script is deterministic, so the cut-over can run it again on the final export.
"""
import json, re, sys, collections
import openpyxl
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

BASE, SRC, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
EXPORT_DATE = '2026-11-25'

ASSET_HEAD = ['code', 'kit', 'category', 'type', 'name', 'brand', 'model', 'serial', 'office', 'status', 'ticketId',
              'holder', 'holderName', 'since', 'calLast', 'calDue', 'note', 'updatedAt',
              'location', 'reservedFor', 'custodian', 'calType', 'calCert', 'po', 'owner', 'warrantyStart', 'warrantyEnd', 'confirmed']
EMP_HEAD_ADD = ['project']

STATUS = {'พร้อมเบิก': 'AVAILABLE', 'รอเบิกใช้งาน': 'RESERVED', 'ใช้งานหน้างาน': 'AVAILABLE', 'รอร้านรับซ่อม': 'REPAIR',
          'ส่งซ่อมแล้ว': 'AT_REPAIR', 'ส่ง Calibrate แล้ว': 'AT_CAL', 'รอตัดจำหน่าย': 'DISPOSAL_PENDING', 'ตัดจำหน่ายแล้ว': 'RETIRED'}
OPS = {'ยืนยันข้อมูลปัจจุบัน': 'verify', 'ส่ง Calibrate': 'sendCal', 'รับคืนเข้า HO': 'returnHO', 'จ่ายไปหน้างาน': 'issue',
       'จองรอเบิก': 'reserve', 'บันทึกใบรับรอง Calibrate': 'recordCal', 'แจ้งรอร้านรับซ่อม': 'repairWait',
       'รับคืนและบันทึกผล Calibrate': 'calibrated', 'โอน': 'transfer', 'ร้านรับซ่อม': 'sendRepair', 'รับจากซ่อม': 'repairDone',
       'ขอตัดจำหน่าย': 'requestDisposal', 'ตัดจำหน่าย': 'completeDisposal', 'ยกเลิกรอตัดจำหน่าย': 'cancelDisposal'}
TYPE2 = {'GNSS': 'RC', 'Digital Level': 'DL', 'Total Station': 'TS', 'Drone': 'DR', 'LiDAR': 'LD', 'Prism': 'PR', 'Digital Theodolite': 'TH'}
OUR_CALTYPE = {('GNSS', 'RC'): 'GNSS', ('Digital Level', 'DL'): 'Digital Level', ('Drone', 'DR'): 'Drone', ('Drone', 'LD'): 'LiDAR'}
PROJECT_NAMES = {'HO': 'สำนักงานใหญ่', 'BPNP': 'บ้านไผ่–นครพนม C2', '011': 'หนองโดน - สระบุรี', '4-6': 'ไทยจีน 4-6'}
SHOPS = {'GIS', 'CST', 'TOPCON'}


def s(v):
    return '' if v is None else str(v).strip()


def blank(v):
    v = s(v)
    return '' if v in ('-', '--') else v


def code_of(c):
    c = s(c)
    m = re.match(r'^ยังไม่ระบุ(\d*)$', c)
    return 'TMP-%03d' % int(m.group(1) or 0) if m else c.upper()


def iso(t):
    m = re.match(r'(\d{2})/(\d{2})/(\d{4}), (\d{2}):(\d{2})', s(t))
    return '%s-%s-%sT%s:%s:00' % (m.group(3), m.group(2), m.group(1), m.group(4), m.group(5)) if m else s(t)


def loc_of(place):
    p = s(place).upper()
    return {'BANPHAI': 'BANPHAI'}.get(p, p)


base = json.load(open(BASE))
si = openpyxl.load_workbook(SRC, data_only=True)


def sheet_rows(name):
    it = si[name].iter_rows(values_only=True)
    head = [s(h) for h in next(it)]
    return [dict(zip(head, r)) for r in it if any(v not in (None, '') for v in r)]


reg = sheet_rows('ทะเบียนเครื่องมือ')
cal = {s(r['รหัสทรัพย์สิน']): r for r in sheet_rows('กำหนด Calibrate')}
mov = sheet_rows('เบิกคืนและเคลื่อนไหว')
rules = sheet_rows('กติกา Calibrate')

# ---------- base tables as dicts ----------
def as_dicts(name):
    rows = base[name]
    return rows[0], [dict(zip(rows[0], r)) for r in rows[1:]]

ahead, assets = as_dicts('Assets')
by_code = {a['code'].upper(): a for a in assets}
for a in assets:
    for h in ASSET_HEAD:
        a.setdefault(h, '')
    a['location'] = 'BPNP'
    a['confirmed'] = 'TRUE'
    ct = OUR_CALTYPE.get((a['category'], a['type']))
    if ct:
        a['calType'] = ct

events_si = collections.defaultdict(list)
for e in mov:
    events_si[code_of(e['รหัสทรัพย์สิน'])].append(e)
for k in events_si:
    events_si[k].sort(key=lambda e: iso(e['วันที่และเวลา (ไทย)']))

report = {'merged': [], 'conflict': [], 'added': [], 'tmp': [], 'sn_mismatch': []}
new_events = []
at_now = EXPORT_DATE + 'T00:00:00'

for r in reg:
    raw = s(r['รหัสทรัพย์สิน'])
    code = code_of(raw)
    c = cal.get(raw, {})
    st = STATUS.get(s(r['สถานะเครื่องมือ']), 'CHECK')
    place = loc_of(c.get('ตำแหน่ง'))
    holder = blank(c.get('ผู้ถือครอง'))
    reserved_for = ''
    if st == 'RESERVED':
        res = [e for e in events_si[code] if s(e['รายการ']) == 'จองรอเบิก']
        reserved_for = s(res[-1]['จองให้โครงการ']).upper() if res else ''
    if st in ('AT_REPAIR', 'AT_CAL'):
        place = s(c.get('ตำแหน่ง'))  # shop name keeps its case
    fields = {
        'po': s(r['PO']), 'owner': s(r['เจ้าของทรัพย์สิน']), 'warrantyStart': s(r['เริ่มประกัน']), 'warrantyEnd': s(r['หมดประกัน']),
        'calType': s(r['ประเภท']), 'calLast': s(c.get('Calibrate ล่าสุด')), 'calDue': s(c.get('ครบกำหนดตามใบรับรองหรือข้อมูลเดิม')),
        'status': st, 'location': place, 'reservedFor': reserved_for, 'custodian': holder,
    }
    certs = [s(e['ใบรับรอง']) for e in events_si[code] if s(e['ใบรับรอง'])]
    if certs:
        fields['calCert'] = certs[-1]
    note_si = '; '.join(x for x in [s(r['หมายเหตุ']), s(r['ส่วนประกอบและจำนวน'])] if x)
    touched = bool(events_si[code])
    if code in by_code:
        a = by_code[code]
        if s(a['serial']).upper() != s(r['Serial No.']).upper():
            report['sn_mismatch'].append((code, a['serial'], s(r['Serial No.'])))
        ours = {'status': a['status'], 'location': a['location']}
        same = (ours['status'] == st and ours['location'] == place)
        a.update({k: v for k, v in fields.items() if v != '' or k in ('reservedFor', 'custodian')})
        a['confirmed'] = 'TRUE' if same else 'FALSE'
        if not same:
            a['note'] = ((a['note'] + ' | ') if a['note'] else '') + 'รอยืนยันตำแหน่ง: ทะเบียนทีม BPNP 17 พ.ย. = อยู่ไซต์ BPNP, Survey Inventory 25 พ.ย. = %s ที่ %s' % (s(r['สถานะเครื่องมือ']), place)
            report['conflict'].append((code, a['name'], a['model'], s(r['สถานะเครื่องมือ']), place))
        else:
            report['merged'].append(code)
        new_events.append({'at': at_now, 'actor': 'นำเข้า Survey Inventory', 'action': 'SI_MERGE', 'ref': code,
                           'detail': json.dumps({'ours': ours, 'si': {'status': st, 'location': place, 'custodian': holder},
                                                 'conflict': not same, 'source': 'export ' + EXPORT_DATE}, ensure_ascii=False)})
    else:
        typ = s(r['ประเภท'])
        a = {h: '' for h in ASSET_HEAD}
        a.update({'code': code, 'category': typ, 'type': TYPE2.get(typ, 'XX'), 'name': typ, 'brand': s(r['ยี่ห้อ']),
                  'model': s(r['รุ่น']), 'serial': s(r['Serial No.']), 'updatedAt': at_now,
                  'confirmed': 'TRUE' if touched else 'FALSE'})
        a.update(fields)
        notes = []
        if code != raw.upper():
            notes.append('ยังไม่มีรหัสทรัพย์สินจริง (Survey Inventory: %s)' % raw)
            report['tmp'].append((code, raw, typ, s(r['รุ่น']), s(r['Serial No.'])))
        if note_si:
            notes.append(note_si)
        a['note'] = ' | '.join(notes)
        assets.append(a)
        by_code[code] = a
        report['added'].append(code)

# ---------- movement history ----------
for code, evs in events_si.items():
    for e in evs:
        op = OPS.get(s(e['รายการ']), 'other')
        d = {'from': {'status': STATUS.get(s(e['จากสถานะ']), s(e['จากสถานะ'])), 'location': loc_of(e['จากตำแหน่ง']) if s(e['จากตำแหน่ง']).upper() not in SHOPS else s(e['จากตำแหน่ง']),
                      'custodian': blank(e['ผู้ถือครองเดิม'])},
             'to': {'status': STATUS.get(s(e['ไปสถานะ']), s(e['ไปสถานะ'])), 'location': loc_of(e['ปลายทาง']) if s(e['ปลายทาง']).upper() not in SHOPS else s(e['ปลายทาง']),
                    'reservedFor': s(e['จองให้โครงการ']).upper(), 'custodian': blank(e['ผู้ถือครองใหม่'])},
             'thai': s(e['รายการ']), 'by': s(e['ผู้บันทึก']), 'source': 'Survey Inventory'}
        if s(e['หมายเหตุ']):
            d['note'] = s(e['หมายเหตุ'])
        if op in ('sendCal', 'sendRepair'):
            d['shop'] = s(e['ปลายทาง'])
        if s(e['วันที่ Calibrate']) or s(e['ใบรับรอง']):
            d['cal'] = {'calLast': s(e['วันที่ Calibrate']), 'calDue': s(e['ครบกำหนดหลัง Calibrate']), 'cert': s(e['ใบรับรอง'])}
        new_events.append({'at': iso(e['วันที่และเวลา (ไทย)']), 'actor': 'Survey Inventory', 'action': 'SI_' + op, 'ref': code,
                           'detail': json.dumps(d, ensure_ascii=False)})

# ---------- projects, rules, settings, employees ----------
proj_codes = {'HO', 'BPNP'}
for a in assets:
    if a['location'] and a['status'] not in ('AT_REPAIR', 'AT_CAL'):
        proj_codes.add(a['location'].upper())
    if a['reservedFor']:
        proj_codes.add(a['reservedFor'].upper())
for e in mov:
    for k in ('จากตำแหน่ง', 'ปลายทาง', 'จองให้โครงการ'):
        v = s(e[k]).upper()
        if v and v not in SHOPS:
            proj_codes.add(loc_of(v))
projects = []
for c in sorted(proj_codes, key=lambda x: (x != 'HO', x != 'BPNP', x)):
    name = PROJECT_NAMES.get(c, '')
    note = 'จุดรับคืนของระบบ ปิดไม่ได้' if c == 'HO' else ('' if name else 'รอยืนยันชื่อโครงการจากอิก (พบรหัสนี้ใน Survey Inventory)')
    if c == 'BANPHAI':
        note = 'อาจซ้ำกับ BPNP รอยืนยันจากอิก'
    projects.append({'code': c, 'name': name or c, 'closedAt': '', 'note': note, 'createdAt': at_now})

calrules = [{'type': s(r['ประเภท']), 'months': s(r['รอบ (เดือน) · 0 = ไม่มีรอบ']), 'lead': s(r['เรียกกลับก่อน (วัน)']),
             'note': 'จาก Survey Inventory (ค่าตั้งต้น ยังไม่ได้ทบทวน)'} for r in rules]

shead, settings = as_dicts('Settings')
have = {x['key'] for x in settings}
for k, v, n in [('HOME_PROJECT', 'BPNP', 'โครงการของทีมที่เบิก–คืนรายวัน (พนักงานที่ไม่ได้ระบุโครงการ)'),
                ('HO_CAL_BLOCK', 'TRUE', 'TRUE = จ่าย/โอนไปโครงการไม่ได้ถ้า Calibrate เกินกำหนดหรือไม่มีข้อมูล (กติกาเดิมของ Survey Inventory)')]:
    if k not in have:
        settings.append({'key': k, 'value': v, 'note': n})

ehead, emps = as_dicts('Employees')
for e in emps:
    e.setdefault('project', '')

out = {}
out['Assets'] = [ASSET_HEAD] + [[s(a.get(h, '')) for h in ASSET_HEAD] for a in assets]
for name in ['Kits', 'Tickets', 'TicketItems', 'Issues', 'Users']:
    out[name] = base[name]
eh = ehead + [h for h in EMP_HEAD_ADD if h not in ehead]
out['Employees'] = [eh] + [[s(e.get(h, '')) for h in eh] for e in emps]
evh = ['at', 'actor', 'action', 'ref', 'detail']
_, old_events = as_dicts('Events')
summary = {'at': at_now, 'actor': 'นำเข้า Survey Inventory', 'action': 'IMPORT_SI', 'ref': 'export ' + EXPORT_DATE,
           'detail': json.dumps({'merged': len(report['merged']), 'conflict': len(report['conflict']), 'added': len(report['added']),
                                 'tmpCodes': len(report['tmp']), 'events': len(mov)}, ensure_ascii=False)}
all_ev = old_events + sorted(new_events, key=lambda e: e['at']) + [summary]
out['Events'] = [evh] + [[s(e.get(h, '')) for h in evh] for e in all_ev]
out['Settings'] = [shead] + [[s(x.get(h, '')) for h in shead] for x in settings]
out['Projects'] = [['code', 'name', 'closedAt', 'note', 'createdAt']] + [[p[h] for h in ['code', 'name', 'closedAt', 'note', 'createdAt']] for p in projects]
out['CalRules'] = [['type', 'months', 'lead', 'note']] + [[r[h] for h in ['type', 'months', 'lead', 'note']] for r in calrules]

json.dump(out, open(OUT + '.json', 'w'), ensure_ascii=False)

wb = openpyxl.Workbook()
wb.remove(wb.active)
for name in ['Assets', 'Kits', 'Tickets', 'TicketItems', 'Issues', 'Users', 'Employees', 'Events', 'Settings', 'Projects', 'CalRules']:
    ws = wb.create_sheet(name)
    for row in out[name]:
        ws.append(row)
    for c in ws[1]:
        c.font = Font(bold=True, color='FFFFFF')
        c.fill = PatternFill('solid', fgColor='95191F')
    ws.freeze_panes = 'A2'
    for i, h in enumerate(out[name][0], 1):
        width = max([len(str(h))] + [len(str(r[i - 1])) for r in out[name][1:200] if i - 1 < len(r)] + [6])
        ws.column_dimensions[get_column_letter(i)].width = min(width + 2, 48)
    for row in ws.iter_rows(min_row=1):
        for c in row:
            c.number_format = '@'
wb.save(OUT + '.xlsx')

cnt = collections.Counter((a['location'] if a['status'] not in ('AT_REPAIR', 'AT_CAL') else 'ร้าน: ' + a['location'], a['status']) for a in assets)
with open(OUT + '-report.md', 'w') as f:
    f.write('# รายงานซ้อมนำเข้า Survey Inventory (ไฟล์ส่งออก %s)\n\n' % EXPORT_DATE)
    f.write('- ทะเบียนเดิมของระบบเบิก–คืน: %d รายการ\n' % (len(assets) - len(report['added'])))
    f.write('- เครื่องที่อยู่ทั้งสองระบบ (รหัสและ S/N ตรงกัน): %d รายการ ตรงกัน %d ขัดกัน %d\n' % (len(report['merged']) + len(report['conflict']), len(report['merged']), len(report['conflict'])))
    f.write('- เพิ่มจาก Survey Inventory: %d รายการ (ในนี้ %d รายการยังไม่มีรหัสจริง ตั้งเป็น TMP-xxx)\n' % (len(report['added']), len(report['tmp'])))
    f.write('- ประวัติเคลื่อนไหวที่คัดลอกมา: %d รายการ\n' % len(mov))
    f.write('- รวมหลังนำเข้า: %d รายการ\n' % len(assets))
    f.write('- S/N ไม่ตรงในรหัสเดียวกัน: %d\n\n' % len(report['sn_mismatch']))
    f.write('## เครื่องที่ข้อมูลขัดกัน (ตั้งตาม Survey Inventory และติดป้ายรอยืนยัน)\n\n| รหัส | อุปกรณ์ | รุ่น | สถานะใน Survey Inventory | ตำแหน่ง |\n|---|---|---|---|---|\n')
    for x in report['conflict']:
        f.write('| %s | %s | %s | %s | %s |\n' % x)
    f.write('\n## รหัสชั่วคราว\n\n| รหัสใหม่ | รหัสใน Survey Inventory | ประเภท | รุ่น | S/N |\n|---|---|---|---|---|\n')
    for x in report['tmp']:
        f.write('| %s | %s | %s | %s | %s |\n' % x)
    f.write('\n## จำนวนตามตำแหน่งและสถานะหลังนำเข้า\n\n| ตำแหน่ง | สถานะ | จำนวน |\n|---|---|---|\n')
    for (loc, st), n in sorted(cnt.items()):
        f.write('| %s | %s | %d |\n' % (loc or '-', st, n))
    f.write('\n## โครงการที่สร้าง\n\n| รหัส | ชื่อ | หมายเหตุ |\n|---|---|---|\n')
    for p in projects:
        f.write('| %s | %s | %s |\n' % (p['code'], p['name'], p['note']))
print(json.dumps({k: len(v) for k, v in report.items()}), 'assets', len(assets), 'events', len(all_ev), 'projects', [p['code'] for p in projects])
