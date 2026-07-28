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
  return d.toISOString().slice(0, 10);
}

export function nowTimeStr() {
  const d = new Date();
  return d.toTimeString().slice(0, 5);
}

export function formatTanggal(iso) {
  if (!iso) return '-';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Total HPP satu menu = jumlah (qty bahan x harga terakhir bahan) dari resep
export function hitungHpp(menu, bahanList) {
  if (!menu.resep || !menu.resep.length) return 0;
  return menu.resep.reduce((sum, r) => {
    const bahan = bahanList.find(b => b.id === r.bahanId);
    const harga = bahan ? Number(bahan.hargaTerakhir || 0) : 0;
    return sum + harga * Number(r.qty || 0);
  }, 0);
}

// Harga jual saran = HPP dinaikkan margin%, lalu dibagi (1 - potongan admin platform%)
// supaya setelah dipotong admin, keuntungan yang didapat tetap sesuai margin.
// Dibulatkan ke atas ke kelipatan 500 biar harga rapi.
export function hitungHargaSaran(hpp, marginPercent, adminPercent) {
  const margin = Number(marginPercent || 0) / 100;
  const admin = Math.min(Number(adminPercent || 0) / 100, 0.95);
  const raw = (hpp * (1 + margin)) / (1 - admin);
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
