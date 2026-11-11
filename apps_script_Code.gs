/**
 * Google Apps Script — ตัวรับข้อมูลจากเว็บ Speech-Based Dementia Screening  (เวอร์ชัน 3, ปรับความปลอดภัย)
 *
 * รับ POST (body เป็น JSON แบบ text/plain) ตามช่อง type:
 *   form       บันทึกข้อมูลผู้เข้าร่วม/แบบสอบถาม ลงแท็บ Participants (1 แถวต่อ 1 SubjectID)
 *   audio      เก็บไฟล์ WAV ลง Audio/<SubjectID>/ และเพิ่มแถวในแท็บ Recordings
 *   discard    ผู้เข้าร่วมกด "ลบไฟล์" → ย้ายไฟล์ไป Audio/_Deleted/ และทำเครื่องหมาย Status=deleted (ไม่ลบถาวร)
 *   status     กลับมาทำต่อด้วยรหัสกลับมาทำต่อ → คืนว่าทำข้อไหนไปแล้ว
 *   staffcheck ตรวจรหัสเจ้าหน้าที่
 *
 * กันการโจมตี:
 *   - แก้ไข/ลบข้อมูลของคนอื่นไม่ได้ ถ้าไม่มี "รหัสกลับมาทำต่อ" (ResumeCode) ของคนนั้น
 *   - รับเฉพาะชื่อคอลัมน์ที่กำหนด (กันการยิงคอลัมน์ขยะจนชีตเต็ม)
 *   - กันสูตรในชีต (ค่าที่ขึ้นต้นด้วย = + - @ จะถูกเก็บเป็นข้อความ)
 *   - ไฟล์เสียงต้องเป็น WAV 16 kHz 16-bit mono ยาว 60 วินาที และขนาดไม่เกินที่กำหนด ตั้งชื่อไฟล์ฝั่งเซิร์ฟเวอร์
 *   - ข้อมูลทางคลินิก (Staff_*) บันทึกได้เฉพาะเมื่อแนบรหัสเจ้าหน้าที่ที่ถูกต้อง (เก็บใน Script Properties ไม่อยู่ในหน้าเว็บ)
 *   - จำกัดจำนวนครั้งต่อชั่วโมง กันการยิงไฟล์จน Drive เต็ม
 *
 * ตั้งค่าครั้งแรก: Run ฟังก์ชัน setup() 1 ครั้ง แล้วดูรหัสเจ้าหน้าที่ใน Execution log
 * (หรือ Project Settings → Script properties → STAFF_KEY)
 */

// ชีตและโฟลเดอร์เก็บไฟล์เสียง: setup() สร้างให้ใหม่ในโฟลเดอร์ "SpeechDementia_Pilot" บน Drive แล้วจำ ID ไว้ใน Script Properties
// (ถ้าต้องการใช้ชีต/โฟลเดอร์เดิม ให้ใส่ ID ใน Script Properties ชื่อ SHEET_ID และ FOLDER_ID ก่อน Run setup)
const DATA_FOLDER_NAME = 'SpeechDementia_Pilot';
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
const RECORDING_SHEET = 'Recordings';

const TASKS = ['PFT', 'CTD', 'SFT'];
const RECORD_SEC = 60;                 // ความยาวที่บังคับ (วินาที)
const MAX_AUDIO_B64 = 3500000;         // ~2.6 MB WAV
const MAX_AUDIO_PER_HOUR = 150;        // ทั้งระบบ
const MAX_STATUS_PER_10MIN = 60;       // กันการเดารหัส
const MAX_STR = 500;

const RECORDING_HEADERS = [
  'Filename', 'SubjectID', 'Task', 'Status', 'Label', 'Age', 'Gender', 'Education', 'RegionAccent',
  'DurationSec', 'Recorder', 'DateTimeISO', 'ServerTime', 'DriveFileId', 'FolderId', 'DeletedAt'
];
const PARTICIPANT_BASE_HEADERS = [
  'SubjectID', 'ResumeCode', 'FirstSaved', 'LastSaved', 'SaveCount', 'Consent', 'Age', 'Gender', 'Education', 'RegionAccent'
];
const CONTACT_HEADERS = ['SubjectID', 'Caregiver', 'LastSaved'];

