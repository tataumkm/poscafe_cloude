/**
 * CAFEKU KASIR — Backend API (Google Apps Script)
 * ------------------------------------------------
 * Sama seperti code.gs, tapi:
 * 1. Mewajibkan API key di setiap request (proteksi dasar)
 * 2. Hanya mengizinkan sheet tertentu (tidak ada Modal, Aset, BelanjaBahan)
 * 3. Tambahan action: login (validasi user + PIN)
 * 4. Penambahan sheet 'Users' untuk user management
 *
 * DEPLOY:
 * 1. Buka Google Sheets (bisa pakai yang sama dengan owner, atau yang baru)
 * 2. Extensions -> Apps Script. Paste file ini.
 * 3. Deploy -> New deployment -> Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4. Copy URL Web App -> paste ke js/config.js sebagai API_URL_CASHIER
 * 5. Ubah API_KEY_CASHIER di config.js (bisa pakai nilai acak)
 * 6. Buat sheet 'Users' dengan kolom A = JSON blob:
 *    [{id, nama, pin, aktif, role}]
 *    atau jalankan setupCashierUsers() untuk membuat data default.
 */

const API_KEY_CASHIER = 'cafeku_kasir_2025';
const ALLOWED_SHEETS_CASHIER = ['Menu', 'Bahan', 'Settings', 'Penjualan', 'Promo', 'Kas', 'Users'];
const SHEETS = ALLOWED_SHEETS_CASHIER;
const CACHE_TTL_SECONDS = 20;

function respond(obj, code = 200) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function apiKeyValid(key) {
  return typeof key === 'string' && key === API_KEY_CASHIER;
}

function isAllowedSheet(name) {
  return ALLOWED_SHEETS_CASHIER.includes(name);
}

// ============ ENTRY POINTS ============

function doGet(e) {
  try {
    const apiKey = e.parameter.apiKey || e.parameter.key;
    if (!apiKeyValid(apiKey)) return respond({ error: 'Unauthorized' }, 403);

    const action = e.parameter.action;
    if (action === 'initAll') return respond(getAllSheetsData());
    if (action === 'getSheet') {
      const sheet = e.parameter.sheet;
      if (!isAllowedSheet(sheet)) return respond({ error: 'Forbidden sheet: ' + sheet }, 403);
      return respond(getSheetData(sheet));
    }
    if (action === 'getUsers') return respond(getSheetData('Users').filter(u => u.aktif !== false));
    return respond({ error: 'Unknown action: ' + action }, 400);
  } catch (err) {
    return respond({ error: err.message }, 500);
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const apiKey = body.apiKey || body.key;
    if (!apiKeyValid(apiKey)) return respond({ error: 'Unauthorized' }, 403);

    const action = body.action;

    if (action === 'login') {
      return respond(doLogin(body));
    }

    // insert/update/delete — cek sheet
    const sheet = body.sheet;
    if (!isAllowedSheet(sheet)) return respond({ error: 'Forbidden sheet: ' + sheet }, 403);

    let result;
    switch (action) {
      case 'insert':       result = insertRow(sheet, body.data); break;
      case 'update':       result = updateRow(sheet, body.id, body.data); break;
      case 'delete':       result = deleteRow(sheet, body.id); break;
      case 'batchUpdate':  result = batchUpdateRows(sheet, body.items); break;
      case 'batchInsert':  result = batchInsertRows(sheet, body.items); break;
      default:
        return respond({ error: 'Unknown action: ' + action }, 400);
    }
    invalidateCache(sheet);
    return respond({ success: true, result: result });
  } catch (err) {
    return respond({ error: err.message }, 500);
  }
}

// ============ LOGIN ============

function doLogin(body) {
  const nama = body.nama;
  const pin = body.pin;
  if (!nama || !pin) return { success: false, error: 'Nama & PIN harus diisi' };

  const users = getSheetData('Users').filter(u => u.aktif !== false);
  const user = users.find(u => u.nama === nama && String(u.pin) === String(pin));
  if (!user) return { success: false, error: 'Nama atau PIN salah' };

  return { success: true, nama: user.nama, role: user.role || 'kasir' };
}

