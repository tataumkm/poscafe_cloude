import { Api } from './api.js';
import { Store } from './store.js';
import { SHEETS } from './config.js';
import { rupiah, numOnly, todayStr, nowTimeStr, formatTanggal, hitungHpp, hitungHargaSaran, hitungAvco, uid, toast } from './utils.js';
import { isBleSupported, isPrinterConnected, getPrinterName, connectPrinter, disconnectPrinter, printBytes, testPrint, buildEscPos } from './ble.js';

const OBJECT_SHEETS = SHEETS.filter(s => s !== 'Settings');

// ============ STATE GLOBAL ============
const state = {
  page: 'kasir',
  cart: [],            // {menuId, nama, qty, hargaJual, hpp}
  platform: 'Offline',
  adjustment: 0,
  catatan: '',
  menuKategoriFilter: 'Semua',
  laporanTab: 'harian',
  laporanTanggal: todayStr(),
  akuntansiPeriode: 'bulan',
  menuFormDraft: null,  // dipakai saat tambah/edit menu
  bahanFormEditingId: null,
  lastTrx: null,
  lastKasTeori: 0,
  cartSearch: '',
  stagedTrx: null,      // transaksi yang sudah checkout&stok turun, belum final
  lastDeduction: null
};

const $app = document.getElementById('app');

// ============ INIT ============
async function init() {
  setTheme(getTheme());
  Store.loadFromLocal();
  render();
  await Store.syncAll(true);
  render();
  await restorePendingTrx();   // kirim ulang transaksi belum sampai
  setInterval(() => { Store.syncAll(true).then(() => restorePendingTrx()).then(render); }, 60000);
}

// Kirim ulang transaksi yang pernah checkout tapi belum tersinkronisasi ke sheet
async function restorePendingTrx() {
  const trx = getPendingTrx();
  if (!trx) return;
  // sudah ada di cache local → berarti sudah pernah masuk, tinggal bersihkan pending
  if (Store.getById('Penjualan', trx.id)) { clearPendingTrx(); return; }
  Store._push('insert', 'Penjualan', trx);
  toast('Mengirim kembali transaksi yang belum terkirim…');
  await Store._flush();
  await new Promise(r => setTimeout(r, 1500));
  if (Store.getById('Penjualan', trx.id)) clearPendingTrx();
}
Store.onChange(() => { /* render dipanggil manual supaya tidak flicker saat mengetik */ });

// ============ HELPERS DATA ============
function getSettings() {
  const s = Store.get('Settings')[0];
  return s || { defaultMarginPercent: 40, platforms: [{ nama: 'Offline', adminPercent: 0 }] };
}
function getPrintPref() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem('cafeku_print_pref') || '{}') || {}; } catch (e) {}
  // normalisasi default: print aktif, metode dialog (manual)
  if (p.on === undefined) p.on = true;
  if (!p.mode) p.mode = 'manual';
  return p;
}
function setPrintPref(p) { localStorage.setItem('cafeku_print_pref', JSON.stringify(p)); }

function getPendingTrx() {
  try { return JSON.parse(localStorage.getItem('cafeku_pending_trx') || 'null'); }
  catch (e) { return null; }
}
function clearPendingTrx() { localStorage.removeItem('cafeku_pending_trx'); }

// ============ TEMA (mode gelap) ============
function getTheme() { return localStorage.getItem('cafeku_theme') || 'light'; }
function setTheme(t) {
  localStorage.setItem('cafeku_theme', t);
  document.documentElement.setAttribute('data-theme', t);
}
function getBahanList() { return Store.get('Bahan'); }
function getMenuList() { return Store.get('Menu'); }

// ============ PROMO OTOMATIS (diskon bertanggal) ============
function promoAktifHariIni() {
  const t = todayStr();
  return Store.get('Promo').filter(p => p.aktif !== false
    && (!p.tglMulai || p.tglMulai <= t) && (!p.tglSelesai || t <= p.tglSelesai));
}
function potonganPromo(promo, base) {
  return promo.jenis === 'persen' ? base * (Number(promo.nilai) / 100) : Number(promo.nilai);
}
// Diskon transaksi: ambil potongan TERBESAR dari semua promo transaksi aktif
function diskonTransaksi(subtotal) {
  const promos = promoAktifHariIni().filter(p => p.tipe === 'transaksi');
  if (!promos.length) return 0;
  return Math.max(...promos.map(p => {
    const v = potonganPromo(p, subtotal);
    return p.jenis === 'persen' ? Math.min(v, subtotal) : v;
  }));
}
// Harga jual efektif per menu (promo menu). Memakai harga maks sebagai harga normal.
// Harga jual efektif per menu dari promo (persen atau rupiah). Menu harga tetap diabaikan.
function promoMenuTerpilih(menu) {
  const promos = promoAktifHariIni().filter(p => p.tipe === 'menu' && (!p.menuId || p.menuId === menu.id));
  if (!promos.length) return null;
  // pilih promo dengan persen diskon tertinggi (atau nilai rp tertinggi), konsisten
  return promos.sort((a, b) => {
    const na = a.jenis === 'persen' ? Number(a.nilai) : 0;
    const nb = b.jenis === 'persen' ? Number(b.nilai) : 0;
    return nb - na;
  })[0];
}
function hargaJualEfektif(menu, hargaSaran) {
  if (menu.hargaJualManual) return hargaSaran; // promo menu diabaikan utk harga tetap
  const promo = promoMenuTerpilih(menu);
  if (!promo) return hargaSaran;
  if (promo.jenis === 'persen') return Math.max(0, hargaSaran * (1 - Number(promo.nilai) / 100));
  return Math.max(0, hargaSaran - Number(promo.nilai)); // rupiah
}

// ============ UI PROMO (CRUD) ============
function renderPromoList() {
  const list = Store.get('Promo');
  if (!list.length) return '<div class="hint" style="margin-top:8px">Belum ada promo.</div>';
  return list.map(p => {
    const menuName = p.tipe === 'menu' ? (getMenuList().find(m => m.id === p.menuId) || {}).nama || '(menu terhapus)' : 'Transaksi';
    const jenis = p.jenis === 'persen' ? p.nilai + '%' : rupiah(p.nilai);
    const status = (p.aktif === false) ? ' <span class="badge low">Nonaktif</span>' : '';
    const range = (p.tglMulai || '?') + ' s/d ' + (p.tglSelesai || 'selamanya');
    return `
      <div class="row" style="margin-top:8px;align-items:flex-start">
        <div>
          <div class="name" style="font-weight:600;font-size:13px">${escapeHtml(p.nama)}${status}</div>
          <div class="hint">${menuName} · ${jenis}<br>${range}</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-ghost btn-sm" data-promo-edit="${p.id}">Edit</button>
          <button class="btn btn-danger btn-sm" data-promo-del="${p.id}">✕</button>
        </div>
      </div>`;
  }).join('');
}

