# Cafeku — Sistem Informasi Cafe

Web app mobile-first untuk kasir (POS), stok bahan, HPP & resep, laporan penjualan,
dan akuntansi sederhana. Database pakai Google Sheets (gratis, tanpa server sendiri),
frontend static di-hosting di GitHub Pages (gratis juga).

## Fitur

1. Input modal usaha
2. Belanja peralatan (aset)
3. Belanja bahan (otomatis update stok)
4. Data menu & resep dengan **kalkulasi HPP otomatis** + saran harga jual
   (HPP → margin % → dibagi potongan admin platform online)
5. Informasi stok bahan (dengan peringatan stok menipis)
6. POS Kasir dengan harga per-item yang **bisa diubah manual saat transaksi**
   (untuk penyesuaian promo/biaya iklan platform online)
7. Laporan penjualan harian + menu terlaris
8. Akuntansi sederhana: posisi modal, aset, estimasi kas, laba rugi (per hari/bulan/semua)

## Arsitektur singkat

```
Browser (GitHub Pages)  <-->  Google Apps Script Web App  <-->  Google Sheets
      (frontend statis)         (backend/API + cache)         (database)
```

- Setiap "tabel" = 1 tab sheet, **hanya 1 kolom** berisi JSON per baris → baca/tulis cepat.
- Backend pakai `CacheService` (cache 20 detik) supaya saat traffic tinggi tidak semua
  request harus baca ulang Google Sheets.
- Frontend menyimpan salinan semua data di `localStorage` dan melakukan
  **optimistic update**: begitu kamu tap "Simpan", tampilan langsung berubah,
  baru di belakang layar dikirim ke server (dengan antrian retry kalau sinyal jelek).
  Ini yang bikin interaksi terasa instan meski database-nya Google Sheets.

## Langkah Setup

### 1. Buat Database (Google Sheets)

1. Buka [sheets.google.com](https://sheets.google.com) → buat spreadsheet baru, beri nama misalnya `CafekuDB`.
2. Klik **Extensions → Apps Script**.
3. Hapus semua isi editor, lalu copy-paste seluruh isi file `gas/Code.gs` dari project ini.
4. Simpan (Ctrl+S / ikon disket).
5. Di dropdown fungsi (atas, sebelah tombol Run/Debug), pilih fungsi `setup`, lalu klik **Run**.
   - Google akan minta izin akses — klik "Review permissions", pilih akun kamu, klik "Advanced" → "Go to project (unsafe)" → Allow. (Ini normal karena scriptnya milikmu sendiri.)
   - Setelah selesai, cek spreadsheet kamu — akan muncul tab: Modal, Aset, BelanjaBahan, Bahan, Menu, Penjualan, Settings.

### 2. Deploy sebagai Web App

1. Di Apps Script editor, klik **Deploy → New deployment**.
2. Klik ikon gear di sebelah "Select type" → pilih **Web app**.
3. Isi:
   - Description: `Cafeku API`
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Klik **Deploy**. Copy URL yang muncul (bentuknya `https://script.google.com/macros/s/XXXXXXXX/exec`).

> ⚠️ Setiap kali kamu **mengubah isi Code.gs**, kamu harus buat deployment baru
> (Deploy → Manage deployments → edit/pencil icon → New version → Deploy) supaya perubahan aktif.

### 3. Hubungkan Frontend ke Backend

1. Buka file `js/config.js`.
2. Ganti baris:
   ```js
   export const API_URL = 'PASTE_URL_WEB_APP_GOOGLE_APPS_SCRIPT_DI_SINI';
   ```
   dengan URL yang kamu copy tadi.

### 4. Deploy Frontend ke GitHub Pages

1. Buat repository baru di GitHub, misalnya `cafeku-app`.
2. Upload semua isi folder ini (`index.html`, folder `css/`, folder `js/`) ke repo tersebut
   (folder `gas/` boleh ikut diupload untuk arsip, tidak berpengaruh ke frontend).
3. Di repo, buka **Settings → Pages**.
4. Source: pilih branch `main`, folder `/ (root)`. Klik Save.
5. Tunggu 1-2 menit, GitHub akan kasih URL seperti `https://username.github.io/cafeku-app/`.
6. Buka URL itu di HP kamu — aplikasi siap dipakai. Disarankan "Add to Home Screen"
   dari browser HP supaya terasa seperti aplikasi asli.

## Cara Pakai Singkat

- **Stok** → catat belanja bahan pertama kali (ini otomatis membuat data bahan + stok awal).
- **Menu** → buat menu baru, pilih bahan dari resep, atur qty per bahan. HPP dan saran
  harga jual akan terhitung otomatis berdasarkan margin default & admin fee platform
  (bisa diatur di tab **Lainnya → Pengaturan**).
- **Kasir** → tap menu untuk masuk keranjang, harga per baris bisa diubah manual
  (untuk promo/adjustment biaya iklan), pilih platform, lalu "Selesaikan Transaksi".
  Stok bahan otomatis berkurang sesuai resep.
- **Laporan** → lihat omzet & laba harian, atau tab Akuntansi untuk laba rugi & estimasi kas.

## Catatan Performa & Batasan

- Google Apps Script Web App gratis punya kuota (± 20.000 request/hari untuk akun biasa).
  Untuk 1 cafe, ini jauh lebih dari cukup.
- Karena `localStorage` dipakai sebagai cache, data tetap terlihat walau internet putus
  sebentar; begitu online lagi, antrian transaksi otomatis terkirim.
- Kalau tim kasirnya lebih dari 1 device aktif bersamaan, ada kemungkinan kecil
  data "telat" sinkron antar device (maks. beberapa detik) — cukup aman untuk skala cafe kecil-menengah.
- Ingin fitur tambahan (multi-cabang, printer struk, login staff, dsb) — bisa dikembangkan
  bertahap dari struktur ini.
