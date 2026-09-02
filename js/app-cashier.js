// ===== CAFeku KASIR — Main App (standalone PWA) =====
// Import shared modules
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
  cart: [],
  platform: 'Offline',
  metodeBayar: 'tunai',
  adjustment: 0,
  cartSearch: '',
  menuKategoriFilter: 'Semua',
  stagedTrx: null,
  printModalTrx: null,
  printModalBayar: 0,
  sesiKas: null,         // {id, saldoAwal, waktuBuka, oleh} atau null
  kategoriFilter: 'Semua',
  riwayatSearch: '',
  riwayatFilter: 'hari',
  users: [],
};

const $app = document.getElementById('app');
let payStr = '';

// ================= INIT =================
const $body = document.body;

async function init() {
  CashierStore.loadFromLocal();
  if (CashierAuth.isLoggedIn()) {
    state.page = 'main';
    await CashierStore.syncAll(true);
    render();
    await CashierStore.syncAll(true);
    render();
    if (CashierStore.pendingCount() > 0) CashierStore._flush();
    setInterval(() => { CashierStore.syncAll(true).then(() => CashierStore._flush()).then(render); }, AUTO_SYNC_INTERVAL);
  } else {
    state.page = 'login';
    render();
    await loadUsers();
  }
}

async function loadUsers() {
  try {
    state.users = await CashierApi.getUsers();
    render();
  } catch (e) {
    toast('Gagal load data: ' + e.message);
  }
}

async function handleLogin() {
  const nama = (document.getElementById('cl-nama') || {}).value || '';
  const pin = (document.getElementById('cl-pin') || {}).value || '';
  if (!nama || !pin) { toast('Pilih nama & isi PIN'); return; }
  try {
    const result = await CashierAuth.login(nama, pin);
    state.page = 'main';
    await CashierStore.syncAll(true);
    render();
    await CashierStore.syncAll(true);
    if (CashierStore.pendingCount() > 0) CashierStore._flush();
    setInterval(() => { CashierStore.syncAll(true).then(() => CashierStore._flush()).then(render); }, AUTO_SYNC_INTERVAL);
  } catch (err) {
    toast('Login gagal: ' + err.message);
  }
}