function openPromoForm(id) {
  const existing = id ? Store.get('Promo').find(p => p.id === id) : null;
  const d = existing || { nama: '', tipe: 'transaksi', jenis: 'persen', nilai: 10, tglMulai: todayStr(), tglSelesai: '', menuId: '', aktif: true };
  const menuOpts = getMenuList().map(m => `<option value="${m.id}" ${d.menuId === m.id ? 'selected' : ''}>${escapeHtml(m.nama)}</option>`).join('');
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>${id ? 'Edit' : 'Tambah'} Promo</h2><button class="btn-icon" data-close-sheet>✕</button></div>
    <label>Nama Promo</label><input id="pr-nama" value="${escapeAttr(d.nama)}" placeholder="mis. Promo Ramadhan" />
    <label>Tipe</label>
    <select id="pr-tipe">
      <option value="transaksi" ${d.tipe === 'transaksi' ? 'selected' : ''}>Diskon Transaksi (semua pesanan)</option>
      <option value="menu" ${d.tipe === 'menu' ? 'selected' : ''}>Diskon Menu Tertentu</option>
    </select>
    <div id="pr-menu-wrap" style="display:${d.tipe === 'menu' ? 'block' : 'none'}">
      <label>Menu</label>
      <select id="pr-menu">${menuOpts}</select>
    </div>
    <div class="field-row">
      <div><label>Jenis</label>
        <select id="pr-jenis">
          <option value="persen" ${d.jenis === 'persen' ? 'selected' : ''}>Persen (%)</option>
          <option value="rp" ${d.jenis !== 'persen' ? 'selected' : ''}>Rupiah (Rp)</option>
        </select>
      </div>
      <div><label>Nilai</label><input type="number" id="pr-nilai" value="${d.nilai}" /></div>
    </div>
    <div class="hint" id="pr-jenis-hint">${d.tipe === 'transaksi' ? 'Persen dari subtotal transaksi.' : 'Persen dari harga jual menu.'}</div>
    <div class="field-row">
      <div><label>Mulai</label><input type="date" id="pr-mulai" value="${d.tglMulai || ''}" /></div>
      <div><label>Selesai (kosongkan = selamanya)</label><input type="date" id="pr-selesai" value="${d.tglSelesai || ''}" /></div>
    </div>
    <label class="switch-row" style="margin-top:8px"><input type="checkbox" id="pr-aktif" ${d.aktif !== false ? 'checked' : ''} /><span>Aktif</span></label>
    <button class="btn btn-primary" data-save-promo="${d.id || ''}" style="margin-top:12px">Simpan Promo</button>
  `, 'promo-form');
}

async function savePromo() {
  const id = document.querySelector('[data-save-promo]')?.dataset.savePromo || '';
  const nama = document.getElementById('pr-nama').value.trim();
  if (!nama) { toast('Nama promo wajib diisi'); return; }
  const tipe = document.getElementById('pr-tipe').value;
  const jenis = document.getElementById('pr-jenis').value;
  const nilai = numOnly(document.getElementById('pr-nilai').value);
  const data = {
    nama, tipe, jenis, nilai,
    tglMulai: document.getElementById('pr-mulai').value || '',
    tglSelesai: document.getElementById('pr-selesai').value || '',
    menuId: tipe === 'menu' ? document.getElementById('pr-menu').value : '',
    aktif: document.getElementById('pr-aktif').checked
  };
  if (id) await Store.update('Promo', id, data);
  else await Store.insert('Promo', data);
  closeSheet();
  toast('Promo disimpan ✓');
  render();
}

function updatePromoHint() {
  const el = document.getElementById('pr-jenis-hint');
  if (!el) return;
  const tipe = document.getElementById('pr-tipe')?.value;
  el.textContent = tipe === 'transaksi'
    ? 'Persen/rupiah dipotong dari subtotal seluruh transaksi.'
    : 'Persen/rupiah dipotong dari harga jual menu tersebut (hanya harga saran).';
}

// Nomor invoice berurutan per tanggal: INV-YYYYMMDD-0001
function nextInvoiceNo() {
  const tgl = todayStr().replace(/-/g, '');
  const jml = Store.get('Penjualan').filter(p => (p.tanggal || '').replace(/-/g, '') === tgl).length + 1;
  return 'INV-' + tgl + '-' + String(jml).padStart(4, '0');
}

function filterByPeriode(list, tanggalField, periode) {
  const now = new Date();
  return list.filter(r => {
    if (!r[tanggalField]) return false;
    const d = new Date(r[tanggalField] + 'T00:00:00');
    if (periode === 'hari') return r[tanggalField] === todayStr();
    if (periode === 'bulan') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    return true; // semua
  });
}

// ============ RENDER SHELL ============
function render() {
  $app.innerHTML = `
    ${renderTopbar()}
    <div class="page" id="page-content">${renderPage()}</div>
    ${renderBottomNav()}
  `;
}

function renderTopbar() {
  const modalTotal = Store.get('Modal').reduce((s, m) => s + Number(m.jumlah || 0), 0);
  const asetTotal = Store.get('Aset').reduce((s, a) => s + Number(a.total || 0), 0);
  const penjualanTotal = Store.get('Penjualan').reduce((s, p) => s + Number(p.total || 0), 0);
  const belanjaTotal = Store.get('BelanjaBahan').reduce((s, b) => s + Number(b.total || 0), 0);
  const kas = modalTotal + penjualanTotal - belanjaTotal - asetTotal;
  const pending = Store.pendingCount();
  return `
    <div class="topbar">
      <h1><span class="dot"></span>Cafeku ${pending ? `<span style="margin-left:auto;font-size:10px;opacity:.7;font-weight:500">⏳ ${pending} menunggu sinkronisasi</span>` : ''}</h1>      <div class="stats">
        <div class="stat"><div class="label">Estimasi Kas</div><div class="value">${rupiah(kas)}</div></div>
        <div class="stat"><div class="label">Omzet Hari Ini</div><div class="value">${rupiah(omzetHariIni())}</div></div>
      </div>
    </div>
  `;
}

function omzetHariIni() {
  return Store.get('Penjualan').filter(p => p.tanggal === todayStr()).reduce((s, p) => s + Number(p.total || 0), 0);
}

const FA_ICON = {
  receipt: 'fa-receipt',
  coffee: 'fa-mug-hot',
  package: 'fa-box-open',
  chart: 'fa-chart-simple',
  more: 'fa-ellipsis',
  plus: 'fa-plus',
  search: 'fa-magnifying-glass',
  edit: 'fa-pen-to-square',
  trash: 'fa-trash',
  file: 'fa-file-lines',
  printer: 'fa-print',
  sync: 'fa-arrows-rotate',
  times: 'fa-xmark',
  plus: 'fa-plus',
  minus: 'fa-minus',
  trash: 'fa-trash',
  print: 'fa-print',
  sync: 'fa-arrows-rotate',
  creditCard: 'fa-credit-card',
  money: 'fa-money-bill-wave',
  arrowLeft: 'fa-arrow-left',
  arrowRight: 'fa-arrow-right',
  check: 'fa-check',
  timesCircle: 'fa-circle-xmark',
  checkCircle: 'fa-circle-check',
  exclamationTriangle: 'fa-triangle-exclamation',
  infoCircle: 'fa-circle-info',
  coffee: 'fa-mug-hot',
  box: 'fa-box',
  chart: 'fa-chart-line',
  more: 'fa-ellipsis-h',
  receipt: 'fa-receipt',
  plusCircle: 'fa-circle-plus',
  minusCircle: 'fa-circle-minus',
  times: 'fa-xmark'
};

function fa(name, cls = 'ic') {
  return `<i class="fa-solid ${FA_ICON[name]} ${cls}"></i>`;
}

function renderBottomNav() {
  const items = [
    ['kasir', 'receipt', 'Kasir'],
    ['menu', 'coffee', 'Menu'],
    ['stok', 'box', 'Stok'],
    ['laporan', 'chart', 'Laporan'],
    ['lainnya', 'more', 'Lainnya']
  ];
  return `<div class="bottomnav">
    ${items.map(([key, ic, label]) => `
      <button data-nav="${key}" class="${state.page === key ? 'active' : ''}">
        <span class="ic">${fa(ic)}</span>${label}
      </button>`).join('')}
  </div>`;
}

function renderPage() {
  if (state.page === 'kasir') return renderKasir();
  if (state.page === 'menu') return renderMenuPage();
  if (state.page === 'stok') return renderStokPage();
  if (state.page === 'laporan') return renderLaporanPage();
  if (state.page === 'lainnya') return renderLainnyaPage();
  return '';
}

// =========================================================
// HALAMAN 1: KASIR (POS)
// =========================================================
function renderKasir() {
  const menus = getMenuList().filter(m => m.aktif !== false);
  const kategoris = ['Semua', ...new Set(menus.map(m => m.kategori).filter(Boolean))];
  const filtered0 = state.menuKategoriFilter === 'Semua' ? menus : menus.filter(m => m.kategori === state.menuKategoriFilter);
  const filtered = state.cartSearch ? filtered0.filter(m => (m.nama + ' ' + (m.kategori || '')).toLowerCase().includes(state.cartSearch.toLowerCase())) : filtered0;
  const settings = getSettings();

  return `
    <div class="search-bar-wrap">
      <input id="cart-search" class="search-bar" type="search" value="${escapeAttr(state.cartSearch)}" placeholder="Cari menu…" enterkeyhint="search" />
    </div>
    <div class="chips">
      ${kategoris.map(k => `<div class="chip ${state.menuKategoriFilter === k ? 'active' : ''}" data-kategori-filter="${k}">${k}</div>`).join('')}
    </div>

    <div class="section-title">Pilih Menu</div>
    ${filtered.length === 0 ? `<div class="empty">☕<div class="big-icon"></div>Belum ada menu. Tambah dulu di tab Menu.</div>` : `
    <div class="card" style="padding:6px 14px">
      ${filtered.map(m => {
        const hpp = hitungHpp(m, getBahanList());
        const saran = m.hargaJualManual || hitungHargaSaran(hpp, m.marginPercent ?? settings.defaultMarginPercent, adminPercentFor(state.platform));
        const efektif = hargaJualEfektif(m, saran);
        const adaDiskon = efektif < saran;
        return `
        <div class="item-line" data-pick-menu="${m.id}" style="cursor:pointer">
          <div>
            <div class="name">${escapeHtml(m.nama)}${adaDiskon ? ' <span class="badge low">PROMO</span>' : ''}</div>
            <div class="sub">${m.kategori || ''} · HPP ${rupiah(hpp)}</div>
          </div>
          <div class="amt">${adaDiskon ? `<span class="coret">${rupiah(Math.round(saran))}</span> <b>${rupiah(Math.round(efektif))}</b>` : rupiah(Math.round(efektif))}</div>
        </div>`;
      }).join('')}
    </div>`}

    <div class="section-title" id="cart-title">Keranjang ${state.cart.length ? `(${state.cart.length})` : ''}</div>
    <div class="card" id="cart-container">${renderCartInner()}</div>
  `;
}

function renderCartInner() {
  if (!state.cart.length) {
    return `<div class="empty" style="padding:16px">Keranjang masih kosong. Tap menu di atas untuk menambah.</div>`;
  }
  const cartTotalJual = state.cart.reduce((s, c) => s + c.hargaJual * c.qty, 0);
  const cartTotalHpp = state.cart.reduce((s, c) => s + c.hpp * c.qty, 0);
  const cartDiskon = diskonTransaksi(cartTotalJual);
  const grandTotal = cartTotalJual - cartDiskon + Number(state.adjustment || 0);
  return `
    ${state.cart.map((c, i) => {
    const diskonItem = (c.hargaNormal || c.hargaJual) - c.hargaJual;
    const adaDiskonItem = diskonItem > 0;
    return `
      <div class="cart-item">
        <div class="ci-left">
          <div class="ci-name">${escapeHtml(c.nama)}</div>
          <div class="ci-qty">
            <button data-cart-dec="${i}" class="q-ctrl">−</button>
            <span class="qn">${c.qty}</span>
            <button data-cart-inc="${i}" class="q-ctrl">+</button>
            <span class="ci-sub">${c.qty}× ${rupiah(Math.round(c.hargaJual))}</span>
          </div>
        </div>
        <div class="ci-right">
          ${adaDiskonItem ? `<span class="ci-coret">${rupiah(Math.round(c.hargaNormal))}</span>` : ''}
          <span class="ci-price">${rupiah(Math.round(c.hargaJual))}</span>
          <button data-cart-remove="${i}" class="ci-delete" title="Hapus">✕</button>
        </div>
      </div>`;
  }).join('')}
    <hr class="receipt-divider" />
    <div class="row"><span class="k">Subtotal</span><span class="v">${rupiah(cartTotalJual)}</span></div>
    ${diskonTransaksi(cartTotalJual) ? `<div class="row"><span class="k">Diskon Promo</span><span class="v negative">−${rupiah(diskonTransaksi(cartTotalJual))}</span></div>` : ''}
    <div>
      <label>Penyesuaian (promo/biaya iklan, boleh minus)</label>
      <input type="number" id="input-adjustment" value="${state.adjustment}" placeholder="mis. -5000 untuk potongan" />
      <div class="hint">Isi minus kalau ada potongan promo/biaya iklan platform, isi plus kalau ada tambahan biaya lain.</div>
    </div>
    <div>
      <label>Platform</label>
      <select id="input-platform">
        ${getSettings().platforms.map(p => `<option value="${p.nama}" ${state.platform === p.nama ? 'selected' : ''}>${p.nama}${p.adminPercent ? ` (admin ${p.adminPercent}%)` : ''}</option>`).join('')}
      </select>
    </div>
    <div class="row" style="margin-top:6px"><span class="k">Total Diterima</span><span class="v big" id="ct-total">${rupiah(grandTotal)}</span></div>
    <div class="row"><span class="k">Estimasi Laba</span><span class="v ${grandTotal - cartTotalHpp >= 0 ? 'positive' : 'negative'}" id="ct-laba">${rupiah(grandTotal - cartTotalHpp)}</span></div>
    <button class="btn btn-primary" id="btn-checkout" style="margin-top:10px" ${state.checkingOut ? 'disabled' : ''}>${state.checkingOut ? 'Menunggu Pembayaran…' : 'Selesaikan Transaksi'}</button>
  `;
}

function renderCartRegion() {
  const container = document.getElementById('cart-container');
  if (container) container.innerHTML = renderCartInner();
  const title = document.getElementById('cart-title');
  if (title) title.textContent = `Keranjang${state.cart.length ? ` (${state.cart.length})` : ''}`;
}

function adminPercentFor(platformName) {
  const s = getSettings();
  const p = s.platforms.find(x => x.nama === platformName);
  return p ? p.adminPercent : 0;
}

function addToCart(menuId) {
  const menu = getMenuList().find(m => m.id === menuId);
  if (!menu) return;
  const hpp = hitungHpp(menu, getBahanList());
  const settings = getSettings();
  const hargaNormal = menu.hargaJualManual || hitungHargaSaran(hpp, menu.marginPercent ?? settings.defaultMarginPercent, adminPercentFor(state.platform));
  const hargaJual = hargaJualEfektif(menu, hargaNormal);
  const existing = state.cart.find(c => c.menuId === menuId);
  if (existing) { existing.qty += 1; }
  else { state.cart.push({ menuId, nama: menu.nama, qty: 1, hargaJual: Math.round(hargaJual), hargaNormal: Math.round(hargaNormal), hpp }); }
  renderCartRegion();
}

async function checkout() {
  if (!state.cart.length) return;
  if (state.checkingOut) return; // cegah double checkout
  state.checkingOut = true;
  const totalJual = state.cart.reduce((s, c) => s + c.hargaJual * c.qty, 0);
  const totalHpp = state.cart.reduce((s, c) => s + c.hpp * c.qty, 0);
  const diskon = diskonTransaksi(totalJual);
  const total = totalJual - diskon + Number(state.adjustment || 0);

  // Kurangi stok bahan sesuai resep tiap menu yang terjual
  const bahanList = getBahanList();
  const menuList = getMenuList();
  const deduction = {}; // bahanId -> total qty terpakai
  state.cart.forEach(item => {
    const menu = menuList.find(m => m.id === item.menuId);
    if (menu && menu.resep) {
      menu.resep.forEach(r => {
        deduction[r.bahanId] = (deduction[r.bahanId] || 0) + Number(r.qty) * item.qty;
      });
    }
  });
  const patches = Object.keys(deduction).map(bahanId => {
    const bahan = bahanList.find(b => b.id === bahanId);
    const stokSekarang = Number((bahan && bahan.stok) || 0);
    const stokBaru = Math.max(0, stokSekarang - deduction[bahanId]);
    return { id: bahanId, patch: { stok: stokBaru } };
  });

  // Validasi stok cukup SEBELUM transaksi disimpan
  const kurang = Object.keys(deduction).filter(bahanId => {
    const bahan = bahanList.find(b => b.id === bahanId);
    return Number((bahan && bahan.stok) || 0) - deduction[bahanId] < 0;
  });
  if (kurang.length) {
    const nama = kurang.map(id => (bahanList.find(b => b.id === id) || {}).nama || id).join(', ');
    toast('Stok tidak cukup: ' + nama);
    return;
  }

  if (patches.length) await Store.batchUpdate('Bahan', patches);
  state.lastDeduction = deduction; // simpan untuk rollback bila dibatalkan

  // Stage transaksi (belum insert) — masih bisa ditambah/kurangi keranjang
  const transaksi = {
    id: uid(),
    noInvoice: nextInvoiceNo(),
    tanggal: todayStr(),
    waktu: nowTimeStr(),
    platform: state.platform,
    items: state.cart.map(c => ({ menuId: c.menuId, nama: c.nama, qty: c.qty, hargaJual: c.hargaJual, hpp: c.hpp })),
    subtotal: totalJual,
    diskon,
    adjustment: Number(state.adjustment || 0),
    total,
    totalHpp,
    laba: total - totalHpp,
    catatan: state.catatan
  };
  // simpan snapshot keranjang agar bisa ditambah lagi bila perlu
  state.stagedCart = state.cart.slice();
  state.stagedTrx = transaksi;
  toast('Transaksi siap dibayar');
  render();
  state.lastTrx = transaksi;
  openPaymentSheet(transaksi);
}

// ===== Pembayaran & cetak struk (mobile-friendly, tanpa prompt/confirm) =====
let payStr = '';
function openPaymentSheet(trx) {
  const total = Number(trx.total || 0);
  payStr = String(total);
  const html = `
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>Pembayaran</h2><button class="btn-icon" data-close-pay>✕</button></div>
    <div class="row"><span class="k">Total Tagihan</span><span class="v big" id="pay-total">${rupiah(total)}</span></div>
    <label>Uang Diterima</label>
    <div class="pay-display" id="pay-display">${rupiah(payValue())}</div>
    <div class="pay-quick">
      <button class="pay-key" data-pay-amount="50000">50k</button>
      <button class="pay-key" data-pay-amount="100000">100k</button>
      <button class="pay-key" data-pay-amount="150000">150k</button>
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
    </div>`;
  openSheet(html, 'pay');
  renderPay();
}

function payValue() { return parseInt(payStr.replace(/[^\d]/g, ''), 10) || 0; }

function renderPay() {
  const total = Number((state.lastTrx || {}).total) || 0;
  const disp = document.getElementById('pay-display');
  if (disp) disp.textContent = rupiah(payValue());
  const el = document.getElementById('pay-kembali');
  if (!el) return;
  const kemb = payValue() - total;
  if (kemb < 0) el.textContent = 'Uang kurang: ' + rupiah(-kemb);
  else el.textContent = 'Kembalian: ' + rupiah(kemb) + (kemb === 0 ? ' (pas)' : '');
}

async function doPay() {
  const trx = state.stagedTrx;
  if (!trx) return;
  const total = Number(trx.total || 0);
  const bayar = payValue() > 0 ? payValue() : total;
  closeSheet();
  
  // Finalisasi: insert ke sheet
  await Store.insert('Penjualan', trx);
  state.lastTrx = trx;
  localStorage.setItem('cafeku_pending_trx', JSON.stringify(trx));
  Store._flush();
  
  // Clear staging
  state.stagedTrx = null;
  state.stagedCart = null;
  state.lastDeduction = null;
  state.cart = [];
  state.adjustment = 0;
  state.catatan = '';
  
  toast('Transaksi selesai ✓');
  render();
  if (getPrintPref().on) printReceipt(trx, bayar);
  else toast('Transaksi selesai ✓');
}

function closePayment() {
  // Rollback stok jika dibatalkan
  if (state.lastDeduction && state.stagedCart) {
    const bahanList = getBahanList();
    const patches = Object.keys(state.lastDeduction).map(bahanId => {
      const bahan = bahanList.find(b => b.id === bahanId);
      if (!bahan) return null;
      const qtyDikurangi = state.lastDeduction[bahanId];
      const stokSekarang = Number((bahan && bahan.stok) || 0);
      const stokBaru = stokSekarang + qtyDikurangi; // rollback: tambah kembali
      return { id: bahanId, patch: { stok: stokBaru } };
    }).filter(Boolean);
    if (patches.length) Store.batchUpdate('Bahan', patches);
  }
  state.stagedTrx = null;
  state.stagedCart = null;
  state.lastDeduction = null;
  state.lastTrx = null;
  state.checkingOut = false;
  closeSheet();
  render();
}

function printReceipt(trx, bayar) {
  const pref = getPrintPref();

  // JALUR A: Cetak langsung via printer Bluetooth (tanpa dialog) bila aktif & terkoneksi
  if (pref.mode === 'ble' && isBleSupported() && isPrinterConnected()) {
    printReceiptBLE(trx, bayar).then(ok => {
      if (!ok) printDialog(trx, bayar);
    });
    return;
  }
  // JALUR C: window.print() (default & fallback paling stabil)
  printDialog(trx, bayar);
}

async function printReceiptBLE(trx, bayar) {
  try {
    await printBytes(buildEscPos(trx, bayar));
    toast('Struk terkirim ke printer ✓');
    return true;
  } catch (err) {
    toast('Printer gagal: ' + err.message);
    return false;
  }
}

function printDialog(trx, bayar, text) {
  const setting = getSettings();
  const shopName = (setting.namaToko || 'Cafeku').replace(/</g, '&lt;');
  const kembalian = Number(bayar || 0) - Number(trx.total || 0);
  const itemRows = (trx.items || []).map(it => `
    <div class="pr-item">
      <div class="pr-name">${escapeHtml(it.nama)}</div>
      <div class="pr-sub">${it.qty} × ${rupiah(it.hargaJual)}</div>
      <div class="pr-amt">${rupiah(it.hargaJual * it.qty)}</div>
    </div>`).join('');

  const html = `
    <div class="pr-center"><b>${shopName}</b></div>
    <div class="pr-center">STRUK KASIR</div>
    <div class="pr-center">${escapeHtml(trx.noInvoice || '')}</div>
    <div class="pr-row"><span>Tanggal</span><span>${formatTanggal(trx.tanggal)}</span></div>
    <div class="pr-row"><span>Jam</span><span>${trx.waktu}</span></div>
    <div class="pr-row"><span>Platform</span><span>${escapeHtml(trx.platform || 'Offline')}</span></div>
    <div class="pr-divider"></div>
    ${itemRows}
    <div class="pr-divider"></div>
    <div class="pr-row"><span>Subtotal</span><span>${rupiah(trx.subtotal)}</span></div>
    ${Number(trx.diskon) ? `<div class="pr-row"><span>Diskon</span><span>−${rupiah(trx.diskon)}</span></div>` : ''}
    ${Number(trx.adjustment) ? `<div class="pr-row"><span>Penyesuaian</span><span>${rupiah(trx.adjustment)}</span></div>` : ''}
    <div class="pr-row pr-big"><span><b>TOTAL</b></span><span><b>${rupiah(trx.total)}</b></span></div>
    <div class="pr-row"><span>Dibayar</span><span>${rupiah(bayar)}</span></div>
    <div class="pr-row"><span>Kembalian</span><span>${kembalian >= 0 ? rupiah(kembalian) : 'KURANG ' + rupiah(-kembalian)}</span></div>
    <div class="pr-center pr-foot">Terima kasih, sampai jumpa!</div>`;

  let p = document.getElementById('print-receipt');
  if (!p) { p = document.createElement('div'); p.id = 'print-receipt'; document.body.appendChild(p); }
  p.innerHTML = html;
  window.print();
}

// Struk sebagai teks untuk jalur share (Opsi B)
function strukText(trx, bayar) {
  const rup = n => 'Rp' + (Math.round(Number(n) || 0)).toLocaleString('id-ID');
  const shop = (trx.namaToko || 'CAFEKU').toUpperCase();
  const W = 32;
  const ln = '='.repeat(W);
  const lines = [];
  lines.push(shop, 'STRUK KASIR', trx.platform || 'OFFLINE', ln);
  (trx.items || []).forEach(it => {
    lines.push((it.nama || '').toUpperCase());
    const left = '  ' + it.qty + ' x ' + rup(it.hargaJual);
    lines.push(left.padEnd(Math.max(0, W - String(rup(it.hargaJual * it.qty)).length)) + rup(it.hargaJual * it.qty));
  });
  lines.push(ln);
  lines.push('Subtotal'.padEnd(W - String(rup(trx.subtotal)).length) + rup(trx.subtotal));
  if (Number(trx.adjustment)) lines.push('Penyesuaian'.padEnd(W - String(rup(trx.adjustment)).length) + rup(trx.adjustment));
  lines.push('TOTAL'.padEnd(W - String(rup(trx.total)).length) + rup(trx.total));
  lines.push('Dibayar'.padEnd(W - String(rup(bayar)).length) + rup(bayar));
  const kemb = Number(bayar) - Number(trx.total);
  lines.push((kemb >= 0 ? 'Kembalian' : 'KURANG').padEnd(W - String(rup(Math.abs(kemb))).length) + rup(Math.abs(kemb)));
  lines.push(ln, 'TERIMA KASIH', 'Sampai jumpa!');
  return lines.join('\n');
}

// =========================================================
// HALAMAN 2: MENU & RESEP (HPP)
// =========================================================
function renderMenuPage() {
  const menus = getMenuList();
  const settings = getSettings();
  return `
    <div class="row" style="margin-bottom:4px">
      <div class="section-title" style="margin:0">Daftar Menu</div>
      <button class="btn btn-primary btn-sm" data-open="menu-form">+ Menu Baru</button>
    </div>
    ${menus.length === 0 ? `<div class="empty">Belum ada menu. Tambahkan menu pertamamu, lengkap dengan resep supaya HPP terhitung otomatis.</div>` : menus.map(m => {
      const hpp = hitungHpp(m, getBahanList());
      const saran = hitungHargaSaran(hpp, m.marginPercent ?? settings.defaultMarginPercent, 0);
      return `
      <div class="card">
        <div class="row" style="padding:0 0 6px">
          <span style="font-weight:700;font-size:15px">${escapeHtml(m.nama)}</span>
          <span class="badge ok">${m.kategori || 'Umum'}</span>
        </div>
        <div class="row"><span class="k">HPP (modal bahan)</span><span class="v">${rupiah(hpp)}</span></div>
        <div class="row"><span class="k">Margin</span><span class="v">${m.marginPercent ?? settings.defaultMarginPercent}%</span></div>
        <div class="row"><span class="k">Harga Jual Saran</span><span class="v positive big">${rupiah(saran)}</span></div>
        ${m.hargaJualManual ? `<div class="row"><span class="k">Harga Ditetapkan</span><span class="v">${rupiah(m.hargaJualManual)}</span></div>` : ''}
        <div class="row" style="gap:8px;margin-top:8px">
          <button class="btn btn-ghost btn-sm" data-edit-menu="${m.id}">Edit</button>
          <button class="btn btn-danger btn-sm" data-delete-menu="${m.id}">Hapus</button>
        </div>
      </div>`;
    }).join('')}
  `;
}

function newResepRow() { return { bahanId: '', qty: '' }; }

function openMenuForm(menuId) {
  const existing = menuId ? getMenuList().find(m => m.id === menuId) : null;
  state.menuFormDraft = existing ? JSON.parse(JSON.stringify(existing)) : {
    id: null, nama: '', kategori: '', resep: [newResepRow()],
    marginPercent: getSettings().defaultMarginPercent, hargaJualManual: '', aktif: true
  };
  openSheet(renderMenuFormSheet(), 'menu-form');
}

function renderMenuFormSheet() {
  const d = state.menuFormDraft;
  const bahanList = getBahanList();
  const hpp = d.resep.reduce((s, r) => {
    const b = bahanList.find(x => x.id === r.bahanId);
    return s + (b ? Number(b.hargaAvco ?? b.hargaTerakhir ?? 0) : 0) * Number(r.qty || 0);
  }, 0);
  const settings = getSettings();
  const saranOffline = hitungHargaSaran(hpp, d.marginPercent, 0);
  const saranOnline = hitungHargaSaran(hpp, d.marginPercent, settings.platforms.find(p => p.nama !== 'Offline')?.adminPercent || 0);

  return `
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>${d.id ? 'Edit Menu' : 'Menu Baru'}</h2><button class="btn-icon" data-close-sheet>✕</button></div>

    <label>Nama Menu</label>
    <input id="mf-nama" value="${escapeAttr(d.nama)}" placeholder="Kopi Susu Gula Aren" />

    <label>Kategori</label>
    <input id="mf-kategori" value="${escapeAttr(d.kategori)}" placeholder="Kopi / Non-Kopi / Snack" />

    <div class="section-title" style="margin-top:16px">Resep (Bahan Terpakai)</div>
    ${d.resep.map((r, i) => `
      <div class="field-row" style="margin-bottom:6px;align-items:flex-end">
        <div style="flex:2">
          <label>Bahan</label>
          <select data-resep-bahan="${i}">
            <option value="">— pilih —</option>
            ${bahanList.map(b => `<option value="${b.id}" ${r.bahanId === b.id ? 'selected' : ''}>${escapeHtml(b.nama)} (${b.satuan})</option>`).join('')}
          </select>
        </div>
        <div style="flex:1">
          <label>Qty</label>
          <input type="number" step="0.01" data-resep-qty="${i}" value="${r.qty}" />
        </div>
        <button class="btn-icon" data-resep-remove="${i}" style="margin-bottom:2px">✕</button>
      </div>
    `).join('')}
    <button class="btn btn-ghost btn-sm" data-resep-add>+ Tambah Bahan</button>

    <div class="section-title" style="margin-top:16px">Harga</div>
    <div class="card">
      <div class="row"><span class="k">HPP Otomatis</span><span class="v big" id="mf-hpp">${rupiah(hpp)}</span></div>
      <label>Margin (% dari HPP)</label>
      <input type="number" id="mf-margin" value="${d.marginPercent}" />
      <div class="hint">
        Saran harga Offline: <b id="mf-saran-offline">${rupiah(saranOffline)}</b> · Saran harga Online (dengan admin platform): <b id="mf-saran-online">${rupiah(saranOnline)}</b>
      </div>
      <label>Harga Jual Tetap (opsional, kosongkan untuk pakai saran otomatis)</label>
      <input type="number" id="mf-harga-manual" value="${d.hargaJualManual || ''}" placeholder="mis. 18000" />
    </div>

    <button class="btn btn-primary" data-save-menu style="margin-top:14px">Simpan Menu</button>
  `;
}

// =========================================================
// HALAMAN 3: STOK BAHAN + BELANJA BAHAN
// =========================================================
function renderStokPage() {
  const bahanList = getBahanList();
  return `
    <div class="row" style="margin-bottom:4px">
      <div class="section-title" style="margin:0">Stok Bahan</div>
      <button class="btn btn-primary btn-sm" data-open="belanja-form">+ Belanja Bahan</button>
    </div>
    ${bahanList.length === 0 ? `<div class="empty">Belum ada data bahan. Catat belanja bahan pertamamu untuk mulai tracking stok.</div>` : `
    <div class="card" style="padding:6px 14px">
      ${bahanList.map(b => {
        const min = Number(b.stokMinimum || 0);
        const low = Number(b.stok || 0) <= min;
        const avco = Number(b.hargaAvco ?? b.hargaTerakhir ?? 0);
        return `
        <div class="item-line">
          <div>
            <div class="name">${escapeHtml(b.nama)} <span class="badge ${low ? 'low' : 'ok'}">${low ? 'Stok Menipis' : 'Aman'}</span></div>
            <div class="sub">Rata-rata (AVCO) ${rupiah(avco)} / ${b.satuan}</div>
          </div>
          <div style="text-align:right">
            <div class="amt">${b.stok} ${b.satuan}</div>
            <button class="btn btn-ghost btn-sm" style="margin-top:4px" data-edit-bahan="${b.id}">Edit</button>
          </div>
        </div>`;
      }).join('')}
    </div>`}

    <div class="section-title">Riwayat Belanja Bahan</div>
    ${Store.get('BelanjaBahan').slice().reverse().slice(0, 20).map(b => {
      const totalHarga = b.hargaBeliTotal ?? b.total ?? 0;
      const totalMasuk = b.totalMasuk ?? b.qty ?? 0;
      const hargaPerSatuan = b.hargaPerSatuan ?? b.hargaSatuan ?? 0;
      return `
      <div class="card">
        <div class="row"><span class="k">${formatTanggal(b.tanggal)}${b.kemasanNama ? ' · ' + escapeHtml(b.kemasanNama) : ''}</span><span class="v">${rupiah(totalHarga)}</span></div>
        <div class="row"><span class="k">${escapeHtml(b.bahanNama)}${b.qtyKemasan ? ` (${b.qtyKemasan} kemasan)` : ''}</span><span class="v" style="font-size:12px">${totalMasuk} ${b.satuan} · ${rupiah(hargaPerSatuan)}/${b.satuan}</span></div>
        ${b.avcoSesudah !== undefined ? `<div class="hint">AVCO diperbarui jadi ${rupiah(b.avcoSesudah)} / ${b.satuan}</div>` : ''}
      </div>`;
    }).join('') || `<div class="empty">Belum ada riwayat belanja.</div>`}
  `;
}

function openBelanjaForm() {
  openSheet(renderBelanjaFormSheet(), 'belanja-form');
  updateBelanjaPreview();
}
function renderBelanjaFormSheet() {
  const bahanList = getBahanList();
  return `
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>Belanja Bahan</h2><button class="btn-icon" data-close-sheet>✕</button></div>

    <label>Tanggal</label>
    <input type="date" id="bf-tanggal" value="${todayStr()}" />

    <label>Bahan</label>
    <select id="bf-bahan-select">
      <option value="__new__">+ Bahan baru...</option>
      ${bahanList.map(b => `<option value="${b.id}">${escapeHtml(b.nama)} (${b.satuan})</option>`).join('')}
    </select>

    <div id="bf-new-bahan-wrap">
      <label>Nama Bahan Baru</label>
      <input id="bf-nama-baru" placeholder="Susu UHT" />
      <label>Satuan Dasar (satuan terkecil yang dipakai di resep)</label>
      <input id="bf-satuan-dasar" placeholder="ml, gram, pcs" />
      <div class="hint">Contoh: resep pakai "ml", isi "ml" di sini walau kamu belinya per liter/botol — konversinya diatur di bawah.</div>
    </div>

    <div class="section-title" style="margin-top:16px">Rincian Pembelian</div>
    <div class="hint" style="margin-bottom:6px">Isi sesuai kemasan yang kamu beli. Sistem otomatis menghitung harga per satuan resep + memperbarui harga rata-rata (AVCO).</div>

    <label>Nama Kemasan (opsional, buat catatan)</label>
    <input id="bf-kemasan-nama" placeholder="Botol 1 Liter" />

    <div class="field-row">
      <div>
        <label>Isi per Kemasan</label>
        <input type="number" step="0.01" id="bf-isi-kemasan" placeholder="1000" value="1" />
      </div>
      <div>
        <label>Jumlah Kemasan Dibeli</label>
        <input type="number" step="0.01" id="bf-qty-kemasan" placeholder="1" />
      </div>
    </div>
    <div class="hint" id="bf-satuan-dasar-hint">dalam satuan dasar bahan</div>

    <label>Total Harga Pembelian (semua kemasan)</label>
    <input type="number" id="bf-harga-total" placeholder="20000" />

    <label>Stok Minimum (opsional, khusus bahan baru)</label>
    <input type="number" id="bf-stok-min" placeholder="0" />

    <label>Supplier (opsional)</label>
    <input id="bf-supplier" placeholder="Toko Sumber Rejeki" />

    <div class="card" style="margin-top:10px">
      <div class="row"><span class="k">Total Masuk Stok</span><span class="v" id="bf-total-masuk-preview">0</span></div>
      <div class="row"><span class="k">Harga / Satuan Dasar</span><span class="v" id="bf-harga-satuan-preview">Rp0</span></div>
      <div class="row"><span class="k">Harga AVCO Setelah Ini</span><span class="v positive big" id="bf-avco-preview">Rp0</span></div>
    </div>

    <button class="btn btn-primary" data-save-belanja style="margin-top:10px">Simpan Belanja</button>
  `;
}

// Kalkulator live: hitung harga per satuan dasar + AVCO tanpa reload seluruh
// form (biar fokus input tidak hilang saat mengetik).
function updateBelanjaPreview() {
  const isi = numOnly(document.getElementById('bf-isi-kemasan')?.value) || 0;
  const qty = numOnly(document.getElementById('bf-qty-kemasan')?.value) || 0;
  const total = numOnly(document.getElementById('bf-harga-total')?.value) || 0;
  const totalMasuk = isi * qty;
  const hargaPerSatuan = totalMasuk > 0 ? total / totalMasuk : 0;

  const select = document.getElementById('bf-bahan-select');
  const bahanId = select ? select.value : '__new__';
  const bahan = bahanId && bahanId !== '__new__' ? getBahanList().find(b => b.id === bahanId) : null;
  const stokLama = bahan ? Number(bahan.stok || 0) : 0;
  const avcoLama = bahan ? Number(bahan.hargaAvco ?? bahan.hargaTerakhir ?? 0) : 0;
  const avcoBaru = hitungAvco(stokLama, avcoLama, totalMasuk, hargaPerSatuan);
  const satuanDasar = bahan ? bahan.satuan : (document.getElementById('bf-satuan-dasar')?.value.trim() || '');

  const elMasuk = document.getElementById('bf-total-masuk-preview');
  const elHarga = document.getElementById('bf-harga-satuan-preview');
  const elAvco = document.getElementById('bf-avco-preview');
  const elHint = document.getElementById('bf-satuan-dasar-hint');
  if (elMasuk) elMasuk.textContent = totalMasuk.toLocaleString('id-ID') + (satuanDasar ? ' ' + satuanDasar : '');
  if (elHarga) elHarga.textContent = rupiah(hargaPerSatuan) + (satuanDasar ? ' / ' + satuanDasar : '');
  if (elAvco) elAvco.textContent = rupiah(avcoBaru) + (satuanDasar ? ' / ' + satuanDasar : '') + (stokLama > 0 ? ` (sebelumnya ${rupiah(avcoLama)})` : ' (harga awal)');
  if (elHint) elHint.textContent = satuanDasar ? `dalam satuan dasar: ${satuanDasar}` : 'dalam satuan dasar bahan';
}

function editBahanPrompt(bahanId) {
  const b = getBahanList().find(x => x.id === bahanId);
  if (!b) return;
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>Edit Bahan</h2><button class="btn-icon" data-close-sheet>✕</button></div>
    <label>Nama</label>
    <input id="eb-nama" value="${escapeAttr(b.nama)}" />
    <div class="field-row">
      <div><label>Stok Saat Ini</label><input type="number" step="0.01" id="eb-stok" value="${b.stok}" /></div>
      <div><label>Satuan</label><input id="eb-satuan" value="${escapeAttr(b.satuan)}" /></div>
    </div>
    <label>Harga Rata-rata (AVCO) / Satuan</label>
    <input type="number" id="eb-harga" value="${b.hargaAvco ?? b.hargaTerakhir ?? 0}" />
    <div class="hint">Ubah manual di sini hanya kalau kamu tahu persis harga rata-rata yang benar — biasanya AVCO sudah otomatis terhitung tiap kali kamu catat belanja bahan.</div>
    <label>Stok Minimum</label>
    <input type="number" id="eb-min" value="${b.stokMinimum || 0}" />
    <button class="btn btn-primary" data-save-bahan="${b.id}" style="margin-top:10px">Simpan</button>
    <button class="btn btn-danger" data-delete-bahan="${b.id}" style="margin-top:8px">Hapus Bahan</button>
  `, 'edit-bahan');
}

