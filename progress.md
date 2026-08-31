# Progress Log — Cafeku POS

## Status: Soft Delete Implemented + Bug Fixes Selesai

Arsitektur: Vanilla JS SPA (frontend) → Google Apps Script (backend) → Google Sheets (DB).
Optimistic update + queue retry untuk offline support.

---

## Keputusan Desain

### Soft Delete (dipilih) — #REF-1
Semua data (Menu, Bahan, Penjualan, BelanjaBahan, Modal, Aset) memakai **soft delete**:
- Item tidak dihapus permanen dari sheet, hanya diberi flag `deleted: true`.
- `Store.get()` otomatis memfilter item `deleted` → tidak tampil di UI.
- Data keuangan tak pernah hilang → laporan & HPP tetap utuh.
- Backend `getSheetData` juga filter `deleted` → tidak mengirim data terhapus.

Catatan: Settings tidak di-soft-delete (langsung overwrite via update).

---

## Changelog

### 2026-08-30 — FASE 4: Mode Gelap + PWA Installable
- [FEAT] **Mode Gelap**: toggle slide di Pengaturan → persist localStorage → `[data-theme="dark"]` + override CSS variabel. `--bar` baru untuk topbar/bottomnav (tetap gelap di dark mode). `css/style.css`, `js/app.js`
- [FEAT] **PWA installable**: `manifest.webmanifest` + `<link rel="manifest">` + meta `apple-mobile-web-app-capable`. Ikon SVG inline. `index.html`

### 2026-08-30 — FASE 3: Promo Otomatis (diskon bertanggal)
- [FEAT] **Sistem promo otomatis** (sheet `Promo` backend). Dua tipe: promo transaksi (diskon dari subtotal) & promo menu (diskon dari harga jual). Jenis: persen atau rupiah. Berlaku otomatis sesuai rentang tanggal. `js/app.js`
- [FEAT] **Halaman Promo**: CRUD promo (tambah/edit/hapus). Form dengan nama, tipe (transaksi/menu), jenis, nilai, rentang tanggal, status aktif. `js/app.js`
- [FEAT] **Kasir integrasi promo**: harga jual menu otomatis terdiskon jika ada promo aktif. "PROMO" badge + harga coret ditampilkan. Subtotal → diskon transaksi → adjustment → total. Transaksi menyimpan `diskon`. `js/app.js`
- [FEAT] **Promo terbesar**: bila beberapa promo transaksi aktif bertumpuk, dipakai yang terbesar. `js/app.js`

### 2026-08-30 — FASE 2: Tombol Uang Cepat
- [FEAT] **Tombol nominal cepat** di sheet pembayaran: 50k / 100k / 150k / Pas. Tambah baris `pay-quick`. `js/app.js`, `css/style.css`

### 2026-08-30 — FASE 1: Fondasi & Keandalan (F1–F5)
- [F1] **Nomor invoice otomatis** `INV-YYYYMMDD-0001` (urutan per tanggal). Ditampilkan di struk (print dialog + ESC/POS). `js/app.js`, `js/ble.js`
- [F2] **Pulihkan item soft-deleted**: halaman Lainnya → "Pulihkan Item Terhapus" → listing Menu & Bahan `deleted` + tombol Pulihkan. `js/app.js`
- [F3] **Opname Kas**: Laporan → Akuntansi → input Kas Fisik + Keterangan, hitung selisih (kas teori vs fisik), riwayat opname. Tersimpan ke sheet baru **`Kas`**. `js/app.js`
- [F4] **Backup/restore lokal**: Download semua data JSON + Import (muat ulang). `js/app.js`, `index.html`
- [F5] **Export CSV** laporan harian (`penjualan-YYYY-MM-DD.csv`). `js/app.js`
- [NEW] Sheet backend **`Kas`** & **`Promo`** ditambahkan ke `SHEETS` (config.js + code.gs). `setup()` otomatis buat. Jalankan ulang deployment Apps Script + `setup()`.