// คอลัมน์ที่รับจากเว็บ (นอกจากนี้จะถูกทิ้ง)
const FORM_FIELDS = ['Consent', 'Consent_Audio', 'Age', 'Gender', 'Education', 'EducationYears', 'RegionAccent',
  'FirstLanguage', 'SpeechFactors', 'FilledBy', 'SessionStartISO', 'SessionStep', 'SessionCompleteISO',
  'TasksDone', 'UserAgent', 'AppVersion', 'StudyPhase', 'ClientTimeISO', 'Survey_Answered', 'Survey_Total',
  'MicCheck_Status', 'MicCheck_SNR_dB', 'MicCheck_RMS_DBFS']
  .concat(['IQCODE_Mode', 'IQCODE_Version', 'Informant_Consent', 'Informant_Type', 'Informant_Relation', 'Informant_Contact', 'Informant_KnownYears',
           'IQCODE_Answered', 'IQCODE_Unknown', 'IQCODE_Mean', 'IQCODE_Insufficient',
           'IQCODE_Self_Answered', 'IQCODE_Self_Unknown', 'IQCODE_Self_Mean', 'IQCODE_Self_Insufficient'])
  .concat(Array.from({ length: 16 }, (_, i) => 'IQ' + String(i + 1).padStart(2, '0')))
  .concat(Array.from({ length: 16 }, (_, i) => 'IQS' + String(i + 1).padStart(2, '0')))
  .concat([].concat.apply([], TASKS.map(t => [t + '_Attempts', t + '_FinalAttempt', t + '_FinalFile', t + '_FinalQC'])));
const STAFF_FIELDS = ['Staff_StaffID', 'Staff_Site', 'Staff_RecordingEnv', 'Staff_TMSE', 'Staff_MoCA', 'Staff_MoCA_RaterCertified',
  'Staff_MMSE_Thai2002', 'Staff_MMSE_EduGroup', 'Staff_MMSE_Orientation', 'Staff_MMSE_Recall', 'Staff_MMSE_Interpretation',
  'Staff_ClinicalGroup', 'Staff_ClinicalGroupSource', 'Staff_ClinicalAssessDate', 'Staff_StaffNotes'];
// ช่องของแบบสอบถาม IQCODE: เมื่อเปลี่ยนผู้ตอบ (ญาติ ↔ ตอบเอง ↔ ตอบภายหลัง) ช่องที่ไม่ได้ส่งมาจะถูกล้าง กันข้อมูลสองแบบปนกัน
const IQ_GROUP = FORM_FIELDS.filter(k => /^(IQ\d|IQS\d|IQCODE_|Informant_)/.test(k) && k !== 'IQCODE_Mode');
const METRIC_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9\-]{3,39}$/;
const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;

/* ---------- entry points ---------- */

function doGet() {
  return json_({ ok: true, message: 'receiver running', version: 3 });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return fail_('no_body');
    if (e.postData.contents.length > MAX_AUDIO_B64 + 200000) return fail_('too_large');
    const body = JSON.parse(e.postData.contents);
    const type = body.type || (body.AudioBase64 ? 'audio' : 'form');
    if (type === 'audio') return json_(saveAudio_(body));
    if (type === 'form') return json_(withLock_(() => saveForm_(body)));
    if (type === 'discard') return json_(withLock_(() => discard_(body)));
    if (type === 'status') return json_(status_(body));
    if (type === 'staffcheck') return json_({ ok: true, valid: staffOk_(body.staffKey) });
    return fail_('unknown_type');
  } catch (err) {
    console.error(err && err.stack || err);
    const known = String(err && err.message || '');
    return fail_(/^[a-z_]+$/.test(known) ? known : 'server_error');
  }
}