// =========================================================
// HALAMAN 4: LAPORAN (Harian + Akuntansi)
// =========================================================
function renderLaporanPage() {
  return `
    <div class="chips">
      <div class="chip ${state.laporanTab === 'harian' ? 'active' : ''}" data-laporan-tab="harian">Penjualan Harian</div>
      <div class="chip ${state.laporanTab === 'akuntansi' ? 'active' : ''}" data-laporan-tab="akuntansi">Akuntansi Sederhana</div>
    </div>
    ${state.laporanTab === 'harian' ? renderLaporanHarian() : renderAkuntansi()}
  `;
}

function renderLaporanHarian() {
  const trx = Store.get('Penjualan').filter(p => p.tanggal === state.laporanTanggal);
  const totalOmzet = trx.reduce((s, t) => s + Number(t.total || 0), 0);
  const totalHpp = trx.reduce((s, t) => s + Number(t.totalHpp || 0), 0);
  const laba = totalOmzet - totalHpp;

  const perMenu = {};
  trx.forEach(t => (t.items || []).forEach(it => {
    perMenu[it.nama] = (perMenu[it.nama] || 0) + it.qty;
  }));
  const topMenu = Object.entries(perMenu).sort((a, b) => b[1] - a[1]);

  return `
    <label style="margin-top:12px">Pilih Tanggal</label>
    <input type="date" id="lap-tanggal" value="${state.laporanTanggal}" />
    <button class="btn btn-ghost btn-sm" style="margin-top:8px" data-open-riwayat>${fa("file")} Semua Riwayat Transaksi</button>
    <button class="btn btn-ghost btn-sm" style="margin-top:8px" data-export-csv>⬇️ Export CSV (tanggal ini)</button>

    <div class="card" style="margin-top:12px">
      <div class="row"><span class="k">Jumlah Transaksi</span><span class="v">${trx.length}</span></div>
      <div class="row"><span class="k">Total Omzet</span><span class="v big">${rupiah(totalOmzet)}</span></div>
      <div class="row"><span class="k">Total HPP Terjual</span><span class="v">${rupiah(totalHpp)}</span></div>
      <hr class="receipt-divider" />
      <div class="row"><span class="k">Laba Kotor</span><span class="v big ${laba >= 0 ? 'positive' : 'negative'}">${rupiah(laba)}</span></div>
    </div>

    ${topMenu.length ? `
    <div class="section-title">Menu Terlaris</div>
    <div class="card">
      ${topMenu.map(([nama, qty]) => `<div class="row"><span class="k">${escapeHtml(nama)}</span><span class="v">${qty} terjual</span></div>`).join('')}
    </div>` : ''}

    <div class="section-title">Detail Transaksi</div>
    ${trx.length === 0 ? `<div class="empty">Belum ada penjualan di tanggal ini.</div>` : trx.slice().reverse().map(t => `
      <div class="card">
        <div class="row"><span class="k">${t.waktu} · ${t.platform}</span><span class="v">${rupiah(t.total)}</span></div>
        ${(t.items || []).map(it => `<div class="row"><span class="k" style="font-size:12px">${it.qty}× ${escapeHtml(it.nama)}</span><span class="v" style="font-size:12px">${rupiah(it.hargaJual * it.qty)}</span></div>`).join('')}
        <button class="btn btn-ghost btn-sm" style="margin-top:8px" data-reprint="${t.id}">${fa("print")} Cetak Ulang Struk</button>
      </div>
    `).join('')}
  `;
}

