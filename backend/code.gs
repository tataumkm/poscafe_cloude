/**
 * CAFEKU — Backend API (Google Apps Script)
 * ------------------------------------------------------------
 * Setiap "tabel" = 1 sheet/tab, dengan HANYA 1 kolom (kolom A) berisi
 * string JSON per baris. Ini bikin baca/tulis jauh lebih cepat karena
 * Apps Script tidak perlu parsing banyak kolom, dan kita bisa
 * getRange(...).getValues() dalam 1 kali panggilan saja.
 *
 * CARA DEPLOY:
 * 1. Buka https://sheets.google.com -> buat Spreadsheet baru, beri nama "CafekuDB".
 * 2. Extensions -> Apps Script. Hapus isi default, paste seluruh file ini.
 * 3. Klik Deploy -> New deployment -> pilih tipe "Web app".
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4. Copy URL Web App yang muncul (https://script.google.com/macros/s/xxxx/exec)
 *    Paste ke js/app.js pada variabel API_URL.
 * 5. Jalankan fungsi `setup()` sekali dari editor Apps Script (pilih fungsi
 *    "setup" di dropdown atas, lalu klik Run) untuk membuat semua sheet +
 *    data default (Settings, dsb).
 *
 * CATATAN CORS:
 * Frontend WAJIB kirim POST dengan header Content-Type: text/plain
 * (bukan application/json) supaya browser tidak mengirim preflight
 * OPTIONS request — karena Apps Script Web App tidak menghandle OPTIONS.
 * Ini sudah diatur otomatis di js/app.js, tidak perlu diubah.
 */

const SHEETS = ['Modal', 'Aset', 'BelanjaBahan', 'Bahan', 'Menu', 'Penjualan', 'Settings', 'Kas', 'Promo'];
const CACHE_TTL_SECONDS = 20; // cache tiap sheet 20 detik -> tahan traffic tinggi

// ============ ENTRY POINTS ============

function doGet(e) {
  try {
    const action = e.parameter.action;
    if (action === 'initAll') return respond(getAllSheetsData());
    if (action === 'getSheet') return respond(getSheetData(e.parameter.sheet));
    return respond({ error: 'Unknown action: ' + action }, 400);
  } catch (err) {
    return respond({ error: err.message }, 500);
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    let result;
    switch (action) {
      case 'insert':
        result = insertRow(body.sheet, body.data);
        break;
      case 'update':
        result = updateRow(body.sheet, body.id, body.data);
        break;
      case 'delete':
        result = deleteRow(body.sheet, body.id);
        break;
      case 'batchUpdate':
        result = batchUpdateRows(body.sheet, body.items);
        break;
      case 'batchInsert':
        result = batchInsertRows(body.sheet, body.items);
        break;
      default:
        return respond({ error: 'Unknown action: ' + action }, 400);
    }
    invalidateCache(body.sheet);
    return respond({ success: true, result: result });
  } catch (err) {
    return respond({ error: err.message }, 500);
  }
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
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
            if (obj.deleted) return; // soft-deleted, jangan dikirim
            obj._row = idx + 2;
            rows.push(obj);
          } catch (e) { /* skip baris rusak */ }
        }
      });
  }
  // cache disimpan sebagai string, batasi ukuran (cache service max ~100KB/key)
  try {
    cache.put(cacheKey, JSON.stringify(rows), CACHE_TTL_SECONDS);
  } catch (e) { /* kalau kepenuhan, skip cache saja */ }
  return rows;
}

function getAllSheetsData() {
  const result = {};
  SHEETS.forEach(function (name) {
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
  data.createdAt = data.createdAt || new Date().toISOString();
  sheet.appendRow([JSON.stringify(data)]);
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

// ============ SETUP (jalankan sekali secara manual) ============

function setup() {
  SHEETS.forEach(function (name) { getSheet_(name); });

  // Default pengaturan margin & platform online
  const settingsSheet = getSheet_('Settings');
  if (settingsSheet.getLastRow() < 2) {
    const defaultSettings = {
      id: 'settings-1',
      defaultMarginPercent: 40,
      platforms: [
        { nama: 'Offline', adminPercent: 0 },
        { nama: 'GoFood', adminPercent: 20 },
        { nama: 'GrabFood', adminPercent: 20 },
        { nama: 'ShopeeFood', adminPercent: 20 }
      ],
      createdAt: new Date().toISOString()
    };
    settingsSheet.appendRow([JSON.stringify(defaultSettings)]);
  }
  Logger.log('Setup selesai. Semua sheet sudah dibuat.');
}
