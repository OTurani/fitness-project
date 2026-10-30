/**
 * 78 KG MISSION CONTROL — backend (Google Apps Script, bound to your Google Sheet)
 *
 * What this file does
 *  - setup()            creates the database tabs, Config, Targets, Data_Dictionary, an API token,
 *                       and enters the 24 Oct 2026 baseline. Safe to run more than once.
 *  - doGet()            serves the dashboard (owner only) and a token-protected JSON summary.
 *  - doPost()           token-protected ingest endpoint for ChatGPT (Custom GPT Action) or any automation.
 *  - ingest_()          validates, normalises units, de-duplicates (upsert on a natural key) and writes rows.
 *  - rebuildDailySummary() writes a flat Daily_Summary tab (handy for Looker Studio / quick checks).
 *
 * Your original tabs (Dashboard, Daily Log, Workout Log, Goals) are never modified, except that setup()
 * fixes the number formats of the Daily Log numeric columns (values are untouched).
 */

var APP_VERSION = '1.1.0';
var DEFAULT_TZ = 'Asia/Riyadh';

/* ------------------------------------------------------------------ schema */

var TABLES = {
  Nutrition: {
    prefix: 'NUT',
    cols: ['record_id', 'date', 'time', 'meal', 'item', 'entry_level', 'calories_kcal', 'protein_g', 'carbs_g', 'fat_g',
           'quantity', 'data_quality', 'source', 'logged_at', 'notes'],
    nums: ['calories_kcal', 'protein_g', 'carbs_g', 'fat_g'],
    key: function (r) {
      return r.entry_level === 'day_total' ? [r.date, 'day_total'] : [r.date, 'meal', lc_(r.meal), lc_(r.item)];
    }
  },
  Body: {
    prefix: 'BDY',
    cols: ['record_id', 'date', 'time', 'metric', 'value', 'unit', 'data_quality', 'conditions', 'source', 'logged_at', 'notes'],
    nums: ['value'],
    key: function (r) { return [r.date, lc_(r.metric), r.time || '']; }
  },
  Sessions: {
    prefix: 'SES',
    cols: ['record_id', 'date', 'session_name', 'status', 'duration_min', 'session_rpe', 'source', 'logged_at', 'notes'],
    nums: ['duration_min', 'session_rpe'],
    key: function (r) { return [r.date, lc_(r.session_name)]; }
  },
  Sets: {
    prefix: 'SET',
    cols: ['record_id', 'date', 'session_name', 'exercise', 'equipment', 'muscle_group', 'set_no', 'weight_kg', 'reps',
           'duration_min', 'distance_km', 'rpe', 'is_warmup', 'data_quality', 'source', 'logged_at', 'notes'],
    nums: ['set_no', 'weight_kg', 'reps', 'duration_min', 'distance_km', 'rpe'],
    key: function (r) { return [r.date, lc_(r.exercise), lc_(r.equipment), r.set_no]; }
  },
  Supplements: {
    prefix: 'SUP',
    cols: ['record_id', 'date', 'supplement', 'amount', 'unit', 'taken', 'source', 'logged_at', 'notes'],
    nums: ['amount'],
    key: function (r) { return [r.date, lc_(r.supplement)]; }
  },
  Recovery: {
    prefix: 'REC',
    cols: ['record_id', 'date', 'sleep_hours', 'energy_1to5', 'soreness_1to5', 'resting_hr_bpm', 'hrv_ms', 'steps',
           'is_rest_day', 'source', 'logged_at', 'notes'],
    nums: ['sleep_hours', 'energy_1to5', 'soreness_1to5', 'resting_hr_bpm', 'hrv_ms', 'steps'],
    key: function (r) { return [r.date, lc_(r.source || 'manual')]; }
  }
};

// payload property name -> sheet/table name
var PAYLOAD_KEYS = {
  nutrition: 'Nutrition', body: 'Body', sessions: 'Sessions', sets: 'Sets', supplements: 'Supplements', recovery: 'Recovery'
};

var RANGES = {
  calories_kcal: [0, 10000], protein_g: [0, 600], carbs_g: [0, 1500], fat_g: [0, 600],
  duration_min: [0, 600], session_rpe: [1, 10], set_no: [1, 50], weight_kg: [0, 1000], reps: [0, 300],
  distance_km: [0, 200], rpe: [1, 10], amount: [0, 100000], sleep_hours: [0, 24], energy_1to5: [1, 5],
  soreness_1to5: [1, 5], resting_hr_bpm: [25, 220], hrv_ms: [1, 400], steps: [0, 200000]
};

var BODY_METRICS = {
  weight: { unit: 'kg', range: [30, 250] },
  waist: { unit: 'cm', range: [40, 200] },
  chest: { unit: 'cm', range: [50, 200] },
  arm: { unit: 'cm', range: [15, 70] },
  thigh: { unit: 'cm', range: [30, 110] },
  body_fat: { unit: '%', range: [3, 60] }
};

var QUALITY = ['confirmed', 'estimated', 'reported'];
var SESSION_STATUS = ['completed', 'missed', 'partial', 'rest'];

var CONFIG_DEFAULTS = [
  ['start_weight_kg', 69, 'kg', 'Approximate, self-reported. Not a confirmed weigh-in.'],
  ['target_weight_kg', 78, 'kg', ''],
  ['height_cm', 175, 'cm', ''],
  ['program_start_date', '2026-10-24', 'date', 'First recorded comeback session'],
  ['training_days', 'Sat,Mon,Wed', 'days', 'Preferred days only (a guide). Progress counts sessions per week, any day.'],
  ['sessions_per_week', 3, 'sessions', 'Weekly workout target. Any 3 sessions Sat–Fri = 100%.'],
  ['session_minutes_target', 60, 'min', ''],
  ['creatine_target_g', 5, 'g', ''],
  ['creatine_start_date', '2026-10-26', 'date', ''],
  ['week_starts_on', 'Sat', 'day', 'Weekly reports run Sat–Fri'],
  ['calorie_tolerance_pct', 10, '%', 'A day counts as on-target when within ± this % of the calorie target'],
  ['timezone', DEFAULT_TZ, 'tz', '']
];