// Semua riwayat transaksi (tidak dibatasi tanggal), urutan terbaru di atas
function openRiwayat() {
  const all = Store.get('Penjualan').slice().reverse();
  const totalOmzet = all.reduce((s, t) => s + Number(t.total || 0), 0);
  const list = all.length === 0
    ? `<div class="empty">Belum ada riwayat transaksi.</div>`
    : all.map(t => `
      <div class="card">
        <div class="row"><span class="k">${formatTanggal(t.tanggal)} ${t.waktu} · ${escapeHtml(t.platform || 'Offline')}</span><span class="v">${rupiah(t.total)}</span></div>
        ${(t.items || []).map(it => `<div class="row"><span class="k" style="font-size:12px">${it.qty}× ${escapeHtml(it.nama)}</span><span class="v" style="font-size:12px">${rupiah(it.hargaJual * it.qty)}</span></div>`).join('')}
        <button class="btn btn-ghost btn-sm" style="margin-top:8px" data-reprint="${t.id}">${fa("print")} Cetak Ulang Struk</button>
      </div>`).join('');
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>Riwayat Transaksi</h2><button class="btn-icon" data-close-sheet>✕</button></div>
    <div class="card" style="background:var(--warn-bg);border:none">
      <div class="row"><span class="k">Total Transaksi</span><span class="v">${all.length}</span></div>
      <div class="row"><span class="k">Total Omzet</span><span class="v big">${rupiah(totalOmzet)}</span></div>
    </div>
    ${list}
  `, 'riwayat');
}

function renderAkuntansi() {
  const periode = state.akuntansiPeriode;
  const modalAll = Store.get('Modal');
  const asetAll = Store.get('Aset');
  const belanjaAll = Store.get('BelanjaBahan');
  const penjualanAll = Store.get('Penjualan');

  const totalModal = modalAll.reduce((s, m) => s + Number(m.jumlah || 0), 0);
  const totalAset = asetAll.reduce((s, a) => s + Number(a.total || 0), 0);
  const totalBelanjaAll = belanjaAll.reduce((s, b) => s + Number(b.total || 0), 0);
  const totalPenjualanAll = penjualanAll.reduce((s, p) => s + Number(p.total || 0), 0);
  const kas = totalModal + totalPenjualanAll - totalBelanjaAll - totalAset;
  state.lastKasTeori = kas;

  const penjualanPeriode = filterByPeriode(penjualanAll, 'tanggal', periode);
  const omzetPeriode = penjualanPeriode.reduce((s, p) => s + Number(p.total || 0), 0);
  const hppPeriode = penjualanPeriode.reduce((s, p) => s + Number(p.totalHpp || 0), 0);
  const labaPeriode = omzetPeriode - hppPeriode;
  const belanjaPeriode = filterByPeriode(belanjaAll, 'tanggal', periode).reduce((s, b) => s + Number(b.total || 0), 0);

  return `
    <div class="section-title">Posisi Modal &amp; Aset (Akumulasi)</div>
    <div class="card">
      <div class="row"><span class="k">Total Modal Disetor</span><span class="v">${rupiah(totalModal)}</span></div>
      <div class="row"><span class="k">Total Nilai Aset</span><span class="v">${rupiah(totalAset)}</span></div>
      <div class="row"><span class="k">Total Belanja Bahan</span><span class="v">${rupiah(totalBelanjaAll)}</span></div>
      <div class="row"><span class="k">Total Penjualan</span><span class="v">${rupiah(totalPenjualanAll)}</span></div>
      <hr class="receipt-divider" />
      <div class="row"><span class="k">Estimasi Kas Saat Ini</span><span class="v big ${kas >= 0 ? 'positive' : 'negative'}">${rupiah(kas)}</span></div>
      <div class="hint">Kas = Modal + Penjualan − Belanja Bahan − Aset (perkiraan kas tunai, belum termasuk piutang/hutang).</div>
    </div>

    <div class="section-title">Opname Kas</div>
    <div class="card">
      <div class="row"><span class="k">Kas Teori</span><span class="v big">${rupiah(kas)}</span></div>
      <label>Kas Fisik (hasil hitung)</label>
      <input type="number" id="op-kas-fisik" value="${opnameKasFisik()}" placeholder="0" />
      <label>Keterangan (opsional)</label>
      <input id="op-ket" placeholder="mis. setoran hari ini" />
      <button class="btn btn-primary" data-save-opname style="margin-top:10px">Simpan Opname Kas</button>
      <div class="hint">Selisih = Kas Fisik − Kas Teori. Positif = lebih, negatif = kurang.</div>
      ${opnameRiwayat()}
    </div>

    <div class="section-title">Laba Rugi</div>
    <div class="chips">
      <div class="chip ${periode === 'hari' ? 'active' : ''}" data-periode="hari">Hari Ini</div>
      <div class="chip ${periode === 'bulan' ? 'active' : ''}" data-periode="bulan">Bulan Ini</div>
      <div class="chip ${periode === 'semua' ? 'active' : ''}" data-periode="semua">Semua</div>
    </div>
    <div class="card">
      <div class="row"><span class="k">Pendapatan (Omzet)</span><span class="v">${rupiah(omzetPeriode)}</span></div>
      <div class="row"><span class="k">Beban HPP Terjual</span><span class="v">${rupiah(hppPeriode)}</span></div>
      <hr class="receipt-divider" />
      <div class="row"><span class="k">Laba / Rugi Kotor</span><span class="v big ${labaPeriode >= 0 ? 'positive' : 'negative'}">${rupiah(labaPeriode)}</span></div>
      <div class="hint">Referensi: belanja bahan periode ini ${rupiah(belanjaPeriode)} (belum tentu semua terpakai jadi HPP terjual).</div>
    </div>
  `;
}

// =========================================================
// HALAMAN 5: LAINNYA (Modal, Aset, Pengaturan)
// =========================================================
function opnameKasFisik() {
  const rec = Store.get('Kas').find(k => k.tanggal === todayStr());
  return rec ? (rec.kasFisik || '') : '';
}
function opnameRiwayat() {
  const riw = Store.get('Kas').slice().reverse().slice(0, 10);
  if (!riw.length) return '<div class="hint" style="margin-top:10px">Belum ada opname.</div>';
  return `<div class="section-title" style="margin-top:12px">Riwayat Opname</div>` + riw.map(r => `
    <div class="row"><span class="k">${formatTanggal(r.tanggal)}</span>
    <span class="v" style="font-size:12px">${rupiah(r.kasFisik)} · selisih ${r.selisih >= 0 ? '+' + rupiah(r.selisih) : rupiah(r.selisih)}</span></div>`).join('');
}
async function saveOpname() {
  const kasTeori = Number(state.lastKasTeori);
  const kasFisik = numOnly(document.getElementById('op-kas-fisik')?.value);
  const ket = document.getElementById('op-ket')?.value.trim() || '';
  const selisih = kasFisik - kasTeori;
  const existing = Store.get('Kas').find(k => k.tanggal === todayStr());
  const data = { tanggal: todayStr(), kasTeori, kasFisik, selisih, keterangan: ket };
  if (existing) await Store.update('Kas', existing.id, data);
  else await Store.insert('Kas', data);
  closeSheet();
  toast('Opname kas disimpan ✓');
  render();
}
function renderLainnyaPage() {
  const modalList = Store.get('Modal').slice().reverse();
  const asetList = Store.get('Aset').slice().reverse();
  const settings = getSettings();

  return `
    <div class="row"><div class="section-title" style="margin:0">Modal Usaha</div><button class="btn btn-primary btn-sm" data-open="modal-form">+ Modal</button></div>
    ${modalList.length === 0 ? `<div class="empty">Belum ada catatan modal.</div>` : modalList.map(m => `
      <div class="card">
        <div class="row"><span class="k">${formatTanggal(m.tanggal)}</span><span class="v positive">${rupiah(m.jumlah)}</span></div>
        ${m.keterangan ? `<div class="hint">${escapeHtml(m.keterangan)}</div>` : ''}
      </div>
    `).join('')}

    <div class="row" style="margin-top:10px"><div class="section-title" style="margin:0">Aset / Peralatan</div><button class="btn btn-primary btn-sm" data-open="aset-form">+ Aset</button></div>
    ${asetList.length === 0 ? `<div class="empty">Belum ada catatan aset.</div>` : asetList.map(a => `
      <div class="card">
        <div class="row"><span class="k">${escapeHtml(a.nama)}</span><span class="v">${rupiah(a.total)}</span></div>
        <div class="hint">${formatTanggal(a.tanggal)} · ${a.qty} unit × ${rupiah(a.hargaSatuan)} ${a.kategori ? '· ' + escapeHtml(a.kategori) : ''}</div>
      </div>
    `).join('')}

    <div class="section-title" style="margin-top:10px">Data &amp; Keamanan</div>
    <div class="card">
      <button class="btn btn-ghost" data-open-restore>♻️ Pulihkan Item Terhapus</button>
      <button class="btn btn-ghost" style="margin-top:8px" data-backup>⬇️ Download Backup (JSON)</button>
      <button class="btn btn-ghost" style="margin-top:8px" id="btn-restore-import">⬆️ Import Backup</button>
    </div>

    <div class="section-title" style="margin-top:10px">Promo &amp; Diskon</div>
    <div class="card">
      <button class="btn btn-primary btn-sm" data-promo-new>+ Tambah Promo</button>
      ${renderPromoList()}
      <div class="hint">Promo berlaku otomatis di kasir sesuai rentang tanggal. Aturan: promo menu hanya untuk harga saran (menu dengan harga tetap diabaikan); bila beberapa promo transaksi aktif, dipakai yang terbesar.</div>
    </div>

    <div class="section-title" style="margin-top:10px">Pengaturan</div>
    <div class="card">
      <label>Margin Default (%)</label>
      <input type="number" id="set-margin" value="${settings.defaultMarginPercent}" />
      <label>Platform &amp; Admin Fee (%)</label>
      ${settings.platforms.map((p, i) => `
        <div class="field-row" style="margin-bottom:6px">
          <input data-platform-nama="${i}" value="${escapeAttr(p.nama)}" placeholder="Nama platform" />
          <input type="number" data-platform-admin="${i}" value="${p.adminPercent}" placeholder="% admin" style="max-width:90px" />
        </div>
      `).join('')}
      <button class="btn btn-ghost btn-sm" data-add-platform>+ Tambah Platform</button>
      <div class="toggle-row" style="margin-top:10px">
        <div><div class="toggle-title">Mode Gelap</div><div class="hint">Kurangi silau saat kafe gelap.</div></div>
        <label class="switch">
          <input type="checkbox" id="set-dark" data-dark-toggle ${getTheme() === 'dark' ? 'checked' : ''} />
          <span class="slider"></span>
        </label>
      </div>
      <button class="btn btn-primary" data-save-settings style="margin-top:12px">Simpan Pengaturan</button>
    </div>

    <div class="card" style="margin-top:10px">
      <button class="btn btn-ghost" id="btn-manual-sync">${fa("sync")} Sinkron Ulang Sekarang</button>
      <div class="hint" style="text-align:center;margin-top:6px">Data disimpan otomatis. Sinkron manual berguna kalau kamu buka di HP lain.</div>
    </div>

    <div class="section-title" style="margin-top:10px">Printer &amp; Struk</div>
    <div class="card">
      <div class="toggle-row">
        <div>
          <div class="toggle-title">Aktifkan Fitur Print</div>
          <div class="hint">Matikan bila kasir tanpa cetak struk — transaksi langsung selesai tanpa dialog/cek.</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="print-on" ${getPrintPref().on ? 'checked' : ''} />
          <span class="slider"></span>
        </label>
      </div>
      ${getPrintPref().on ? `
      <div class="row" style="margin-top:10px">
        <span class="k">Status Printer</span>
        <span class="v" id="printer-status">${isBleSupported() ? (isPrinterConnected() ? 'Terkoneksi: ' + getPrinterName() : 'Belum terkoneksi') : 'Web Bluetooth tidak didukung (butuh Android + Chrome)'}</span>
      </div>
      <div class="toggle-row" style="margin-top:6px">
        <div>
          <div class="toggle-title">Cetak Langsung (tanpa preview)</div>
          <div class="hint">Aktif: struk langsung terkirim ke printer Bluetooth saat Bayar, tanpa jendela preview. Nonaktif: muncul dialog print standar.</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="printer-auto" ${getPrintPref().mode === 'ble' ? 'checked' : ''} ${!isBleSupported() ? 'disabled' : ''} />
          <span class="slider"></span>
        </label>
      </div>
      <div class="row" style="gap:8px;margin-top:10px">
        <button class="btn btn-ghost" id="btn-printer-connect">${isPrinterConnected() ? 'Putus Koneksi' : 'Konek Printer'}</button>
        <button class="btn btn-primary" id="btn-printer-test">Test Print</button>
      </div>
      ` : ''}
    </div>
  `;
}

function openRestore() {
  const deletedMenu = Store.getWithDeleted('Menu').filter(m => m.deleted);
  const deletedBahan = Store.getWithDeleted('Bahan').filter(b => b.deleted);
  const blok = (label, list, sheet) => list.length === 0
    ? `<div class="hint">Tidak ada ${label} terhapus.</div>`
    : list.map(x => `
      <div class="card">
        <div class="row"><span class="k">${escapeHtml(x.nama || x.id)}</span><button class="btn btn-ghost btn-sm" data-restore="${sheet}|${x.id}">Pulihkan</button></div>
        <div class="hint">Dihapus: ${x.deletedAt ? formatTanggal(x.deletedAt.slice(0,10)) : '-'}</div>
      </div>`).join('');
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>Pulihkan Item Terhapus</h2><button class="btn-icon" data-close-sheet>✕</button></div>
    <div class="section-title" style="margin-top:0">Menu</div>
    ${blok('menu', deletedMenu, 'Menu')}
    <div class="section-title">Bahan</div>
    ${blok('bahan', deletedBahan, 'Bahan')}
  `, 'restore');
}

