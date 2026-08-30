export function rupiah(n) {
  n = Math.round(Number(n) || 0);
  return 'Rp' + n.toLocaleString('id-ID');
}

export function numOnly(v) {
  const n = parseFloat(String(v).replace(/[^\d.-]/g, ''));
  return isNaN(n) ? 0 : n;
}

export function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function nowTimeStr() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

export function formatTanggal(iso) {
  if (!iso) return '-';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Total HPP satu menu = jumlah (qty bahan x harga AVCO bahan) dari resep.
// Pakai harga rata-rata tertimbang (AVCO), bukan harga beli terakhir saja,
// supaya HPP tetap stabil walau harga tiap belanja naik-turun.
export function hitungHpp(menu, bahanList) {
  if (!menu.resep || !menu.resep.length) return 0;
  return menu.resep.reduce((sum, r) => {
    const bahan = bahanList.find(b => b.id === r.bahanId);
    const harga = bahan ? Number(bahan.hargaAvco ?? bahan.hargaTerakhir ?? 0) : 0;
    return sum + harga * Number(r.qty || 0);
  }, 0);
}

// AVCO (Average Cost) — harga rata-rata tertimbang setelah ada stok baru masuk.
// Rumus: (nilai stok lama + nilai pembelian baru) / (stok lama + qty masuk)
export function hitungAvco(stokLama, avcoLama, qtyMasuk, hargaSatuanBaru) {
  const nilaiLama = Number(stokLama || 0) * Number(avcoLama || 0);
  const nilaiBaru = Number(qtyMasuk || 0) * Number(hargaSatuanBaru || 0);
  const stokBaru = Number(stokLama || 0) + Number(qtyMasuk || 0);
  if (stokBaru <= 0) return 0;
  return (nilaiLama + nilaiBaru) / stokBaru;
}

// Harga jual saran = HPP dinaikkan margin%, lalu dibagi (1 - potongan admin platform%)
// supaya setelah dipotong admin, keuntungan yang didapat tetap sesuai margin.
// Dibulatkan ke atas ke kelipatan 500 biar harga rapi.
export function hitungHargaSaran(hpp, marginPercent, adminPercent) {
  const margin = Number(marginPercent || 0) / 100;
  const admin = Math.min(Number(adminPercent || 0) / 100, 0.95);
  const divisor = 1 - admin;
  const raw = divisor <= 0 ? Infinity : (hpp * (1 + margin)) / divisor;
  if (!isFinite(raw)) return 0;
  return Math.ceil(raw / 500) * 500;
}

export function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
}

export function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}