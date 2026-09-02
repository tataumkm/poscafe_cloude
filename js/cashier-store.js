// Cashier Store — versi ringan dari store.js
// Pakai prefix localStorage YANG BERTBEDA agar tidak bentrok dengan owner app
import { CashierApi } from './cashier-api.js';

const PREFIX = 'cafeku_cashier';
const QUEUE_KEY = PREFIX + '_queue';
const SETTINGS_CACHE = ['Menu', 'Bahan', 'Settings', 'Penjualan', 'Promo', 'Kas'];

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
}

export const CashierStore = {
  data: {},
  online: navigator.onLine,
  listeners: [],

  onChange(fn) { this.listeners.push(fn); },
  emit() { this.listeners.forEach(fn => fn()); },

  loadFromLocal() {
    SETTINGS_CACHE.forEach(name => {
      const raw = localStorage.getItem(PREFIX + '_cache_' + name);
      this.data[name] = raw ? JSON.parse(raw) : [];
    });
  },

  saveLocal(sheet) {
    localStorage.setItem(PREFIX + '_cache_' + sheet, JSON.stringify(this.data[sheet] || []));
  },

  get(sheet) {
    return (this.data[sheet] || []).filter(r => !r.deleted);
  },

  getById(sheet, id) {
    return (this.data[sheet] || []).find(r => r.id === id);
  },

  async syncAll(silent) {
    try {
      const all = await CashierApi.initAll();
      Object.keys(all).forEach(sheet => {
        if (!SETTINGS_CACHE.includes(sheet)) return;
        this.data[sheet] = all[sheet] || [];
        this.saveLocal(sheet);
      });
      localStorage.setItem(PREFIX + '_last_sync', String(Date.now()));
      this.emit();
    } catch (err) {
      if (!silent) console.warn('Cashier sync gagal:', err.message);
    }
  },

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

  async remove(sheet, id) {
    this.data[sheet] = (this.data[sheet] || []).filter(r => r.id !== id);
    this.saveLocal(sheet);
    this.emit();
    this._push('delete', sheet, { id });
  },

  _getQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
    catch (e) { return []; }
  },

  _setQueue(q) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  },

  _push(action, sheet, data) {
    const q = this._getQueue();
    if (action === 'insert' || action === 'update' || action === 'delete') {
      const idx = q.findIndex(j => j.action === action && j.sheet === sheet && j.id === data.id);
      if (idx > -1) q.splice(idx, 1);
    }
    q.push({ action, sheet, data, id: data.id, ts: Date.now(), attempts: 0 });
    this._setQueue(q);
    this._flush();
  },

  async _flush() {
    if (this._flushing) return;
    this._flushing = true;
    const MAX_ATTEMPTS = 5;
    while (true) {
      const q = this._getQueue();
      const job = q.find(j => j.attempts < MAX_ATTEMPTS && (!j.nextRetry || j.nextRetry <= Date.now()));
      if (!job) break;
      const jobKey = job.action + '|' + job.sheet + '|' + (job.id || '') + '|' + (job.ts || '');
      try {
        if (job.action === 'insert') await CashierApi.insert(job.sheet, job.data);
        else if (job.action === 'update') await CashierApi.update(job.sheet, job.id, job.data);
        else if (job.action === 'delete') await CashierApi.remove(job.sheet, job.id);
        const fresh = this._getQueue();
        const fi = fresh.findIndex(j => j.action + '|' + j.sheet + '|' + (j.id || '') + '|' + (j.ts || '') === jobKey);
        if (fi > -1) fresh.splice(fi, 1);
        this._setQueue(fresh);
      } catch (err) {
        const fresh = this._getQueue();
        const fi = fresh.findIndex(j => j.action + '|' + j.sheet + '|' + (j.id || '') + '|' + (j.ts || '') === jobKey);
        if (fi > -1) {
          const fj = fresh[fi];
          fj.attempts = (fj.attempts || 0) + 1;
          if (fj.attempts >= MAX_ATTEMPTS) {
            fresh.splice(fi, 1);
            console.error('Queue job gagal permanen:', fj);
          } else {
            fj.nextRetry = Date.now() + Math.pow(2, fj.attempts) * 5000;
          }
        }
        this._setQueue(fresh);
      }
    }
    this._flushing = false;
  },

  pendingCount() {
    return this._getQueue().length;
  }
};

window.addEventListener('online', () => { CashierStore.online = true; CashierStore._flush(); });
window.addEventListener('offline', () => { CashierStore.online = false; });
setInterval(() => CashierStore._flush(), 8000);