### 2026-08-30 — Master Toggle Print (slide) + Riwayat Transaksi
- [FEAT] Toggle **"Aktifkan Fitur Print"** (gaya slide/geser) sebagai saklar master. OFF → transaksi selesai **tanpa cetak sama sekali** (tanpa dialog/cek). ON → opsi status/cetak BLE/tombol muncul. `js/app.js`, `css/style.css`
- [FEAT] Slide switch `:root` `.switch`/`.slider` menggantikan checkbox lama.
- [FEAT] **Riwayat Transaksi**: tombol **"Semua Riwayat Transaksi"** di Laporan → Penjualan Harian → buka sheet berisi **seluruh** transaksi (tidak dibatasi tanggal, terbaru di atas) + ringkasan total + tombol **Cetak Ulang Struk** tiap item. `openRiwayat()`. `js/app.js`

### 2026-08-30 — Perbaiki Alur Cetak: Share Sheet DIGANTI Print Dialog
- [FIX] Saat toggle "Cetak Langsung" OFF, bayar **tidak lagi membuka Web Share** (mengganggu). Kini langsung `window.print()` (dialog print standar).
- [FIX] Fallback jalur A (BLE gagal/koneksi putus) juga langsung ke `window.print()`, bukan share.
- [NOTE] Struk teks (`strukText`) dipertahankan sebagai util untuk opsi share eksplisit di masa depan (belum dipakai).

### 2026-08-30 — Cetak Langsung Printer Bluetooth (ESC/POS) + Fallback
- [FEAT] Modul baru `js/ble.js`: **Web Bluetooth + ESC/POS**. Connect printer BT thermal, kirim byte langsung (tanpa dialog preview), test print, persist device.
- [FEAT] Orkestrasi cetak 3 jalur (`printReceipt`): **A)** printer BLE langsung (bila toggle aktif & terkoneksi) → **B)** Web Share (share struk teks ke app printer) → **C)** `window.print()` dialog. `js/app.js`
- [FEAT] Settings (Lainnya → Printer Bluetooth): status koneksi, toggle **"Cetak Langsung (tanpa preview)"**, tombol **Konek Printer** & **Test Print**. Pref disimpan di localStorage (`cafeku_print_pref`).
- [IMPROVE] CSS toggle switch. `css/style.css`
- ⚠️ Batasan: Web Bluetooth **hanya Android + Chrome/Edge**; banyak printer GP-5890BT pakai BT Classic (SPP) → tidak connect via BLE → otomatis fallback ke share/dialog.

### 2026-08-30 — Auto-fill Nama Kemasan & Isi Per Kemasan
- [FIX] Saat pilih bahan existing di form Belanja Bahan, kolom **Nama Kemasan** & **Isi per Kemasan** kini terisi otomatis. Sumber: `kemasanDefault` pada record bahan (data kemasan terakhir belanja), dengan **fallback ke riwayat `BelanjaBahan` terakhir untuk bahan itu** — sehingga bahan lama yang belum punya `kemasanDefault` tetap terisi. Helper `defaultKemasanUntuk()`. `js/app.js`

### 2026-08-30 — Cetak Ulang Struk dari Riwayat
- [FEAT] Tombol **"Cetak Ulang Struk"** di tiap kartu Detail Transaksi (Laporan → Penjualan Harian). `printReceipt()` ulang tanpa perlu input uang lagi (dibayar = total). `js/app.js`

### 2026-08-30 — Adaptasi HP: UI Pembayaran Mobile (ganti prompt/confirm)
- [FIX] `confirm`/`prompt` **diblokir di PWA/webview HP** → diganti **sheet pembayaran** berbasis keypad angka besar. `js/app.js`
- [FEAT] Setelah checkout otomatis buka sheet "Pembayaran": display uang diterima besar, keypad 0-9/backspace/clear, tombol **Uang Pas** & **Bayar**, live hitung kembalian (atau "uang kurang"). Tombol **Tanpa Cetak** untuk lewati struk.
- [FEAT] "Uang Pas" set uang = total tagihan → langsung cetak struk kembalian 0.
- [IMPROVE] CSS keypad pembayaran mobile-friendly (grid 3 kolom, tombol besar). `css/style.css`