function handleLogout() {
  CashierAuth.clearLogin();
  state.page = 'login';
  state.tab = 'kasir';
  state.cart = [];
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
  const now = new Date();
  const d = now.toISOString().split('T')[0];
  return CashierStore.get('Promo').filter(p => {
    if (p.aktif === false) return false;
    if (p.tglMulai && d < p.tglMulai) return false;
    if (p.tglSelesai && d > p.tglSelesai) return false;
    return true;
  }).sort((a, b) => {
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
  return String(s || '').replace(/[&<>"']/g, function (c) {
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
  });
}

function escapeAttr(s) {
  return String(s || '').replace(/[&<>"']/g, function (c) {
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
  });
}

// ================= RENDER =================
function render() {
  if (state.page === 'login') {
    $app.innerHTML = renderLogin();
    return;
  }
  $app.innerHTML = `
    <div class="cashier-header">
      <h1>Cafeku Kasir</h1>
      <div class="ch-user">
        ${CashierAuth.getUser()?.nama || ''} <span class="ch-logout" data-logout>(keluar)</span>
        <button class="btn btn-ghost btn-sm" id="btn-printer-connect" style="margin-left:8px">${isPrinterConnected() ? 'Putus Printer' : 'Konek Printer'}</button>
      </div>
    </div>
    <div class="cashier-tabs">
      <button class="cashier-tab ${state.tab === 'kasir' ? 'active' : ''}" data-tab="kasir"><span class="ic"><i class="fa fa-utensils"></i></span>Kasir</button>
      <button class="cashier-tab ${state.tab === 'riwayat' ? 'active' : ''}" data-tab="riwayat"><span class="ic"><i class="fa fa-clock"></i></span>Riwayat</button>
      <button class="cashier-tab ${state.tab === 'promo' ? 'active' : ''}" data-tab="promo"><span class="ic"><i class="fa fa-tag"></i></span>Promo</button>
      <button class="cashier-tab ${state.tab === 'sesi' ? 'active' : ''}" data-tab="sesi"><span class="ic"><i class="fa fa-cash-register"></i></span>Sesi Kas</button>
      <button class="cashier-tab ${state.tab === 'stok' ? 'active' : ''}" data-tab="stok"><span class="ic"><i class="fa fa-box"></i></span>Stok</button>
    </div>
    <div class="cashier-page" id="cp-content">${renderTabContent()}</div>
    <div id="cart-drawer-container" style="display:none">${renderCartDrawer()}</div>
  `;
}

function renderTabContent() {
  if (state.tab === 'kasir') return renderKasirTab();
  if (state.tab === 'riwayat') return renderRiwayatTab();
  if (state.tab === 'promo') return renderPromoTab();
  if (state.tab === 'sesi') return renderSesiTab();
  if (state.tab === 'stok') return renderStokTab();
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
      <div class="cl-sub">Pilih nama & masukkan PIN untuk memulai sesi</div>
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
      <button class="btn btn-primary cl-btn" data-login-btn>Masuk</button>
    </div>
  `;
}

// ================= TAB: KASIR =================
function renderKasirTab() {
  const menus = getMenuList().filter(m => m.aktif !== false);
  const kategoris = ['Semua', ...new Set(menus.map(m => m.kategori).filter(Boolean))];
  const filtered0 = state.kategoriFilter === 'Semua' ? menus : menus.filter(m => m.kategori === state.kategoriFilter);
  const settings = getSettings();

  let html = '';
  // Category chips
  html += `<div class="category-chips">
    ${kategoris.map(k => `<button class="category-chip ${state.kategoriFilter === k ? 'active' : ''}" data-kategori="${k}">${escapeHtml(k)}</button>`).join('')}
  </div>`;
  // Menu grid
  html += `<div class="cashier-menu-grid">`;
  if (filtered0.length === 0) {
    html += `<div class="empty" style="padding:30px 14px;text-align:center">Tidak ada menu di kategori ini.</div>`;
  } else {
    html += filtered0.map(m => {
      const hpp = hitungHpp(m, getBahanList());
      const saran = m.hargaJualManual || hitungHargaSaran(hpp, m.marginPercent ?? settings.defaultMarginPercent, adminPercentFor(state.platform));
      const efektif = hargaJualEfektif(m, saran, saran);
      const adaDiskon = efektif < saran;
      return `
      <div class="menu-card" data-pick-menu="${m.id}" style="position:relative">
        ${m.gambar ? `<img src="${escapeAttr(m.gambar)}" class="mc-img">` : `<div class="mc-ph">☕</div>`}
        ${adaDiskon ? `<span class="menu-card-badge">PROMO</span>` : ''}
        <div class="mc-name">${escapeHtml(m.nama)}</div>
        <div class="mc-price">${adaDiskon ? `<span class="coret">${rupiah(Math.round(saran))}</span> <b>${rupiah(Math.round(efektif))}</b>` : rupiah(Math.round(efektif))}</div>
      </div>`;
    }).join('');
  }
  html += `</div>`;
  // Cart FAB
  html += `
    <button class="cart-fab ${state.cart.length ? 'has-items' : ''}" data-cart-toggle="open">
      <i class="fa fa-shopping-cart"></i>
      ${state.cart.length ? `<span class="cart-count">${state.cart.length}</span>` : ''}
    </button>
  `;
  return html;
}

// ================= TAB: RIWYAT =================
function renderRiwayatTab() {
  const penjualan = CashierStore.get('Penjualan');
  const now = new Date();
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
    <div class="sesi-kas-card">
      <div style="display:flex;gap:6px;margin-bottom:10px">
        <input type="search" id="riwayat-search" placeholder="Cari invoice/menu…" value="${escapeAttr(state.riwayatSearch)}" style="flex:1" />
        <select id="riwayat-filter">
          <option value="hari" ${state.riwayatFilter === 'hari' ? 'selected' : ''}>Hari Ini</option>
          <option value="semua" ${state.riwayatFilter === 'semua' ? 'selected' : ''}>Semua</option>
        </select>
      </div>
      ${filtered.length === 0 ? `<div class="empty">Tidak ada transaksi.</div>` : filtered.map(p => {
        const totalHarga = Number(p.total || 0);
        const metode = p.metodeBayar === 'qris' ? 'QRIS' : 'Tunai';
        return `
        <div class="riwayat-item" data-reprint="${p.id}">
          <div class="ri-top">
            <span class="ri-invoice">${escapeHtml(p.noInvoice || '')}</span>
            <span class="ri-total">${rupiah(totalHarga)}</span>
          </div>
          <div class="ri-meta">
            <span>${formatTanggalCashier(p.tanggal)} • ${p.waktu || ''}</span>
            <span class="ri-metode">${metode}</span>
          </div>
        </div>`;
      }).join('')}
    </div>
  `;
}

// ================= TAB: PROMO =================
function renderPromoTab() {
  const promos = getPromoAktif();
  return `
    <div class="cashier-page">
      ${promos.length === 0 ? `<div class="empty" style="padding:40px">Tidak ada promo aktif.</div>` : promos.map(p => `
      <div class="promo-card">
        <div class="pc-name">${escapeHtml(p.nama || '(Tanpa Nama)')}</div>
        <div class="pc-detail">
          ${p.jenis === 'persen' ? p.nilai + '% diskon' : 'Potongan ' + rupiah(p.nilai)} • ${p.tipe === 'transaksi' ? 'Diskon transaksi' : p.tipe === 'menu' ? 'Diskon menu' : 'Umum'}
          <br>${p.tglMulai ? formatTanggalCashier(p.tglMulai) : '?'} s/d ${p.tglSelesai ? formatTanggalCashier(p.tglSelesai) : 'selamanya'}
        </div>
      </div>
      `).join('')}
    </div>
  `;
}

// ================= TAB: SESI KAS =================
function renderSesiTab() {
  if (!state.sesiKas) {
    const today = todayStr();
    const kasRecords = CashierStore.get('Kas').filter(k => k.tanggal === today && k.sesi === 'buka');
    const alreadyOpen = kasRecords.length > 0;
    if (alreadyOpen) {
      state.sesiKas = {
        id: kasRecords[0].id,
        saldoAwal: kasRecords[0].saldoAwal,
        waktuBuka: kasRecords[0].waktu,
        oleh: kasRecords[0].oleh,
        tanggal: kasRecords[0].tanggal
      };
    }
    if (state.sesiKas) {
      return renderSesiOpen();
    }
    return `
      <div class="sesi-kas-card">
        <div class="sk-row"><span class="k">Tanggal</span><span class="v">${today}</span></div>
        <div class="sk-row"><span class="k">Kasir</span><span class="v">${CashierAuth.getUser()?.nama || ''}</span></div>
        <div class="num-input-wrap">
          <label>Saldo Awal Kas (Rp)</label>
          <input type="text" id="sk-saldo-awal" inputmode="numeric" placeholder="mis. 100000" autocomplete="off" readonly />
        </div>
        <button class="btn btn-primary" style="width:100%;margin-top:12px" data-sesi-buka>Buka Sesi Kas</button>
        <div class="num-keypad" data-target="sk-saldo-awal" style="display:none">
          ${[1,2,3,4,5,6,7,8,9,0].map(n => `<button class="num-key" data-num="${n}">${n}</button>`).join('')}
          <button class="num-key num-del" data-num-del><i class="fa fa-backspace"></i></button>
        </div>
      </div>
    `;
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
    <div class="sesi-kas-card">
      <div class="sk-row"><span class="k">Tanggal</span><span class="v">${today}</span></div>
      <div class="sk-row"><span class="k">Kasir</span><span class="v">${escapeHtml(s.oleh || '')}</span></div>
      <div class="sk-row"><span class="k">Waktu Buka</span><span class="v">${s.waktuBuka || '-'}</span></div>
      <div class="sk-row"><span class="k">Saldo Awal</span><span class="v">${rupiah(saldoAwal)}</span></div>
      <div class="sk-row"><span class="k">Transaksi Tunai</span><span class="v">${tunaiTransaksi.length} ×</span></div>
      <div class="sk-row"><span class="k">Total Tunai Masuk</span><span class="v">${rupiah(totalTunai)}</span></div>
      <div class="sk-total"><span>Total Kas (teori)</span><span>${rupiah(harusnya)}</span></div>
      <div class="num-input-wrap">
        <label>Uang di Petungku Sekarang (Rp)</label>
        <input type="text" id="sk-saldo-akhir" inputmode="numeric" placeholder="mis. ${harusnya.toLocaleString('id-ID')}" value="${harusnya}" autocomplete="off" readonly />
      </div>
      <div class="num-keypad" data-target="sk-saldo-akhir" style="display:none">
        ${[1,2,3,4,5,6,7,8,9,0].map(n => `<button class="num-key" data-num="${n}">${n}</button>`).join('')}
        <button class="num-key num-del" data-num-del><i class="fa fa-backspace"></i></button>
      </div>
      <div class="sk-row" style="margin-top:8px"><span class="k">Selisih</span><span class="v" id="sk-selisih">${rupiah(0)}</span></div>
      <button class="btn btn-primary" style="width:100%;margin-top:12px" data-sesi-tutup>Tutup Sesi & Cetak Laporan</button>
    </div>
  `;
}

// ================= TAB: STOK =================
function renderStokTab() {
  const bahanList = getBahanList();
  return `
    <div class="cashier-page">
      <div class="section-title" style="margin:12px 14px">Stok Bahan</div>
      ${bahanList.length === 0 ? `<div class="empty">Belum ada data bahan.</div>` : bahanList.map(b => {
        const min = Number(b.stokMinimum || 0);
        const low = Number(b.stok || 0) <= min;
        const avco = Number(b.hargaAvco ?? 0);
        return `
        <div class="stok-item">
          <div class="si-info">
            <div class="name">${escapeHtml(b.nama)} <span class="badge ${low ? 'low' : 'ok'}">${low ? 'Stok Menipis' : 'Aman'}</span></div>
            <div class="sub">AVCO ${rupiah(avco)} / ${b.satuan}</div>
          </div>
          <div style="text-align:right">
            <div class="amt">${b.stok} ${b.satuan}</div>
          </div>
        </div>`;
      }).join('')}
    </div>
  `;
}

// ================= CART =================
function renderCartDrawer() {
  if (!state.cart.length) {
    return `
      <div class="cashier-cart-overlay" data-cart-toggle="close"></div>
      <div class="cashier-cart-drawer" id="cart-drawer">
        <div class="cd-header">
          <span>Keranjang</span>
          <button class="cd-close" data-cart-toggle="close">✕</button>
        </div>
        <div class="cd-items">
          <div class="empty" style="padding:20px;text-align:center">Keranjang masih kosong.</div>
        </div>
      </div>
    `;
  }
  const totalJual = state.cart.reduce((s, c) => s + c.hargaJual * c.qty, 0);
  const diskon = diskonTransaksi(totalJual);
  const grandTotal = totalJual - diskon + Number(state.adjustment || 0);
  const cartItems = state.cart.map((c, i) => `
    <div class="cd-item">
      <div class="cd-name">${escapeHtml(c.nama)}
        <div class="cd-price">${rupiah(Math.round(c.hargaJual))}/${c.qty} × = ${rupiah(Math.round(c.hargaJual * c.qty))}</div>
      </div>
      <div class="cd-qty">
        <button data-cart-dec="${i}">−</button>
        <span>${c.qty}</span>
        <button data-cart-inc="${i}">+</button>
        <button data-cart-remove="${i}" class="ci-delete">✕</button>
      </div>
    </div>
  `).join('');

  return `
    <div class="cashier-cart-overlay" data-cart-toggle="close"></div>
    <div class="cashier-cart-drawer open" id="cart-drawer">
      <div class="cd-header">
        <span>Keranjang</span>
        <button class="cd-close" data-cart-toggle="close">✕</button>
      </div>
      <div class="cd-items">
        ${cartItems}
      </div>
      <div class="cd-footer">
        <div class="cd-total"><span>Subtotal</span><span>${rupiah(totalJual)}</span></div>
        ${diskon ? `<div class="cd-total"><span>Diskon</span><span>−${rupiah(diskon)}</span></div>` : ''}
        ${state.adjustment ? `<div class="cd-total"><span>Penyesuaian</span><span>${rupiah(state.adjustment)}</span></div>` : ''}
        <div class="cd-total"><span class="big">TOTAL</span><span>${rupiah(grandTotal)}</span></div>
        <div style="margin-bottom:8px">
          <label>Platform</label>
          <div class="cd-pay-row">
            ${getSettings().platforms.map(p => `<button class="btn btn-sm ${state.platform === p.nama ? 'btn-primary' : 'btn-ghost'}" data-set-platform="${p.nama}">${escapeHtml(p.nama)}</button>`).join('')}
          </div>
        </div>
        <div style="margin-bottom:8px">
          <label>Metode Bayar</label>
          <div class="cd-pay-row">
            <button class="btn btn-sm ${state.metodeBayar === 'tunai' ? 'btn-primary' : 'btn-ghost'}" data-set-metode="tunai">Tunai</button>
            <button class="btn btn-sm ${state.metodeBayar === 'qris' ? 'btn-primary' : 'btn-ghost'}" data-set-metode="qris">QRIS</button>
          </div>
        </div>
        <button class="btn btn-primary cd-btn-bayar" data-checkout-btn>Selesaikan Transaksi</button>
      </div>
    </div>
  `;
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
  else {
    state.cart.push({
      menuId, nama: menu.nama, qty: 1,
      hargaJual: Math.round(hargaJual),
      hargaNormal: Math.round(hargaNormal),
      hpp
    });
  }
  renderCartRegion();
  toggleCartDrawer(true);
}

function renderCartRegion() {
  const container = document.getElementById('cart-drawer-container');
  if (container) {
    container.innerHTML = renderCartDrawer();
    container.style.display = state.cart.length ? 'block' : 'none';
  }
}

function toggleCartDrawer(show) {
  const container = document.getElementById('cart-drawer-container');
  if (container) {
    container.innerHTML = renderCartDrawer();
    container.style.display = show ? 'block' : 'none';
  }
}

// ================= CHECKOUT =================
async function checkoutCashier() {
  if (!state.cart.length) return;
  const totalJual = state.cart.reduce((s, c) => s + c.hargaJual * c.qty, 0);
  const totalHpp = state.cart.reduce((s, c) => s + c.hpp * c.qty, 0);
  const diskon = diskonTransaksi(totalJual);
  const total = totalJual - diskon + Number(state.adjustment || 0);

  // BYPASS stok — tidak validasi stok bahan di kasir
  // Stok tetap dikurangi via belanja bahan di owner app, bukan di kasir

  const transaksi = {
    id: uid(),
    noInvoice: nextInvoiceNo(),
    tanggal: todayStr(),
    waktu: nowTimeStr(),
    platform: state.platform,
    metodeBayar: state.metodeBayar,
    items: state.cart.map(c => ({
      menuId: c.menuId,
      nama: c.nama,
      qty: c.qty,
      hargaJual: c.hargaJual,
      hpp: c.hpp
    })),
    subtotal: totalJual,
    diskon: diskon,
    adjustment: Number(state.adjustment || 0),
    total: total,
    totalHpp: totalHpp,
    laba: total - totalHpp,
    catatan: state.catatan || '',
    oleh: CashierAuth.getUser()?.nama || ''
  };

  state.stagedTrx = transaksi;
  payStr = '';

  if (state.metodeBayar === 'qris') {
    openQrisConfirmSheet(transaksi);
  } else {
    openPaymentSheet(transaksi);
  }
}

function nextInvoiceNo() {
  const tgl = todayStr().replace(/-/g, '');
  const jml = CashierStore.get('Penjualan').filter(p => (p.tanggal || '').replace(/-/g, '') === tgl).length + 1;
  return 'INV-' + tgl + '-' + String(jml).padStart(4, '0');
}

// ================= PAYMENT SHEETS =================
function renderPay() {
  const total = Number((state.stagedTrx || {}).total) || 0;
  const disp = document.getElementById('pay-display');
  if (disp) disp.textContent = rupiah(payValue());
  const el = document.getElementById('pay-kembali');
  if (!el) return;
  const kemb = payValue() - total;
  if (kemb < 0) el.textContent = 'Uang kurang: ' + rupiah(-kemb);
  else el.textContent = 'Kembalian: ' + rupiah(kemb) + (kemb === 0 ? ' (pas)' : '');
}

function payValue() { return parseInt(payStr.replace(/[^\d]/g, ''), 10) || 0; }

function openPaymentSheet(trx) {
  const total = Number(trx.total || 0);
  payStr = String(total);
  const html = `
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>Pembayaran (Tunai)</h2><button class="btn-icon" data-close-pay>✕</button></div>
    <div class="row"><span class="k">Total Tagihan</span><span class="v big">${rupiah(total)}</span></div>
    <label>Uang Diterima</label>
    <div class="pay-display" id="pay-display">${rupiah(payValue())}</div>
    <div class="pay-quick">
      <button class="pay-key" data-pay-amount="50000">50k</button>
      <button class="pay-key" data-pay-amount="100000">100k</button>
      <button class="pay-key" data-pay-amount="200000">200k</button>
      <button class="pay-key" data-pay-exact>Pas</button>
    </div>
    <div class="pay-kb">
      ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="pay-key" data-pay-key="${n}">${n}</button>`).join('')}
    </div>
    <div class="pay-kb">
      <button class="pay-key" data-pay-bks>⌫</button>
      <button class="pay-key" data-pay-key="0">0</button>
      <button class="pay-key" data-pay-clr>C</button>
    </div>
    <div class="pay-actions">
      <button class="btn btn-ghost" data-pay-exact>Uang Pas</button>
      <button class="btn btn-primary" data-pay-ok>Bayar</button>
    </div>
    <div class="hint" id="pay-kembali"></div>
    <div class="pay-actions">
      <button class="btn btn-ghost btn-sm" data-pay-cancel>Batal</button>
    </div>
  `;
  openSheet(html, 'pay');
  renderPay();
}

function openQrisConfirmSheet(trx) {
  const total = Number(trx.total || 0);
  const html = `
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>Pembayaran QRIS</h2><button class="btn-icon" data-close-pay>✕</button></div>
    <div class="row"><span class="k">Total Tagihan</span><span class="v big">${rupiah(total)}</span></div>
    <p style="text-align:center;color:#888;margin:16px 0">Pastikan pembayaran QRIS sudah diterima, lalu konfirmasi.</p>
    <button class="btn btn-primary" data-qris-confirm-ok style="width:100%;margin-bottom:8px">Sudah Bayar</button>
    <button class="btn btn-ghost" data-pay-cancel style="width:100%">Batal</button>
  `;
  openSheet(html, 'qris-confirm');
}

// ================= RECEIPT PRINTING =================
function printReceipt(trx, bayar) {
  const pref = getPrintPref();
  if (pref.mode === 'ble' && isBleSupported() && isPrinterConnected()) {
    printBle(trx, bayar);
  } else {
    printDialogCashier(trx, bayar);
  }
}

async function printBle(trx, bayar) {
  try {
    await printBytes(buildEscPos(trx, bayar));
    toast('Struk terkirim ke printer ✓');
  } catch (err) {
    toast('Printer gagal: ' + err.message);
    printDialogCashier(trx, bayar);
  }
}

function printDialogCashier(trx, bayar) {
  const setting = getSettings();
  const shopName = (setting.namaToko || 'CAFEKU').replace(/</g, '&lt;');
  const kembalian = Number(bayar || 0) - Number(trx.total || 0);
  const itemRows = (trx.items || []).map(it => `
    <div class="pr-item">
      <div class="pr-name">${escapeHtml(it.nama)}</div>
      <div class="pr-sub">${it.qty} × Rp${Math.round(it.hargaJual).toLocaleString('id-ID')}</div>
      <div class="pr-amt">Rp${Math.round(it.hargaJual * it.qty).toLocaleString('id-ID')}</div>
    </div>`).join('');

  const html = `
    <div class="pr-center"><b>${shopName}</b></div>
    <div class="pr-center">STRUK KASIR</div>
    <div class="pr-center">${escapeHtml(trx.noInvoice || '')}</div>
    <div class="pr-row"><span>Tanggal</span><span>${trx.tanggal || '-'}</span></div>
    <div class="pr-row"><span>Jam</span><span>${trx.waktu || '-'}</span></div>
    <div class="pr-row"><span>Platform</span><span>${escapeHtml(trx.platform || 'Offline')}</span></div>
    <div class="pr-row"><span>Metode</span><span>${escapeHtml(trx.metodeBayar === 'qris' ? 'QRIS' : 'Tunai')}</span></div>
    <div class="pr-divider"></div>
    ${itemRows}
    <div class="pr-divider"></div>
    <div class="pr-row"><span>Subtotal</span><span>Rp${Number(trx.subtotal || 0).toLocaleString('id-ID')}</span></div>
    ${Number(trx.diskon) ? `<div class="pr-row"><span>Diskon</span><span>-Rp${trx.diskon.toLocaleString('id-ID')}</span></div>` : ''}
    ${Number(trx.adjustment) ? `<div class="pr-row"><span>Penyesuaian</span><span>Rp${trx.adjustment.toLocaleString('id-ID')}</span></div>` : ''}
    <div class="pr-row pr-big"><span><b>TOTAL</b></span><span><b>Rp${Number(trx.total || 0).toLocaleString('id-ID')}</b></span></div>
    <div class="pr-row"><span>Dibayar</span><span>Rp${Math.round(Number(bayar || 0)).toLocaleString('id-ID')}</span></div>
    <div class="pr-row"><span>Kembalian</span><span>${kembalian >= 0 ? 'Rp' + kembalian.toLocaleString('id-ID') : 'KURANG Rp' + (-kembalian).toLocaleString('id-ID')}</span></div>
    <div class="pr-center pr-foot">Terima kasih, sampai jumpa!</div>
  `;

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
  closeSheet();

  // Finalisasi: insert ke sheet
  await CashierStore.insert('Penjualan', trx);

  // Reset cart
  state.stagedTrx = null;
  state.cart = [];
  state.adjustment = 0;
  state.metodeBayar = 'tunai';

  toast('Transaksi selesai ✓');
  render();

  // Buka modal print (BLE atau dialog)
  const pref = getPrintPref();
  if (pref.on) {
    state.printModalTrx = trx;
    state.printModalBayar = bayar;
    const html = `
      <div class="sheet-handle"></div>
      <div class="sheet-head"><h2>Cetak Nota</h2></div>
      <p style="text-align:center;color:#888;margin:0 0 16px">Klik Cetak untuk mencetak, atau Selesai untuk melewati.</p>
      <button class="btn btn-primary" data-print-modal-print style="width:100%;margin-bottom:8px">Cetak Nota</button>
      <button class="btn btn-ghost" data-print-modal-done style="width:100%">Selesai</button>
    `;
    openSheet(html, 'print-modal');
  }
}

// ================= SESI KAS =================
async function openSesiKas() {
  const saldoAwal = numOnly(document.getElementById('sk-saldo-awal')?.value);
  if (!saldoAwal || saldoAwal <= 0) { toast('Masukkan saldo awal kas'); return; }
  const user = CashierAuth.getUser();
  const trx = {
    id: uid(),
    sesi: 'buka',
    tanggal: todayStr(),
    waktu: nowTimeStr(),
    saldoAwal: saldoAwal,
    oleh: user?.nama || '',
    oleh: user?.nama || '',
    totalTunai: 0,
    totalTransaksi: 0,
    catatan: ''
  };
  await CashierStore.insert('Kas', trx);
  state.sesiKas = { id: trx.id, saldoAwal: saldoAwal, waktuBuka: trx.waktu, oleh: trx.oleh, tanggal: trx.tanggal };
  closeSheet();
  toast('Sesi kas dibuka ✓');
  render();
}

function updateSelisih() {
  const s = state.sesiKas;
  if (!s) return;
  const today = todayStr();
  const transaksi = CashierStore.get('Penjualan').filter(p => p.tanggal === today);
  const tunaiTransaksi = transaksi.filter(p => p.metodeBayar === 'tunai');
  const totalTunai = tunaiTransaksi.reduce((sum, p) => sum + Number(p.total || 0), 0);
  const saldoAwal = Number(s.saldoAwal || 0);
  const harusnya = saldoAwal + totalTunai;
  const akhirInput = numOnly(document.getElementById('sk-saldo-akhir')?.value);
  const selisih = akhirInput - harusnya;
  const el = document.getElementById('sk-selisih');
  if (el) el.textContent = rupiah(selisih);
  if (el) el.className = 'v ' + (selisih >= 0 ? 'positive' : 'negative');
}

async function tutupSesiKas() {
  const s = state.sesiKas;
  if (!s) return;
  const today = todayStr();
  const transaksi = CashierStore.get('Penjualan').filter(p => p.tanggal === today);
  const tunaiTransaksi = transaksi.filter(p => p.metodeBayar === 'tunai');
  const totalTunai = tunaiTransaksi.reduce((sum, p) => sum + Number(p.total || 0), 0);
  const saldoAwal = Number(s.saldoAwal || 0);
  const harusnya = saldoAwal + totalTunai;
  const saldoAkhir = numOnly(document.getElementById('sk-saldo-akhir')?.value) || harusnya;
  const selisih = saldoAkhir - harusnya;
  const user = CashierAuth.getUser();

  const trx = {
    id: uid(),
    sesi: 'tutup',
    tanggal: today,
    waktu: nowTimeStr(),
    saldoAwal: saldoAwal,
    saldoAkhir: saldoAkhir,
    totalTunai: totalTunai,
    totalTransaksi: transaksi.length,
    selisih: selisih,
    oleh: user?.nama || '',
    catatan: ''
  };
  await CashierStore.insert('Kas', trx);
  await CashierStore._flush();

  // Generate laporan
  const laporanHtml = renderLaporanHarian(saldoAwal, saldoAkhir, totalTunai, transaksi);
  state.sesiKas = null;
  closeSheet();
  toast('Sesi kas ditutup ✓');

  // Buka laporan sebagai modal printable
  const html = `
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>Laporan Kasier Hari Ini</h2><button class="btn-icon" data-close-sheet>✕</button></div>
    <div id="laporan-print" style="padding:0 14px">${laporanHtml}</div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-ghost" style="flex:1" data-laporan-download-png>Download PNG</button>
      <button class="btn btn-ghost" style="flex:1" data-laporan-download-pdf>Download PDF</button>
    </div>
  `;
  openSheet(html, 'laporan');
}

function renderLaporanHarian(saldoAwal, saldoAkhir, totalTunai, transaksi) {
  let html = `
    <div style="text-align:center;margin-bottom:16px">
      <h2 style="margin:0;font-size:18px">CAFEKU KASIR</h2>
      <div style="font-size:13px;color:#888">Laporan Penjualan Hari Ini</div>
      <div style="font-size:13px;color:#888">${formatTanggalCashier(todayStr())}</div>
    </div>
    <div style="border:1px solid #ddd;padding:8px;margin-bottom:12px;border-radius:6px">
      <div style="display:flex;justify-content:space-between;padding:4px 0">
        <span>Saldo Awal</span><span>${rupiah(saldoAwal)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:4px 0">
        <span>Total Penjualan (semua)</span><span>${rupiah(transaksi.reduce((s,p) => s + Number(p.total || 0), 0))}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:4px 0">
        <span>Total Tunai</span><span>${rupiah(totalTunai)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:4px 0">
        <span>QRIS</span><span>${rupiah(transaksi.filter(p=>p.metodeBayar==='qris').reduce((s,p)=>s+Number(p.total||0),0))}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:4px 0;border-top:1px solid #ddd;font-weight:700">
        <span>Saldo Akhir (seharusnya)</span><span>${rupiah(saldoAwal + totalTunai)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:4px 0;border-top:2px solid #1F1B16;font-weight:700">
        <span>Saldo Akhir (aktual)</span><span>${rupiah(saldoAkhir)}</span>
      </div>
    </div>
    <div style="margin-bottom:8px;font-size:12px"><b>Riwayat Transaksi (${transaksi.length})</b></div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr><td style="padding:4px;border-bottom:1px solid #eee">No. Invoice</td><td style="padding:4px;border-bottom:1px solid #eee;text-align:right">Waktu</td><td style="padding:4px;border-bottom:1px solid #eee;text-align:right">Total</td><td style="padding:4px;border-bottom:1px solid #eee;text-align:right">Metode</td></tr></thead>
      <tbody>
        ${transaksi.slice().reverse().map(p => `
        <tr>
          <td style="padding:4px">${escapeHtml(p.noInvoice || '')}</td>
          <td style="padding:4px;text-align:right">${p.waktu || '-'}</td>
          <td style="padding:4px;text-align:right">${rupiah(Number(p.total || 0))}</td>
          <td style="padding:4px;text-align:right">${p.metodeBayar === 'qris' ? 'QRIS' : 'Tunai'}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  `;
  return html;
}

// ================= UTILITIES =================
const AUTO_SYNC_INTERVAL = 60 * 1000;

function openSheet(html, key) {
  let overlay = document.getElementById('overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'overlay';
    overlay.className = 'overlay';
    document.body.appendChild(overlay);
  }
  overlay.dataset.key = key || '';
  overlay.innerHTML = `<div class="sheet" id="sheet-inner">${html}</div>`;
  overlay.style.display = 'flex';
  overlay.onclick = (e) => { if (e.target === overlay) closeSheet(); };
}

function closeSheet() {
  const overlay = document.getElementById('overlay');
  if (overlay) overlay.style.display = 'none';
  state.userFormDraft = null;
}

function formatTanggalCashier(iso) {
  if (!iso) return '-';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ================= EVENT DELEGATION =================
document.addEventListener('click', async (e) => {
  const t = e.target;

  // Tab navigation
  const tabBtn = t.closest('[data-tab]');
  if (tabBtn) {
    state.tab = tabBtn.dataset.tab;
    closeSheet();
    render();
    return;
  }

  // Close sheet
  if (t.closest('[data-close-sheet]')) { closeSheet(); return; }
  if (t.closest('[data-close-pay]')) { closeSheet(); return; }
  if (t.closest('[data-pay-cancel]')) { state.stagedTrx = null; closeSheet(); return; }

  // Login
  if (t.dataset.loginBtn !== undefined) { await handleLogin(); return; }
  if (t.dataset.pinKey !== undefined) {
    const pinEl = document.getElementById('cl-pin');
    if (pinEl && pinEl.value.length < 6) pinEl.value += t.dataset.pinKey;
    return;
  }
  if (t.dataset.pinDel !== undefined) {
    const pinEl = document.getElementById('cl-pin');
    if (pinEl) pinEl.value = pinEl.value.slice(0, -1);
    return;
  }

  // Logout
  if (t.dataset.logout !== undefined) { handleLogout(); return; }

  // Cart
  const pick = t.closest('[data-pick-menu]');
  if (pick) { addToCartCashier(pick.dataset.pickMenu); renderCartRegion(); return; }
  if (t.dataset.cartInc !== undefined) { state.cart[+t.dataset.cartInc].qty++; renderCartRegion(); return; }
  if (t.dataset.cartDec !== undefined) {
    const i = +t.dataset.cartDec;
    state.cart[i].qty--;
    if (state.cart[i].qty <= 0) state.cart.splice(i, 1);
    renderCartRegion();
    return;
  }
  if (t.dataset.cartRemove !== undefined) { state.cart.splice(+t.dataset.cartRemove, 1); renderCartRegion(); return; }

  // Platform / Metode Bayar
  if (t.dataset.setPlatform) { state.platform = t.dataset.setPlatform; renderCartRegion(); return; }
  if (t.dataset.setMetode) { state.metodeBayar = t.dataset.setMetode; renderCartRegion(); return; }

  // Open / close cart drawer
  if (t.dataset.cartToggle === 'open') {
    toggleCartDrawer(true);
    return;
  }
  if (t.dataset.cartToggle === 'close') {
    const container = document.getElementById('cart-drawer-container');
    if (container) container.style.display = 'none';
    return;
  }
  if (t.id === 'btn-checkout') return checkoutCashier();
  if (t.dataset.checkoutBtn !== undefined) return checkoutCashier();

  // Numeric Keypad Handlers
  if (t.dataset.num !== undefined) {
    const targetEl = document.getElementById('sk-saldo-awal');
    const targetEl2 = document.getElementById('sk-saldo-akhir');
    let val = t.dataset.num;
    // Add to current visible input
    if (targetEl && !targetEl.disabled && targetEl.readOnly) {
      if (targetEl.value.length < 16) targetEl.value += val;
    } else if (targetEl2 && !targetEl2.disabled && targetEl2.readOnly) {
      if (targetEl2.value.length < 16) targetEl2.value += val;
    }
    return;
  }
  if (t.dataset.numDel !== undefined) {
    const targetEl = document.getElementById('sk-saldo-awal');
    const targetEl2 = document.getElementById('sk-saldo-akhir');
    if (targetEl && targetEl.value) targetEl.value = targetEl.value.slice(0, -1);
    if (targetEl2 && targetEl2.value) targetEl2.value = targetEl2.value.slice(0, -1);
    return;
  }

  // Category filter
  if (t.dataset.kategori) {
    state.kategoriFilter = t.dataset.kategori;
    render();
    return;
  }

  // Payment sheet
  if (t.dataset.payAmount !== undefined) { payStr = String(Number(t.dataset.payAmount) || 0); renderPay(); return; }
  if (t.dataset.payKey !== undefined) { payStr = (payStr + t.dataset.payKey).replace(/^0+(?=\d)/, ''); renderPay(); return; }
  if (t.dataset.payBks !== undefined) { payStr = payStr.slice(0, -1); renderPay(); return; }
  if (t.dataset.payClr !== undefined) { payStr = ''; renderPay(); return; }
  if (t.dataset.payExact !== undefined) { payStr = String(Number((state.stagedTrx || {}).total) || 0); renderPay(); return; }
  if (t.dataset.payOk !== undefined) { doPay(); return; }
  if (t.dataset.qrisConfirmOk !== undefined) { payStr = String(Number((state.stagedTrx || {}).total) || 0); doPay(); return; }

  // Print modal
  if (t.closest('[data-print-modal-print]')) {
    if (state.printModalTrx) printReceipt(state.printModalTrx, state.printModalBayar);
    return;
  }
  if (t.closest('[data-print-modal-done]')) { state.printModalTrx = null; state.printModalBayar = 0; closeSheet(); return; }

  // Reprint from riwayat
  if (t.dataset.reprint) {
    const tr = CashierStore.get('Penjualan').find(x => x.id === t.dataset.reprint);
    if (tr) {
      state.printModalTrx = tr;
      state.printModalBayar = Number(tr.total || 0);
      const html = `
        <div class="sheet-handle"></div>
        <div class="sheet-head"><h2>Cetak Nota</h2></div>
        <p style="text-align:center;color:#888;margin:0 0 16px">Klik Cetak untuk mencetak, atau Selesai untuk melewati.</p>
        <button class="btn btn-primary" data-print-modal-print style="width:100%;margin-bottom:8px">Cetak Nota</button>
        <button class="btn btn-ghost" data-print-modal-done style="width:100%">Selesai</button>
      `;
      openSheet(html, 'print-modal');
    }
    return;
  }

  // Sesi Kas
  if (t.dataset.sesiBuka !== undefined) { await openSesiKas(); return; }
  if (t.dataset.sesiTutup !== undefined) { await tutupSesiKas(); return; }

  // Download lapoan PDF/PNG
  if (t.dataset.laporanDownloadPng !== undefined) { await downloadLaporanPng(); return; }
  if (t.dataset.laporanDownloadPdf !== undefined) { await downloadLaporanPdf(); return; }

  // Printer
  if (t.id === 'btn-printer-connect') {
    if (isPrinterConnected()) {
      await disconnectPrinter();
      render();
      toast('Printer diputus koneksinya');
      return;
    }
    try {
      toast('Pilih printer Bluetooth di popup...');
      const nama = await connectPrinter();
      render();
      toast('Terkoneksi: ' + nama);
    } catch (err) {
      toast('Gagal konek: ' + err.message);
    }
    return;
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'sk-saldo-akhir') { updateSelisih(); return; }
  if (t.id === 'riwayat-search') { state.riwayatSearch = t.value; render(); return; }
  if (t.id === 'riwayat-filter') { state.riwayatFilter = t.value; render(); return; }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'printer-auto') {
    const pref = getPrintPref();
    pref.mode = t.checked ? 'ble' : 'manual';
    localStorage.setItem('cafeku_print_pref', JSON.stringify(pref));
    return;
  }
  if (t.id === 'print-on') {
    const pref = getPrintPref();
    pref.on = t.checked;
    localStorage.setItem('cafeku_print_pref', JSON.stringify(pref));
    return;
  }
});

// ================= DOWNLOAD LAPORAN =================
async function downloadLaporanPng() {
  const el = document.getElementById('laporan-print');
  if (!el) return;
  const html2canvas = await loadHtml2Canvas();
  const canvas = await html2canvas(el, { scale: 2, useXHR: false });
  const url = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = 'laporan-kasir-' + todayStr() + '.png';
  a.click();
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
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
    s.onload = () => resolve(window.html2canvas);
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function loadHtml2Pdf() {
  return new Promise((resolve, reject) => {
    if (window.html2pdf) return resolve(window.html2pdf);
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
    s.onload = () => resolve(window.html2pdf);
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ================= PRINT DIALOG (cashier version) =================
// (printDialogCashier function sudah didefinisikan di atas bersama printReceipt)

// Init
init();