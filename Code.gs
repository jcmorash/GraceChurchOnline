const SHEET_NAME = "MassCounts";
const STORAGE_PROVIDER_DEFAULT = "sheets";
const SUPABASE_TABLE_DEFAULT = "mass_counts";

function testHealthCheck() {
  return { status: "ok", timestamp: new Date().toString() };
}

function createJsonResponse(data) {
  const output = ContentService.createTextOutput(typeof data === 'string' ? data : JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

function createTextResponse(text) {
  const output = ContentService.createTextOutput(String(text || ''));
  output.setMimeType(ContentService.MimeType.TEXT);
  return output;
}

/**
 * ROUTER — serves HTML pages OR falls back to API logic
 */
function doGet(e) {
  try {
    const params = e && e.parameter ? e.parameter : {};
    const page = String(params.page || 'index').toLowerCase();
    const date = params.date;
    const mass = params.mass;
    const action = String(params.action || '').toLowerCase();

    if (action === 'lookup' || (date && mass && !params.altar)) {
      return createJsonResponse(getAttendanceRecord(date, mass));
    }

    if (action === 'analytics') {
      return getAttendanceAnalytics({ parameter: params });
    }

    if (action === 'export_csv') {
      return createTextResponse(exportAttendanceCsv());
    }

    if (page === 'analytics' || (page === 'admin' && action === 'analytics')) {
      return getAttendanceAnalytics({ parameter: params });
    }

    if (page === 'lookup' || page === 'attendancelookup') {
      return createJsonResponse(getAttendanceRecord(date, mass));
    }

    // Check if this is a save request (has attendance fields)
    if (date && mass && (params.altar !== undefined || params.left_choir !== undefined)) {
      const attendanceData = {
        date: date,
        mass: mass,
        altar: params.altar || 0,
        left_choir: params.left_choir || 0,
        right_choir: params.right_choir || 0,
        left_nave: params.left_nave || 0,
        right_nave: params.right_nave || 0,
        balcony: params.balcony || 0,
        ushers: params.ushers || 0,
        total: params.total || 0
      };
      return createJsonResponse(saveAttendance(attendanceData));
    }

    if (page === 'index' || page === 'home' || page === 'attendance' || page === 'admin') {
      return getHtmlOutputForPage(page);
    }

    return getHtmlOutputForPage('index');
  } catch (err) {
    return createJsonResponse({ exists: false, error: err.toString() });
  }
}

function getAttendanceRecord(date, mass) {
  try {
    if (!date || !mass) {
      return { exists: false };
    }

    const normalizedDate = normalizeDate(date);
    const normalizedMass = String(mass || '').trim();
    const records = readAllAttendanceRecords();
    const targetMass = normalizeMass(normalizedMass);

    const match = records.find((record) => {
      if (normalizeDate(record.date) !== normalizedDate) {
        return false;
      }

      const rowMass = normalizeMass(record.mass);
      return rowMass === targetMass || rowMass.includes(targetMass) || targetMass.includes(rowMass);
    });

    if (!match) {
      return { exists: false };
    }

    return toLookupRecord(match);
  } catch (err) {
    return { exists: false, error: err.toString() };
  }
}

function saveAttendance(payload) {
  try {
    if (!payload || typeof payload !== 'object') {
      throw new Error('No attendance data was received.');
    }

    const data = Object.assign({}, payload);
    data.date = normalizeDate(data.date);
    upsertAttendanceRecord(data);

    return {
      result: 'success',
      day_total: calculateDayTotalForDate(data.date)
    };
  } catch (err) {
    return {
      result: 'error',
      message: err.toString()
    };
  }
}

/**
 * POST — insert or update attendance row
 */
function doPost(e) {
  try {
    const rawBody = e && e.postData && e.postData.contents ? e.postData.contents : '';
    const contentType = e && e.postData && e.postData.type ? e.postData.type : '';
    if (!rawBody) {
      return createJsonResponse({ result: 'error', message: 'No form data was received.' });
    }

    let data = {};
    try {
      data = JSON.parse(rawBody);
    } catch (err) {
      data = { raw: rawBody };
    }

    if (data && data.action === 'lookup') {
      return createJsonResponse(getAttendanceRecord(data.date, data.mass));
    }

    if (data && data.action === 'analytics') {
      return getAttendanceAnalytics({ parameter: { date: data.date } });
    }

    if (data && data.action === 'test') {
      return createJsonResponse(testHealthCheck());
    }

    if (data && data.action === 'import_csv') {
      return createJsonResponse(importAttendanceCsv(data.csv || ''));
    }

    const result = saveAttendance(data);
    return createJsonResponse(result);
  } catch (err) {
    return createJsonResponse({ result: 'error', message: err.toString() });
  }
}

function doOptions(e) {
  const output = ContentService.createTextOutput('');
  output.setMimeType(ContentService.MimeType.TEXT);
  return output;
}

/**
 * Ensure sheet exists and has updated headers
 */
function getOrCreateSheet() {
  const ss = getTargetSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }

  ensureHeaders(sheet);
  return sheet;
}

function ensureHeaders(sheet) {
  const headers = [
    "Date",
    "Mass",
    "Altar",
    "LeftChoir",
    "RightChoir",
    "LeftNave",
    "RightNave",
    "Balcony",
    "Ushers",
    "MassTotal"
  ];

  const existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0] || [];
  const needsHeaders = existing.length < headers.length || headers.some((header, index) => {
    return String(existing[index] || '').trim() !== String(header || '').trim();
  });

  if (needsHeaders) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

/**
 * Normalize date to YYYY-MM-DD
 */
function normalizeDate(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (value instanceof Date) {
    return formatDateOnly(value);
  }

  const text = String(value).trim();
  if (!text) {
    return '';
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  if (typeof value === 'number') {
    try {
      const serialDate = new Date((value - 25569) * 86400000);
      if (!isNaN(serialDate.getTime())) {
        return formatDateOnly(serialDate);
      }
    } catch (err) {
      Logger.log('Date serial conversion failed: ' + err);
    }
  }

  if (text.includes('/')) {
    const parts = text.split('/');
    if (parts.length === 3) {
      const month = Number(parts[0]);
      const day = Number(parts[1]);
      const year = Number(parts[2]);
      if (!isNaN(month) && !isNaN(day) && !isNaN(year)) {
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }
  }

  if (text.includes('-')) {
    const parts = text.split('-');
    if (parts.length === 3) {
      const year = parts[0];
      const month = parts[1];
      const day = parts[2];
      if (year && month && day) {
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }
  }

  try {
    const parsed = new Date(text);
    if (!isNaN(parsed.getTime())) {
      return formatDateOnly(parsed);
    }
  } catch (err) {
    Logger.log('Date parse failed: ' + err);
  }

  return text;
}

function formatDateOnly(value) {
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    return '';
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Find row by normalized date + mass
 */
function findRow(sheet, date, mass) {
  const data = sheet.getDataRange().getValues();
  const rows = data.slice(1);
  const matchInfo = findMatchingRow(rows, normalizeDate(date), String(mass || '').trim());
  return matchInfo ? matchInfo.row : -1;
}

function findMatchingRow(rows, requestedDate, requestedMass) {
  const normalizedDate = normalizeDate(requestedDate);
  const normalizedMass = normalizeMass(requestedMass);

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const rowDate = normalizeDate(row[0]);
    const rowMass = normalizeMass(row[1]);

    if (!rowDate) {
      continue;
    }

    if (rowDate !== normalizedDate) {
      continue;
    }

    if (rowMass === normalizedMass || rowMass.includes(normalizedMass) || normalizedMass.includes(rowMass)) {
      return { row: index + 2, date: rowDate, mass: rowMass };
    }
  }

  return null;
}

function normalizeMass(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Calculate Day Total = sum of all Mass Totals for the date
 */
function calculateDayTotal(sheet, date) {
  if (!sheet) {
    return calculateDayTotalForDate(date);
  }

  const data = sheet.getDataRange().getValues();
  let sum = 0;

  for (let i = 1; i < data.length; i++) {
    const rowDate = normalizeDate(data[i][0]);
    if (rowDate === date) {
      sum += Number(data[i][9]) || 0;
    }
  }

  return sum;
}

function getTargetSpreadsheet() {
  try {
    const scriptProps = PropertiesService.getScriptProperties();
    const explicitId = scriptProps.getProperty('SPREADSHEET_ID') || scriptProps.getProperty('SPREADSHEET');
    if (explicitId) {
      return SpreadsheetApp.openById(explicitId);
    }
  } catch (err) {
    Logger.log('Configured spreadsheet ID unavailable: ' + err);
  }

  try {
    return SpreadsheetApp.getActiveSpreadsheet();
  } catch (err) {
    Logger.log('Active spreadsheet unavailable: ' + err);
  }

  throw new Error('Unable to access the attendance spreadsheet. Make sure the Apps Script project is bound to the spreadsheet or set SPREADSHEET_ID.');
}

function findSpreadsheetByName(name) {
  try {
    const files = DriveApp.getFilesByName(name);
    while (files.hasNext()) {
      const file = files.next();
      if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
        const spreadsheet = SpreadsheetApp.open(file);
        if (spreadsheet.getSheetByName(SHEET_NAME)) {
          return spreadsheet;
        }
      }
    }
  } catch (err) {
    Logger.log('Could not find spreadsheet by name: ' + name + ' | ' + err);
  }

  return null;
}

function findSpreadsheetWithSheet(sheetName) {
  try {
    const files = DriveApp.searchFiles("mimeType='application/vnd.google-apps.spreadsheet'");
    while (files.hasNext()) {
      const file = files.next();
      try {
        const spreadsheet = SpreadsheetApp.open(file);
        if (spreadsheet.getSheetByName(sheetName)) {
          return spreadsheet;
        }
      } catch (err) {
        Logger.log('Could not inspect spreadsheet: ' + file.getName() + ' | ' + err);
      }
    }
  } catch (err) {
    Logger.log('Could not search spreadsheets: ' + err);
  }

  return null;
}

function getHtmlOutputForPage(page) {
  const normalized = String(page || '').trim().toLowerCase();
  if (!normalized) {
    return HtmlService.createHtmlOutputFromFile('index');
  }

  const pageMap = {
    index: 'index',
    home: 'index',
    attendance: 'attendance',
    admin: 'admin'
  };

  const lookup = pageMap[normalized] || normalized.replace(/\.html?$/i, '');
  const candidates = [lookup, `${lookup}.html`, `${lookup}.htm`];

  for (const candidate of candidates) {
    try {
      return HtmlService.createHtmlOutputFromFile(candidate);
    } catch (err) {
      // try next candidate
    }
  }

  try {
    return HtmlService.createHtmlOutputFromFile('index');
  } catch (err) {
    return HtmlService.createHtmlOutput('<p>Unable to load page.</p>');
  }
}

function getAttendanceAnalytics(e) {
  try {
    const records = readAllAttendanceRecords().sort((a, b) => a.date.localeCompare(b.date));

  const masses = [...new Set(records.map(r => r.mass).filter(Boolean))];
  const summaries = masses.map(mass => {
    const massRecords = records.filter(r => r.mass === mass);
    const average = massRecords.length > 0
      ? Math.round(massRecords.reduce((sum, r) => sum + r.total, 0) / massRecords.length)
      : 0;

    return {
      mass,
      count: massRecords.length,
      averageAttendance: average,
      latestAttendance: massRecords.length > 0 ? massRecords[massRecords.length - 1].total : 0
    };
  });

  const recentHistory = records.slice(-10).reverse();
  const weeklyTrend = buildWeeklyTrend(records);
  const yearOverYear = buildYearOverYear(records);

  let forecast = null;
  let note = '';

  if (records.length >= 5) {
    const requestedDate = e && e.parameter && e.parameter.date ? normalizeDate(e.parameter.date) : null;

    if (requestedDate) {
      const selectedDate = new Date(requestedDate);
      if (!isNaN(selectedDate)) {
        const weekday = selectedDate.getDay();
        const weekdayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][weekday];
        let hasEnoughData = true;
        const byMass = {};

        masses.forEach(mass => {
          const sameWeekdayRecords = records.filter(r => r.mass === mass && new Date(r.date).getDay() === weekday);
          if (sameWeekdayRecords.length >= 3) {
            const average = sameWeekdayRecords.reduce((sum, r) => sum + r.total, 0) / sameWeekdayRecords.length;
            byMass[mass] = Math.round(average);
          } else {
            hasEnoughData = false;
            byMass[mass] = null;
          }
        });

        if (hasEnoughData) {
          forecast = {
            date: requestedDate,
            weekday: weekdayName,
            byMass
          };
        } else {
          note = 'Not enough historical data for a reliable prediction yet. Add more entries and this forecast will improve.';
        }
      }
    } else {
      note = 'Select a date to preview a simple weekly forecast.';
    }
  } else {
    note = 'Not enough historical data for a reliable prediction yet. Add more entries and this forecast will improve.';
  }

  if (!note && weeklyTrend.length < 3) {
    note = 'Not enough historical data for a reliable prediction yet. Add more entries and this forecast will improve.';
  }

    return createJsonResponse({
      totalRecords: records.length,
      dateRange: records.length > 0 ? {
        first: records[0].date,
        last: records[records.length - 1].date
      } : null,
      masses,
      summaries,
      recentHistory,
      weeklyTrend,
      yearOverYear,
      forecast,
      note
    });
  } catch (err) {
    return createJsonResponse({ totalRecords: 0, note: err.toString(), error: err.toString() });
  }
}

function getStorageProvider() {
  try {
    const provider = PropertiesService.getScriptProperties().getProperty('STORAGE_PROVIDER');
    if (provider) {
      return String(provider).trim().toLowerCase();
    }
  } catch (err) {
    Logger.log('Unable to read STORAGE_PROVIDER: ' + err);
  }

  return STORAGE_PROVIDER_DEFAULT;
}

function toLookupRecord(record) {
  return {
    exists: true,
    date: normalizeDate(record.date),
    mass: String(record.mass || ''),
    altar: Number(record.altar) || 0,
    left_choir: Number(record.left_choir) || 0,
    right_choir: Number(record.right_choir) || 0,
    left_nave: Number(record.left_nave) || 0,
    right_nave: Number(record.right_nave) || 0,
    balcony: Number(record.balcony) || 0,
    ushers: Number(record.ushers) || 0,
    total: Number(record.total) || 0,
    leftChoir: Number(record.left_choir) || 0,
    rightChoir: Number(record.right_choir) || 0,
    leftNave: Number(record.left_nave) || 0,
    rightNave: Number(record.right_nave) || 0
  };
}

function normalizeRecord(input) {
  return {
    date: normalizeDate(input && input.date),
    mass: String(input && input.mass ? input.mass : ''),
    altar: Number(input && input.altar) || 0,
    left_choir: Number(input && input.left_choir) || 0,
    right_choir: Number(input && input.right_choir) || 0,
    left_nave: Number(input && input.left_nave) || 0,
    right_nave: Number(input && input.right_nave) || 0,
    balcony: Number(input && input.balcony) || 0,
    ushers: Number(input && input.ushers) || 0,
    total: Number(input && input.total) || 0
  };
}

function readAllAttendanceRecords() {
  const provider = getStorageProvider();
  if (provider === 'supabase') {
    return readAllAttendanceRecordsFromSupabase();
  }

  return readAllAttendanceRecordsFromSheets();
}

function upsertAttendanceRecord(payload) {
  const provider = getStorageProvider();
  const record = normalizeRecord(payload);

  if (!record.date || !record.mass) {
    throw new Error('Both date and mass are required.');
  }

  if (provider === 'supabase') {
    upsertAttendanceRecordToSupabase(record);
    return;
  }

  upsertAttendanceRecordToSheets(record);
}

function calculateDayTotalForDate(date) {
  const normalizedDate = normalizeDate(date);
  if (!normalizedDate) {
    return 0;
  }

  const records = readAllAttendanceRecords();
  return records
    .filter((record) => normalizeDate(record.date) === normalizedDate)
    .reduce((sum, record) => sum + (Number(record.total) || 0), 0);
}

function readAllAttendanceRecordsFromSheets() {
  const sheet = getOrCreateSheet();
  const data = sheet.getDataRange().getValues();
  const records = [];

  for (let index = 1; index < data.length; index++) {
    const row = data[index];
    const date = normalizeDate(row[0]);
    if (!date) {
      continue;
    }

    records.push({
      date,
      mass: String(row[1] || ''),
      altar: Number(row[2]) || 0,
      left_choir: Number(row[3]) || 0,
      right_choir: Number(row[4]) || 0,
      left_nave: Number(row[5]) || 0,
      right_nave: Number(row[6]) || 0,
      balcony: Number(row[7]) || 0,
      ushers: Number(row[8]) || 0,
      total: Number(row[9]) || 0
    });
  }

  return records;
}

function upsertAttendanceRecordToSheets(record) {
  const sheet = getOrCreateSheet();
  ensureHeaders(sheet);

  const row = findRow(sheet, record.date, record.mass);
  const rowData = [
    String(record.date || ''),
    String(record.mass || ''),
    Number(record.altar) || 0,
    Number(record.left_choir) || 0,
    Number(record.right_choir) || 0,
    Number(record.left_nave) || 0,
    Number(record.right_nave) || 0,
    Number(record.balcony) || 0,
    Number(record.ushers) || 0,
    Number(record.total) || 0
  ];

  if (row === -1) {
    sheet.appendRow(rowData);
  } else {
    sheet.getRange(row, 1, 1, 10).setValues([rowData]);
  }

  SpreadsheetApp.flush();
}

function getSupabaseConfig() {
  const props = PropertiesService.getScriptProperties();
  const url = String(props.getProperty('SUPABASE_URL') || '').trim().replace(/\/+$/, '');
  const key = String(props.getProperty('SUPABASE_KEY') || '').trim();
  const table = String(props.getProperty('SUPABASE_TABLE') || SUPABASE_TABLE_DEFAULT).trim();

  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_KEY must be set in Script Properties when STORAGE_PROVIDER=supabase.');
  }

  return { url, key, table };
}

function supabaseRequest(method, table, queryString, body, preferHeader) {
  const config = getSupabaseConfig();
  const endpoint = `${config.url}/rest/v1/${table}${queryString ? `?${queryString}` : ''}`;
  const headers = {
    apikey: config.key,
    Authorization: `Bearer ${config.key}`,
    'Content-Type': 'application/json'
  };

  if (preferHeader) {
    headers.Prefer = preferHeader;
  }

  const response = UrlFetchApp.fetch(endpoint, {
    method,
    headers,
    payload: body ? JSON.stringify(body) : undefined,
    muteHttpExceptions: true
  });

  const statusCode = response.getResponseCode();
  const text = response.getContentText();
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Supabase request failed (${statusCode}): ${text}`);
  }

  if (!text) {
    return [];
  }

  return JSON.parse(text);
}

function mapSupabaseRecord(row) {
  return {
    date: normalizeDate(row.date),
    mass: String(row.mass || ''),
    altar: Number(row.altar) || 0,
    left_choir: Number(row.left_choir) || 0,
    right_choir: Number(row.right_choir) || 0,
    left_nave: Number(row.left_nave) || 0,
    right_nave: Number(row.right_nave) || 0,
    balcony: Number(row.balcony) || 0,
    ushers: Number(row.ushers) || 0,
    total: Number(row.total) || 0
  };
}

function readAllAttendanceRecordsFromSupabase() {
  const config = getSupabaseConfig();
  const query = [
    'select=date,mass,altar,left_choir,right_choir,left_nave,right_nave,balcony,ushers,total',
    'order=date.asc,mass.asc'
  ].join('&');

  const rows = supabaseRequest('get', config.table, query, null, null);
  return rows.map(mapSupabaseRecord);
}

function upsertAttendanceRecordToSupabase(record) {
  const config = getSupabaseConfig();
  const row = {
    date: normalizeDate(record.date),
    mass: String(record.mass || ''),
    altar: Number(record.altar) || 0,
    left_choir: Number(record.left_choir) || 0,
    right_choir: Number(record.right_choir) || 0,
    left_nave: Number(record.left_nave) || 0,
    right_nave: Number(record.right_nave) || 0,
    balcony: Number(record.balcony) || 0,
    ushers: Number(record.ushers) || 0,
    total: Number(record.total) || 0
  };

  const query = 'on_conflict=date,mass';
  supabaseRequest('post', config.table, query, [row], 'resolution=merge-duplicates,return=minimal');
}

function escapeCsvCell(value) {
  const text = String(value === null || value === undefined ? '' : value);
  if (/[,"\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function exportAttendanceCsv() {
  const headers = ['Date', 'Mass', 'Altar', 'LeftChoir', 'RightChoir', 'LeftNave', 'RightNave', 'Balcony', 'Ushers', 'MassTotal'];
  const rows = readAllAttendanceRecords().sort((a, b) => {
    const dateCompare = String(a.date).localeCompare(String(b.date));
    if (dateCompare !== 0) {
      return dateCompare;
    }
    return String(a.mass).localeCompare(String(b.mass));
  });

  const lines = [headers.join(',')];
  rows.forEach((row) => {
    lines.push([
      row.date,
      row.mass,
      row.altar,
      row.left_choir,
      row.right_choir,
      row.left_nave,
      row.right_nave,
      row.balcony,
      row.ushers,
      row.total
    ].map(escapeCsvCell).join(','));
  });

  return lines.join('\n');
}

function parseCsvRows(csvText) {
  const text = String(csvText || '');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ',') {
      row.push(cell);
      cell = '';
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') {
        i++;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function normalizeHeaderKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function importAttendanceCsv(csvText) {
  const rows = parseCsvRows(csvText);
  if (!rows.length) {
    return { result: 'error', message: 'CSV file is empty.' };
  }

  const headerRow = rows[0].map(normalizeHeaderKey);
  const getIndex = (candidates) => {
    for (let i = 0; i < headerRow.length; i++) {
      if (candidates.includes(headerRow[i])) {
        return i;
      }
    }
    return -1;
  };

  const dateIndex = getIndex(['date']);
  const massIndex = getIndex(['mass']);
  if (dateIndex === -1 || massIndex === -1) {
    return { result: 'error', message: 'CSV must include Date and Mass columns.' };
  }

  const indexMap = {
    altar: getIndex(['altar']),
    left_choir: getIndex(['leftchoir', 'left_choir']),
    right_choir: getIndex(['rightchoir', 'right_choir']),
    left_nave: getIndex(['leftnave', 'left_nave']),
    right_nave: getIndex(['rightnave', 'right_nave']),
    balcony: getIndex(['balcony']),
    ushers: getIndex(['ushers']),
    total: getIndex(['masstotal', 'total'])
  };

  let imported = 0;
  let skipped = 0;

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (!row || row.every((value) => String(value || '').trim() === '')) {
      continue;
    }

    const record = {
      date: row[dateIndex],
      mass: row[massIndex],
      altar: indexMap.altar === -1 ? 0 : Number(row[indexMap.altar]) || 0,
      left_choir: indexMap.left_choir === -1 ? 0 : Number(row[indexMap.left_choir]) || 0,
      right_choir: indexMap.right_choir === -1 ? 0 : Number(row[indexMap.right_choir]) || 0,
      left_nave: indexMap.left_nave === -1 ? 0 : Number(row[indexMap.left_nave]) || 0,
      right_nave: indexMap.right_nave === -1 ? 0 : Number(row[indexMap.right_nave]) || 0,
      balcony: indexMap.balcony === -1 ? 0 : Number(row[indexMap.balcony]) || 0,
      ushers: indexMap.ushers === -1 ? 0 : Number(row[indexMap.ushers]) || 0,
      total: indexMap.total === -1 ? 0 : Number(row[indexMap.total]) || 0
    };

    if (!normalizeDate(record.date) || !String(record.mass || '').trim()) {
      skipped++;
      continue;
    }

    upsertAttendanceRecord(record);
    imported++;
  }

  return {
    result: 'success',
    imported,
    skipped
  };
}

function validateSupabaseConnection() {
  try {
    const config = getSupabaseConfig();
    const query = 'select=date,mass&limit=1';
    supabaseRequest('get', config.table, query, null, null);

    return {
      result: 'success',
      provider: 'supabase',
      table: config.table,
      message: 'Supabase connection verified.'
    };
  } catch (err) {
    return {
      result: 'error',
      message: err.toString()
    };
  }
}

function migrateSheetsDataToSupabase() {
  try {
    const config = getSupabaseConfig();
    const records = readAllAttendanceRecordsFromSheets();

    records.forEach((record) => {
      upsertAttendanceRecordToSupabase(record);
    });

    return {
      result: 'success',
      migrated: records.length,
      table: config.table
    };
  } catch (err) {
    return {
      result: 'error',
      message: err.toString()
    };
  }
}

function buildWeeklyTrend(records) {
  const grouped = {};

  records.forEach(record => {
    const date = new Date(record.date + 'T00:00:00');
    const year = date.getFullYear();
    const week = getIsoWeek(date);
    const key = `${year}-W${String(week).padStart(2, '0')}`;

    if (!grouped[key]) {
      grouped[key] = { label: key, total: 0, count: 0 };
    }

    grouped[key].total += Number(record.total) || 0;
    grouped[key].count += 1;
  });

  return Object.values(grouped)
    .sort((a, b) => a.label.localeCompare(b.label))
    .slice(-12)
    .map(item => ({
      label: item.label,
      averageAttendance: Math.round(item.total / item.count)
    }));
}

function buildYearOverYear(records) {
  const grouped = {};

  records.forEach(record => {
    const date = new Date(record.date + 'T00:00:00');
    const year = date.getFullYear();
    const month = date.getMonth();

    if (!grouped[year]) {
      grouped[year] = Array(12).fill(0);
    }

    grouped[year][month] += Number(record.total) || 0;
  });

  const years = Object.keys(grouped).sort((a, b) => Number(a) - Number(b));
  if (years.length < 2) {
    return [];
  }

  const currentYear = years[years.length - 1];
  const previousYear = years[years.length - 2];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  return monthNames.map((monthName, index) => ({
    month: monthName,
    currentYear: grouped[currentYear] ? grouped[currentYear][index] : 0,
    previousYear: grouped[previousYear] ? grouped[previousYear][index] : 0,
    delta: (grouped[currentYear] ? grouped[currentYear][index] : 0) - (grouped[previousYear] ? grouped[previousYear][index] : 0)
  }));
}

function getIsoWeek(date) {
  const temp = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = temp.getUTCDay() || 7;
  temp.setUTCDate(temp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(temp.getUTCFullYear(), 0, 1));
  return Math.ceil((((temp - yearStart) / 86400000) + 1) / 7);
}