var TARGETS_COLS = ['effective_from', 'calorie_target_kcal', 'protein_target_g', 'notes'];
var LOG_COLS = ['request_id', 'received_at', 'channel', 'inserted', 'updated', 'rejected', 'messages'];

/* ------------------------------------------------------------------ baseline (24 Oct 2026) */

var BASELINE = {
  request_id: 'baseline-2026-10-24',
  source: 'baseline_import',
  nutrition: [{
    date: '2026-10-24', entry_level: 'day_total', meal: 'Day total', item: 'All food (from reported portions)',
    calories_kcal: 2351, protein_g: 110, data_quality: 'estimated',
    notes: 'Estimated from reported food portions. Includes homemade shake with 1.5 scoops whey.'
  }],
  sessions: [{
    date: '2026-10-24', session_name: 'Full body', status: 'completed', duration_min: 90,
    notes: 'First comeback session. ~90 min total including rest/conversation.'
  }],
  sets: [
    { date: '2026-10-24', session_name: 'Full body', exercise: 'Biceps curl', equipment: 'Machine', muscle_group: 'Biceps', set_no: 1, weight_kg: 23, reps: 10, data_quality: 'confirmed' },
    { date: '2026-10-24', session_name: 'Full body', exercise: 'Biceps curl', equipment: 'Machine', muscle_group: 'Biceps', set_no: 2, weight_kg: 29, reps: 10, data_quality: 'confirmed' },
    { date: '2026-10-24', session_name: 'Full body', exercise: 'Biceps curl', equipment: 'Machine', muscle_group: 'Biceps', set_no: 3, weight_kg: 29, reps: 8, data_quality: 'confirmed' },
    { date: '2026-10-24', session_name: 'Full body', exercise: 'Triceps extension', equipment: 'Machine', muscle_group: 'Triceps', set_no: 1, weight_kg: 18, reps: 10, data_quality: 'confirmed' },
    { date: '2026-10-24', session_name: 'Full body', exercise: 'Triceps extension', equipment: 'Machine', muscle_group: 'Triceps', set_no: 2, weight_kg: 23, reps: 10, data_quality: 'confirmed' },
    { date: '2026-10-24', session_name: 'Full body', exercise: 'Triceps extension', equipment: 'Machine', muscle_group: 'Triceps', set_no: 3, weight_kg: 27, reps: 10, data_quality: 'confirmed' },
    { date: '2026-10-24', session_name: 'Full body', exercise: 'Leg press', equipment: 'Machine', muscle_group: 'Quads', set_no: 1, data_quality: 'reported',
      notes: 'Completed. Weights, sets and reps are in the original training tracker; add them here when available.' },
    { date: '2026-10-24', session_name: 'Full body', exercise: 'Outdoor walk', equipment: 'Outdoor', muscle_group: 'Cardio', set_no: 1, duration_min: 6, data_quality: 'confirmed' }
  ],
  supplements: [
    { date: '2026-10-24', supplement: 'Whey protein', amount: 1.5, unit: 'scoop', taken: 'yes', notes: 'Homemade shake' },
    { date: '2026-10-24', supplement: 'Creatine', amount: 0, unit: 'g', taken: 'no', notes: 'Creatine plan starts 26 Oct 2026' }
  ]
  // No body-weight row on purpose: ~69 kg is a last reported weight, not a confirmed 24 Oct weigh-in.
};

/* ------------------------------------------------------------------ menu & setup */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('78 KG')
    .addItem('1 · Set up / repair database', 'setupFromMenu')
    .addItem('Show API token', 'showToken')
    .addItem('Rotate API token', 'rotateToken')
    .addItem('Show dashboard link key', 'showDashboardKey')
    .addItem('Rotate dashboard link', 'rotateDashboardKey')
    .addItem('Rebuild Daily_Summary', 'rebuildDailySummary')
    .addToUi();
}

function setupFromMenu() {
  var res = setup();
  SpreadsheetApp.getUi().alert('78 KG Mission Control is ready.\n\n' + res.join('\n'));
}

function setup() {
  var ss = ss_();
  var out = [];
  ss.setSpreadsheetTimeZone(DEFAULT_TZ);

  // Config
  var cfg = ensureSheet_(ss, 'Config', ['key', 'value', 'unit', 'notes']);
  var existing = readObjects_(cfg).map(function (r) { return r.key; });
  CONFIG_DEFAULTS.forEach(function (row) {
    if (existing.indexOf(row[0]) === -1) cfg.appendRow(row);
  });
  cfg.getRange('B:B').setNumberFormat('@');
  out.push('Config: ok');

  // Targets (history of goals, so changing a goal never rewrites past adherence)
  var tg = ensureSheet_(ss, 'Targets', TARGETS_COLS);
  if (tg.getLastRow() < 2) {
    tg.appendRow(['2026-10-24', 2650, 140, 'Initial targets']);
  }
  tg.getRange('A:A').setNumberFormat('@');
  out.push('Targets: ok');

  // Fact tables
  Object.keys(TABLES).forEach(function (name) {
    var sh = ensureSheet_(ss, name, TABLES[name].cols);
    TABLES[name].cols.forEach(function (c, i) {
      var fmt = TABLES[name].nums.indexOf(c) > -1 || c === 'value' ? '0.##' : '@';
      sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat(fmt);
    });
    out.push(name + ': ok');
  });
  ensureSheet_(ss, 'Ingest_Log', LOG_COLS);

  writeDictionary_(ss);
  out.push('Data_Dictionary: ok');

  // API token
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('API_TOKEN')) props.setProperty('API_TOKEN', newToken_());
  if (!props.getProperty('OWNER_EMAIL') && Session.getEffectiveUser().getEmail()) props.setProperty('OWNER_EMAIL', Session.getEffectiveUser().getEmail());
  out.push('API token: ready (menu 78 KG → Show API token)');

  // Fix legacy column formats without touching values
  var legacy = ss.getSheetByName('Daily Log');
  if (legacy) {
    legacy.getRange('C2:C').setNumberFormat('0');      // Calories
    legacy.getRange('D2:D').setNumberFormat('0');      // Protein (g)  (was being read as a date)
    legacy.getRange('E2:E').setNumberFormat('0.0');    // Weight (kg)
    legacy.getRange('G2:H').setNumberFormat('0');      // Minutes, Creatine (g)
    out.push('Legacy Daily Log: number formats fixed (values unchanged)');
  }

  // Baseline
  var res = ingest_(BASELINE, 'baseline');
  out.push('Baseline 24 Oct: ' + res.inserted + ' inserted, ' + res.updated + ' updated' + (res.duplicate_request ? ' (already present)' : ''));

  rebuildDailySummary();
  out.push('Daily_Summary: rebuilt');
  return out;
}

