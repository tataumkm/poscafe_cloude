// Self-check: buildEscPos menghasilkan baris <= 42 kolom (58mm, Font B)
// Jalankan: node check-escpos.mjs
import { buildEscPos } from './js/ble.js';

const trx = {
  namaToko: 'CAFEKU',
  noInvoice: 'INV-2026-0001',
  platform: 'OFFLINE',
  metodeBayar: 'tunai',
  noMeja: '3',
  namaPembeli: 'Budi Santoso',
  oleh: 'Andi',
  items: [
    { nama: 'Kopi Susu Gula Aren Besar', qty: 2, hargaJual: 18000 },
    { nama: 'Nasi Goreng Spesial Telur', qty: 1, hargaJual: 25000 },
    { nama: 'Es Teh Manis Panjang', qty: 500, hargaJual: 5000 },
  ],
  subtotal: 61000,
  diskon: 5000,
  adjustment: 0,
  total: 56000,
};

const bytes = buildEscPos(trx, 100000);
let txt = '';
for (let i = 0; i < bytes.length; i++) {
  const code = bytes[i];
  if (code === 0x0A) { txt += '\n'; continue; }
  if (code === 0x1B) {           // ESC
    const c2 = bytes[i + 1];
    i += (c2 === 0x40) ? 1 : 2;  // 1B 40 (init) = 1 param; lain = 2 param
    continue;
  }
  if (code === 0x1D) { i += 2; continue; } // GS (size/cut) = 1 param
  if (code >= 0x20 && code <= 0x7E) txt += String.fromCharCode(code);
}

const lines = txt.split('\n').filter(l => l.length > 0);
let fail = 0;
for (const l of lines) {
  if (l.length > 42) {
    console.log(`FAIL(${l.length}): "${l}"`);
    fail++;
  }
}

if (fail) {
  console.log(`\n${fail} baris melebihi 42 kolom.`);
  process.exit(1);
}
console.log(`OK: semua ${lines.length} baris <= 42 kolom.`);
console.log('Contoh item multi-qty:');
console.log(lines.find(l => l.includes('500')));
