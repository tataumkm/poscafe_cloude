// Cashier API client — sama seperti api.js, tapi semua request kirim apiKey
import { API_URL_CASHIER, API_KEY_CASHIER } from './config.js';

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Gagal memuat data (' + res.status + ')');
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
}

async function postJson(payload) {
  const res = await fetch(API_URL_CASHIER + '?apiKey=' + API_KEY_CASHIER, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Gagal menyimpan data (' + res.status + ')');
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

function withKey(qs) {
  return '?apiKey=' + API_KEY_CASHIER + (qs ? '&' + qs : '');
}

export const CashierApi = {
  initAll() {
    return getJson(API_URL_CASHIER + withKey('action=initAll'));
  },
  getSheet(name) {
    return getJson(API_URL_CASHIER + withKey('action=getSheet&sheet=' + encodeURIComponent(name)));
  },
  getUsers() {
    return getJson(API_URL_CASHIER + withKey('action=getUsers'));
  },
  login(nama, pin) {
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