function showToken() {
  var t = PropertiesService.getScriptProperties().getProperty('API_TOKEN') || '(run setup first)';
  SpreadsheetApp.getUi().alert('API token (keep private):\n\n' + t);
}

function rotateToken() {
  PropertiesService.getScriptProperties().setProperty('API_TOKEN', newToken_());
  showToken();
}

/* ------------------------------------------------------------------ web endpoints */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'summary') {
    if (!tokenOk_(p.key)) return json_({ ok: false, error: 'unauthorized' });
    return json_(buildSummary_(Number(p.days) || 14));
  }
  if (p.action === 'ping') return json_({ ok: true, app: '78kg', version: APP_VERSION });
  if (p.action === 'data') {
    if (!dashKeyOk_(p.k)) return json_({ ok: false, error: 'unauthorized' });
    return ContentService.createTextOutput(getDashboardData(p.k)).setMimeType(ContentService.MimeType.JSON);
  }
  if (p.action === 'app') {
    // Full dashboard HTML for the Fitness Project home-screen app (it fetches this, so design updates need no re-install).
    if (!dashKeyOk_(p.k)) return ContentService.createTextOutput('unauthorized');
    return ContentService.createTextOutput(appHtml_()).setMimeType(ContentService.MimeType.TEXT);
  }
  if (p.k && dashKeyOk_(p.k)) return serveDashboard_(p.k);
  if (!isOwner_()) {
    return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">Private dashboard. Open the <b>Dashboard</b> deployment while signed in to the owner account.</p>');
  }
  return serveDashboard_('');
}

function serveDashboard_(key) {
  var html = HtmlService.createHtmlOutputFromFile('Dashboard').getContent().replace('__KG78_KEY__', key || '');
  return HtmlService.createHtmlOutput(html)
    .setTitle('Fitness Project')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .addMetaTag('apple-mobile-web-app-capable', 'yes');
}

var APP_HEAD = '<meta name="theme-color" content="#0d1012">' +
  '<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">' +
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">' +
  '<meta name="apple-mobile-web-app-title" content="Fitness Project">' +
  '<link rel="manifest" href="manifest.webmanifest"><link rel="apple-touch-icon" href="apple-touch-icon.png">' +
  '<link rel="icon" type="image/png" href="icon-192.png">';

function appHtml_() {
  return HtmlService.createHtmlOutputFromFile('Dashboard').getContent()
    .replace('<base target="_top">', '')
    .replace('</title>', '</title>' + APP_HEAD);
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Body is not valid JSON' });
  }
  var key = body.token || (e && e.parameter && e.parameter.key);
  var viaDashboard = dashKeyOk_(body.k);
  if (!tokenOk_(key) && !viaDashboard) return json_({ ok: false, error: 'unauthorized' });
  delete body.k;
  if (viaDashboard && !tokenOk_(key)) { delete body.token; return json_(ingest_(body, 'dashboard')); }
  if (body.action === 'summary') return json_(buildSummary_(Number(body.days) || 14));
  delete body.token;
  return json_(ingest_(body, body.source === 'chatgpt' || !body.source ? 'chatgpt' : 'api'));
}

/** Called from the dashboard (google.script.run). Owner-only. */
function getDashboardData(key) {
  if (!authed_(key)) throw new Error('Not authorised');
  var ss = ss_();
  var data = { meta: { version: APP_VERSION, tz: tz_(), today: today_(), generated_at: nowIso_() } };
  data.config = {};
  readObjects_(ss.getSheetByName('Config')).forEach(function (r) { data.config[r.key] = r.value; });
  data.targets = readObjects_(ss.getSheetByName('Targets'));
  Object.keys(TABLES).forEach(function (name) {
    data[name.toLowerCase()] = readObjects_(ss.getSheetByName(name));
  });
  var log = readObjects_(ss.getSheetByName('Ingest_Log'));
  data.ingest_log = log.slice(-15).reverse();
  return JSON.stringify(data);
}

/** Called from the dashboard Log tab. Owner-only, no token needed. */
function ingestFromDashboard(payload, key) {
  if (!authed_(key)) throw new Error('Not authorised');
  var obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
  delete obj.token;
  return JSON.stringify(ingest_(obj, 'dashboard'));
}

/* ------------------------------------------------------------------ ingest */

