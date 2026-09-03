// =========================================================
// BLE PRINTER — Web Bluetooth + ESC/POS (thermal 58mm)
// ---------------------------------------------------------
// RPP02N (chipset khusus) expose BLE GATT:
//   Primary service   : 49535343-FE7D-4AE5-8FA9-9AFD205E455
//   TX/write chars    : 49535343-8841-43F4-A8D4-ECBE34729BB3
//                       (WRITE + WRITE WITHOUT RESPONSE)
// Ini diverifikasi via nRF Connect (bukan asumsi universal).
//
// arsitektur tetap: GitHub Pages + Google Apps Script + Sheet.
// printer BLE langsung lewat browser (Android + Chrome/Edge).
// =========================================================

const STORAGE_DEVICE = 'cafeku_bt_device';

const esc = {
  init: () => new Uint8Array([0x1B, 0x40]),
  center: () => new Uint8Array([0x1B, 0x61, 0x01]),
  left: () => new Uint8Array([0x1B, 0x61, 0x00]),
  boldOn: () => new Uint8Array([0x1B, 0x45, 0x01]),
  boldOff: () => new Uint8Array([0x1B, 0x45, 0x00]),
  fontB: () => new Uint8Array([0x1B, 0x4D, 0x01]), // condensed 9x17 -> 48 kolom/48mm
  fontA: () => new Uint8Array([0x1B, 0x4D, 0x00]),
  feed: (n = 3) => new Uint8Array([0x1B, 0x64, n]),
  cut: () => new Uint8Array([0x1D, 0x56, 0x00]),
  cashdrawer: () => new Uint8Array([0x1B, 0x70, 0x00, 0x19, 0xFA]),
  text: (s) => new TextEncoder().encode((s || '') + '\n')
};

// ------------------------------------------------------------------
// Konfigurasi printer RPP02N (dari hasil nRF Connect)
// ------------------------------------------------------------------
const RPP_HOST = {
  serviceUUID: '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  txWriteUUID: '49535343-8841-43f4-a8d4-ecbe34729bb3', // WRITE + WRITE_NO_RESPONSE
};

// Cadangan: UUID umum produk thermal lain (untuk auto-detection).
// RPP02N dikenali lewat UUID_HOST di atas; sisa ini hanya fallback.
const UUID_FALLBACK_SERVICES = [
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000ffe5-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
  '000018f0-0000-1000-8000-00805f9b34fb',
];
const UUID_WRITE_PRIORITY = [
  '0000ffe1-0000-1000-8000-00805f9b34fb',
  '0000ffe2-0000-1000-8000-00805f9b34fb',
  '0000fff2-0000-1000-8000-00805f9b34fb',
];

const log = (level, ...args) => {
  const pfx = `[BLE ${level.toUpperCase()}]`;
  if (level === 'error') console.error(pfx, ...args);
  else if (level === 'warn') console.warn(pfx, ...args);
  else console.log(pfx, ...args);
};

let device = null;
let server = null;
let txChar = null;

const ms = n => new Promise(r => setTimeout(r, n));

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

function trunc(s, w) {
  const t = String(s || '');
  return t.length > w ? t.slice(0, w) : t;
}