function downloadBackup() {
  const data = {};
  OBJECT_SHEETS.forEach(s => { data[s] = Store.getWithDeleted(s); });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cafeku-backup-' + todayStr() + '.json';
  a.click();
  URL.revokeObjectURL(url);
  toast('Backup diunduh ✓');
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object') throw new Error('format salah');
    const count = Object.keys(data).length;
    Object.keys(data).forEach(s => {
      if (!(Store.data[s] instanceof Array)) return;
      Store.data[s] = data[s];
      Store.saveLocal(s);
      // sinkronkan seluruh isi ke sheet (upsert via batch)
      const items = data[s].map(r => ({ id: r.id, data: r }));
      if (items.length) Store._pushBatch('batchUpdate', s, items);
    });
    toast('Backup diimpor ✓ (' + count + ' tabel)');
    render();
  } catch (err) {
    toast('Import gagal: ' + err.message);
  }
}

function downloadCSV(filename, headers, rows) {
  const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const csv = [headers.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  toast('CSV diunduh ✓');
}

function exportCsvHarian() {
  const trx = Store.get('Penjualan').filter(p => p.tanggal === state.laporanTanggal);
  const rows = trx.map(t => [t.noInvoice || '', t.waktu, t.platform, (t.items || []).length, t.subtotal, t.adjustment, t.total, t.totalHpp, t.laba]);
  downloadCSV('penjualan-' + state.laporanTanggal + '.csv',
    ['No. Invoice', 'Waktu', 'Platform', 'Jml Item', 'Subtotal', 'Penyesuaian', 'Total', 'HPP', 'Laba'],
    rows);
}

function openModalForm() {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>Tambah Modal</h2><button class="btn-icon" data-close-sheet>✕</button></div>
    <label>Tanggal</label><input type="date" id="mo-tanggal" value="${todayStr()}" />
    <label>Jumlah</label><input type="number" id="mo-jumlah" placeholder="5000000" />
    <label>Keterangan</label><input id="mo-ket" placeholder="Setoran modal awal" />
    <button class="btn btn-primary" data-save-modal style="margin-top:10px">Simpan</button>
  `, 'modal-form');
}
function openAsetForm() {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>Belanja Aset/Peralatan</h2><button class="btn-icon" data-close-sheet>✕</button></div>
    <label>Tanggal</label><input type="date" id="as-tanggal" value="${todayStr()}" />
    <label>Nama Aset</label><input id="as-nama" placeholder="Mesin Espresso" />
    <label>Kategori</label><input id="as-kategori" placeholder="Peralatan Dapur" />
    <div class="field-row">
      <div><label>Jumlah Unit</label><input type="number" id="as-qty" value="1" /></div>
      <div><label>Harga Satuan</label><input type="number" id="as-harga" placeholder="3000000" /></div>
    </div>
    <div class="row"><span class="k">Total</span><span class="v big" id="as-total-preview">Rp0</span></div>
    <button class="btn btn-primary" data-save-aset style="margin-top:10px">Simpan</button>
  `, 'aset-form');
}