function ingest_(payload, channel) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = ss_();
    var result = { ok: true, inserted: 0, updated: 0, rejected: 0, messages: [], records: [] };
    var requestId = String(payload.request_id || '').trim();
    var logSh = ensureSheet_(ss, 'Ingest_Log', LOG_COLS);

    if (requestId) {
      var seen = readObjects_(logSh).some(function (r) { return String(r.request_id) === requestId && Number(r.rejected) === 0 && r.channel !== 'error'; });
      if (seen) {
        result.duplicate_request = true;
        result.messages.push('request_id "' + requestId + '" was already processed; nothing written.');
        return result;
      }
    }

    var source = String(payload.source || channel || 'manual');
    var loggedAt = nowIso_();
    var any = false;
    result.deleted = 0;

    // Deletes run first, so "delete wrong row + insert corrected row" works in one call.
    if (payload.deletes) {
      var dels = Array.isArray(payload.deletes) ? payload.deletes : [payload.deletes];
      if (dels.length) any = true;
      dels.forEach(function (d, n) {
        var tName = PAYLOAD_KEYS[lc_(d && d.table)];
        if (!tName) { result.rejected++; result.messages.push('deletes[' + n + ']: table must be one of ' + Object.keys(PAYLOAD_KEYS).join(', ')); return; }
        var def = TABLES[tName];
        var rid = d.record_id ? String(d.record_id) : null;
        if (!rid) {
          var k = deleteKey_(tName, d);
          if (k.error) { result.rejected++; result.messages.push('deletes[' + n + ']: ' + k.error); return; }
          rid = def.prefix + '-' + hash_(def.key(k.record).join('|'));
        }
        var sh = ss.getSheetByName(tName);
        var last = sh ? sh.getLastRow() : 0;
        var ids = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
        var found = false;
        for (var i = ids.length - 1; i >= 0; i--) {
          if (ids[i] === rid) { sh.deleteRow(i + 2); found = true; }
        }
        if (found) { result.deleted++; result.records.push({ table: tName, record_id: rid, action: 'deleted' }); }
        else { result.rejected++; result.messages.push('deletes[' + n + ']: no ' + tName + ' row matches ' + rid); }
      });
    }

    Object.keys(PAYLOAD_KEYS).forEach(function (pk) {
      var rows = payload[pk];
      if (!rows) return;
      if (!Array.isArray(rows)) rows = [rows];
      if (!rows.length) return;
      any = true;
      var tableName = PAYLOAD_KEYS[pk];
      var def = TABLES[tableName];
      var sh = ensureSheet_(ss, tableName, def.cols);
      var existing = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, def.cols.length).getValues() : [];
      var idIndex = {};
      existing.forEach(function (row, i) { idIndex[String(row[0])] = i; });

      rows.forEach(function (raw, n) {
        var v = validate_(tableName, raw);
        if (v.error) {
          result.rejected++;
          result.messages.push(pk + '[' + n + ']: ' + v.error);
          return;
        }
        var rec = v.record;
        rec.source = rec.source || source;
        rec.logged_at = loggedAt;
        rec.record_id = def.prefix + '-' + hash_(def.key(rec).join('|'));
        var rowArr = def.cols.map(function (c) { return rec[c] === undefined || rec[c] === null ? '' : rec[c]; });

        if (idIndex.hasOwnProperty(rec.record_id)) {
          // Upsert: new non-empty values overwrite, empty values never erase what is already stored.
          var i = idIndex[rec.record_id];
          var merged = existing[i].map(function (old, c) {
            var nv = rowArr[c];
            return nv === '' ? old : nv;
          });
          sh.getRange(i + 2, 1, 1, def.cols.length).setValues([merged]);
          existing[i] = merged;
          result.updated++;
          result.records.push({ table: tableName, record_id: rec.record_id, action: 'updated' });
        } else {
          sh.appendRow(rowArr);
          existing.push(rowArr);
          idIndex[rec.record_id] = existing.length - 1;
          result.inserted++;
          result.records.push({ table: tableName, record_id: rec.record_id, action: 'inserted' });
        }
      });
    });

    // Optional: targets change (e.g. {"targets":{"effective_from":"2026-11-15","calorie_target_kcal":2800}})
    if (payload.targets) {
      any = true;
      var t = payload.targets;
      var eff = normDate_(t.effective_from);
      var kc = num_(t.calorie_target_kcal), pr = num_(t.protein_target_g);
      if (!eff || (kc === null && pr === null)) {
        result.rejected++;
        result.messages.push('targets: need effective_from and calorie_target_kcal and/or protein_target_g');
      } else {
        var tg = ensureSheet_(ss, 'Targets', TARGETS_COLS);
        var prev = readObjects_(tg).filter(function (r) { return normDate_(r.effective_from) <= eff; }).pop() || {};
        tg.appendRow([eff, kc !== null ? kc : prev.calorie_target_kcal, pr !== null ? pr : prev.protein_target_g, t.notes || 'Updated via ' + channel]);
        result.inserted++;
        result.records.push({ table: 'Targets', action: 'inserted', effective_from: eff });
      }
    }

    if (!any) {
      result.ok = false;
      result.messages.push('No records found. Send arrays under nutrition, body, sessions, sets, supplements or recovery.');
    }
    if (result.rejected) result.ok = result.inserted + result.updated + result.deleted > 0;

    if (result.deleted) result.messages.unshift(result.deleted + ' row(s) deleted');
    logSh.appendRow([requestId || ('auto-' + Utilities.getUuid().slice(0, 8)), loggedAt, channel,
      result.inserted, result.updated, result.rejected, result.messages.join(' | ').slice(0, 1000)]);

    if (result.inserted || result.updated || result.deleted) {
      try { rebuildDailySummary(); } catch (err) { result.messages.push('Daily_Summary not rebuilt: ' + err); }
    }
    return result;
  } finally {
    lock.releaseLock();
  }
}