/* ---------- handlers ---------- */

function saveForm_(b) {
  const d = b.data || {};
  const sid = String(d.SubjectID || '');
  if (!SID_RE.test(sid)) throw new Error('bad_sid');
  const code = String(b.code || '');
  if (code && !CODE_RE.test(code)) throw new Error('bad_code');
  const now = new Date();

  const sheet = getSheet_('Participants', PARTICIPANT_BASE_HEADERS);
  const allowed = FORM_FIELDS.concat(staffOk_(b.staffKey) ? STAFF_FIELDS : []);
  const fields = {};
  allowed.forEach(k => { if (Object.prototype.hasOwnProperty.call(d, k)) fields[k] = d[k]; });
  const headers = ensureColumns_(sheet, ['ResumeCode'].concat(Object.keys(fields)));
  const rowIdx = findRow_(sheet, sid);
  const existing = rowIdx ? sheet.getRange(rowIdx, 1, 1, headers.length).getValues()[0] : headers.map(() => '');
  const ci = headers.indexOf('ResumeCode');

  if (rowIdx) {
    const stored = String(existing[ci] || '');
    // แถวที่มีรหัสแล้ว แก้ได้เฉพาะคนที่มีรหัสเดียวกัน
    if (stored && stored !== code) throw new Error('forbidden');
    if (!stored && !code) throw new Error('forbidden');   // แถวเก่า (ไม่มีรหัส) ต้องแนบรหัสเพื่อผูกครั้งแรก
  } else {
    if (fields.Consent !== 'yes' || fields.Consent_Audio !== 'yes') throw new Error('no_consent');
    if (!code) throw new Error('bad_code');
  }

  const resetIQ = Object.prototype.hasOwnProperty.call(fields, 'IQCODE_Mode');
  const row = headers.map((h, i) => {
    if (h === 'SubjectID') return sid;
    if (resetIQ && IQ_GROUP.indexOf(h) !== -1 && !Object.prototype.hasOwnProperty.call(fields, h)) return '';
    if (h === 'ResumeCode') return existing[i] || code;
    if (h === 'FirstSaved') return existing[i] || now;
    if (h === 'LastSaved') return now;
    if (h === 'SaveCount') return (Number(existing[i]) || 0) + 1;
    if (Object.prototype.hasOwnProperty.call(fields, h) && fields[h] !== '' && fields[h] !== null && fields[h] !== undefined) {
      return cell_(fields[h]);
    }
    return existing[i];
  });
  if (rowIdx) sheet.getRange(rowIdx, 1, 1, row.length).setValues([row]);
  else sheet.appendRow(row);

  const c = b.contact || {};
  if (c.Caregiver) {
    const cs = getSheet_('Contacts', CONTACT_HEADERS);
    const cr = findRow_(cs, sid);
    const crow = [sid, cell_(c.Caregiver), now];
    if (cr) cs.getRange(cr, 1, 1, crow.length).setValues([crow]);
    else cs.appendRow(crow);
  }
  return { ok: true, subjectId: sid };
}

