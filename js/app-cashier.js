// ===== CAFeku KASIR — Main App (standalone PWA) =====
import { CashierApi } from './cashier-api.js';
import { CashierAuth } from './cashier-auth.js';
import { CashierStore } from './cashier-store.js';
import {
  isBleSupported, isPrinterConnected, getPrinterName, connectPrinter,
  disconnectPrinter, testPrint, buildEscPos, printBytes
} from './ble.js';
import {
  rupiah, numOnly, todayStr, nowTimeStr,
  hitungHpp, hitungHargaSaran, uid, toast, getPrintPref
} from './utils.js';

// ================= STATE =================
const state = {
  page: 'login',
  tab: 'kasir',
  subtab: null,
  cart: [],
  platform: 'Offline',
  metodeBayar: 'tunai',
  adjustment: 0,
  menuSearch: '',
  kategoriFilter: 'Semua',
  stagedTrx: null,
  printModalTrx: null,
  printModalBayar: 0,
  sesiKas: null,
  riwayatSearch: '',
  riwayatFilter: 'hari',
  users: [],
  noMeja: '',
  namaPembeli: '',
  loggingIn: false,
};

const $app = document.getElementById('app');
let payStr = '';
const AUTO_SYNC_INTERVAL = 60 * 1000;

// ================= INIT =================
async function init() {
  CashierStore.loadFromLocal();
  if (CashierAuth.isLoggedIn()) {
    state.page = 'main';
    render();
    CashierStore.syncAll(true).then(() => { CashierStore._flush(); render(); });
    setInterval(() => { CashierStore.syncAll(true).then(() => CashierStore._flush()).then(render); }, AUTO_SYNC_INTERVAL);
  } else {
    state.page = 'login';
    // tampilkan daftar kasir dari cache dulu (instan), lalu segarkan di background
    const cached = CashierAuth.getCachedUsers();
    state.users = cached.users;
    render();
    refreshUsers();
  }
}

async function refreshUsers() {
  try {
    const users = await CashierApi.getUsers();
    if (Array.isArray(users) && users.length) {
      state.users = users;
      CashierAuth.cacheUsers(users);
      // re-render hanya kalau masih login page & PIN belum diketik,
      // supaya refresh tidak menghapus PIN yang sedang dimasukkan user.
      const pinEl = document.getElementById('cl-pin');
      if (state.page === 'login' && (!pinEl || !pinEl.value)) render();
    }
  } catch (e) {
    // offline -> biarkan cache lama, dropdown tetap berfungsi
  }
}

async function loadUsers() {
  try {
    state.users = await CashierApi.getUsers();
    CashierAuth.cacheUsers(state.users);
    render();
  } catch (e) {
    toast('Gagal load data: ' + e.message);
  }
}

async function handleLogin() {
  if (state.loggingIn) return;
  const nama = (document.getElementById('cl-nama') || {}).value || '';
  const pin = (document.getElementById('cl-pin') || {}).value || '';
  if (!nama || !pin) { toast('Pilih nama & isi PIN'); return; }
  state.loggingIn = true;
  const btn = document.querySelector('[data-login-btn]');
  if (btn) { btn.disabled = true; btn.textContent = 'Masuk…'; }
  try {
    await CashierAuth.login(nama, pin);
    state.page = 'main';
    state.tab = 'kasir';
    render();
    CashierStore.syncAll(true).then(() => { CashierStore._flush(); render(); });
    setInterval(() => { CashierStore.syncAll(true).then(() => CashierStore._flush()).then(render); }, AUTO_SYNC_INTERVAL);
  } catch (err) {
    toast('Login gagal: ' + err.message);
    // reset PIN supaya tidak ada residu yang membingungkan
    const pinEl = document.getElementById('cl-pin');
    if (pinEl) pinEl.value = '';
    if (btn) { btn.disabled = false; btn.textContent = 'Masuk'; }
  } finally {
    state.loggingIn = false;
  }
}

function handleLogout() {
  CashierAuth.clearLogin();
  state.page = 'login';
  state.tab = 'kasir';
  state.subtab = null;
  state.cart = [];
  state.menuSearch = '';
  render();
  loadUsers();
}