/** Natural key for a delete request, normalised the same way validate_ stores records. */
function deleteKey_(table, raw) {
  var r = { date: normDate_(raw.date) };
  if (!r.date) return { error: 'date (YYYY-MM-DD) or record_id is required' };
  switch (table) {
    case 'Nutrition':
      r.entry_level = lc_(raw.entry_level) === 'day_total' ? 'day_total' : 'meal';
      r.meal = raw.meal ? cap_(raw.meal) : (r.entry_level === 'day_total' ? 'Day total' : 'Other');
      r.item = raw.item || '';
      if (r.entry_level === 'meal' && !raw.item && !raw.meal) return { error: 'nutrition delete needs meal and item' };
      break;
    case 'Body':
      r.metric = lc_(raw.metric || 'weight');
      if (raw.time) { var tm = String(raw.time).match(/^(\d{1,2}):(\d{2})/); r.time = tm ? ('0' + tm[1]).slice(-2) + ':' + tm[2] : ''; }
      break;
    case 'Sessions':
      r.session_name = raw.session_name ? String(raw.session_name) : 'Workout';
      break;
    case 'Sets':
      if (!raw.exercise || raw.set_no === undefined) return { error: 'sets delete needs exercise, equipment and set_no' };
      r.exercise = cap_(raw.exercise); r.equipment = raw.equipment ? cap_(raw.equipment) : 'Unspecified'; r.set_no = num_(raw.set_no);
      break;
    case 'Supplements':
      if (!raw.supplement) return { error: 'supplement is required' };
      r.supplement = cap_(raw.supplement);
      break;
    case 'Recovery':
      r.source = raw.source ? lc_(raw.source) : 'manual';
      break;
  }
  return { record: r };
}

function validate_(table, raw) {
  if (!raw || typeof raw !== 'object') return { error: 'record must be an object' };
  var def = TABLES[table];
  var r = {};
  def.cols.forEach(function (c) { if (raw[c] !== undefined && raw[c] !== null && raw[c] !== '') r[c] = raw[c]; });
  if (raw.notes) r.notes = String(raw.notes).slice(0, 500);

  r.date = normDate_(raw.date);
  if (!r.date) return { error: 'date is required as YYYY-MM-DD' };
  if (r.date > addDaysStr_(today_(), 1)) return { error: 'date ' + r.date + ' is in the future' };
  if (raw.time) {
    var tm = String(raw.time).match(/^(\d{1,2}):(\d{2})/);
    if (!tm) return { error: 'time must be HH:MM' };
    r.time = ('0' + tm[1]).slice(-2) + ':' + tm[2];
  }

  // numbers: strip units, keep missing as missing
  for (var i = 0; i < def.nums.length; i++) {
    var c = def.nums[i];
    if (raw[c] === undefined || raw[c] === null || raw[c] === '') { delete r[c]; continue; }
    var n = num_(raw[c]);
    if (n === null) return { error: c + ' is not a number: ' + raw[c] };
    r[c] = n;
  }

  if (r.data_quality !== undefined || def.cols.indexOf('data_quality') > -1) {
    var q = lc_(raw.data_quality || raw.quality || '');
    if (!q) q = table === 'Nutrition' ? 'estimated' : 'confirmed';
    if (QUALITY.indexOf(q) === -1) return { error: 'data_quality must be one of ' + QUALITY.join(', ') };
    if (def.cols.indexOf('data_quality') > -1) r.data_quality = q;
  }

  switch (table) {
    case 'Nutrition':
      r.entry_level = lc_(raw.entry_level) === 'day_total' ? 'day_total' : 'meal';
      if (r.entry_level === 'meal' && !raw.meal && !raw.item) return { error: 'meal entries need meal and/or item' };
      r.meal = raw.meal ? cap_(raw.meal) : (r.entry_level === 'day_total' ? 'Day total' : 'Other');
      if (raw.calories_kj !== undefined && r.calories_kcal === undefined) {
        var kj = num_(raw.calories_kj); if (kj !== null) r.calories_kcal = Math.round(kj / 4.184);
      }
      if (r.calories_kcal === undefined && r.protein_g === undefined) return { error: 'nutrition needs calories_kcal and/or protein_g' };
      break;
    case 'Body':
      var m = lc_(raw.metric || 'weight').replace(/[\s-]+/g, '_');
      if (m === 'bodyfat' || m === 'body_fat_pct' || m === 'bf') m = 'body_fat';
      if (m === 'arms' || m === 'bicep' || m === 'biceps') m = 'arm';
      if (m === 'thighs') m = 'thigh';
      if (!BODY_METRICS[m]) return { error: 'metric must be one of ' + Object.keys(BODY_METRICS).join(', ') };
      r.metric = m;
      var unit = lc_(raw.unit || BODY_METRICS[m].unit);
      if (r.value === undefined) return { error: 'value is required' };
      if (m === 'weight' && (unit === 'lb' || unit === 'lbs')) r.value = round_(r.value * 0.45359237, 2);
      if (m !== 'weight' && m !== 'body_fat' && (unit === 'in' || unit === 'inch' || unit === 'inches')) r.value = round_(r.value * 2.54, 1);
      r.unit = BODY_METRICS[m].unit;
      var br = BODY_METRICS[m].range;
      if (r.value < br[0] || r.value > br[1]) return { error: m + ' value ' + r.value + ' outside plausible range ' + br.join('–') };
      break;
    case 'Sessions':
      r.session_name = raw.session_name ? String(raw.session_name) : 'Workout';
      r.status = lc_(raw.status || 'completed');
      if (SESSION_STATUS.indexOf(r.status) === -1) return { error: 'status must be one of ' + SESSION_STATUS.join(', ') };
      break;
    case 'Sets':
      if (!raw.exercise) return { error: 'exercise is required' };
      r.exercise = cap_(raw.exercise);
      r.equipment = raw.equipment ? cap_(raw.equipment) : 'Unspecified';
      r.session_name = raw.session_name ? String(raw.session_name) : 'Workout';
      if (r.set_no === undefined) return { error: 'set_no is required (1, 2, 3 …)' };
      if (raw.weight_unit && /^lb/.test(lc_(raw.weight_unit)) && r.weight_kg !== undefined) r.weight_kg = round_(r.weight_kg * 0.45359237, 1);
      r.is_warmup = /^(y|yes|true|1)$/i.test(String(raw.is_warmup || '')) ? 'yes' : 'no';
      if (raw.muscle_group) r.muscle_group = cap_(raw.muscle_group);
      break;
    case 'Supplements':
      if (!raw.supplement) return { error: 'supplement is required' };
      r.supplement = cap_(raw.supplement);
      r.unit = raw.unit ? String(raw.unit) : 'g';
      var tk = lc_(raw.taken);
      if (!tk) tk = r.amount === 0 ? 'no' : 'yes';
      if (['yes', 'no'].indexOf(tk) === -1) tk = /^(y|true|1)/.test(tk) ? 'yes' : 'no';
      r.taken = tk;
      break;
    case 'Recovery':
      r.source = raw.source ? lc_(raw.source) : 'manual';
      if (raw.is_rest_day !== undefined && raw.is_rest_day !== '') r.is_rest_day = /^(y|yes|true|1)$/i.test(String(raw.is_rest_day)) ? 'yes' : 'no';
      break;
  }

  // ranges
  for (var k in RANGES) {
    if (r[k] !== undefined && typeof r[k] === 'number' && (r[k] < RANGES[k][0] || r[k] > RANGES[k][1])) {
      return { error: k + ' value ' + r[k] + ' outside plausible range ' + RANGES[k].join('–') };
    }
  }
  return { record: r };
}