function setupCashierUsers() {
  const usersSheet = getSheet_('Users');
  if (usersSheet.getLastRow() < 2) {
    const defaultUsers = [
      { id: 'u1', nama: 'Kasir 1', pin: '0000', role: 'kasir', aktif: true, createdAt: new Date().toISOString() },
      { id: 'u2', nama: 'Kasir 2', pin: '1111', role: 'kasir', aktif: true, createdAt: new Date().toISOString() },
    ];
    defaultUsers.forEach(u => usersSheet.appendRow([JSON.stringify(u)]));
  }
}

// ============ SHEET HELPERS ============

function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1).setValue('data');
    sheet.setColumnWidth(1, 900);
  }
  return sheet;
}

function getSheetData(name) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'sheet_' + name;
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const sheet = getSheet_(name);
  const lastRow = sheet.getLastRow();
  const rows = [];
  if (lastRow >= 2) {
    const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    values.forEach(function (r, idx) {
      if (r[0]) {
        try {
          const obj = JSON.parse(r[0]);
          if (obj.deleted) return;
          obj._row = idx + 2;
          rows.push(obj);
        } catch (e) { /* skip baris rusak */ }
      }
    });
  }
  try { cache.put(cacheKey, JSON.stringify(rows), CACHE_TTL_SECONDS); } catch (e) { /* skip cache */ }
  return rows;
}

function getAllSheetsData() {
  const result = {};
  ALLOWED_SHEETS_CASHIER.forEach(function (name) {
    result[name] = getSheetData(name);
  });
  return result;
}

function invalidateCache(name) {
  CacheService.getScriptCache().remove('sheet_' + name);
}

function findRowById_(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0]) {
      try {
        const obj = JSON.parse(values[i][0]);
        if (obj.id === id) return i + 2;
      } catch (e) { /* skip */ }
    }
  }
  return -1;
}

// ============ CRUD ============

function insertRow(sheetName, data) {
  const sheet = getSheet_(sheetName);
  if (!data.id) data.id = Utilities.getUuid();
  const existing = findRowById_(sheet, data.id);
  if (existing !== -1) {
    data.updatedAt = new Date().toISOString();
    sheet.getRange(existing, 1).setValue(JSON.stringify(data));
  } else {
    data.createdAt = data.createdAt || new Date().toISOString();
    sheet.appendRow([JSON.stringify(data)]);
  }
  invalidateCache(sheetName);
  return data;
}

function batchInsertRows(sheetName, items) {
  const sheet = getSheet_(sheetName);
  const rows = items.map(function (data) {
    if (!data.id) data.id = Utilities.getUuid();
    data.createdAt = data.createdAt || new Date().toISOString();
    return [JSON.stringify(data)];
  });
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 1).setValues(rows);
  }
  return items;
}

function updateRow(sheetName, id, data) {
  const sheet = getSheet_(sheetName);
  const row = findRowById_(sheet, id);
  if (row === -1) throw new Error('ID tidak ditemukan di ' + sheetName + ': ' + id);
  data.id = id;
  data.updatedAt = new Date().toISOString();
  sheet.getRange(row, 1).setValue(JSON.stringify(data));
  return data;
}

function batchUpdateRows(sheetName, items) {
  const sheet = getSheet_(sheetName);
  items.forEach(function (item) {
    const row = findRowById_(sheet, item.id);
    if (row !== -1) {
      item.data.id = item.id;
      item.data.updatedAt = new Date().toISOString();
      sheet.getRange(row, 1).setValue(JSON.stringify(item.data));
    }
  });
  return items;
}

function deleteRow(sheetName, id) {
  const sheet = getSheet_(sheetName);
  const row = findRowById_(sheet, id);
  if (row === -1) throw new Error('ID tidak ditemukan di ' + sheetName + ': ' + id);
  sheet.deleteRow(row);
  return { id: id };
}

function setup() {
  ALLOWED_SHEETS_CASHIER.forEach(function (name) { getSheet_(name); });
  // default Settings jika belum ada
  const settingsSheet = getSheet_('Settings');
  if (settingsSheet.getLastRow() < 2) {
    settingsSheet.appendRow([JSON.stringify({
      id: 'settings-1',
      defaultMarginPercent: 40,
      platforms: [
        { nama: 'Offline', adminPercent: 0 },
        { nama: 'GoFood', adminPercent: 20 },
        { nama: 'GrabFood', adminPercent: 20 },
        { nama: 'ShopeeFood', adminPercent: 20 }
      ],
      createdAt: new Date().toISOString()
    })]);
  }
  setupCashierUsers();
  Logger.log('Setup cashier selesai.');
}
