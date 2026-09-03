// =========================================================
// BLE PRINTER — Web Bluetooth + ESC/POS (thermal 58mm)
// ---------------------------------------------------------
// Menghubungkan printer thermal Bluetooth (BLE UART), mengirim
// byte ESC/POS langsung (tanpa dialog print browser).
//
// CATATAN TERBATAS:
// - Hanya jalan di Android + Chrome/Edge. iOS/Safari TIDAK support.
// - Banyak printer thermal (mis. GP-5890BT) pakai BT Classic (SPP),
//   bukan BLE -> tidak connect di sini. Fallback ke share/print tersedia.
// =========================================================

const STORAGE_DEVICE = 'cafeku_bt_device';

const esc = {
  init: () => new Uint8Array([0x1B, 0x40]),
  center: () => new Uint8Array([0x1B, 0x61, 0x01]),
  left: () => new Uint8Array([0x1B, 0x61, 0x00]),
  boldOn: () => new Uint8Array([0x1B, 0x45, 0x01]),
  boldOff: () => new Uint8Array([0x1B, 0x45, 0x00]),
  feed: (n = 3) => new Uint8Array([0x1B, 0x64, n]),
  cut: () => new Uint8Array([0x1D, 0x56, 0x42, 0x00]),
  text: (s) => new TextEncoder().encode((s || '') + '\n')
};

function concatBytes(arrays) {
  let len = 0;
  arrays.forEach(a => len += a.length);
  const out = new Uint8Array(len);
  let off = 0;
  arrays.forEach(a => { out.set(a, off); off += a.length; });
  return out;
}

function escWidth(ch) {
  const w = (ch || '').length;
  return w < 32 ? 32 : w > 48 ? 48 : w;
}
function padRight(s, width) { return (s || '') + ' '.repeat(Math.max(0, width - (s || '').length)); }

// Struk -> byte ESC/POS
export function buildEscPos(trx, bayar) {
  const W = escWidth('################################');
  const rup = n => 'Rp' + (Math.round(Number(n) || 0)).toLocaleString('id-ID');
  const total = Number(trx.total || 0);
  const kembalian = Number(bayar || 0) - total;
  const shop = (trx.namaToko || 'CAFEKU').toUpperCase();

  const ln = '='.repeat(W);
  const g = (k, v) => padRight(k, W - String(v).length) + v;

  const lines = [
    '', ' ', '',
    '   ' + shop,
    '   STRUK KASIR',
    '',
    (trx.noInvoice || ''),
    (trx.platform || 'OFFLINE'),
    (trx.metodeBayar === 'qris' ? 'QRIS' : 'TUNAI'),
    ...(trx.noMeja ? ['NO MEJA ' + String(trx.noMeja)] : []),
    ...(trx.namaPembeli ? ['PEMBELI ' + String(trx.namaPembeli).toUpperCase()] : []),
    (trx.oleh ? 'OLEH ' + trx.oleh.toUpperCase() : '')
  ];
  const body = [];
  (trx.items || []).forEach(it => {
    body.push((it.nama || '').toUpperCase());
    body.push(padRight('  ' + it.qty + ' x ' + rup(it.hargaJual), W) + rup(it.hargaJual * it.qty));
  });

  const cols = 26;
  const totalA = padRight('TOTAL', cols) + rup(total);
  const bayarA = padRight('Dibayar', cols) + rup(bayar);
  const kemA = kembalian >= 0 ? padRight('Kembalian', cols) + rup(kembalian) : padRight('KURANG', cols) + rup(-kembalian);

  const rows = [ln, ...body, ln,
    padRight('Subtotal', cols) + rup(trx.subtotal),
    ...(Number(trx.diskon) ? [padRight('Diskon', cols) + '- ' + rup(trx.diskon)] : []),
    ...(Number(trx.adjustment) ? [padRight('Penyesuaian', cols) + rup(trx.adjustment)] : []),
    totalA, bayarA, kemA, ln,
    'TERIMA KASIH', 'Sampai jumpa!'
  ];

  const parts = [esc.init(), esc.center(), esc.boldOn()];
  lines.forEach(l => parts.push(esc.text(l)));
  parts.push(esc.boldOff(), esc.left());
  rows.forEach(r => parts.push(esc.text(r)));
  parts.push(esc.text(''), esc.feed(4), esc.cut());
  return concatBytes(parts);
}

let device = null;
let txChar = null;

const ms = n => new Promise(r => setTimeout(r, n));

// Ambil device yang sudah dipilih (di-cache di localStorage)
function getSavedDevice() {
  const id = localStorage.getItem(STORAGE_DEVICE);
  if (!id) return null;
  try { return { id }; } catch (e) { return null; }
}

export function isBleSupported() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

export function isPrinterConnected() { return !!device; }
export function getPrinterName() {
  return (device && device.name) || localStorage.getItem(STORAGE_DEVICE) || '';
}