/* ------------------------------------------------------------------ Daily_Summary (flat, for Looker / quick checks) */

function rebuildDailySummary() {
  var ss = ss_();
  var cfg = {};
  readObjects_(ss.getSheetByName('Config')).forEach(function (r) { cfg[r.key] = r.value; });
  var start = normDate_(cfg.program_start_date) || '2026-10-24';
  var end = today_();
  var targets = readObjects_(ss.getSheetByName('Targets')).map(function (t) {
    return { from: normDate_(t.effective_from), kcal: num_(t.calorie_target_kcal), prot: num_(t.protein_target_g) };
  }).sort(function (a, b) { return a.from < b.from ? -1 : 1; });
  var trainDays = String(cfg.training_days || 'Sat,Mon,Wed').split(',').map(function (s) { return s.trim().slice(0, 3); });
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  var byDate = function (rows) {
    var m = {};
    rows.forEach(function (r) { var d = normDate_(r.date); if (!d) return; (m[d] = m[d] || []).push(r); });
    return m;
  };
  var nut = byDate(readObjects_(ss.getSheetByName('Nutrition')));
  var body = byDate(readObjects_(ss.getSheetByName('Body')).filter(function (r) { return r.metric === 'weight'; }));
  var ses = byDate(readObjects_(ss.getSheetByName('Sessions')));
  var sets = byDate(readObjects_(ss.getSheetByName('Sets')));
  var sup = byDate(readObjects_(ss.getSheetByName('Supplements')));
  var rec = byDate(readObjects_(ss.getSheetByName('Recovery')));

  var header = ['date', 'weekday', 'calories_kcal', 'protein_g', 'calorie_target_kcal', 'protein_target_g', 'calorie_diff_kcal',
    'protein_diff_g', 'nutrition_quality', 'weight_kg', 'planned_training_day', 'workout_status', 'session_minutes',
    'working_sets', 'volume_kg', 'creatine_g', 'sleep_hours', 'energy_1to5', 'soreness_1to5'];
  var rows = [];
  for (var d = start; d <= end; d = addDaysStr_(d, 1)) {
    var dow = DOW[dateObj_(d).getUTCDay()];
    var t = targets.filter(function (x) { return x.from <= d; }).pop() || {};
    var n = dailyNutrition_(nut[d] || []);
    var w = (body[d] || []).map(function (r) { return num_(r.value); }).filter(function (x) { return x !== null; });
    var s = (ses[d] || [])[0];
    var dset = (sets[d] || []).filter(function (x) { return x.is_warmup !== 'yes'; });
    var vol = dset.reduce(function (a, x) { var wk = num_(x.weight_kg), rp = num_(x.reps); return a + (wk !== null && rp !== null ? wk * rp : 0); }, 0);
    var cr = (sup[d] || []).filter(function (x) { return lc_(x.supplement) === 'creatine'; })[0];
    var rc = (rec[d] || [])[0] || {};
    rows.push([
      d, dow,
      n ? n.kcal : '', n ? n.prot : '',
      t.kcal != null ? t.kcal : '', t.prot != null ? t.prot : '',
      n && n.kcal !== '' && t.kcal != null ? n.kcal - t.kcal : '',
      n && n.prot !== '' && t.prot != null ? n.prot - t.prot : '',
      n ? n.quality : '',
      w.length ? round_(w.reduce(function (a, b) { return a + b; }, 0) / w.length, 2) : '',
      trainDays.indexOf(dow) > -1 ? 'yes' : 'no',
      s ? s.status : '',
      s && num_(s.duration_min) !== null ? num_(s.duration_min) : '',
      dset.length || '',
      vol || '',
      cr ? num_(cr.amount) : '',
      rc.sleep_hours !== undefined ? rc.sleep_hours : '',
      rc.energy_1to5 !== undefined ? rc.energy_1to5 : '',
      rc.soreness_1to5 !== undefined ? rc.soreness_1to5 : ''
    ]);
  }
  var sh = ss.getSheetByName('Daily_Summary') || ss.insertSheet('Daily_Summary');
  sh.clearContents();
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  sh.setFrozenRows(1);
  return rows.length;
}

/** Day total wins when present (latest one); otherwise meals are summed. Never both → no double counting. */
function dailyNutrition_(entries) {
  if (!entries.length) return null;
  var totals = entries.filter(function (e) { return e.entry_level === 'day_total'; });
  var use = totals.length ? [totals.sort(function (a, b) { return String(a.logged_at) < String(b.logged_at) ? -1 : 1; }).pop()] : entries;
  var kcal = null, prot = null, est = false;
  use.forEach(function (e) {
    var k = num_(e.calories_kcal), p = num_(e.protein_g);
    if (k !== null) kcal = (kcal || 0) + k;
    if (p !== null) prot = (prot || 0) + p;
    if (e.data_quality !== 'confirmed') est = true;
  });
  return { kcal: kcal === null ? '' : Math.round(kcal), prot: prot === null ? '' : Math.round(prot), quality: est ? 'estimated' : 'confirmed' };
}