// ============ MODAL SHEET GENERIK ============
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
  state.menuFormDraft = null;
}
function refreshSheet(html) {
  const inner = document.getElementById('sheet-inner');
  if (inner) inner.innerHTML = html;
}

// ============ EVENT DELEGATION ============
document.addEventListener('click', async (e) => {
  const t = e.target;

  // navigasi bawah
  const nav = t.closest('[data-nav]');
  if (nav) { state.page = nav.dataset.nav; render(); return; }

  if (t.closest('[data-close-sheet]')) { closeSheet(); return; }
  if (t.closest('[data-close-pay]')) { closePayment(); return; }
  if (t.closest('[data-pay-cancel]')) { closePayment(); return; }
  if (t.dataset.payAmount !== undefined) { payStr = String(Number(t.dataset.payAmount) || 0); renderPay(); return; }
  if (t.dataset.payKey !== undefined) { payStr = (payStr + t.dataset.payKey).replace(/^0+(?=\d)/, ''); renderPay(); return; }
  if (t.dataset.payBks !== undefined) { payStr = payStr.slice(0, -1); renderPay(); return; }
  if (t.dataset.payClr !== undefined) { payStr = ''; renderPay(); return; }
  if (t.dataset.payExact !== undefined) { payStr = String(Number((state.lastTrx || {}).total) || 0); renderPay(); return; }
  if (t.dataset.payOk !== undefined) { doPay(); return; }
  if (t.dataset.reprint) {
    const tr = Store.get('Penjualan').find(x => x.id === t.dataset.reprint);
    if (tr) printReceipt(tr, Number(tr.total) || 0);
    return;
  }

  if (t.dataset.open === 'modal-form') return openModalForm();
  if (t.dataset.open === 'aset-form') return openAsetForm();
  if (t.dataset.open === 'belanja-form') return openBelanjaForm();
  if (t.dataset.open === 'menu-form') return openMenuForm(null);
  if (t.dataset.openRiwayat !== undefined) return openRiwayat();
  if (t.dataset.exportCsv !== undefined) return exportCsvHarian();
  if (t.dataset.openRestore !== undefined) return openRestore();
  if (t.dataset.backup !== undefined) return downloadBackup();
  if (t.dataset.saveOpname !== undefined) return saveOpname();
  if (t.id === 'btn-restore-import') { document.getElementById('import-file')?.click(); return; }
  if (t.dataset.restore) {
    const [sheet, id] = t.dataset.restore.split('|');
    await Store.update(sheet, id, { deleted: false, deletedAt: null });
    toast('Item dipulihkan ✓');
    openRestore();
    return;
  }

  if (t.dataset.kategoriFilter) { state.menuKategoriFilter = t.dataset.kategoriFilter; render(); return; }
  if (t.dataset.laporanTab) { state.laporanTab = t.dataset.laporanTab; render(); return; }
  if (t.dataset.periode) { state.akuntansiPeriode = t.dataset.periode; render(); return; }

  // KASIR
  const pick = t.closest('[data-pick-menu]');
  if (pick) return addToCart(pick.dataset.pickMenu);
  if (t.dataset.cartInc !== undefined) { state.cart[+t.dataset.cartInc].qty++; renderCartRegion(); return; }
  if (t.dataset.cartDec !== undefined) {
    const i = +t.dataset.cartDec;
    state.cart[i].qty--;
    if (state.cart[i].qty <= 0) state.cart.splice(i, 1);
    renderCartRegion(); return;
  }
  if (t.dataset.cartRemove !== undefined) { state.cart.splice(+t.dataset.cartRemove, 1); renderCartRegion(); return; }
  if (t.id === 'btn-checkout') return checkout();

  // MENU
  if (t.dataset.editMenu) return openMenuForm(t.dataset.editMenu);
  if (t.dataset.deleteMenu) {
    if (confirm('Hapus menu ini? Data tidak hilang permanen (soft delete).')) { await Store.softDelete('Menu', t.dataset.deleteMenu); render(); }
    return;
  }
  if (t.dataset.resepAdd !== undefined) { state.menuFormDraft.resep.push(newResepRow()); refreshSheet(renderMenuFormSheet()); return; }
  if (t.dataset.resepRemove !== undefined) { state.menuFormDraft.resep.splice(+t.dataset.resepRemove, 1); refreshSheet(renderMenuFormSheet()); return; }
  if (t.dataset.saveMenu !== undefined) return saveMenuForm();

  // STOK
  if (t.dataset.editBahan) return editBahanPrompt(t.dataset.editBahan);
  if (t.dataset.saveBahan) return saveBahanEdit(t.dataset.saveBahan);
  if (t.dataset.deleteBahan) {
    if (confirm('Hapus bahan ini? Riwayat belanja terkait tidak ikut terhapus (soft delete).')) {
      await Store.softDelete('Bahan', t.dataset.deleteBahan); closeSheet(); render();
    }
    return;
  }
  if (t.dataset.saveBelanja !== undefined) return saveBelanjaForm();

  // LAINNYA
  if (t.dataset.saveModal !== undefined) return saveModalForm();
  if (t.dataset.saveAset !== undefined) return saveAsetForm();
  if (t.dataset.addPlatform !== undefined) {
    const s = getSettings();
    s.id = s.id || 'settings-1';
    s.platforms.push({ nama: '', adminPercent: 0 });
    await Store.update('Settings', s.id, s);
    render(); return;
  }
  if (t.dataset.saveSettings !== undefined) return saveSettingsForm();
  if (t.dataset.promoNew !== undefined) return openPromoForm(null);
  if (t.dataset.promoEdit) return openPromoForm(t.dataset.promoEdit);
  if (t.dataset.promoDel) { await Store.softDelete('Promo', t.dataset.promoDel); render(); return; }
  if (t.dataset.savePromo !== undefined) return savePromo();
  if (t.id === 'btn-manual-sync') { toast('Menyinkronkan...'); await Store.syncAll(); render(); toast('Sinkron selesai ✓'); return; }

  if (t.id === 'btn-printer-connect') {
    if (isPrinterConnected()) {
      await disconnectPrinter(); render(); toast('Printer diputus koneksinya'); return;
    }
    try {
      toast('Pilih printer Bluetooth di popup...');
      const nama = await connectPrinter();
      render(); toast('Terkoneksi: ' + nama);
    } catch (err) {
      toast('Gagal konek: ' + err.message);
    }
    return;
  }
  if (t.id === 'btn-printer-test') {
    if (!isPrinterConnected()) { toast('Konek printer dulu'); return; }
    try { await testPrint(); toast('Test print terkirim ✓'); }
    catch (err) { toast('Gagal: ' + err.message); }
    return;
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'cart-search') { state.cartSearch = t.value; render(); return; }
  if (t.id === 'input-adjustment') {
    state.adjustment = numOnly(t.value);
    // update total & laba live tanpa re-render (biar fokus tidak hilang)
    const cartTotalJual = state.cart.reduce((s, c) => s + c.hargaJual * c.qty, 0);
    const cartDiskon = diskonTransaksi(cartTotalJual);
    const cartTotalHpp = state.cart.reduce((s, c) => s + c.hpp * c.qty, 0);
    const grandTotal = cartTotalJual - cartDiskon + state.adjustment;
    const elTotal = document.getElementById('ct-total');
    const elLaba = document.getElementById('ct-laba');
    if (elTotal) elTotal.textContent = rupiah(grandTotal);
    if (elLaba) { elLaba.textContent = rupiah(grandTotal - cartTotalHpp); elLaba.className = 'v ' + (grandTotal - cartTotalHpp >= 0 ? 'positive' : 'negative'); }
    return;
  }
  if (t.id === 'input-platform') return; // handled on change
  if (t.id === 'lap-tanggal') { state.laporanTanggal = t.value; render(); return; }

  // form menu -> live update HPP preview TANPA re-render (biar fokus tidak hilang)
  if (['mf-nama', 'mf-kategori', 'mf-margin', 'mf-harga-manual'].includes(t.id) || t.dataset.resepBahan !== undefined || t.dataset.resepQty !== undefined) {
    syncMenuDraftFromDom();
    updateMenuPreviewFromDom();
    return;
  }

  if (['bf-isi-kemasan', 'bf-qty-kemasan', 'bf-harga-total', 'bf-satuan-dasar'].includes(t.id)) {
    updateBelanjaPreview();
    return;
  }
  if (['as-qty', 'as-harga'].includes(t.id)) {
    const qty = numOnly(document.getElementById('as-qty')?.value);
    const harga = numOnly(document.getElementById('as-harga')?.value);
    const preview = document.getElementById('as-total-preview');
    if (preview) preview.textContent = rupiah(qty * harga);
    return;
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'pr-jenis') { updatePromoHint(); return; }
  if (t.id === 'pr-tipe') {
    const wrap = document.getElementById('pr-menu-wrap');
    if (wrap) wrap.style.display = t.value === 'menu' ? 'block' : 'none';
    updatePromoHint();
    return;
  }
  if (t.dataset.darkToggle !== undefined) { setTheme(t.checked ? 'dark' : 'light'); return; }
  if (t.id === 'print-on') {
    const pref = getPrintPref();
    pref.on = t.checked;
    setPrintPref(pref);
    render();
    return;
  }
  if (t.id === 'import-file') {
    if (t.files && t.files[0]) importBackup(t.files[0]);
    t.value = '';
    return;
  }
  if (t.id === 'printer-auto') {
    const pref = getPrintPref();
    pref.mode = t.checked ? 'ble' : 'manual';
    setPrintPref(pref);
    return;
  }
  if (t.dataset.cartPrice !== undefined) {
    // harga satuan diubah manual -> refresh total setelah selesai mengetik
    renderCartRegion();
    return;
  }
  if (t.id === 'input-platform') {
    state.platform = t.value;
    // update default harga item yang belum diubah manual? sederhanakan: biarkan user edit manual.
    return;
  }
  if (t.id === 'bf-bahan-select') {
    const wrap = document.getElementById('bf-new-bahan-wrap');
    if (wrap) wrap.style.display = t.value === '__new__' ? 'block' : 'none';
    if (t.value !== '__new__') {
      const def = defaultKemasanUntuk(t.value);
      if (def) {
        const kn = document.getElementById('bf-kemasan-nama');
        const ik = document.getElementById('bf-isi-kemasan');
        if (kn && def.nama !== undefined) kn.value = def.nama || '';
        if (ik && def.isi !== undefined) ik.value = def.isi || 1;
        updateBelanjaPreview();
      }
    }
    updateBelanjaPreview();
  }
});

