import { API_URL } from './config.js';

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Gagal memuat data (' + res.status + ')');
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
}

async function postJson(payload) {
  const res = await fetch(API_URL, {
    method: 'POST',
    // text/plain sengaja dipakai supaya browser TIDAK mengirim preflight
    // OPTIONS request (Apps Script tidak bisa handle OPTIONS).
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Gagal menyimpan data (' + res.status + ')');
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

export const Api = {
  initAll() {
    return getJson(API_URL + '?action=initAll');
  },
  getSheet(name) {
    return getJson(API_URL + '?action=getSheet&sheet=' + encodeURIComponent(name));
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