// Struk -> byte ESC/POS
// Kertas 58/56mm, area cetak efektif ~48mm.
// Printer RPP02N wrap pada 48 kolom -> pakai Font B lebar aman 42 kolom.
export function buildEscPos(trx, bayar) {
  const W = 42;
  const rup = n => 'Rp' + (Math.round(Number(n) || 0)).toLocaleString('id-ID');
  const total = Number(trx.total || 0);
  const kembalian = Number(bayar || 0) - total;
  const shop = (trx.namaToko || 'CAFEKU').toUpperCase();
  const alamat = trx.alamat || '';
  const tgl = trx.tanggal || '';
  const formatTanggal = tgl ? new Date(tgl.replace(/-/g, '/')).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const waktu = trx.waktu || '';
  const totalQty = (trx.items || []).reduce((s, it) => s + Number(it.qty || 0), 0);
  const metode = trx.metodeBayar === 'qris' ? 'QRIS' : 'TUNAI';
  const platform = (trx.platform || 'OFFLINE').toUpperCase();
  const noAntrian = trx.noMeja ? String(trx.noMeja) : '';

  // pembatas cantik: garis tebal & tipis (hanya ASCII, aman di printer termal)
  const SOLID = '='.repeat(W);            // header/footer tebal
  const THIN = '-'.repeat(W);             // garis tipis (middle)

  // dua kolom sejajar: label kiri, nilai kanan rapat batas W
  const row = (label, value) => {
    const v = String(value);
    const maxLabel = Math.max(1, W - v.length);
    const lbl = trunc(label, maxLabel);
    return lbl + ' '.repeat(Math.max(0, W - lbl.length - v.length)) + v;
  };

  // header (center): nama toko + alamat
  const head = [
    '',
    '  ' + shop,
    ...(alamat ? [trunc('  ' + alamat, W)] : []),
    SOLID,
    trx.noInvoice ? row('NO INVOICE :', trx.noInvoice) : '',
    (tgl || waktu) ? row('TANGGAL', [formatTanggal, waktu].filter(Boolean).join(' ')) : '',
    ...(trx.namaPembeli ? ['PEMBELI : ' + trunc(String(trx.namaPembeli).toUpperCase(), W - 10)] : []),
    THIN,
  ];

  // bagian platform & no antrian — menonjol (uppercase, jelas)
  const meta = [];
  meta.push('');
  meta.push(row('PLATFORM :', platform));
  if (noAntrian) meta.push(row('NO ANTRIAN :', '#' + noAntrian));
  meta.push(THIN);

  // body item: 2 baris/item ala minimarket.
  //   baris 1: nama produk (kiri, penuh sampai W)
  //   baris 2: qty x harga (kiri)  +  subtotal (kanan)
  const body = [];
  (trx.items || []).forEach(it => {
    body.push(trunc((it.nama || '').toUpperCase(), W));
    body.push(row('  ' + it.qty + ' x ' + rup(it.hargaJual), rup(it.hargaJual * it.qty)));
  });

  // ringkasan: total qty dulu, lalu subtotal dkk
  const sum = [];
  sum.push(SOLID);
  sum.push(row('TOTAL QTY', String(totalQty) + ' item'));
  sum.push(row('SUBTOTAL', rup(trx.subtotal)));
  if (Number(trx.diskon)) sum.push(row('DISKON', '- ' + rup(trx.diskon)));
  if (Number(trx.adjustment)) sum.push(row('PENYESUAIAN', rup(trx.adjustment)));
  sum.push(row('TOTAL', rup(total)));
  sum.push(row('DIBAYAR', rup(bayar)));
  sum.push(kembalian >= 0 ? row('KEMBALIAN', rup(kembalian)) : row('KURANG', rup(-kembalian)));
  sum.push(SOLID);
  sum.push('METODE PEMBAYARAN : ' + metode);
  sum.push('');

  const foot = [
    'Terima Kasih atas Kunjungan Anda.',
    'Sampai jumpa lagi!',
    '',
    '',
    '',
  ];

  // Urutan ESC: init -> Font B (condensed, 42 kolom) -> center utk header
  const parts = [
    esc.init(), esc.fontB(), esc.center(), esc.boldOn(),
    ...head.map(l => esc.text(l)),
    esc.boldOff(), esc.left(),
    ...meta.map(l => esc.text(l)),
    ...body.map(l => esc.text(l)),
    ...sum.map(r => esc.text(r)),
    esc.center(),
    ...foot.map(l => esc.text(l)),
    esc.text(''), esc.feed(4), esc.cut(),
  ];
  return concatBytes(parts);
}

export function isBleSupported() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

export function isPrinterConnected() {
  return !!device && !!device.gatt && !!server && !!server.connected;
}

export function getPrinterName() {
  return (device && device.name) || localStorage.getItem(STORAGE_DEVICE) || '';
}

function getSavedDevice() {
  const id = localStorage.getItem(STORAGE_DEVICE);
  return id ? { id } : null;
}

function clearState() {
  device = null;
  server = null;
  txChar = null;
}

// Ambil karakteristik tulis dari service yang dikenal (RPP02N dulu).
// Prioritas:
//   1) service RPP02N 49535343-FE7D... -> char TX eksplisit
//   2) fallback service umum (FFE0/FFE5/FEE7/18F0) -> char tulis pertama
//   3) apapun yang writable
async function findTxCharacteristic() {
  // 1) RPP02N service eksplisit
  try {
    const svc = await server.getPrimaryService(RPP_HOST.serviceUUID);
    log('info', 'Service RPP02N ditemukan:', RPP_HOST.serviceUUID);
    const chars = await svc.getCharacteristics();
    for (const c of chars) {
      if (c.uuid.toLowerCase() === RPP_HOST.txWriteUUID) {
        txChar = c;
        log('info', 'TX char RPP02N ditetapkan:', c.uuid, 'props:', JSON.stringify(c.properties));
        return txChar;
      }
    }
    // char tulis dalam service itu (biar tetap jalan kalau UUID berubah antar-unit)
    for (const c of chars) {
      if (c.properties.writeWithoutResponse || c.properties.write) {
        txChar = c;
        log('warn', 'TX char eksplisit tak ketemu, pakai char tulis dalam service RPP02N:', c.uuid);
        return txChar;
      }
    }
  } catch (e) {
    log('warn', 'Service RPP02N tidak terbaca:', e.message);
  }

  // 2) fallback service umum
  const svcs = await server.getPrimaryServices();
  for (const svc of svcs) {
    const su = svc.uuid.toLowerCase();
    if (!UUID_FALLBACK_SERVICES.includes(su)) continue;
    let chars = [];
    try { chars = await svc.getCharacteristics(); } catch (e) { continue; }
    for (const c of chars) {
      if (c.properties.writeWithoutResponse || c.properties.write) {
        txChar = c;
        log('warn', 'Fallback service dipakai:', su, '->', c.uuid);
        return txChar;
      }
    }
  }

  // 3) apapun yang writable (paling tidak ideal, tapi berusaha)
  for (const svc of svcs) {
    let chars = [];
    try { chars = await svc.getCharacteristics(); } catch (e) { continue; }
    const writable = chars.find(c => c.properties.writeWithoutResponse || c.properties.write);
    if (writable) {
      txChar = writable;
      log('warn', 'Arbitrary writable char dipakai (service tidak dikenal):', txChar.uuid);
      return txChar;
    }
  }

  throw new Error('Tidak menemukan karakteristik tulis di printer.');
}