// Ambil default kemasan untuk suatu bahan: prioritas dari record bahan
// (kemasan terakhir dipakai), fallback ke entri BelanjaBahan terakhir untuk bahan itu.
function defaultKemasanUntuk(bahanId) {
  const b = getBahanList().find(x => x.id === bahanId);
  if (b && b.kemasanDefault && (b.kemasanDefault.nama !== undefined || b.kemasanDefault.isi !== undefined)) {
    return b.kemasanDefault;
  }
  const riwayat = Store.get('BelanjaBahan').filter(r => r.bahanId === bahanId);
  if (!riwayat.length) return null;
  const last = riwayat[riwayat.length - 1];
  return { nama: last.kemasanNama, isi: last.isiPerKemasan };
}

function syncMenuDraftFromDom() {
  const d = state.menuFormDraft;
  const nama = document.getElementById('mf-nama'); if (nama) d.nama = nama.value;
  const kat = document.getElementById('mf-kategori'); if (kat) d.kategori = kat.value;
  const margin = document.getElementById('mf-margin'); if (margin) d.marginPercent = numOnly(margin.value);
  const hm = document.getElementById('mf-harga-manual'); if (hm) d.hargaJualManual = numOnly(hm.value);
  document.querySelectorAll('[data-resep-bahan]').forEach(el => {
    d.resep[+el.dataset.resepBahan].bahanId = el.value;
  });
  document.querySelectorAll('[data-resep-qty]').forEach(el => {
    d.resep[+el.dataset.resepQty].qty = el.value;
  });
}