### 2026-08-30 — Pengembangan: Perf Kasir + Print Termal + Tata Letak
- [PERF] **Kasir tidak lagi re-render penuh** tiap operasi keranjang. Split jadi `renderCartRegion()`/`renderCartInner()` yang hanya update kontainer keranjang (menu list, topbar, bottomnav tidak disentuh). `addToCart`, `+`/`-`/`hapus` item pakai region-render → jauh lebih responsif saat antrian. `js/app.js`
- [PERF] `input-adjustment` kini update total & laba live **tanpa re-render** (fokus tidak hilang). `js/app.js`
- [FEAT] **Print struk termal 58mm** setelah checkout (via `window.print`). Opsional konfirmasi + input uang diterima → hitung kembalian. `printReceipt()`. `js/app.js`
- [IMPROVE] `#print-receipt` + `@media print` CSS (hanya struk yang tampil, sisanya disembunyikan). Tambah `namaToko` sebagai setting opsional untuk header struk. `css/style.css`
- [LAYOUT] Perbaikan tabrakan: topbar stats bisa wrap (`flex-wrap`), `.item-line` top-align + long-name wrap, `.qty-stepper` flex-wrap biar tidak kebentur harga di layar sempit. `css/style.css`

### 2026-08-30 — Soft Delete + Fix Kritis
- [FIX] `todayStr()` & `nowTimeStr()`: ganti dari UTC (`toISOString`/`toTimeString`) ke **waktu lokal**. Ini memperbaiki tanggal transaksi & laporan yang bisa salah 1 hari di WIB setelah jam 17:00. `js/utils.js`
- [FIX] `hitungHargaSaran()`: guard division by zero saat `adminPercent >= 100` (return 0). `js/utils.js`
- [FIX] `checkout()`: validasi stok bahan **sebelum** kurangi stok → toast & batalkan transaksi bila stok tidak cukup (tidak lagi diam-diam jadi 0). `js/app.js`
- [IMP] `Store.softDelete(sheet, id)` + `Store.get()` filter `deleted`, tambah `Store.getWithDeleted()`. `js/store.js`
- [IMP] Backend `getSheetData` filter `deleted`. `backend/code.gs`
- [IMP] List Menu & Bahan: tombol hapus kini soft delete (tidak permanen).
- [IMP] `SaveSettings` & `Add Platform`: pastikan `id: 'settings-1'` ada sebelum update (mencegah gagal simpan saat Settings belum ter-sync).
- [FIX] Form Menu: live HPP/saran update **tanpa re-render** full sheet → cursor/fokus tidak hilang saat mengetik. Update preview via `updateMenuPreviewFromDom()`. `js/app.js`

---

## Bug Ditemukan — Status

### Kritis
| # | Status | Lokasi | Bug / Catatan |
|---|--------|--------|-----|
| 1 | ✅ FIXED | `js/utils.js` | `todayStr()` UTC → tanggal salah di WIB. |
| 2 | ✅ FIXED | `checkout()` | Stok tidak divalidasi sebelum dikurangi. |
| 3 | ❌ BUKAN BUG | `renderLaporanHarian` | `laba = omzet - hpp`, `omzet` = `sum(t.total)` yang **sudah termasuk adjustment** → sudah benar. |
| 4 | ❌ BUKAN BUG | `saveBelanjaForm` | `bahanNama` ternyata sudah di-set dari `newBahan.nama` sebelum toast. |
| 5 | ✅ FIXED | add platform/settings | `id` Settings bisa undefined sebelum sync. |

### Moderat
| # | Status | Lokasi | Bug |
|---|--------|--------|-----|
| 7 | ✅ FIXED | `hitungHargaSaran` | division by zero admin=100%. |
| 8 | ✅ FIXED | form menu | cursor hilang tiap keystroke. |
| 9 | ⏳ TERTUNDA | `store.js` | Queue tidak dedup — edit ganda offline bisa overwrite data baru dengan lama. Perlu revisi terpisah. |
| 10 | ⏳ TERTUNDA | laporan detail | `it.hargaJual * it.qty` — data lama bisa string. Low priority selama data baru selalu Number. |

### Minor / Backend
| # | Status | Lokasi | Bug |
|---|--------|--------|-----|
| 11 | ⏳ TERTUNDA | `escapeAttr` | tidak escape backtick/attr-specific. Low risk. |
| 12 | ⏳ TERTUNDA | `store.js` | overwrite multi-device (last-write-wins). |
| 16 | ⏳ TERTUNDA | `code.gs` | row index shift setelah deleteRow → batch delete bisa salah. |
| 17 | ⏳ TERTUNDA | `code.gs` | crash bila header row terhapus. |

---
## TODO Berikutnya (yang masih tertunda)
- [#9] Queue dedup di `store.js` (anti overwrite).
- Restore UI untuk soft-deleted items (kalau diperlukan).
- Hapus field `_row` agar tidak tersimpan/null.
