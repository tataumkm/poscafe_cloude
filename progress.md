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
