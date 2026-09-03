import { API_URL_CASHIER, API_KEY_CASHIER } from './config.js';

function buildUrl(qs) {
  const hasKey = API_URL_CASHIER.includes('AKfycbwQEvnawOQlhAfH9l1gMzZbDfXfT8hUob1D-rCSCQDlUzY8g5FHLvS1NoJjs7_8fB9ZJg');
  const sep = API_URL_CASHIER.includes('?') ? '&' : '?';
  if (hasKey) return API_URL_CASHIER + sep + 'apiKey=' + API_KEY_CASHIER + (qs ? '&' + qs : '');
  return API_URL_CASHIER + sep + (qs || '');
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Gagal memuat data (' + res.status + ')');
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
}

async function postJson(payload) {
  const hasKey = API_URL_CASHIER.includes('AKfycbwQEvnawOQlhAfH9l1gMzZbDfXfT8hUob1D-rCSCQDlUzY8g5FHLvS1NoJjs7_8fB9ZJg');
  const url = hasKey ? API_URL_CASHIER + '?apiKey=' + API_KEY_CASHIER : API_URL_CASHIER;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Gagal menyimpan data (' + res.status + ')');
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.result || json;
}

export const CashierApi = {
  initAll() { return getJson(buildUrl('action=initAll')); },
  getSheet(name) { return getJson(buildUrl('action=getSheet&sheet=' + encodeURIComponent(name))); },
  getUsers() { return getJson(buildUrl('action=getUsers')); },
  login(nama, pin) { return postJson({ action: 'login', nama, pin }); },
  insert(sheet, data) { return postJson({ action: 'insert', sheet, data }); },
  update(sheet, id, data) { return postJson({ action: 'update', sheet, id, data }); },
  remove(sheet, id) { return postJson({ action: 'delete', sheet, id }); },
  batchUpdate(sheet, items) { return postJson({ action: 'batchUpdate', sheet, items }); },
  batchInsert(sheet, items) { return postJson({ action: 'batchInsert', sheet, items }); }
};
