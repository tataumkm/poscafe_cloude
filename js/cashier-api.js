// Cashier API client — works with both owner backend (no auth) and cashier backend (with API key)
import { API_URL_CASHIER, API_KEY_CASHIER } from './config.js';

// Detect if using owner backend (no API key needed) or cashier backend (needs API key)
const USE_API_KEY = API_URL_CASHIER.includes('AKfycbwQEvnawOQlhAfH9l1gMzZbDfXfT8hUob1D-rCSCQDlUzY8g5FHLvS1NoJjs7_8fB9ZJg');

function buildUrl(qs) {
  const base = API_URL_CASHIER + '?';
  if (USE_API_KEY) {
    return base + 'apiKey=' + API_KEY_CASHIER + (qs ? '&' + qs : '');
  }
  return base + (qs ? qs : '');
}

async function getJson(url) {
  console.log('[DEBUG api] GET:', url);
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    console.error('[DEBUG api] GET failed:', res.status, txt);
    throw new Error('Gagal memuat data (' + res.status + ')');
  }
  const json = await res.json();
  console.log('[DEBUG api] GET response:', json);
  if (json.error) throw new Error(json.error);
  return json;
}

async function postJson(payload) {
  const url = USE_API_KEY 
    ? API_URL_CASHIER + '?apiKey=' + API_KEY_CASHIER 
    : API_URL_CASHIER;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const txt = await res.text();
    console.error('[DEBUG api] POST failed:', res.status, txt);
    throw new Error('Gagal menyimpan data (' + res.status + ')');
  }
  const json = await res.json();
  console.log('[DEBUG api] POST response:', json);
  if (json.error) throw new Error(json.error);
  return json.result || json;
}

export const CashierApi = {
  initAll() {
    return getJson(buildUrl('action=initAll'));
  },
  getSheet(name) {
    return getJson(buildUrl('action=getSheet&sheet=' + encodeURIComponent(name)));
  },
  getUsers() {
    return getJson(buildUrl('action=getUsers'));
  },
  login(nama, pin) {
    console.log('[DEBUG api] login:', { nama, pin });
    return postJson({ action: 'login', nama, pin });
  },
  insert(sheet, data) {
    return postJson({ action: 'insert', sheet, data });
  },
  update(sheet, id, data) {
    return postJson({ action: 'update', sheet, id, data });
  },
  remove(sheet, id) {
    return postJson({ action: 'delete', sheet, id });
  },
  batchUpdate(sheet, items) {
    return postJson({ action: 'batchUpdate', sheet, items });
  },
  batchInsert(sheet, items) {
    return postJson({ action: 'batchInsert', sheet, items });
  }
};