function saveAudio_(b) {
  const sid = String(b.SubjectID || '');
  if (!SID_RE.test(sid)) throw new Error('bad_sid');
  const task = String(b.Task || '');
  if (TASKS.indexOf(task) === -1) throw new Error('bad_task');
  const code = String(b.code || '');
  const b64full = String(b.AudioBase64 || '');
  if (!b64full) throw new Error('no_audio');
  if (b64full.length > MAX_AUDIO_B64) throw new Error('too_large');
  if (!rate_('audio', MAX_AUDIO_PER_HOUR, 3600)) throw new Error('rate_limited');

  // ต้องเป็นผู้เข้าร่วมที่ยินยอมแล้ว และรหัสตรงกัน
  const p = participant_(sid);
  if (!p) throw new Error('no_participant');
  if (!p.code || p.code !== code) throw new Error('forbidden');
  if (p.consent !== 'yes') throw new Error('no_consent');

  const bytes = Utilities.base64Decode(b64full.split(',').pop());
  const info = wavInfo_(bytes);
  if (!info) throw new Error('bad_wav');
  if (Math.abs(info.duration - RECORD_SEC) > 1.0) throw new Error('bad_duration');

  const ts = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd_HHmmss');
  const name = sid + '_' + task + '_' + ts + '.wav';
  const folder = getOrCreateSubfolder_(getRootFolder_(), sid);
  const file = folder.createFile(Utilities.newBlob(bytes, 'audio/wav', name));

  const rec = {
    Filename: name, SubjectID: sid, Task: task, Status: 'active', Label: 'Unlabeled',
    Age: p.age, Gender: p.gender, Education: p.education, RegionAccent: p.accent,
    DurationSec: Math.round(info.duration * 10) / 10, Recorder: cell_(b.Recorder), DateTimeISO: cell_(b.DateTimeISO),
    DriveFileId: file.getId(), FolderId: folder.getId(), ServerTime: new Date()
  };
  const m = (b.Metrics && typeof b.Metrics === 'object') ? b.Metrics : {};
  Object.keys(m).slice(0, 60).forEach(k => {
    if (METRIC_KEY.test(k) && !(k in rec)) rec[k] = cell_(m[k]);
  });
  return withLock_(() => {
    // ไฟล์เดิมของข้อเดียวกันที่ยังไม่ได้ลบ → ถือว่าถูกแทนที่ (1 ข้อมีไฟล์ใช้งานได้ 1 ไฟล์)
    markTask_(sid, task, 'replaced');
    const sheet = getSheet_(RECORDING_SHEET, RECORDING_HEADERS);
    const headers = ensureColumns_(sheet, Object.keys(rec));
    sheet.appendRow(headers.map(h => (h in rec ? rec[h] : '')));
    return { ok: true, filename: name };
  });
}

function discard_(b) {
  const sid = String(b.SubjectID || '');
  const task = String(b.Task || '');
  if (!SID_RE.test(sid) || TASKS.indexOf(task) === -1) throw new Error('bad_request');
  const p = participant_(sid);
  if (!p || !p.code || p.code !== String(b.code || '')) throw new Error('forbidden');
  const n = markTask_(sid, task, 'deleted');
  return { ok: true, deleted: n };
}

function status_(b) {
  if (!rate_('status', MAX_STATUS_PER_10MIN, 600)) throw new Error('rate_limited');
  const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!CODE_RE.test(code)) throw new Error('not_found');
  const sh = getSheet_('Participants', PARTICIPANT_BASE_HEADERS);
  const data = sh.getDataRange().getValues();
  const H = data[0].map(String);
  const ci = H.indexOf('ResumeCode');
  let row = null;
  for (let i = 1; i < data.length; i++) if (String(data[i][ci]) === code) { row = data[i]; break; }
  if (!row) throw new Error('not_found');
  const get = k => { const i = H.indexOf(k); return i < 0 ? '' : row[i]; };
  const sid = String(get('SubjectID'));
  // แบบสอบถาม IQCODE ที่ตอบไว้แล้ว (เพื่อให้ผู้ให้ข้อมูลกลับมาตอบต่อได้)
  const mode = String(get('IQCODE_Mode') || '');
  const pre = mode === 'self' ? 'IQS' : 'IQ';
  const ans = {};
  for (let q = 1; q <= 16; q++) {
    const v = get(pre + String(q).padStart(2, '0'));
    if (v !== '' && v !== null && v !== undefined) ans[String(q)] = String(v) === 'NA' ? 'NA' : Number(v);
  }
  return {
    ok: true, sid: sid, consent: get('Consent') === 'yes',
    profile: { age: get('Age'), gender: get('Gender'), education: get('Education'), accent: get('RegionAccent'),
               firstLang: get('FirstLanguage'), helper: get('FilledBy') },
    iq: { mode: mode, type: String(get('Informant_Type') || ''), rel: String(get('Informant_Relation') || ''),
          contact: String(get('Informant_Contact') || ''), known: String(get('Informant_KnownYears') || ''),
          consent: String(get('Informant_Consent') || ''), ans: ans },
    tasks: activeTasks_(sid)
  };
}

