// Logika jadwal pengingat (tanpa Firebase, supaya bisa dites: node api/_jadwal.js).
// File berawalan _ tidak dijadikan endpoint oleh Vercel.

const TEKS = {
  posisi: ['Ganti posisi', 'Ubah posisi, lalu cek kulit di area yang tertekan.'],
  minumLansia: ['Minum air', 'Tawarkan minum.'],
  minumSaya: ['Minum air', 'Waktunya minum juga, Princess.'],
};
// pengingat yang terlambat lebih dari ini tidak dikirim lagi (cron eksternal bisa telat beberapa menit)
const TOLERANSI = 30;

const hhmm = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
const menitHari = (t, tz) => {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t).split(':').map(Number);
  return h * 60 + m;
};

// menit sejak kejadian terakhir pengingat ini, null kalau sedang di luar jam aktif.
// jam aktif boleh melewati tengah malam (shift malam), mis. 21:00 sampai 07:00
function sejak(p, m) {
  if (p.jam) return (m - hhmm(p.jam) + 1440) % 1440;
  const a = hhmm(p.mulai), lama = (hhmm(p.selesai) - a + 1440) % 1440 || 1440, e = (m - a + 1440) % 1440;
  return e > lama ? null : e % Math.max(15, +p.tiap || 120);
}

// semua pengingat: milik sendiri (cg.pengingat) + per pasien (judul memuat nama pasien, id diawali id pasien)
const dariPg = (pg = {}, awal = '', untuk = '') => [
  ...Object.keys(TEKS).filter(k => pg[k]).map(k => ({ ...pg[k], id: awal + k, judul: TEKS[k][0] + untuk, isi: TEKS[k][1] })),
  ...(pg.obat || []).map(o => ({ ...o, judul: 'Obat' + untuk, isi: o.ket || 'Waktunya memberi obat.' })),
];
export const daftar = cg => [
  ...dariPg(cg.pengingat),
  ...(cg.pasien || []).flatMap(p => dariPg(p.pengingat, p.id + ':', ': ' + (p.nama || 'pasien') + (p.kamar ? ' (' + p.kamar + ')' : ''))),
];

// pengingat yang harus dikirim sekarang; terkirim = { id: waktu kejadian terakhir yang sudah dikirim }
export function jatuhTempo(cg, now, terkirim = {}) {
  const m = menitHari(now, cg.tz || 'Asia/Jakarta'), menit = Math.floor(now / 6e4);
  return daftar(cg).filter(p => p.on && (p.jam || (p.mulai && p.selesai))).flatMap(p => {
    const s = sejak(p, m);
    if (s == null || s > TOLERANSI) return [];
    const t = (menit - s) * 6e4;
    return (terkirim[p.id] || 0) < t ? [{ ...p, t }] : [];
  });
}

// self-check
if (process.argv[1]?.endsWith('_jadwal.js')) {
  const { strict: assert } = await import('node:assert');
  const jkt = (h, m) => Date.UTC(2026, 10, 23, h - 7, m); // jam Jakarta (UTC+7)
  const cg = { tz: 'Asia/Jakarta', pengingat: { minumSaya: { on: false, tiap: 60, mulai: '07:00', selesai: '21:00' } }, pasien: [
    { id: 'pa', nama: 'Ny. Siti', kamar: 'K-03', pengingat: {
      posisi: { on: true, tiap: 120, mulai: '07:00', selesai: '21:00' },
      minumLansia: { on: true, tiap: 120, mulai: '21:00', selesai: '07:00' },
      obat: [{ id: 'o1', on: true, jam: '08:00', ket: 'amlodipin' }],
    } },
    { id: 'pb', nama: 'Tn. Budi', pengingat: { posisi: { on: true, tiap: 180, mulai: '08:00', selesai: '20:00' } } },
  ] };
  const ids = (t, k) => jatuhTempo(cg, t, k).map(p => p.id).sort().join();
  assert.equal(ids(jkt(9, 5)), 'pa:posisi', '09:05 posisi Siti jatuh tempo (09:00), Budi belum');
  assert.equal(ids(jkt(11, 5)), 'pa:posisi,pb:posisi', 'tiap pasien punya jadwal sendiri');
  assert.equal(ids(jkt(9, 5), { 'pa:posisi': jkt(9, 0) }), '', 'tidak dikirim dua kali');
  assert.equal(ids(jkt(9, 45)), '', 'lewat toleransi');
  assert.equal(ids(jkt(8, 10)), 'o1,pb:posisi', 'obat 08:00 dan posisi Budi 08:00');
  assert.equal(ids(jkt(23, 10)), 'pa:minumLansia', 'shift malam lewat tengah malam (23:00)');
  assert.equal(ids(jkt(1, 0)), 'pa:minumLansia', 'shift malam 01:00');
  assert.equal(jatuhTempo(cg, jkt(9, 5))[0].t, jkt(9, 0), 'waktu kejadian');
  assert.equal(jatuhTempo(cg, jkt(8, 10)).find(p => p.id === 'o1').judul, 'Obat: Ny. Siti (K-03)', 'judul memuat nama pasien');
  console.log('jadwal OK');
}
