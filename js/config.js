// GANTI dengan URL Web App hasil deploy Google Apps Script kamu.
// Contoh: https://script.google.com/macros/s/AKfycb.../exec
export const API_URL = 'https://script.google.com/macros/s/AKfycbzo_KwWxD07G6-ebSxj8D_oEapS_XUsmeOMoDAOj8OAxz7WrUddnwL0xo8hg7GqU7RM/exec';

export const SHEETS = ['Modal', 'Aset', 'BelanjaBahan', 'Bahan', 'Menu', 'Penjualan', 'Settings', 'Kas', 'Promo', 'Users'];

// Berapa lama data lokal dianggap "segar" sebelum auto re-sync ke server (ms)
export const AUTO_SYNC_INTERVAL = 60 * 1000;

// ===== CASHIER APP CONFIG =====
// TEMPORARY: Use owner backend URL for testing (no API key required)
// Deploy code-cashier.gs separately for production
export const API_URL_CASHIER = 'https://script.google.com/macros/s/AKfycbzo_KwWxD07G6-ebSxj8D_oEapS_XUsmeOMoDAOj8OAxz7WrUddnwL0xo8hg7GqU7RM/exec';
export const API_KEY_CASHIER = 'cafeku_kasir_2025';