/* ---------- data helpers ---------- */

function participant_(sid) {
  const sh = getSheet_('Participants', PARTICIPANT_BASE_HEADERS);
  const r = findRow_(sh, sid);
  if (!r) return null;
  const H = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const v = sh.getRange(r, 1, 1, H.length).getValues()[0];
  const get = k => { const i = H.indexOf(k); return i < 0 ? '' : v[i]; };
  return { code: String(get('ResumeCode') || ''), consent: String(get('Consent')), age: get('Age'), gender: get('Gender'),
           education: get('Education'), accent: get('RegionAccent') };
}

/** ไฟล์ที่ยังใช้งานอยู่ของแต่ละข้อ */
function activeTasks_(sid) {
  const sh = getSheet_(RECORDING_SHEET, RECORDING_HEADERS);
  const data = sh.getDataRange().getValues();
  const H = data[0].map(String);
  const iS = H.indexOf('SubjectID'), iT = H.indexOf('Task'), iSt = H.indexOf('Status'), iF = H.indexOf('Filename'),
        iQ = H.indexOf('QC_Status'), iTime = H.indexOf('ServerTime');
  const out = {};
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (String(r[iS]) !== sid) continue;
    const st = iSt < 0 ? '' : String(r[iSt]);
    if (st === 'deleted' || st === 'replaced') continue;
    out[String(r[iT])] = { filename: String(r[iF]), qc: iQ < 0 ? '' : String(r[iQ]),
                           when: r[iTime] instanceof Date ? r[iTime].toISOString() : String(r[iTime]) };
  }
  return out;
}

/** ทำเครื่องหมายไฟล์ของข้อนั้นที่ยังใช้งานอยู่ แล้วย้ายไฟล์ไปโฟลเดอร์ _Deleted (ไม่ลบถาวร) */
function markTask_(sid, task, newStatus) {
  const sh = getSheet_(RECORDING_SHEET, RECORDING_HEADERS);
  const headers = ensureColumns_(sh, ['Status', 'DeletedAt']);
  const n = sh.getLastRow();
  if (n < 2) return 0;
  const data = sh.getRange(2, 1, n - 1, headers.length).getValues();
  const iS = headers.indexOf('SubjectID'), iT = headers.indexOf('Task'), iSt = headers.indexOf('Status'),
        iD = headers.indexOf('DeletedAt'), iF = headers.indexOf('DriveFileId');
  let count = 0;
  data.forEach((r, k) => {
    if (String(r[iS]) !== sid || String(r[iT]) !== task) return;
    const st = String(r[iSt]);
    if (st === 'deleted' || st === 'replaced') return;
    sh.getRange(k + 2, iSt + 1).setValue(newStatus);
    sh.getRange(k + 2, iD + 1).setValue(new Date());
    try {
      const del = getOrCreateSubfolder_(getOrCreateSubfolder_(getRootFolder_(), '_Deleted'), sid);
      DriveApp.getFileById(String(r[iF])).moveTo(del);
    } catch (e) { console.warn('move failed ' + r[iF]); }
    count++;
  });
  return count;
}