export async function connectPrinter() {
  if (!isBleSupported()) {
    throw new Error('Web Bluetooth tidak didukung di perangkat ini (butuh Android + Chrome).');
  }
  disconnectPrinter();

  // requestDevice WAJIB minta service RPP02N supaya Chrome expose service itu.
  const optionalServices = [RPP_HOST.serviceUUID, ...UUID_FALLBACK_SERVICES];

  device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices,
  });
  log('info', 'Device dipilih:', device.name, '| id:', device.id);

  device.ongattdisconnected = () => {
    log('warn', 'GATT disconnected');
    clearState();
  };

  server = await device.gatt.connect();
  log('info', 'GATT connected. Service diminta:', optionalServices.length);

  // MTU: Web Bluetooth tidak punya requestMTU standar. Jangan andalkan.
  // Semua kirim memakai chunk kecil (20 B) yang pasti aman untuk MTU default.
  if (server.requestMTU) {
    log('warn', 'requestMTU ada di browser ini tapi TIDAK diandalkan; tetap chunk kecil.');
  }

  await findTxCharacteristic();
  try { localStorage.setItem(STORAGE_DEVICE, device.id); } catch (e) {}
  log('info', 'Siap cetak. TX char:', txChar && txChar.uuid);
  return device.name || 'Printer';
}

export function disconnectPrinter() {
  if (server && server.connected) {
    try { server.disconnect(); } catch (e) {}
  }
  clearState();
}

async function writeChunk(c, part, idx) {
  let mode = '';
  if (c.properties.writeWithoutResponse) {
    try {
      await c.writeValueWithoutResponse(part);
      mode = 'writeWithoutResponse';
      log('debug', `chunk ${idx} OK (${part.byteLength}B) -> ${mode}`);
      return;
    } catch (e) {
      log('warn', `chunk ${idx} writeWithoutResponse gagal, coba write():`, e.message);
    }
  }
  if (c.properties.write) {
    await c.writeValue(part);
    mode = 'writeValue';
    log('debug', `chunk ${idx} OK (${part.byteLength}B) -> ${mode}`);
    return;
  }
  throw new Error('Karakteristik tidak bisa ditulisi.');
}

export async function printBytes(bytes) {
  if (!isPrinterConnected() || !txChar) {
    throw new Error('Printer belum terkoneksi (GATT tidak terhubung).');
  }
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const CHUNK = 20;   // aman di MTU default (23).
  const DELAY = 40;
  const totalChunks = Math.ceil(arr.length / CHUNK);

  log('info', `printBytes: ${arr.length} byte, ${totalChunks} chunk, chunk=${CHUNK}, delay=${DELAY}ms, tx=${txChar.uuid}`);

  for (let i = 0, idx = 0; i < arr.length; i += CHUNK, idx++) {
    const part = arr.slice(i, i + CHUNK);
    await writeChunk(txChar, part, idx);
    if (idx < totalChunks - 1) await ms(DELAY);
  }
  log('info', `Selesai kirim ${arr.length} byte dalam ${totalChunks} chunk.`);
}

// Test print sederhana (TANPA cutter) untuk diagnosa tahap awal.
export async function testPrint() {
  log('info', 'testPrint dipanggil');
  const now = new Date();
  const ts = now.toLocaleString('id-ID');
  const text = [
    '============================',
    '        TEST RPP02N',
    '============================',
    'BLE CONNECTION OK',
    'ESC/POS TEST',
    '0123456789',
    '============================',
    '',
    ts,
  ];

  const byteParts = [
    esc.init(), esc.fontB(),
    ...text.map(l => {
      const bytes = new TextEncoder().encode(l + '\n');
      return bytes;
    }),
    esc.feed(4),
    // TIDAK pakai esc.cut() pada tes pertama.
  ];
  const bytes = concatBytes(byteParts);
  await printBytes(bytes);
}