/* ------------------------------------------------------------------ summary for ChatGPT (read access) */

function buildSummary_(days) {
  rebuildDailySummary();
  var ss = ss_();
  var all = readObjects_(ss.getSheetByName('Daily_Summary'));
  var cfg = {};
  readObjects_(ss.getSheetByName('Config')).forEach(function (r) { cfg[r.key] = r.value; });
  var weights = readObjects_(ss.getSheetByName('Body')).filter(function (r) { return r.metric === 'weight'; })
    .sort(function (a, b) { return normDate_(a.date) < normDate_(b.date) ? -1 : 1; });
  var sets = readObjects_(ss.getSheetByName('Sets'));
  var since = addDaysStr_(today_(), -Math.min(Math.max(days, 1), 120));
  var sessions = readObjects_(ss.getSheetByName('Sessions')).map(function (r) { r.date = normDate_(r.date); return r; })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  var perWeek = num_(cfg.sessions_per_week) || String(cfg.training_days || 'Sat,Mon,Wed').split(',').length;
  var t = today_(), dow = dateObj_(t).getUTCDay(), wkStart = addDaysStr_(t, -((dow - 6 + 7) % 7)), wkEnd = addDaysStr_(wkStart, 6);
  var done = sessions.filter(function (r) { return r.date >= wkStart && r.date <= wkEnd && (r.status === 'completed' || r.status === 'partial'); });
  var nutSince = addDaysStr_(t, -2);
  var nutrition = readObjects_(ss.getSheetByName('Nutrition')).filter(function (r) { return normDate_(r.date) >= nutSince; });
  return {
    ok: true,
    today: today_(),
    config: cfg,
    latest_weight: weights.length ? { date: normDate_(weights[weights.length - 1].date), kg: num_(weights[weights.length - 1].value) } : null,
    days: all.filter(function (r) { return normDate_(r.date) >= since; }).map(function (r) { r.date = normDate_(r.date); return r; }),
    this_week: { start: wkStart, end: wkEnd, sessions_done: done.length, sessions_target: perWeek,
      sessions_left: Math.max(0, perWeek - done.length), days_left_incl_today: Math.round((dateObj_(wkEnd) - dateObj_(t)) / 864e5) + 1 },
    recent_sessions: sessions.slice(-6).map(function (r) {
      return { date: r.date, session_name: r.session_name, status: r.status, duration_min: r.duration_min };
    }),
    recent_nutrition: nutrition.map(function (r) {
      return { record_id: r.record_id, date: normDate_(r.date), meal: r.meal, item: r.item, entry_level: r.entry_level,
        calories_kcal: r.calories_kcal, protein_g: r.protein_g, logged_at: r.logged_at };
    }),
    recent_sets: sets.filter(function (r) { return normDate_(r.date) >= since; }).map(function (r) {
      return { date: normDate_(r.date), exercise: r.exercise, equipment: r.equipment, set_no: r.set_no, weight_kg: r.weight_kg, reps: r.reps, is_warmup: r.is_warmup, duration_min: r.duration_min };
    })
  };
}

/* ------------------------------------------------------------------ data dictionary */

var DICTIONARY = [
  ['Config', 'key / value', 'text', '', 'Settings: start & target weight, training days, creatine plan, session target. Edit values here; dashboard updates.'],
  ['Targets', 'effective_from', 'date', 'YYYY-MM-DD', 'Date a calorie/protein target starts applying. Add a new row to change goals; past days keep the old target.'],
  ['Targets', 'calorie_target_kcal / protein_target_g', 'number', 'kcal / g', 'Daily intake targets.'],
  ['All fact tables', 'record_id', 'text', '', 'Deterministic ID from the natural key. Same key = same row (updated, never duplicated).'],
  ['All fact tables', 'date', 'date', 'YYYY-MM-DD', 'Calendar day in Asia/Riyadh. Required.'],
  ['All fact tables', 'source', 'text', '', 'Where the record came from: chatgpt, dashboard, baseline_import, apple_health, manual.'],
  ['All fact tables', 'logged_at', 'timestamp', 'ISO 8601', 'When the row was written or last updated.'],
  ['Nutrition', 'entry_level', 'enum', 'meal | day_total', 'meal = one food/meal entry; day_total = a whole-day figure. If a day has a day_total it is used and meal rows are shown as detail only (prevents double counting).'],
  ['Nutrition', 'meal / item / quantity', 'text', '', 'Breakfast, Lunch, Dinner, Snack, Shake …; food description; portion as reported.'],
  ['Nutrition', 'calories_kcal, protein_g, carbs_g, fat_g', 'number', 'kcal, g', 'Blank = not known (never treated as 0).'],
  ['Nutrition/Sets/Body', 'data_quality', 'enum', 'confirmed | estimated | reported', 'confirmed = label/scale/measured; estimated = derived from portions/photos; reported = stated from memory, unverified.'],
  ['Natural keys', 'Nutrition', '', '', 'day_total: date. meal: date + meal + item.'],
  ['Natural keys', 'Body', '', '', 'date + metric + time.'],
  ['Natural keys', 'Sessions / Sets', '', '', 'Sessions: date + session_name. Sets: date + exercise + equipment + set_no.'],
  ['Natural keys', 'Supplements / Recovery', '', '', 'Supplements: date + supplement. Recovery: date + source.'],
  ['Body', 'metric / value / unit', 'enum / number', 'weight kg, waist/chest/arm/thigh cm, body_fat %', 'lb and inches are converted automatically on ingest.'],
  ['Body', 'time / conditions', 'text', 'HH:MM', 'Weigh-in time and context, e.g. "morning, fasted, after toilet".'],
  ['Sessions', 'status', 'enum', 'completed | partial | missed | rest', 'Weekly progress = completed/partial sessions in the Sat–Fri week vs sessions_per_week, on any days.'],
  ['API', 'deletes', 'array', '{table, record_id} or {table + natural key}', 'Removes a wrong row (e.g. food logged on the wrong date). Runs before inserts in the same call.'],
  ['Sessions', 'duration_min / session_rpe', 'number', 'min / 1–10', 'Total session time; overall effort.'],
  ['Sets', 'exercise + equipment', 'text', '', 'Progress is tracked per exercise AND equipment, so different machines are never compared as if equivalent.'],
  ['Sets', 'muscle_group', 'text', '', 'Quads, Hamstrings, Glutes, Calves, Chest, Back, Shoulders, Biceps, Triceps, Forearms, Core, Cardio.'],
  ['Sets', 'set_no, weight_kg, reps, rpe, is_warmup', 'number / yes-no', 'kg, reps', 'One row per set. Warm-ups are excluded from volume and PRs.'],
  ['Sets', 'duration_min / distance_km', 'number', 'min / km', 'For cardio entries.'],
  ['Supplements', 'supplement / amount / unit / taken', 'text / number', 'g, scoop, caps', 'One row per supplement per day. taken = yes | no.'],
  ['Recovery', 'sleep_hours, energy_1to5, soreness_1to5', 'number', 'h, 1–5', 'Subjective scores: 1 = very low, 5 = very high.'],
  ['Recovery', 'resting_hr_bpm, hrv_ms, steps', 'number', 'bpm, ms, steps', 'Ready for Apple Health/Watch values (source = apple_health). No integration exists until you configure one.'],
  ['Ingest_Log', 'request_id', 'text', '', 'Idempotency key per submission. Re-sending the same request_id writes nothing.'],
  ['Daily_Summary', '(all)', 'derived', '', 'Rebuilt automatically after every write. One row per day since program start. Blank = not logged.']
];