/** อ่านหัวไฟล์ WAV: ต้องเป็น PCM 16-bit mono 16 kHz */
function wavInfo_(bytes) {
  if (!bytes || bytes.length < 44) return null;
  const s = (o, n) => String.fromCharCode.apply(null, bytes.slice(o, o + n).map(x => x & 255));
  const u16 = o => (bytes[o] & 255) | ((bytes[o + 1] & 255) << 8);
  const u32 = o => (u16(o) | (u16(o + 2) << 16)) >>> 0;
  if (s(0, 4) !== 'RIFF' || s(8, 4) !== 'WAVE' || s(12, 4) !== 'fmt ') return null;
  if (u16(20) !== 1 || u16(22) !== 1 || u32(24) !== 16000 || u16(34) !== 16) return null;
  if (s(36, 4) !== 'data') return null;
  const dataLen = Math.min(u32(40), bytes.length - 44);
  return { duration: dataLen / 32000 };
}

/* ---------- security helpers ---------- */

function staffOk_(key) {
  const k = PropertiesService.getScriptProperties().getProperty('STAFF_KEY');
  return !!k && typeof key === 'string' && key.length >= 6 && key === k;
}

/** ค่าที่จะเขียนลงชีต: ตัดความยาว และกันไม่ให้กลายเป็นสูตร */
function cell_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  let s = String(v).slice(0, MAX_STR);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s;
}

/** จำกัดจำนวนครั้งในช่วงเวลา (ทั้งระบบ) */
function rate_(name, max, sec) {
  const cache = CacheService.getScriptCache();
  const key = 'rl_' + name + '_' + Math.floor(Date.now() / 1000 / sec);
  const n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), sec + 60);
  return n <= max;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------- sheet helpers ---------- */

function getRootFolder_() { const id = prop_('FOLDER_ID'); if (!id) throw new Error('not_setup'); return DriveApp.getFolderById(id); }
function getSpreadsheet_() { const id = prop_('SHEET_ID'); if (!id) throw new Error('not_setup'); return SpreadsheetApp.openById(id); }

function getSheet_(name, headers) {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function ensureColumns_(sheet, keys) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const missing = keys.filter(k => headers.indexOf(k) === -1);
  if (missing.length) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    return headers.concat(missing);
  }
  return headers;
}

function findRow_(sheet, sid) {
  const n = sheet.getLastRow();
  if (n < 2) return 0;
  const ids = sheet.getRange(2, 1, n - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === sid) return i + 2;
  return 0;
}

function getOrCreateSubfolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function fail_(code) { return json_({ ok: false, error: code }); }

/** Run 1 ครั้ง: ให้สิทธิ์ สร้างแท็บ และสร้างรหัสเจ้าหน้าที่ (ดูใน Execution log) */
function setup() {
  const P = PropertiesService.getScriptProperties();
  if (!P.getProperty('SHEET_ID') || !P.getProperty('FOLDER_ID')) {
    const top = DriveApp.createFolder(DATA_FOLDER_NAME);
    const audio = top.createFolder('Audio');
    const ss = SpreadsheetApp.create('SpeechDementia_Pilot_Data');
    DriveApp.getFileById(ss.getId()).moveTo(top);
    const first = ss.getSheets()[0];
    P.setProperties({ SHEET_ID: ss.getId(), FOLDER_ID: audio.getId() });
    getSheet_('Participants', PARTICIPANT_BASE_HEADERS);
    ss.deleteSheet(first);
    Logger.log('สร้างโฟลเดอร์ใหม่: ' + top.getUrl());
  }
  getRootFolder_();
  getSheet_(RECORDING_SHEET, RECORDING_HEADERS);
  ensureColumns_(getSheet_(RECORDING_SHEET, RECORDING_HEADERS), ['Status', 'DeletedAt']);
  ensureColumns_(getSheet_('Participants', PARTICIPANT_BASE_HEADERS), ['ResumeCode']);
  getSheet_('Contacts', CONTACT_HEADERS);
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('STAFF_KEY')) {
    const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let k = ''; for (let i = 0; i < 10; i++) k += abc[Math.floor(Math.random() * abc.length)];
    props.setProperty('STAFF_KEY', k);
  }
  Logger.log('ready: ' + getSpreadsheet_().getUrl());
  Logger.log('STAFF_KEY = ' + props.getProperty('STAFF_KEY'));
}
