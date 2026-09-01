import { Api } from './api.js';
import { SHEETS } from './config.js';

const QUEUE_KEY = 'cafeku_queue';

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
}

export const Store = {
  data: {},
  online: navigator.onLine,
  syncing: false,
  listeners: [],

  onChange(fn) { this.listeners.push(fn); },
  emit() { this.listeners.forEach(fn => fn()); },

  loadFromLocal() {
    SHEETS.forEach(name => {
      const raw = localStorage.getItem('cache_' + name);
      this.data[name] = raw ? JSON.parse(raw) : [];
    });
  },

  saveLocal(sheet) {
    localStorage.setItem('cache_' + sheet, JSON.stringify(this.data[sheet] || []));
  },

  get(sheet) {
    return (this.data[sheet] || []).filter(r => !r.deleted);
  },
  getWithDeleted(sheet) {
    return this.data[sheet] || [];
  },

  getById(sheet, id) {
    return (this.data[sheet] || []).find(r => r.id === id);
  },

  async syncAll(silent) {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const all = await Api.initAll();
      Object.keys(all).forEach(sheet => {
        // gabungkan item lokal yang masih dalam antrian (belum terkirim ke server)
        // agar tidak hilang dari cache saat disinkronkan.
        const serverData = all[sheet] || [];
        const queuedIds = this._queuedIdsForSheet(sheet);
        let merged = serverData;
        if (queuedIds.size) {
          const local = this.data[sheet] || [];
          const queued = local.filter(r => queuedIds.has(r.id));
          if (queued.length) {
            merged = serverData.filter(r => !queuedIds.has(r.id)).concat(queued);
          }
        }
        this.data[sheet] = merged;
        this.saveLocal(sheet);
      });
      localStorage.setItem('cafeku_last_sync', String(Date.now()));
      this.emit();
    } catch (err) {
      if (!silent) console.warn('Sync gagal, pakai data cache lokal:', err.message);
    } finally {
      this.syncing = false;
    }
  },

  // kumpulkan id yang masih menunggu dikirim (di antrian) untuk sebuah sheet
  _queuedIdsForSheet(sheet) {
    const q = this._getQueue();
    const ids = new Set();
    q.forEach(j => {
      if (j.sheet !== sheet) return;
      if (j.action === 'insert' || j.action === 'update') {
        if (j.id) ids.add(j.id);
        else if (j.items) j.items.forEach(i => i.id && ids.add(i.id));
      } else if (j.action === 'batchUpdate' && j.items) {
        j.items.forEach(i => i.id && ids.add(i.id));
      }
    });
    return ids;
  },

  // ---- optimistic writes: update UI dulu, baru kirim ke server di belakang layar ----

  async insert(sheet, obj) {
    if (!obj.id) obj.id = uid();
    obj.createdAt = obj.createdAt || new Date().toISOString();
    this.data[sheet] = this.data[sheet] || [];
    this.data[sheet].push(obj);
    this.saveLocal(sheet);
    this.emit();
    this._push('insert', sheet, obj);
    return obj;
  },

  async update(sheet, id, patch) {
    const list = this.data[sheet] || [];
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) return null;
    const updated = Object.assign({}, list[idx], patch, { id });
    list[idx] = updated;
    this.saveLocal(sheet);
    this.emit();
    this._push('update', sheet, updated);
    return updated;
  },

  async batchUpdate(sheet, patches) {
    // patches: [{id, patch}]
    const list = this.data[sheet] || [];
    const items = [];
    patches.forEach(({ id, patch }) => {
      const idx = list.findIndex(r => r.id === id);
      if (idx > -1) {
        list[idx] = Object.assign({}, list[idx], patch, { id });
        items.push({ id, data: list[idx] });
      }
    });
    this.saveLocal(sheet);
    this.emit();
    this._pushBatch('batchUpdate', sheet, items);
    return items;
  },

  async remove(sheet, id) {
    this.data[sheet] = (this.data[sheet] || []).filter(r => r.id !== id);
    this.saveLocal(sheet);
    this.emit();
    this._push('delete', sheet, { id });
  },

  softDelete(sheet, id) {
    return this.update(sheet, id, { deleted: true, deletedAt: new Date().toISOString() });
  },

  // ---- antrian kirim ke server (retry kalau gagal / offline) ----

  _getQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
    catch (e) { return []; }
  },
  _setQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); },

  _push(action, sheet, data) {
    const q = this._getQueue();
    // dedup: hapus entry dengan action+id yang sama agar tidak double kirim
    if (action === 'insert' || action === 'update' || action === 'delete') {
      const idx = q.findIndex(j => j.action === action && j.sheet === sheet && j.id === data.id);
      if (idx > -1) q.splice(idx, 1);
    }
    q.push({ action, sheet, data, id: data.id, ts: Date.now(), attempts: 0 });
    this._setQueue(q);
    this._flush();
  },
  _pushBatch(action, sheet, items) {
    const q = this._getQueue();
    q.push({ action, sheet, items, ts: Date.now(), attempts: 0 });
    this._setQueue(q);
    this._flush();
  },

  async _flush() {
    if (this._flushing) return;
    this._flushing = true;
    const MAX_ATTEMPTS = 5;
    let q = this._getQueue();
    while (q.length) {
      const job = q[0];
      try {
        if (job.action === 'insert') await Api.insert(job.sheet, job.data);
        else if (job.action === 'update') await Api.update(job.sheet, job.id, job.data);
        else if (job.action === 'delete') await Api.remove(job.sheet, job.id);
        else if (job.action === 'batchUpdate') await Api.batchUpdate(job.sheet, job.items);
        q.shift();
        this._setQueue(q);
      } catch (err) {
        job.attempts = (job.attempts || 0) + 1;
          if (job.attempts >= MAX_ATTEMPTS) {
          q.shift();
          try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (e) {}
          console.error('Queue job gagal permanen setelah', MAX_ATTEMPTS, 'x:', job);
          try { window.dispatchEvent(new CustomEvent('store:failed', { detail: { sheet: job.sheet, id: job.id || job.items } })); } catch (e) {}
        } else {
          // backoff eksponensial: 10s, 20s, 40s...
          job.nextRetry = Date.now() + Math.pow(2, job.attempts) * 5000;
          this._setQueue(q);
          break; // coba lagi nanti
        }
      }
    }
    this._flushing = false;
  },

  pendingCount() {
    return this._getQueue().filter(j => !j.failed).length;
  },
  pendingFailedCount() {
    return this._getQueue().filter(j => j.failed).length;
  }
};

window.addEventListener('online', () => { Store.online = true; Store._flush(); });
window.addEventListener('offline', () => { Store.online = false; });

setInterval(() => Store._flush(), 8000);