function writeDictionary_(ss) {
  var sh = ss.getSheetByName('Data_Dictionary') || ss.insertSheet('Data_Dictionary');
  sh.clearContents();
  var rows = [['table', 'field', 'type', 'unit / values', 'description']].concat(DICTIONARY);
  sh.getRange(1, 1, rows.length, 5).setValues(rows);
  sh.getRange(1, 1, 1, 5).setFontWeight('bold');
  sh.setFrozenRows(1);
}

/* ------------------------------------------------------------------ helpers */

function ss_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return SpreadsheetApp.openById(id);
}

function ensureSheet_(ss, name, cols) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readObjects_(sh) {
  if (!sh || sh.getLastRow() < 2) return [];
  var vals = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  var head = vals.shift().map(String);
  return vals.filter(function (r) { return r.some(function (c) { return c !== '' && c !== null; }); }).map(function (r) {
    var o = {};
    head.forEach(function (h, i) {
      var v = r[i];
      if (v === '' || v === null || v === undefined) return;      // missing stays missing
      if (Object.prototype.toString.call(v) === '[object Date]') {
        v = h === 'logged_at' || h === 'received_at' ? Utilities.formatDate(v, tz_(), "yyyy-MM-dd'T'HH:mm:ssXXX")
          : h === 'time' ? Utilities.formatDate(v, tz_(), 'HH:mm') : Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
      }
      o[h] = v;
    });
    return o;
  });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function isOwner_() {
  var active = Session.getActiveUser().getEmail();
  var owner = PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL');
  if (!owner) {
    owner = Session.getEffectiveUser().getEmail();
    if (owner) PropertiesService.getScriptProperties().setProperty('OWNER_EMAIL', owner);
  }
  return !!active && !!owner && active.toLowerCase() === owner.toLowerCase();
}

/** Private dashboard link key (separate from the API token). */
function dashKey_() {
  var props = PropertiesService.getScriptProperties();
  var k = props.getProperty('DASH_KEY');
  if (!k) { k = 'v' + Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 12); props.setProperty('DASH_KEY', k); }
  return k;
}
function dashKeyOk_(k) { return !!k && String(k) === dashKey_(); }
function authed_(key) { return dashKeyOk_(key) || isOwner_(); }

function showDashboardKey() {
  SpreadsheetApp.getUi().alert('Dashboard link = your API web-app URL + ?k=' + dashKey_() + '\n\nKeep it private. Rotate with "Rotate dashboard link".');
}
function rotateDashboardKey() {
  PropertiesService.getScriptProperties().deleteProperty('DASH_KEY');
  showDashboardKey();
}

function tokenOk_(t) {
  var real = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  return !!real && !!t && String(t) === real;
}

function newToken_() {
  return 'kg78_' + Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
}

function hash_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8);
  return bytes.slice(0, 6).map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function tz_() { return DEFAULT_TZ; }
function today_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'); }
function nowIso_() { return Utilities.formatDate(new Date(), tz_(), "yyyy-MM-dd'T'HH:mm:ssXXX"); }

function normDate_(v) {
  if (v === undefined || v === null || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  var s = String(v).trim();
  var out = '';
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) out = m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);   // dd/mm/yyyy
  if (!out && m) out = m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  if (!out) return '';
  // reject impossible dates such as 2026-13-40 or 2026-02-30
  return dateObj_(out).toISOString().slice(0, 10) === out ? out : '';
}

function dateObj_(d) { var p = d.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
function addDaysStr_(d, n) { var o = dateObj_(d); o.setUTCDate(o.getUTCDate() + n); return o.toISOString().slice(0, 10); }

function num_(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (Object.prototype.toString.call(v) === '[object Date]') return null;
  var m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function round_(x, d) { var f = Math.pow(10, d); return Math.round(x * f) / f; }
function lc_(s) { return s === undefined || s === null ? '' : String(s).trim().toLowerCase(); }
function cap_(s) { s = String(s).trim(); return s.charAt(0).toUpperCase() + s.slice(1); }

/** Run from the editor to print your private links' keys in the Execution log. */
function logKeys() {
  Logger.log('API_TOKEN=' + (PropertiesService.getScriptProperties().getProperty('API_TOKEN') || '(run setup)'));
  Logger.log('DASH_KEY=' + dashKey_());
}