// ================= HELPERS DATA =================
function getSettings() {
  const s = CashierStore.get('Settings')[0];
  return s || { defaultMarginPercent: 40, platforms: [{ nama: 'Offline', adminPercent: 0 }] };
}
function getMenuList() { return CashierStore.get('Menu'); }
function getBahanList() { return CashierStore.get('Bahan'); }
function getPromoAktif() {
  const t = todayStr();
  return CashierStore.get('Promo').filter(p => p.aktif !== false
    && (!p.tglMulai || p.tglMulai <= t) && (!p.tglSelesai || t <= p.tglSelesai)
  ).sort((a, b) => {
    const na = a.jenis === 'persen' ? Number(a.nilai) : 0;
    const nb = b.jenis === 'persen' ? Number(b.nilai) : 0;
    return nb - na;
  });
}
function adminPercentFor(name) {
  const s = getSettings();
  const p = s.platforms.find(x => x.nama === name);
  return p ? p.adminPercent : 0;
}
function diskonTransaksi(subtotal) {
  const promos = getPromoAktif().filter(p => p.tipe === 'transaksi');
  if (!promos.length) return 0;
  return Math.max(...promos.map(p => {
    const v = potonganPromo(p, subtotal);
    return p.jenis === 'persen' ? Math.min(v, subtotal) : v;
  }));
}
function potonganPromo(p, subtotal) {
  if (p.jenis === 'persen') return subtotal * Number(p.nilai) / 100;
  return Number(p.nilai || 0);
}
function promoMenuTerpilih(menu) {
  const promos = getPromoAktif().filter(p => p.tipe === 'menu' && (!p.menuId || p.menuId === menu.id));
  if (!promos.length) return null;
  return promos[0];
}
function hargaJualEfektif(menu, hargaNormal, hargaSaran) {
  if (menu.hargaJualManual) return hargaSaran;
  const promo = promoMenuTerpilih(menu);
  if (!promo) return hargaSaran;
  if (promo.jenis === 'persen') return Math.max(0, hargaSaran * (1 - Number(promo.nilai) / 100));
  return Math.max(0, hargaSaran - Number(promo.nilai));
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function formatTanggalCashier(iso) {
  if (!iso) return '-';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ================= RENDER =================
function render() {
  if (state.page === 'login') {
    $app.innerHTML = renderLogin();
    return;
  }
  $app.innerHTML = `
    <div class="pos-app">
      <div class="cashier-header">
        <h1>Cafeku Kasir</h1>
        <div class="ch-right">
          <span class="ch-user">${escapeHtml(CashierAuth.getUser()?.nama || '')}</span>
          <button id="btn-printer-connect">${isPrinterConnected() ? 'Printer ✓' : 'Konek Printer'}</button>
          <button class="ch-logout" data-logout>Keluar</button>
        </div>
      </div>
      <div class="pos-body">
        ${state.tab === 'kasir' ? renderKasirSplit() : renderTabContent()}
      </div>
      <nav class="pos-bottomnav">
        <button class="${state.tab === 'kasir' ? 'active' : ''}" data-tab="kasir"><i class="fa fa-utensils"></i><span>Kasir</span></button>
        <button class="${state.tab === 'riwayat' ? 'active' : ''}" data-tab="riwayat"><i class="fa fa-clock"></i><span>Riwayat</span></button>
        <button class="${state.tab === 'lainnya' ? 'active' : ''}" data-tab="lainnya"><i class="fa fa-ellipsis"></i><span>Lainnya</span></button>
      </nav>
    </div>
    ${state.tab === 'kasir' ? '<div id="total-bar-slot"></div>' + renderCartSheet() : ''}
  `;
  if (state.page === 'main' && state.tab === 'kasir') renderTotalBarSlot();
}

function renderTotalBarSlot() {
  const slot = document.getElementById('total-bar-slot');
  if (!slot) return;
  slot.innerHTML = state.cart.length ? renderTotalBar() : '';
}

function renderTotalBar() {
  if (!state.cart.length) return '';
  const { totalJual, diskon, grandTotal } = cartTotals();
  const totalQty = state.cart.reduce((s, c) => s + c.qty, 0);
  return `
    <div class="total-bar active" data-open-cart>
      <div class="tb-row">
        <div class="tb-info">
          <span class="tb-count">${totalQty} item</span>
          <span class="tb-total">${rupiah(grandTotal)}</span>
        </div>
        <button class="tb-bayar" data-open-cart>Bayar</button>
      </div>
      ${diskon ? `<div class="tb-diskon"><i class="fa fa-tag"></i> Diskon ${rupiah(diskon)}</div>` : ''}
    </div>`;
}

function cartTotals() {
  const totalJual = state.cart.reduce((s, c) => s + c.hargaJual * c.qty, 0);
  const diskon = diskonTransaksi(totalJual);
  const grandTotal = totalJual - diskon + Number(state.adjustment || 0);
  return { totalJual, diskon, grandTotal };
}

function renderTabContent() {
  if (state.tab === 'riwayat') return renderRiwayatTab();
  if (state.tab === 'lainnya') return renderLainnyaTab();
  return '';
}

// ================= LOGIN =================
function renderLogin() {
  const user = CashierAuth.getUser();
  const nama = user ? user.nama : '';
  return `
    <div class="cashier-login">
      <div class="cl-logo"><i class="fa fa-utensils"></i></div>
      <h1>Cafeku Kasir</h1>
      <div class="cl-sub">Pilih nama & masukkan PIN untuk memulai</div>
      <div class="cl-field">
        <label>Kasir</label>
        <select id="cl-nama">
          <option value="">— Pilih User —</option>
          ${(state.users || []).map(u => `<option value="${escapeAttr(u.nama)}" ${u.nama === nama ? 'selected' : ''}>${escapeHtml(u.nama)}</option>`).join('')}
        </select>
      </div>
      <div class="cl-field">
        <label>PIN (6 digit)</label>
        <input id="cl-pin" type="password" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="off" readonly />
      </div>
      <div class="cl-keypad">
        ${[1,2,3,4,5,6,7,8,9,0].map(n => `<button class="pin-key" data-pin-key="${n}">${n}</button>`).join('')}
        <button class="pin-key pin-del" data-pin-del><i class="fa fa-backspace"></i></button>
      </div>
      <button class="cl-btn" data-login-btn>Masuk</button>
    </div>
  `;
}

// ================= TAB: KASIR — SPLIT VIEW =================
function cariSesiBukaHariIni() {
  const today = todayStr();
  const kas = CashierStore.get('Kas').filter(k => k.tanggal === today);
  // kalau sudah ada record tutup hari ini, sesi dianggap sudah ditutup
  if (kas.some(k => k.sesi === 'tutup')) return null;
  const r = kas.find(k => k.sesi === 'buka');
  if (!r) return null;
  return { id: r.id, saldoAwal: r.saldoAwal, waktuBuka: r.waktu, oleh: r.oleh, tanggal: r.tanggal };
}

function loadSesiFromStore() {
  if (state.sesiKas) return;
  state.sesiKas = cariSesiBukaHariIni();
}

function renderKasirSplit() {
  loadSesiFromStore();
  if (!state.sesiKas) {
    return `
      <div class="sesi-gate">
        <div class="sg-icon"><i class="fa fa-cash-register"></i></div>
        <div class="sg-title">Belum Melakukan Open Sesi</div>
        <div class="sg-sub">Silakan buka sesi kas terlebih dahulu untuk mulai menjual.</div>
        <button class="btn btn-primary" data-open-sesi-gate>Buka Sesi Kas</button>
      </div>`;
  }
  return `
    <div class="pos-layout">
      <div class="pos-menu-panel">
        <div class="pos-search">
          <input type="search" id="menu-search" placeholder="Cari menu..." value="${escapeAttr(state.menuSearch || '')}" />
        </div>
        <div class="category-chips">${renderCategoryChips()}</div>
        ${renderPromoBanner()}
        <div class="cashier-menu-grid" id="menu-grid">${renderMenuGridItems()}</div>
      </div>
      <div class="pos-cart-panel" id="pos-cart-sidebar">${renderCartSidebarContent()}</div>
    </div>
  `;
}

function renderCategoryChips() {
  const menus = getMenuList().filter(m => m.aktif !== false);
  const kategoris = ['Semua', ...new Set(menus.map(m => m.kategori).filter(Boolean))];
  return kategoris.map(k => `<button class="category-chip ${state.kategoriFilter === k ? 'active' : ''}" data-kategori="${k}">${escapeHtml(k)}</button>`).join('');
}

function renderPromoBanner() {
  const txPromos = getPromoAktif().filter(p => p.tipe === 'transaksi');
  const menuPromos = getPromoAktif().filter(p => p.tipe === 'menu');
  if (!txPromos.length && !menuPromos.length) return '';
  const fmt = p => p.jenis === 'persen' ? p.nilai + '%' : rupiah(Number(p.nilai));
  const chips = [];
  txPromos.forEach(p => chips.push('Diskon transaksi ' + fmt(p)));
  menuPromos.forEach(p => {
    const nm = (p.menuId && getMenuList().find(m => m.id === p.menuId) || {}).nama || 'menu tertentu';
    chips.push(nm + ' ' + fmt(p));
  });
  return `
    <div class="promo-banner">
      <div class="pb-title"><i class="fa fa-tag"></i> Promo Aktif</div>
      <div class="pb-list">${chips.map(x => `<span class="pb-chip">${x}</span>`).join('')}</div>
    </div>`;
}

function renderMenuGridItems() {
  const menus = getMenuList().filter(m => m.aktif !== false);
  const searchQuery = (state.menuSearch || '').toLowerCase();
  let filtered = searchQuery
    ? menus.filter(m => (m.nama || '').toLowerCase().includes(searchQuery))
    : menus;
  filtered = state.kategoriFilter === 'Semua' ? filtered : filtered.filter(m => m.kategori === state.kategoriFilter);
  if (filtered.length === 0) {
    return `<div class="empty" style="padding:30px;text-align:center">${searchQuery ? 'Menu tidak ditemukan.' : 'Tidak ada menu di kategori ini.'}</div>`;
  }
  const settings = getSettings();
  return filtered.map(m => {
    const hpp = hitungHpp(m, getBahanList());
    const saran = m.hargaJualManual || hitungHargaSaran(hpp, m.marginPercent ?? settings.defaultMarginPercent, adminPercentFor(state.platform));
    const efektif = hargaJualEfektif(m, saran, saran);
    const adaDiskon = efektif < saran;
    const qty = cartQty(m.id);
    const stepper = qty > 0 ? `
      <div class="mc-stepper" data-card-stepper="${m.id}">
        <button class="mc-minus" data-mc-minus="${m.id}">−</button>
        <span class="mc-q">${qty}</span>
        <button class="mc-plus" data-mc-plus="${m.id}">+</button>
      </div>` : `
      <button class="mc-add" data-mc-add="${m.id}">+ Tambah</button>`;
    return `
    <div class="menu-card" data-card="${m.id}">
      <div class="mc-body" data-icr="${m.id}">
        ${m.gambar ? `<img src="${escapeAttr(m.gambar)}" class="mc-img">` : `<div class="mc-ph">☕</div>`}
        ${adaDiskon ? `<span class="menu-card-badge">PROMO</span>` : ''}
        <div class="mc-name">${escapeHtml(m.nama)}</div>
        <div class="mc-price">${adaDiskon ? `<span class="coret">${rupiah(Math.round(saran))}</span> ${rupiah(Math.round(efektif))}` : rupiah(Math.round(efektif))}</div>
      </div>
      ${stepper}
    </div>`;
  }).join('');
}

function cartQty(menuId) {
  const it = state.cart.find(c => c.menuId === menuId);
  return it ? it.qty : 0;
}


// ================= CART SIDEBAR (tablet) =================
function renderCustomerFields(prefix) {
  const idMeja = (prefix || 'cs') + '-nomeja';
  const idNama = (prefix || 'cs') + '-nama';
  return `
    <div class="cs-cust-row">
      <label>No. Meja / Antrian</label>
      <input type="text" id="${idMeja}" inputmode="text" placeholder="mis. 12" value="${escapeAttr(state.noMeja)}" autocomplete="off" />
    </div>
    <div class="cs-cust-row">
      <label>Nama Pembeli</label>
      <input type="text" id="${idNama}" placeholder="mis. Budi" value="${escapeAttr(state.namaPembeli)}" autocomplete="off" />
    </div>`;
}

function renderCartSidebarContent() {
  if (!state.cart.length) {
    return `<div class="cs-header"><span>Keranjang</span></div><div class="cs-items"><div class="cs-empty">Keranjang kosong<br><small style="color:var(--ink-dim)">Tap menu untuk menambah</small></div></div>`;
  }
  const totalJual = state.cart.reduce((s, c) => s + c.hargaJual * c.qty, 0);
  const diskon = diskonTransaksi(totalJual);
  const grandTotal = totalJual - diskon + Number(state.adjustment || 0);
  const cartItems = state.cart.map((c, i) => `
    <div class="cs-item">
      <div class="cs-name">${escapeHtml(c.nama)}<div class="cs-price">${rupiah(Math.round(c.hargaJual))} × ${c.qty} = ${rupiah(Math.round(c.hargaJual * c.qty))}</div></div>
      <div class="cs-qty">
        <button class="q-ctrl" data-cart-dec="${i}">−</button>
        <span class="qn">${c.qty}</span>
        <button class="q-ctrl" data-cart-inc="${i}">+</button>
        <button class="ci-delete" data-cart-remove="${i}">✕</button>
      </div>
    </div>`).join('');
  return `
    <div class="cs-header"><span>Keranjang</span><span class="cs-count">${state.cart.length} item</span></div>
    <div class="cs-items">${cartItems}</div>
    <div class="cs-footer">
      <div class="cs-section">${renderCustomerFields()}</div>
      <div class="cs-row"><span>Subtotal</span><span>${rupiah(totalJual)}</span></div>
      ${diskon ? `<div class="cs-row cs-discount"><span>Diskon</span><span>−${rupiah(diskon)}</span></div>` : ''}
      ${state.adjustment ? `<div class="cs-row"><span>Penyesuaian</span><span>${rupiah(state.adjustment)}</span></div>` : ''}
      <div class="cs-row cs-total"><span>TOTAL</span><span>${rupiah(grandTotal)}</span></div>
      <div class="cs-section"><label>Platform</label><div class="cs-btn-row">
        ${getSettings().platforms.map(p => `<button class="btn btn-sm ${state.platform === p.nama ? 'btn-primary' : 'btn-ghost'}" data-set-platform="${p.nama}">${escapeHtml(p.nama)}</button>`).join('')}
      </div></div>
      <div class="cs-section"><label>Bayar</label><div class="cs-btn-row">
        <button class="btn btn-sm ${state.metodeBayar === 'tunai' ? 'btn-primary' : 'btn-ghost'}" data-set-metode="tunai">Tunai</button>
        <button class="btn btn-sm ${state.metodeBayar === 'qris' ? 'btn-primary' : 'btn-ghost'}" data-set-metode="qris">QRIS</button>
      </div></div>
      <button class="cs-bayar-btn" data-checkout-btn>Bayar</button>
    </div>`;
}

// ================= CART BOTTOM SHEET (small) =================
function renderCartSheet() {
  const openClass = state.sheetOpen === 'cart' ? ' show' : '';
  return `
    <div class="cs-overlay${openClass}" id="cs-overlay" data-close-cart></div>
    <div class="cs-sheet${openClass}" id="cs-sheet">
      <div class="cs-grip"></div>
      <div class="cs-sheet-header"><span>Keranjang</span><button class="cs-sheet-close" data-close-cart>✕</button></div>
      <div class="cs-sheet-items">${renderSheetItems()}</div>
      <div class="cs-sheet-foot">${renderSheetFooter()}</div>
    </div>`;
}

function renderSheetItems() {
  if (!state.cart.length) return `<div class="empty" style="padding:24px;text-align:center">Keranjang kosong.</div>`;
  return state.cart.map((c, i) => `
    <div class="cd-item">
      <div class="cs-name">${escapeHtml(c.nama)}<div class="cs-price">${rupiah(Math.round(c.hargaJual))} × ${c.qty} = ${rupiah(Math.round(c.hargaJual * c.qty))}</div></div>
      <div class="cd-qty">
        <button data-cart-dec="${i}">−</button><span>${c.qty}</span><button data-cart-inc="${i}">+</button>
        <button data-cart-remove="${i}" class="ci-delete">✕</button>
      </div>
    </div>`).join('');
}

function renderSheetFooter() {
  if (!state.cart.length) {
    return `<button class="cs-sheet-bayar" data-close-cart style="opacity:.5">Keranjang Kosong</button>`;
  }
  const { totalJual, diskon, grandTotal } = cartTotals();
  return `
    <div class="cs-sheet-row"><span>Subtotal</span><span>${rupiah(totalJual)}</span></div>
    ${diskon ? `<div class="cs-sheet-row cs-discount"><span>Diskon</span><span>−${rupiah(diskon)}</span></div>` : ''}
    ${state.adjustment ? `<div class="cs-sheet-row"><span>Penyesuaian</span><span>${rupiah(state.adjustment)}</span></div>` : ''}
    <div class="cs-sheet-row cs-sheet-total"><span>TOTAL</span><span>${rupiah(grandTotal)}</span></div>
    <div class="cs-sheet-section"><label>Platform</label><div class="cs-sheet-prow">
      ${getSettings().platforms.map(p => `<button class="btn btn-sm ${state.platform === p.nama ? 'btn-primary' : 'btn-ghost'}" data-set-platform="${p.nama}">${escapeHtml(p.nama)}</button>`).join('')}
    </div></div>
    <div class="cs-sheet-section"><label>Bayar</label><div class="cs-sheet-prow">
      <button class="btn btn-sm ${state.metodeBayar === 'tunai' ? 'btn-primary' : 'btn-ghost'}" data-set-metode="tunai">Tunai</button>
      <button class="btn btn-sm ${state.metodeBayar === 'qris' ? 'btn-primary' : 'btn-ghost'}" data-set-metode="qris">QRIS</button>
    </div></div>
    <button class="cs-sheet-bayar" data-checkout-btn>Bayar Sekarang</button>`;
}

// ================= TAB: RIWAYAT =================
function renderRiwayatTab() {
  const penjualan = CashierStore.get('Penjualan');
  const today = todayStr();
  let filtered = penjualan.slice().reverse();
  if (state.riwayatFilter === 'hari') {
    filtered = filtered.filter(p => p.tanggal === today);
  }
  if (state.riwayatSearch.trim()) {
    const s = state.riwayatSearch.toLowerCase();
    filtered = filtered.filter(p => (p.noInvoice || '').toLowerCase().includes(s) || (p.items || []).some(it => (it.nama || '').toLowerCase().includes(s)));
  }
  return `
    <div style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch">
      <div class="riwayat-wrap">
        <div class="riwayat-filters">
          <input type="search" id="riwayat-search" placeholder="Cari invoice/menu..." value="${escapeAttr(state.riwayatSearch)}" />
          <select id="riwayat-filter">
            <option value="hari" ${state.riwayatFilter === 'hari' ? 'selected' : ''}>Hari Ini</option>
            <option value="semua" ${state.riwayatFilter === 'semua' ? 'selected' : ''}>Semua</option>
          </select>
        </div>
        ${filtered.length === 0 ? `<div class="empty">Tidak ada transaksi.</div>` : filtered.map(p => {
          const totalHarga = Number(p.total || 0);
          const metode = p.metodeBayar === 'qris' ? 'QRIS' : 'Tunai';
          return `<div class="riwayat-item" data-reprint="${p.id}">
            <div class="ri-top"><span class="ri-invoice">${escapeHtml(p.noInvoice || '')}</span><span class="ri-total">${rupiah(totalHarga)}</span></div>
            <div class="ri-meta"><span>${formatTanggalCashier(p.tanggal)} • ${p.waktu || ''}</span><span class="ri-metode">${metode}</span></div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

// ================= TAB: LAINNYA =================
function renderLainnyaTab() {
  if (state.subtab === 'promo') return renderPromoSubtab();
  if (state.subtab === 'sesi') return renderSesiSubtab();
  if (state.subtab === 'stok') return renderStokSubtab();
  return `
    <div style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:16px">
      <div class="section-title" style="margin-top:0">Menu Lainnya</div>
      <div class="lainnya-grid">
        <div class="lainnya-card" data-lainnya-subtab="promo"><div class="lainnya-icon"><i class="fa fa-tag"></i></div><div class="lainnya-label">Promo</div><div class="lainnya-sub">${getPromoAktif().length} aktif</div></div>
        <div class="lainnya-card" data-lainnya-subtab="sesi"><div class="lainnya-icon"><i class="fa fa-cash-register"></i></div><div class="lainnya-label">Sesi Kas</div><div class="lainnya-sub">${state.sesiKas ? 'Terbuka' : 'Belum dibuka'}</div></div>
        <div class="lainnya-card" data-lainnya-subtab="stok"><div class="lainnya-icon"><i class="fa fa-box"></i></div><div class="lainnya-label">Stok Bahan</div><div class="lainnya-sub">${getBahanList().length} bahan</div></div>
      </div>
    </div>`;
}

function renderPromoSubtab() {
  const promos = getPromoAktif();
  return `
    <div style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch">
      <div class="subtab-header"><button class="subtab-back" data-lainnya-back><i class="fa fa-arrow-left"></i></button><h2>Promo Aktif</h2></div>
      <div style="padding:12px 16px">
        ${promos.length === 0 ? `<div class="empty">Tidak ada promo aktif.</div>` : promos.map(p => `
        <div class="promo-card"><div class="pc-name">${escapeHtml(p.nama || '(Tanpa Nama)')}</div>
          <div class="pc-detail">${p.jenis === 'persen' ? p.nilai + '% diskon' : 'Potongan ' + rupiah(p.nilai)} • ${p.tipe === 'transaksi' ? 'Diskon transaksi' : p.tipe === 'menu' ? 'Diskon menu' : 'Umum'}<br>${p.tglMulai ? formatTanggalCashier(p.tglMulai) : '?'} s/d ${p.tglSelesai ? formatTanggalCashier(p.tglSelesai) : 'selamanya'}</div>
        </div>`).join('')}
      </div>
    </div>`;
}

function renderSesiSubtab() {
  if (!state.sesiKas) {
    const today = todayStr();
    state.sesiKas = cariSesiBukaHariIni();
    if (state.sesiKas) return renderSesiOpen();
    return `
      <div style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch">
        <div class="subtab-header"><button class="subtab-back" data-lainnya-back><i class="fa fa-arrow-left"></i></button><h2>Sesi Kas</h2></div>
        <div class="sesi-kas-card">
          <div class="sk-row"><span class="k">Tanggal</span><span class="v">${today}</span></div>
          <div class="sk-row"><span class="k">Kasir</span><span class="v">${escapeHtml(CashierAuth.getUser()?.nama || '')}</span></div>
          <div class="num-input-wrap"><label>Saldo Awal Kas (Rp)</label><input type="text" id="sk-saldo-awal" inputmode="numeric" placeholder="mis. 100000" autocomplete="off" readonly /></div>
          <div class="num-keypad" data-target="sk-saldo-awal">
            ${[1,2,3,4,5,6,7,8,9,0].map(n => `<button class="num-key" data-num="${n}">${n}</button>`).join('')}
            <button class="num-key num-del" data-num-del><i class="fa fa-backspace"></i></button>
          </div>
          <button class="btn btn-primary" style="width:100%;margin-top:12px" data-sesi-buka>Buka Sesi Kas</button>
        </div>
      </div>`;
  }
  return renderSesiOpen();
}

function renderSesiOpen() {
  const s = state.sesiKas;
  const today = todayStr();
  const transaksi = CashierStore.get('Penjualan').filter(p => p.tanggal === today);
  const tunaiTransaksi = transaksi.filter(p => p.metodeBayar === 'tunai');
  const totalTunai = tunaiTransaksi.reduce((sum, p) => sum + Number(p.total || 0), 0);
  const saldoAwal = Number(s.saldoAwal || 0);
  const harusnya = saldoAwal + totalTunai;
  return `
    <div style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch">
      <div class="subtab-header"><button class="subtab-back" data-lainnya-back><i class="fa fa-arrow-left"></i></button><h2>Sesi Kas</h2></div>
      <div class="sesi-kas-card">
        <div class="sk-row"><span class="k">Tanggal</span><span class="v">${today}</span></div>
        <div class="sk-row"><span class="k">Kasir</span><span class="v">${escapeHtml(s.oleh || '')}</span></div>
        <div class="sk-row"><span class="k">Waktu Buka</span><span class="v">${s.waktuBuka || '-'}</span></div>
        <div class="sk-row"><span class="k">Saldo Awal</span><span class="v">${rupiah(saldoAwal)}</span></div>
        <div class="sk-row"><span class="k">Transaksi Tunai</span><span class="v">${tunaiTransaksi.length} ×</span></div>
        <div class="sk-row"><span class="k">Total Tunai Masuk</span><span class="v">${rupiah(totalTunai)}</span></div>
        <div class="sk-total"><span>Total Kas (teori)</span><span>${rupiah(harusnya)}</span></div>
        <div class="num-input-wrap"><label>Uang di Kotak Sekarang (Rp)</label><input type="text" id="sk-saldo-akhir" inputmode="numeric" placeholder="mis. ${harusnya.toLocaleString('id-ID')}" value="${harusnya}" autocomplete="off" readonly /></div>
        <div class="num-keypad" data-target="sk-saldo-akhir">
          ${[1,2,3,4,5,6,7,8,9,0].map(n => `<button class="num-key" data-num="${n}">${n}</button>`).join('')}
          <button class="num-key num-del" data-num-del><i class="fa fa-backspace"></i></button>
        </div>
        <div class="sk-row" style="margin-top:8px"><span class="k">Selisih</span><span class="v" id="sk-selisih">${rupiah(0)}</span></div>
        <button class="btn btn-primary" style="width:100%;margin-top:12px" data-sesi-tutup>Tutup Sesi & Cetak Laporan</button>
      </div>
    </div>`;
}

function renderStokSubtab() {
  const bahanList = getBahanList();
  return `
    <div style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch">
      <div class="subtab-header"><button class="subtab-back" data-lainnya-back><i class="fa fa-arrow-left"></i></button><h2>Stok Bahan</h2></div>
      <div style="padding:12px 16px">
        ${bahanList.length === 0 ? `<div class="empty">Belum ada data bahan.</div>` : bahanList.map(b => {
          const min = Number(b.stokMinimum || 0);
          const low = Number(b.stok || 0) <= min;
          return `<div class="stok-item"><div class="si-info"><div class="name">${escapeHtml(b.nama)} <span class="badge ${low ? 'low' : 'ok'}">${low ? 'Menipis' : 'Aman'}</span></div><div class="sub">Min. ${min} ${escapeHtml(b.satuan || '')}</div></div><div style="text-align:right;font-family:var(--font-mono);font-weight:700;font-size:14px">${b.stok} ${escapeHtml(b.satuan || '')}</div></div>`;
        }).join('')}
      </div>
    </div>`;
}

// ================= CART ACTIONS =================
function addToCartCashier(menuId) {
  const menu = getMenuList().find(m => m.id === menuId);
  if (!menu) return;
  const hpp = hitungHpp(menu, getBahanList());
  const settings = getSettings();
  const hargaNormal = menu.hargaJualManual || hitungHargaSaran(hpp, menu.marginPercent ?? settings.defaultMarginPercent, adminPercentFor(state.platform));
  const hargaJual = hargaJualEfektif(menu, hargaNormal, hargaNormal);
  const existing = state.cart.find(c => c.menuId === menuId);
  if (existing) { existing.qty += 1; }
  else { state.cart.push({ menuId, nama: menu.nama, qty: 1, hargaJual: Math.round(hargaJual), hargaNormal: Math.round(hargaNormal), hpp }); }
  renderCartRegion();
}

function removeOneFromCart(menuId) {
  const idx = state.cart.findIndex(c => c.menuId === menuId);
  if (idx < 0) return;
  state.cart[idx].qty--;
  if (state.cart[idx].qty <= 0) state.cart.splice(idx, 1);
  renderCartRegion();
}

function renderCartRegion() {
  const grid = document.getElementById('menu-grid');
  if (grid) grid.innerHTML = renderMenuGridItems();
  const sidebar = document.getElementById('pos-cart-sidebar');
  if (sidebar) sidebar.innerHTML = renderCartSidebarContent();
  refreshTotalBar();
  refreshSheet();
}

function refreshTotalBar() {
  const slot = document.getElementById('total-bar-slot');
  if (!slot) return;
  slot.innerHTML = state.cart.length ? renderTotalBar() : '';
}

function refreshSheet() {
  const sheet = document.getElementById('cs-sheet');
  if (!sheet) return;
  const items = sheet.querySelector('.cs-sheet-items');
  const foot = sheet.querySelector('.cs-sheet-foot');
  if (items) items.innerHTML = renderSheetItems();
  if (foot) foot.innerHTML = renderSheetFooter();
}

function openCartSheet() {
  state.sheetOpen = 'cart';
  const ov = document.getElementById('cs-overlay');
  const sh = document.getElementById('cs-sheet');
  if (ov) ov.classList.add('show');
  if (sh) sh.classList.add('show');
  closePaymentOverlay();
}

function closeCartSheet() {
  state.sheetOpen = null;
  const ov = document.getElementById('cs-overlay');
  const sh = document.getElementById('cs-sheet');
  if (ov) ov.classList.remove('show');
  if (sh) sh.classList.remove('show');
}

// ================= CHECKOUT =================
async function checkoutCashier() {
  if (!state.cart.length) return;
  const totalJual = state.cart.reduce((s, c) => s + c.hargaJual * c.qty, 0);
  const totalHpp = state.cart.reduce((s, c) => s + c.hpp * c.qty, 0);
  const diskon = diskonTransaksi(totalJual);
  const total = totalJual - diskon + Number(state.adjustment || 0);
  const transaksi = {
    id: uid(), noInvoice: nextInvoiceNo(), tanggal: todayStr(), waktu: nowTimeStr(),
    platform: state.platform, metodeBayar: state.metodeBayar,
    noMeja: state.noMeja || '', namaPembeli: state.namaPembeli || '',
    items: state.cart.map(c => ({ menuId: c.menuId, nama: c.nama, qty: c.qty, hargaJual: c.hargaJual, hpp: c.hpp })),
    subtotal: totalJual, diskon, adjustment: Number(state.adjustment || 0), total, totalHpp, laba: total - totalHpp,
    catatan: state.catatan || '', oleh: CashierAuth.getUser()?.nama || ''
  };
  state.stagedTrx = transaksi;
  payStr = '';
  if (state.metodeBayar === 'qris') openQrisConfirmPanel(transaksi);
  else openPaymentPanel(transaksi);
}

function nextInvoiceNo() {
  const tgl = todayStr().replace(/-/g, '');
  const jml = CashierStore.get('Penjualan').filter(p => (p.tanggal || '').replace(/-/g, '') === tgl).length + 1;
  return 'INV-' + tgl + '-' + String(jml).padStart(4, '0');
}

// ================= PAYMENT PANEL (full-screen) =================
function openPaymentOverlay(html) {
  let overlay = document.getElementById('payment-overlay');
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'payment-overlay'; overlay.className = 'payment-overlay'; document.body.appendChild(overlay); }
  overlay.innerHTML = html;
  overlay.style.display = 'flex';
}

function closePaymentOverlay() {
  const overlay = document.getElementById('payment-overlay');
  if (overlay) overlay.style.display = 'none';
}

function payValue() { return parseInt(payStr.replace(/[^\d]/g, ''), 10) || 0; }

function renderPay() {
  const total = Number((state.stagedTrx || {}).total) || 0;
  const disp = document.getElementById('pay-display');
  if (disp) disp.textContent = rupiah(payValue());
  const el = document.getElementById('pay-kembali');
  if (!el) return;
  const kemb = payValue() - total;
  if (kemb < 0) el.innerHTML = 'Uang kurang: <span>' + rupiah(-kemb) + '</span>';
  else el.innerHTML = 'Kembalian: <span>' + rupiah(kemb) + '</span>' + (kemb === 0 ? ' (pas)' : '');
}

function openPaymentPanel(trx) {
  const total = Number(trx.total || 0);
  payStr = String(total);
  const html = `
    <div class="po-header"><button class="po-back" data-close-payment><i class="fa fa-arrow-left"></i></button><h2>Pembayaran Tunai</h2></div>
    <div class="po-body">
      <div class="po-total-label">Total Tagihan</div>
      <div class="po-total-value">${rupiah(total)}</div>
      <div class="po-input-label">Uang Diterima</div>
      <div class="po-display" id="pay-display">${rupiah(payValue())}</div>
      <div class="po-quick">
        <button data-pay-amount="50000">50.000</button>
        <button data-pay-amount="100000">100.000</button>
        <button data-pay-amount="200000">200.000</button>
        <button data-pay-exact>Pas</button>
      </div>
      <div class="po-kb">
        ${[1,2,3,4,5,6,7,8,9].map(n => `<button data-pay-key="${n}">${n}</button>`).join('')}
        <button class="po-clear" data-pay-clr>C</button>
        <button data-pay-key="0">0</button>
        <button class="po-del" data-pay-bks>⌫</button>
      </div>
      <div class="po-change" id="pay-kembali"></div>
    </div>
    <div class="po-footer"><button class="btn btn-ghost" data-close-payment>Batal</button><button class="btn btn-primary" data-pay-ok>Bayar</button></div>`;
  openPaymentOverlay(html);
  renderPay();
}

function openQrisConfirmPanel(trx) {
  const total = Number(trx.total || 0);
  const html = `
    <div class="po-header"><button class="po-back" data-close-payment><i class="fa fa-arrow-left"></i></button><h2>Pembayaran QRIS</h2></div>
    <div class="po-body" style="justify-content:center">
      <div class="po-total-label">Total Tagihan</div>
      <div class="po-total-value">${rupiah(total)}</div>
      <p style="text-align:center;color:var(--ink-dim);margin:20px 0;max-width:300px">Pastikan pembayaran QRIS sudah diterima, lalu konfirmasi.</p>
    </div>
    <div class="po-footer" style="flex-direction:column">
      <button class="btn btn-primary" data-qris-confirm-ok style="width:100%;margin-bottom:8px">Sudah Bayar</button>
      <button class="btn btn-ghost" data-close-payment style="width:100%">Batal</button>
    </div>`;
  openPaymentOverlay(html);
}

// ================= RECEIPT PRINTING =================
function printReceipt(trx, bayar) {
  const pref = getPrintPref();
  if (pref.mode === 'ble' && isBleSupported() && isPrinterConnected()) printBle(trx, bayar);
  else printDialogCashier(trx, bayar);
}

async function printBle(trx, bayar) {
  try { await printBytes(buildEscPos(trx, bayar)); toast('Struk terkirim ke printer ✓'); }
  catch (err) { toast('Printer gagal: ' + err.message); printDialogCashier(trx, bayar); }
}

function printDialogCashier(trx, bayar) {
  const setting = getSettings();
  const shopName = (setting.namaToko || 'CAFEKU').replace(/</g, '&lt;');
  const kembalian = Number(bayar || 0) - Number(trx.total || 0);
  const itemRows = (trx.items || []).map(it => `<div class="pr-item"><div class="pr-name">${escapeHtml(it.nama)}</div><div class="pr-sub">${it.qty} × Rp${Math.round(it.hargaJual).toLocaleString('id-ID')}</div><div class="pr-amt">Rp${Math.round(it.hargaJual * it.qty).toLocaleString('id-ID')}</div></div>`).join('');
  const html = `
    <div class="pr-center"><b>${shopName}</b></div><div class="pr-center">STRUK KASIR</div><div class="pr-center">${escapeHtml(trx.noInvoice || '')}</div>
    <div class="pr-row"><span>Tanggal</span><span>${trx.tanggal || '-'}</span></div><div class="pr-row"><span>Jam</span><span>${trx.waktu || '-'}</span></div>
    <div class="pr-row"><span>Platform</span><span>${escapeHtml(trx.platform || 'Offline')}</span></div><div class="pr-row"><span>Metode</span><span>${escapeHtml(trx.metodeBayar === 'qris' ? 'QRIS' : 'Tunai')}</span></div>
    ${trx.noMeja ? `<div class="pr-row"><span>No. Meja</span><span>${escapeHtml(trx.noMeja)}</span></div>` : ''}
    ${trx.namaPembeli ? `<div class="pr-row"><span>Pembeli</span><span>${escapeHtml(trx.namaPembeli)}</span></div>` : ''}
    <div class="pr-divider"></div>${itemRows}<div class="pr-divider"></div>
    <div class="pr-row"><span>Subtotal</span><span>Rp${Number(trx.subtotal || 0).toLocaleString('id-ID')}</span></div>
    ${Number(trx.diskon) ? `<div class="pr-row"><span>Diskon</span><span>-Rp${trx.diskon.toLocaleString('id-ID')}</span></div>` : ''}
    ${Number(trx.adjustment) ? `<div class="pr-row"><span>Penyesuaian</span><span>Rp${trx.adjustment.toLocaleString('id-ID')}</span></div>` : ''}
    <div class="pr-row pr-big"><span><b>TOTAL</b></span><span><b>Rp${Number(trx.total || 0).toLocaleString('id-ID')}</b></span></div>
    <div class="pr-row"><span>Dibayar</span><span>Rp${Math.round(Number(bayar || 0)).toLocaleString('id-ID')}</span></div>
    <div class="pr-row"><span>Kembalian</span><span>${kembalian >= 0 ? 'Rp' + kembalian.toLocaleString('id-ID') : 'KURANG Rp' + (-kembalian).toLocaleString('id-ID')}</span></div>
    <div class="pr-center pr-foot">Terima kasih, sampai jumpa!</div>`;
  let p = document.getElementById('print-receipt');
  if (!p) { p = document.createElement('div'); p.id = 'print-receipt'; document.body.appendChild(p); }
  p.innerHTML = html;
  window.print();
}

async function doPay() {
  const trx = state.stagedTrx;
  if (!trx) return;
  const total = Number(trx.total || 0);
  const bayar = payValue() > 0 ? payValue() : total;
  closePaymentOverlay();
  await CashierStore.insert('Penjualan', trx);
  state.stagedTrx = null;
  state.cart = [];
  state.adjustment = 0;
  state.metodeBayar = 'tunai';
  state.noMeja = '';
  state.namaPembeli = '';
  toast('Transaksi selesai ✓');
  render();
  const pref = getPrintPref();
  if (pref.on) {
    state.printModalTrx = trx;
    state.printModalBayar = bayar;
    const html = `<div class="sheet-handle"></div><div class="sheet-head"><h2>Cetak Nota</h2></div>
      <p style="text-align:center;color:var(--ink-dim);margin:0 0 16px">Klik Cetak untuk mencetak, atau Selesai untuk melewati.</p>
      <button class="btn btn-primary" data-print-modal-print style="width:100%;margin-bottom:8px">Cetak Nota</button>
      <button class="btn btn-ghost" data-print-modal-done style="width:100%">Selesai</button>`;
    openSheet(html, 'print-modal');
  }
}

// ================= SESI KAS =================
async function openSesiKas() {
  const saldoAwal = numOnly(document.getElementById('sk-saldo-awal')?.value);
  if (!saldoAwal || saldoAwal <= 0) { toast('Masukkan saldo awal kas'); return; }
  const user = CashierAuth.getUser();
  const trx = { id: uid(), sesi: 'buka', tanggal: todayStr(), waktu: nowTimeStr(), saldoAwal, oleh: user?.nama || '', totalTunai: 0, totalTransaksi: 0, catatan: '' };
  await CashierStore.insert('Kas', trx);
  state.sesiKas = { id: trx.id, saldoAwal, waktuBuka: trx.waktu, oleh: trx.oleh, tanggal: trx.tanggal };
  closeSheet();
  toast('Sesi kas dibuka ✓');
  state.tab = 'kasir';
  state.subtab = null;
  render();
}

function updateSelisih() {
  const s = state.sesiKas;
  if (!s) return;
  const today = todayStr();
  const transaksi = CashierStore.get('Penjualan').filter(p => p.tanggal === today);
  const totalTunai = transaksi.filter(p => p.metodeBayar === 'tunai').reduce((sum, p) => sum + Number(p.total || 0), 0);
  const harusnya = Number(s.saldoAwal || 0) + totalTunai;
  const akhirInput = numOnly(document.getElementById('sk-saldo-akhir')?.value);
  const selisih = akhirInput - harusnya;
  const el = document.getElementById('sk-selisih');
  if (el) { el.textContent = rupiah(selisih); el.className = 'v ' + (selisih >= 0 ? 'positive' : 'negative'); }
}

async function tutupSesiKas() {
  const s = state.sesiKas;
  if (!s) return;
  const today = todayStr();
  const transaksi = CashierStore.get('Penjualan').filter(p => p.tanggal === today);
  const totalTunai = transaksi.filter(p => p.metodeBayar === 'tunai').reduce((sum, p) => sum + Number(p.total || 0), 0);
  const saldoAwal = Number(s.saldoAwal || 0);
  const harusnya = saldoAwal + totalTunai;
  const saldoAkhir = numOnly(document.getElementById('sk-saldo-akhir')?.value) || harusnya;
  const selisih = saldoAkhir - harusnya;
  const user = CashierAuth.getUser();
  const trx = { id: uid(), sesi: 'tutup', tanggal: today, waktu: nowTimeStr(), saldoAwal, saldoAkhir, totalTunai, totalTransaksi: transaksi.length, selisih, oleh: user?.nama || '', catatan: '' };
  await CashierStore.insert('Kas', trx);
  await CashierStore._flush();
  const laporanHtml = renderLaporanHarian(saldoAwal, saldoAkhir, totalTunai, transaksi, selisih);
  state.sesiKas = null;
  closeSheet();
  toast('Sesi kas ditutup ✓');
  const html = `<div class="sheet-handle"></div><div class="sheet-head"><h2>Laporan Kasier Hari Ini</h2><button class="btn-icon" data-close-sheet>✕</button></div>
    <div id="laporan-print" style="padding:0 14px">${laporanHtml}</div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-ghost" style="flex:1" data-laporan-download-png>Download PNG</button>
      <button class="btn btn-ghost" style="flex:1" data-laporan-download-pdf>Download PDF</button>
    </div>`;
  openSheet(html, 'laporan');
}

function renderLaporanHarian(saldoAwal, saldoAkhir, totalTunai, transaksi, selisih) {
  const selIsPos = Number(selisih || 0) >= 0;
  const selClass = selIsPos ? 'var(--positive)' : 'var(--negative)';
  return `
    <div style="text-align:center;margin-bottom:16px"><h2 style="margin:0;font-size:18px">CAFEKU KASIR</h2><div style="font-size:13px;color:var(--ink-dim)">Laporan Penjualan Hari Ini</div><div style="font-size:13px;color:var(--ink-dim)">${formatTanggalCashier(todayStr())}</div></div>
    <div style="border:1px solid var(--line);padding:8px;margin-bottom:12px;border-radius:6px">
      <div class="row"><span class="k">Saldo Awal</span><span class="v">${rupiah(saldoAwal)}</span></div>
      <div class="row"><span class="k">Total Penjualan</span><span class="v">${rupiah(transaksi.reduce((s,p) => s + Number(p.total || 0), 0))}</span></div>
      <div class="row"><span class="k">Total Tunai</span><span class="v">${rupiah(totalTunai)}</span></div>
      <div class="row"><span class="k">QRIS</span><span class="v">${rupiah(transaksi.filter(p=>p.metodeBayar==='qris').reduce((s,p)=>s+Number(p.total||0),0))}</span></div>
      <div class="row" style="border-top:1px solid var(--line);padding-top:4px"><span class="k" style="font-weight:700">Saldo Akhir (teori)</span><span class="v">${rupiah(saldoAwal + totalTunai)}</span></div>
      <div class="row"><span class="k" style="font-weight:700">Saldo Akhir (aktual)</span><span class="v">${rupiah(saldoAkhir)}</span></div>
      <div class="row" style="border-top:2px solid var(--ink);padding-top:4px"><span class="k" style="font-weight:700">Selisih</span><span class="v" style="color:${selClass};font-weight:800">${rupiah(selisih)}</span></div>
    </div>
    <div style="margin-bottom:8px;font-size:12px"><b>Riwayat Transaksi (${transaksi.length})</b></div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr><td style="padding:4px;border-bottom:1px solid var(--line)">No. Invoice</td><td style="padding:4px;border-bottom:1px solid var(--line);text-align:right">Waktu</td><td style="padding:4px;border-bottom:1px solid var(--line);text-align:right">Total</td><td style="padding:4px;border-bottom:1px solid var(--line);text-align:right">Metode</td></tr></thead>
      <tbody>${transaksi.slice().reverse().map(p => `<tr><td style="padding:4px">${escapeHtml(p.noInvoice || '')}</td><td style="padding:4px;text-align:right">${p.waktu || '-'}</td><td style="padding:4px;text-align:right">${rupiah(Number(p.total || 0))}</td><td style="padding:4px;text-align:right">${p.metodeBayar === 'qris' ? 'QRIS' : 'Tunai'}</td></tr>`).join('')}</tbody>
    </table>`;
}

// ================= UTILITIES =================
function openSheet(html, key) {
  let overlay = document.getElementById('overlay');
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'overlay'; overlay.className = 'overlay'; document.body.appendChild(overlay); }
  overlay.dataset.key = key || '';
  overlay.innerHTML = `<div class="sheet" id="sheet-inner">${html}</div>`;
  overlay.style.display = 'flex';
  overlay.onclick = (e) => { if (e.target === overlay) closeSheet(); };
}

function closeSheet() {
  const overlay = document.getElementById('overlay');
  if (overlay) overlay.style.display = 'none';
}

// ================= DOWNLOAD LAPORAN =================
async function downloadLaporanPng() {
  const el = document.getElementById('laporan-print');
  if (!el) return;
  const html2canvas = await loadHtml2Canvas();
  const canvas = await html2canvas(el, { scale: 2, useXHR: false });
  const url = canvas.toDataURL('image/png');
  const a = document.createElement('a'); a.href = url; a.download = 'laporan-kasir-' + todayStr() + '.png'; a.click();
}
async function downloadLaporanPdf() {
  const el = document.getElementById('laporan-print');
  if (!el) return;
  const html2pdf = await loadHtml2Pdf();
  const opt = { margin: 0.5, filename: 'laporan-kasir-' + todayStr(), image: { type: 'jpeg', quality: 0.98 }, html2canvas: { scale: 2 }, jsPDF: { unit: 'in', format: 'paper', orientation: 'portrait' } };
  await html2pdf().set(opt).from(el).save();
}
function loadHtml2Canvas() {
  return new Promise((resolve, reject) => {
    if (window.html2canvas) return resolve(window.html2canvas);
    const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
    s.onload = () => resolve(window.html2canvas); s.onerror = reject; document.head.appendChild(s);
  });
}
function loadHtml2Pdf() {
  return new Promise((resolve, reject) => {
    if (window.html2pdf) return resolve(window.html2pdf);
    const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
    s.onload = () => resolve(window.html2pdf); s.onerror = reject; document.head.appendChild(s);
  });
}

// ================= EVENT DELEGATION =================
document.addEventListener('click', async (e) => {
  const t = e.target;

  // Tab navigation
  const tabBtn = t.closest('[data-tab]');
  if (tabBtn) { state.tab = tabBtn.dataset.tab; state.subtab = null; closeSheet(); closePaymentOverlay(); closeCartSheet(); render(); return; }

  // Close overlays
  if (t.closest('[data-close-sheet]')) { closeSheet(); return; }
  if (t.closest('[data-close-payment]')) { state.stagedTrx = null; closePaymentOverlay(); return; }

  // Login
  if (t.dataset.loginBtn !== undefined) { await handleLogin(); return; }
  if (t.dataset.pinKey !== undefined) {
    const pinEl = document.getElementById('cl-pin');
    if (pinEl && pinEl.value.length < 6) {
      pinEl.value += t.dataset.pinKey;
      // auto-login HANYA saat PIN yang diketik benar-benar cocok dengan user
      // terpilih. Ini mencegah submit prematur (yang bikin rasa "freeze" saat
      // fallback ke server yang lambat). Kalau tidak cocok, biarkan user
      // mengetik lagi / menghapus tanpa terblokir.
      const nama = (document.getElementById('cl-nama') || {}).value || '';
      const sel = (state.users || []).find(u => u.nama === nama);
      if (sel && pinEl.value === String(sel.pin)) handleLogin();
    }
    return;
  }
  if (t.dataset.pinDel !== undefined) {
    const pinEl = document.getElementById('cl-pin');
    if (pinEl) pinEl.value = pinEl.value.slice(0, -1);
    return;
  }

  // Logout
  if (t.dataset.logout !== undefined) { handleLogout(); return; }

  // Cart — open / close bottom sheet
  if (t.dataset.openCart !== undefined) { openCartSheet(); return; }
  if (t.dataset.closeCart !== undefined) { closeCartSheet(); return; }

  // Menu card — add / stepper (stop propagation from stepper buttons)
  if (t.dataset.mcAdd !== undefined) { addToCartCashier(t.dataset.mcAdd); return; }
  if (t.dataset.mcPlus !== undefined) { addToCartCashier(t.dataset.mcPlus); return; }
  if (t.dataset.mcMinus !== undefined) { removeOneFromCart(t.dataset.mcMinus); return; }
  const body = t.closest('[data-icr]');
  if (body) { addToCartCashier(body.dataset.icr); return; }

  // Cart — inc / dec / remove
  if (t.dataset.cartInc !== undefined) { state.cart[+t.dataset.cartInc].qty++; renderCartRegion(); return; }
  if (t.dataset.cartDec !== undefined) {
    const i = +t.dataset.cartDec; state.cart[i].qty--;
    if (state.cart[i].qty <= 0) state.cart.splice(i, 1);
    renderCartRegion(); return;
  }
  if (t.dataset.cartRemove !== undefined) { state.cart.splice(+t.dataset.cartRemove, 1); renderCartRegion(); return; }

  // Platform / Metode Bayar
  if (t.dataset.setPlatform) { state.platform = t.dataset.setPlatform; renderCartRegion(); return; }
  if (t.dataset.setMetode) { state.metodeBayar = t.dataset.setMetode; renderCartRegion(); return; }

  // Checkout
  if (t.dataset.checkoutBtn !== undefined) { closeCartSheet(); return checkoutCashier(); }

  // Numeric Keypad
  if (t.dataset.num !== undefined) {
    const targetEl = document.getElementById('sk-saldo-awal');
    const targetEl2 = document.getElementById('sk-saldo-akhir');
    const val = t.dataset.num;
    if (targetEl && targetEl.readOnly) { if (targetEl.value.length < 16) targetEl.value += val; }
    else if (targetEl2 && targetEl2.readOnly) { if (targetEl2.value.length < 16) targetEl2.value += val; updateSelisih(); }
    return;
  }
  if (t.dataset.numDel !== undefined) {
    const targetEl = document.getElementById('sk-saldo-awal');
    const targetEl2 = document.getElementById('sk-saldo-akhir');
    if (targetEl && targetEl.value) targetEl.value = targetEl.value.slice(0, -1);
    if (targetEl2 && targetEl2.value) targetEl2.value = targetEl2.value.slice(0, -1);
    if (targetEl2) updateSelisih();
    return;
  }

  // Category filter
  if (t.dataset.kategori) {
    state.kategoriFilter = t.dataset.kategori;
    document.querySelectorAll('.category-chip').forEach(c => c.classList.toggle('active', c.dataset.kategori === state.kategoriFilter));
    const grid = document.getElementById('menu-grid');
    if (grid) grid.innerHTML = renderMenuGridItems();
    return;
  }

  // Lainnya subtab
  const lainEl = t.closest('[data-lainnya-subtab]');
  if (lainEl) { state.subtab = lainEl.dataset.lainnyaSubtab; render(); return; }
  if (t.closest('[data-lainnya-back]')) { state.subtab = null; render(); return; }
  if (t.dataset.openSesiGate !== undefined) { state.tab = 'lainnya'; state.subtab = 'sesi'; render(); return; }

  // Payment overlay numpad
  if (t.dataset.payAmount !== undefined) { payStr = String(Number(t.dataset.payAmount) || 0); renderPay(); return; }
  if (t.dataset.payKey !== undefined) { payStr = (payStr + t.dataset.payKey).replace(/^0+(?=\d)/, ''); renderPay(); return; }
  if (t.dataset.payBks !== undefined) { payStr = payStr.slice(0, -1); renderPay(); return; }
  if (t.dataset.payClr !== undefined) { payStr = ''; renderPay(); return; }
  if (t.dataset.payExact !== undefined) { payStr = String(Number((state.stagedTrx || {}).total) || 0); renderPay(); return; }
  if (t.dataset.payOk !== undefined) { doPay(); return; }
  if (t.dataset.qrisConfirmOk !== undefined) { payStr = String(Number((state.stagedTrx || {}).total) || 0); doPay(); return; }

  // Print modal
  if (t.closest('[data-print-modal-print]')) { if (state.printModalTrx) printReceipt(state.printModalTrx, state.printModalBayar); return; }
  if (t.closest('[data-print-modal-done]')) { state.printModalTrx = null; state.printModalBayar = 0; closeSheet(); return; }

  // Reprint from riwayat
  const reprintEl = t.closest('[data-reprint]');
  if (reprintEl) {
    const tr = CashierStore.get('Penjualan').find(x => x.id === reprintEl.dataset.reprint);
    if (tr) {
      state.printModalTrx = tr; state.printModalBayar = Number(tr.total || 0);
      openSheet(`<div class="sheet-handle"></div><div class="sheet-head"><h2>Cetak Nota</h2></div><p style="text-align:center;color:var(--ink-dim);margin:0 0 16px">Klik Cetak untuk mencetak, atau Selesai untuk melewati.</p><button class="btn btn-primary" data-print-modal-print style="width:100%;margin-bottom:8px">Cetak Nota</button><button class="btn btn-ghost" data-print-modal-done style="width:100%">Selesai</button>`, 'print-modal');
    }
    return;
  }

  // Sesi Kas
  if (t.dataset.sesiBuka !== undefined) { await openSesiKas(); return; }
  if (t.dataset.sesiTutup !== undefined) { await tutupSesiKas(); return; }

  // Download laporan
  if (t.dataset.laporanDownloadPng !== undefined) { await downloadLaporanPng(); return; }
  if (t.dataset.laporanDownloadPdf !== undefined) { await downloadLaporanPdf(); return; }

  // Printer
  if (t.id === 'btn-printer-connect') {
    if (isPrinterConnected()) { await disconnectPrinter(); render(); toast('Printer diputus'); return; }
    try { toast('Pilih printer Bluetooth...'); const nama = await connectPrinter(); render(); toast('Terkoneksi: ' + nama); }
    catch (err) { toast('Gagal konek: ' + err.message); }
    return;
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'menu-search') {
    state.menuSearch = t.value;
    const grid = document.getElementById('menu-grid');
    if (grid) grid.innerHTML = renderMenuGridItems();
    return;
  }
  if (t.id === 'cs-nomeja' || t.id === 'sh-nomeja') { state.noMeja = t.value; return; }
  if (t.id === 'cs-nama' || t.id === 'sh-nama') { state.namaPembeli = t.value; return; }
  if (t.id === 'sk-saldo-akhir') { updateSelisih(); return; }
  if (t.id === 'riwayat-search') { state.riwayatSearch = t.value; render(); return; }
  if (t.id === 'riwayat-filter') { state.riwayatFilter = t.value; render(); return; }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'printer-auto') {
    const pref = getPrintPref(); pref.mode = t.checked ? 'ble' : 'manual';
    localStorage.setItem('cafeku_print_pref', JSON.stringify(pref));
  }
  if (t.id === 'print-on') {
    const pref = getPrintPref(); pref.on = t.checked;
    localStorage.setItem('cafeku_print_pref', JSON.stringify(pref));
  }
});

// Init
init();
