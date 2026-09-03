// Cashier Auth — login screen (nama + PIN) dan token management
import { CashierApi } from './cashier-api.js';

const TOKEN_KEY = 'cafeku_cashier_token';
const USER_KEY = 'cafeku_cashier_user';
const USERS_CACHE_KEY = 'cafeku_cashier_users_cache';
const USERS_TTL = 5 * 60 * 1000; // anggap segar 5 menit

export const CashierAuth = {
  // cek apakah sudah login
  isLoggedIn() {
    return !!localStorage.getItem(TOKEN_KEY);
  },
  getUser() {
    const u = localStorage.getItem(USER_KEY);
    return u ? JSON.parse(u) : null;
  },
  // simpan token + user
  setLogin(nama, role) {
    localStorage.setItem(TOKEN_KEY, 'logged-' + Date.now());
    localStorage.setItem(USER_KEY, JSON.stringify({ nama, role }));
  },
  clearLogin() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },

  // ---- cache daftar user (biar dropdown langsung muncul, tidak nunggu API) ----
  getCachedUsers() {
    try {
      const raw = localStorage.getItem(USERS_CACHE_KEY);
      if (!raw) return { users: [], fresh: false };
      const data = JSON.parse(raw);
      const fresh = (Date.now() - (data.ts || 0)) < USERS_TTL;
      return { users: data.users || [], fresh };
    } catch (e) {
      return { users: [], fresh: false };
    }
  },
  cacheUsers(users) {
    try {
      localStorage.setItem(USERS_CACHE_KEY, JSON.stringify({ users, ts: Date.now() }));
    } catch (e) { /* abaikan */ }
  },

  // fetch daftar user (untuk dropdown)
  async fetchUsers() {
    try {
      return await CashierApi.getUsers();
    } catch (err) {
      return [];
    }
  },

  // ---- login cepat: utamakan validasi dari cache lokal (instan) ----
  // hanya dipakai bila cache masih fresh (≤ TTL). Kalau bukan fresh atau
  // user tidak ada di cache -> validasi ke backend.
  fastLogin(nama, pin) {
    const { users, fresh } = this.getCachedUsers();
    if (!fresh) return null;
    const user = users.find(u => u.aktif !== false && u.nama === nama && String(u.pin) === String(pin));
    if (!user) return null;
    this.setLogin(user.nama, user.role || 'kasir');
    return user;
  },

  // login: validasi lokal dulu (cepat), fallback ke backend
  async login(nama, pin) {
    const localUser = this.fastLogin(nama, pin);
    if (localUser) {
      // sinkronkan user terbaru ke backend di background (tanpa blokir)
      this._confirmServer(nama, pin);
      return { success: true, nama: localUser.nama, role: localUser.role || 'kasir', local: true };
    }
    // tidak ada di cache -> tanya server
    const result = await CashierApi.login(nama, pin);
    if (!result.success) throw new Error(result.error || 'Login gagal');
    this.setLogin(result.nama, result.role);
    return result;
  },

  // verifikasi ke server di background (tidak menghalangi login cepat)
  // fungsi ini hanya menyegarkan cache user; tidak me-render ulang/meng-logout
  // supaya tidak ada "kicked out" yang membingungkan saat server lambat.
  async _confirmServer(nama, pin) {
    try {
      const users = await this.fetchUsers();
      this.cacheUsers(users);
    } catch (e) { /* offline/timed out -> abaikan, cache lama tetap dipakai */ }
  }
};
