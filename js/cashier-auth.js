// Cashier Auth — login screen (nama + PIN) dan token management
import { CashierApi } from './cashier-api.js';

const TOKEN_KEY = 'cafeku_cashier_token';
const USER_KEY = 'cafeku_cashier_user';

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
  // fetch daftar user (untuk dropdown)
  async fetchUsers() {
    try {
      return await CashierApi.getUsers();
    } catch (err) {
      return [];
    }
  },
  // login: kirim ke backend, dapat success/gagal
  async login(nama, pin) {
    const result = await CashierApi.login(nama, pin);
    if (!result.success) throw new Error(result.error || 'Login gagal');
    this.setLogin(result.nama, result.role);
    return result;
  }
};