// Konek ke printer BLE (memunculkan picker browser bila perlu)
export async function connectPrinter() {
  if (typeof navigator === 'undefined' || !navigator.bluetooth) {
    throw new Error('Web Bluetooth tidak didukung di perangkat ini (butuh Android + Chrome).');
  }
  device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: [
      '0000ffe0-0000-1000-8000-00805f9b34fb',
      '000018f0-0000-1000-8000-00805f9b34fb',
      '0000fee7-0000-1000-8000-00805f9b34fb',
    ]
  });
  let server;
  try {
    server = await device.gatt.connect();
  } catch (e) {
    // fallback: beberapa printer expose service AIS/HM-10
    server = await device.gatt.connect();
  }
  // naikkan MTU biar bisa kirim banyak byte dalam satu paket (Android)
  try { if (server.requestMTU) await server.requestMTU(512); } catch (e) {}
  await findTxCharacteristic(server);
  try { localStorage.setItem(STORAGE_DEVICE, device.id); } catch (e) {}
  device.ongattdisconnected = () => { device = null; };
  return device.name || 'Printer';
}

// UUID umum untuk channel data printer thermal BT (UART/HM-10)
const UUID_WRITE_PRIORITY = [
  '0000ffe1-0000-1000-8000-00805f9b34fb', // FFE1 (HM-10 / banyak thermal)
  '0000ffe2-0000-1000-8000-00805f9b34fb',
  '49535343-8841-43f4-a8d4-ecbe34729bb3', // RedBear BLE Mini
  '0000fff2-0000-1000-8000-00805f9b34fb',
];

async function findTxCharacteristic(server) {
  const svcs = await server.getPrimaryServices();
  const candidates = [];

  // 1) karakteristik tulis yang UUID-nya dikenali (pakai yang punya uuid)
  for (const svc of svcs) {
    let chars = [];
    try { chars = await svc.getCharacteristics(); } catch (e) { continue; }
    for (const c of chars) {
      if (c.properties.writeWithoutResponse || c.properties.write) {
        if (UUID_WRITE_PRIORITY.includes(c.uuid.toLowerCase())) {
          txChar = c; return c;
        }
      }
    }
  }

  // 2) fallback: ambil SEMUA karakteristik tulis, prioritaskan yang punya properti
  //    'write' (dengan respons) untuk data, lalu writeWithoutResponse.
  for (const svc of svcs) {
    let chars = [];
    try { chars = await svc.getCharacteristics(); } catch (e) { continue; }
    for (const c of chars) {
      if (c.properties.write) candidates.push({ c, w: 0 });
      else if (c.properties.writeWithoutResponse) candidates.push({ c, w: 1 });
    }
  }
  candidates.sort((a, b) => a.w - b.w);
  if (candidates.length) { txChar = candidates[0].c; return txChar; }

  throw new Error('Tidak menemukan karakteristik tulis di printer.');
}

export async function disconnectPrinter() {
  if (device && device.gatt && device.gatt.connected) {
    try { device.gatt.disconnect(); } catch (e) {}
  }
  device = null;
  txChar = null;
}

// Kirim byte ke printer (dipecah per 20 byte — batas MTU BLE — dengan jeda)
export async function printBytes(bytes) {
  if (!device || !device.gatt || !device.gatt.connected) {
    throw new Error('Printer belum terkoneksi.');
  }
  // pastikan tahu karakteristik tulis (simpan dari connect)
  if (!txChar) {
    await findTxCharacteristic(await device.gatt.getPrimaryService('0000ffe0-0000-1000-8000-00805f9b34fb').catch(() => null));
  }
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const CHUNK = 20;
  const DELAY = 40;

  // coba pakai txChar yang tersimpan; kalau ada properti write, pakai itu
  // karena beberapa printer menolak writeWithoutResponse untuk data.
  const writeChunk = async (c, part) => {
    if (c.properties.writeWithoutResponse) {
      try { await c.writeValueWithoutResponse(part); return; } catch (e) { /* coba write */ }
    }
    if (c.properties.write) { await c.writeValue(part); return; }
    throw new Error('Karakteristik tidak bisa ditulisi.');
  };

  if (txChar && (txChar.properties.write || txChar.properties.writeWithoutResponse)) {
    for (let i = 0; i < arr.length; i += CHUNK) {
      await writeChunk(txChar, arr.slice(i, i + CHUNK));
      await ms(DELAY);
    }
    return;
  }

  // fallback: scan langsung
  const svcs = await device.gatt.getPrimaryServices();
  for (const svc of svcs) {
    const chars = await svc.getCharacteristics().catch(() => []);
    for (const c of chars) {
      if (c.properties.writeWithoutResponse || c.properties.write) {
        for (let i = 0; i < arr.length; i += CHUNK) {
          await writeChunk(c, arr.slice(i, i + CHUNK));
          await ms(DELAY);
        }
        return;
      }
    }
  }
  throw new Error('Tidak ada karakteristik tulis.');
}

// Test print: baris sederhana
export async function testPrint() {
  const bytes = concatBytes([
    esc.init(), esc.center(), esc.boldOn(),
    esc.text('PRINTER OK'), esc.text(new Date().toLocaleString('id-ID')),
    esc.boldOff(), esc.text(''), esc.feed(3), esc.cut()
  ]);
  await printBytes(bytes);
}