function updateMenuPreviewFromDom() {
  const d = state.menuFormDraft;
  const bahanList = getBahanList();
  const hpp = d.resep.reduce((s, r) => {
    const b = bahanList.find(x => x.id === r.bahanId);
    return s + (b ? Number(b.hargaAvco ?? b.hargaTerakhir ?? 0) : 0) * Number(r.qty || 0);
  }, 0);
  const settings = getSettings();
  const adminFirst = settings.platforms.find(p => p.nama !== 'Offline')?.adminPercent || 0;
  const elHpp = document.getElementById('mf-hpp');
  const elOff = document.getElementById('mf-saran-offline');
  const elOn = document.getElementById('mf-saran-online');
  if (elHpp) elHpp.textContent = rupiah(hpp);
  if (elOff) elOff.textContent = rupiah(hitungHargaSaran(hpp, d.marginPercent, 0));
  if (elOn) elOn.textContent = rupiah(hitungHargaSaran(hpp, d.marginPercent, adminFirst));
}

async function saveMenuForm() {
  syncMenuDraftFromDom();
  const d = state.menuFormDraft;
  if (!d.nama.trim()) { toast('Nama menu wajib diisi'); return; }
  d.resep = d.resep.filter(r => r.bahanId && r.qty);
  const payload = {
    id: d.id, nama: d.nama.trim(), kategori: d.kategori.trim(),
    resep: d.resep.map(r => ({ bahanId: r.bahanId, qty: Number(r.qty) })),
    marginPercent: Number(d.marginPercent) || 0,
    hargaJualManual: d.hargaJualManual ? Number(d.hargaJualManual) : null,
    aktif: true
  };
  if (d.id) await Store.update('Menu', d.id, payload);
  else await Store.insert('Menu', payload);
  closeSheet();
  toast('Menu tersimpan ✓');
  render();
}

async function saveBelanjaForm() {
  const tanggal = document.getElementById('bf-tanggal').value || todayStr();
  const select = document.getElementById('bf-bahan-select');
  const kemasanNama = document.getElementById('bf-kemasan-nama').value.trim();
  const isiPerKemasan = numOnly(document.getElementById('bf-isi-kemasan').value) || 1;
  const qtyKemasan = numOnly(document.getElementById('bf-qty-kemasan').value);
  const hargaBeliTotal = numOnly(document.getElementById('bf-harga-total').value);
  const stokMin = numOnly(document.getElementById('bf-stok-min').value);
  const supplier = document.getElementById('bf-supplier').value.trim();

  if (!qtyKemasan || !hargaBeliTotal) { toast('Isi jumlah kemasan & total harga dulu'); return; }

  const totalMasuk = isiPerKemasan * qtyKemasan;       // dalam satuan dasar (mis. ml)
  const hargaPerSatuan = totalMasuk > 0 ? hargaBeliTotal / totalMasuk : 0; // harga per ml

  let bahanId = select.value;
  let bahanNama, satuanDasar, stokLama, avcoLama;

  if (bahanId === '__new__') {
    const namaBaru = document.getElementById('bf-nama-baru').value.trim();
    satuanDasar = document.getElementById('bf-satuan-dasar').value.trim();
    if (!namaBaru) { toast('Isi nama bahan baru'); return; }
    if (!satuanDasar) { toast('Isi satuan dasar (mis. ml, gram, pcs)'); return; }
    stokLama = 0;
    avcoLama = 0;
  } else {
    const bahan = getBahanList().find(b => b.id === bahanId);
    bahanNama = bahan.nama;
    satuanDasar = bahan.satuan;
    stokLama = Number(bahan.stok || 0);
    avcoLama = Number(bahan.hargaAvco ?? bahan.hargaTerakhir ?? 0);
  }

  // AVCO: harga rata-rata tertimbang antara stok lama + pembelian baru ini
  const avcoBaru = hitungAvco(stokLama, avcoLama, totalMasuk, hargaPerSatuan);
  const kemasanDefault = { nama: kemasanNama, isi: isiPerKemasan, hargaTotal: hargaBeliTotal, qty: qtyKemasan };

  if (bahanId === '__new__') {
    const namaBaru = document.getElementById('bf-nama-baru').value.trim();
    const newBahan = await Store.insert('Bahan', {
      nama: namaBaru, satuan: satuanDasar, stok: totalMasuk, hargaAvco: avcoBaru,
      stokMinimum: stokMin, kemasanDefault
    });
    bahanId = newBahan.id;
    bahanNama = newBahan.nama;
  } else {
    const bahanLama = getBahanList().find(b => b.id === bahanId);
    await Store.update('Bahan', bahanId, {
      stok: stokLama + totalMasuk,
      hargaAvco: avcoBaru,
      stokMinimum: stokMin || bahanLama.stokMinimum || 0,
      kemasanDefault
    });
  }

  await Store.insert('BelanjaBahan', {
    tanggal, bahanId, bahanNama, satuan: satuanDasar,
    kemasanNama, isiPerKemasan, qtyKemasan,
    totalMasuk, hargaPerSatuan, hargaBeliTotal,
    total: hargaBeliTotal, // alias untuk kompatibilitas laporan akuntansi
    avcoSesudah: avcoBaru, supplier
  });

  closeSheet();
  toast(`Belanja tersimpan ✓ — AVCO ${bahanNama}: ${rupiah(avcoBaru)}/${satuanDasar}`);
  render();
}

async function saveBahanEdit(id) {
  const nama = document.getElementById('eb-nama').value.trim();
  const stok = numOnly(document.getElementById('eb-stok').value);
  const satuan = document.getElementById('eb-satuan').value.trim();
  const harga = numOnly(document.getElementById('eb-harga').value);
  const min = numOnly(document.getElementById('eb-min').value);
  await Store.update('Bahan', id, { nama, stok, satuan, hargaAvco: harga, stokMinimum: min });
  closeSheet();
  toast('Bahan diperbarui ✓');
  render();
}

async function saveModalForm() {
  const tanggal = document.getElementById('mo-tanggal').value || todayStr();
  const jumlah = numOnly(document.getElementById('mo-jumlah').value);
  const keterangan = document.getElementById('mo-ket').value.trim();
  if (!jumlah) { toast('Isi jumlah modal'); return; }
  await Store.insert('Modal', { tanggal, jumlah, keterangan });
  closeSheet();
  toast('Modal tercatat ✓');
  render();
}

async function saveAsetForm() {
  const tanggal = document.getElementById('as-tanggal').value || todayStr();
  const nama = document.getElementById('as-nama').value.trim();
  const kategori = document.getElementById('as-kategori').value.trim();
  const qty = numOnly(document.getElementById('as-qty').value) || 1;
  const harga = numOnly(document.getElementById('as-harga').value);
  if (!nama || !harga) { toast('Lengkapi nama & harga aset'); return; }
  await Store.insert('Aset', { tanggal, nama, kategori, qty, hargaSatuan: harga, total: qty * harga });
  closeSheet();
  toast('Aset tercatat ✓');
  render();
}

async function saveSettingsForm() {
  const s = getSettings();
  s.id = s.id || 'settings-1';
  s.defaultMarginPercent = numOnly(document.getElementById('set-margin').value);
  document.querySelectorAll('[data-platform-nama]').forEach(el => {
    s.platforms[+el.dataset.platformNama].nama = el.value.trim();
  });
  document.querySelectorAll('[data-platform-admin]').forEach(el => {
    s.platforms[+el.dataset.platformAdmin].adminPercent = numOnly(el.value);
  });
  await Store.update('Settings', s.id, s);
  toast('Pengaturan disimpan ✓');
  render();
}

// ============ UTIL ESCAPE ============
function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

window.addEventListener('store:failed', () => {
  if (navigator.onLine) toast('⚠️ Ada data yang gagal terkirim ke sheet. Cek koneksi & sync manual.');
});

init();